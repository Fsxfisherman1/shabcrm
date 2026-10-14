import Anthropic from "@anthropic-ai/sdk";
import type { AiProvider } from "@/db/schema";

// ---------------------------------------------------------------------------
// One small interface over whichever language model an account connects:
// Claude through Anthropic's SDK, and OpenAI, Gemini or any OpenAI-compatible
// service (OpenRouter, Groq, a local Ollama…) over their HTTP APIs.
// ---------------------------------------------------------------------------

export type LlmConfig = { provider: AiProvider; model: string; apiKey: string | null; baseUrl: string | null };

/** `quick` asks for the least effort, for short jobs like tagging a message. */
export type LlmRequest = { system: string; prompt: string; maxTokens: number; quick?: boolean };
export type Llm = (req: LlmRequest) => Promise<string>;
export type MakeLlm = (config: LlmConfig) => Llm;

export class AiError extends Error {}

const TIMEOUT_MS = 60_000;

export function makeLlm(config: LlmConfig, fetchImpl: typeof fetch = fetch): Llm {
  switch (config.provider) {
    case "anthropic":
      return anthropic(config, fetchImpl);
    case "gemini":
      return gemini(config, fetchImpl);
    case "openai":
    case "openai_compatible":
      return openAiChat(config, fetchImpl);
  }
}

// Claude models that take an effort level, and those that can hand a declined
// request to a fallback model on Anthropic's side.
const TAKES_EFFORT = /^claude-(fable|mythos|opus-5|opus-4-[678]|sonnet-5|haiku-5)/;
const SERVER_FALLBACK = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

function anthropic(config: LlmConfig, fetchImpl: typeof fetch): Llm {
  const client = new Anthropic({ apiKey: config.apiKey ?? "", fetch: fetchImpl, timeout: TIMEOUT_MS, maxRetries: 1 });
  return async ({ system, prompt, maxTokens, quick }) => {
    try {
      const res = await client.beta.messages.create({
        model: config.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
        ...(quick && TAKES_EFFORT.test(config.model) ? { output_config: { effort: "low" as const } } : {}),
        ...(SERVER_FALLBACK.has(config.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      if (res.stop_reason === "refusal") throw new AiError("The AI declined to answer this one.");
      return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new AiError("Anthropic didn't accept the API key.");
      if (err instanceof Anthropic.NotFoundError) throw new AiError(`Anthropic doesn't know the model "${config.model}".`);
      if (err instanceof Anthropic.RateLimitError) throw new AiError("Anthropic says you're over your rate limit. Try again shortly.");
      if (err instanceof Anthropic.APIError) throw new AiError(`Anthropic said: ${err.message}`);
      throw new AiError(`Couldn't reach Anthropic: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

function openAiChat(config: LlmConfig, fetchImpl: typeof fetch): Llm {
  const official = config.provider === "openai";
  const base = (official ? "https://api.openai.com/v1" : (config.baseUrl ?? "")).replace(/\/+$/, "");
  const name = official ? "OpenAI" : "The AI service";
  return async ({ system, prompt, maxTokens }) => {
    const json = await post(fetchImpl, name, `${base}/chat/completions`, config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}, {
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      // OpenAI's own API renamed this; compatible services still use the old name.
      [official ? "max_completion_tokens" : "max_tokens"]: maxTokens,
    });
    const text = (json as { choices?: { message?: { content?: string | null } }[] }).choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new AiError(`${name} sent back an answer we couldn't read.`);
    return text.trim();
  };
}

function gemini(config: LlmConfig, fetchImpl: typeof fetch): Llm {
  return async ({ system, prompt, maxTokens }) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
    const json = await post(fetchImpl, "Gemini", url, config.apiKey ? { "x-goog-api-key": config.apiKey } : {}, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    });
    const parts = (json as { candidates?: { content?: { parts?: { text?: string }[] } }[] }).candidates?.[0]?.content?.parts;
    if (!parts) throw new AiError("Gemini sent back an answer we couldn't read.");
    return parts.map((p) => p.text ?? "").join("").trim();
  };
}

async function post(fetchImpl: typeof fetch, name: string, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AiError(`Couldn't reach ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // reported below
  }
  if (!res.ok) {
    const raw = (json as { error?: { message?: string } | string } | null)?.error;
    const message = typeof raw === "string" ? raw : raw?.message;
    if (res.status === 401 || res.status === 403) throw new AiError(`${name} didn't accept the API key.`);
    throw new AiError(`${name} said: ${message ?? `error ${res.status}`}`);
  }
  if (json === null) throw new AiError(`${name} sent back an answer we couldn't read.`);
  return json;
}
