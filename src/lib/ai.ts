import type { AiProvider } from "@/db/schema";

// Words for the AI settings and inbox, shared by the server and the browser.

/** What an inbound message can be tagged as. Anything else gets no tag. */
export const INTENTS = ["wants_to_book", "pricing", "reschedule", "complaint", "question"] as const;
export type Intent = (typeof INTENTS)[number];

export const INTENT_LABEL: Record<Intent, string> = {
  wants_to_book: "Wants to book",
  pricing: "Asking about price",
  reschedule: "Reschedule or cancel",
  complaint: "Unhappy",
  question: "Question",
};

export const INTENT_HINT: Record<Intent, string> = {
  wants_to_book: "wants to book, schedule or buy",
  pricing: "asks what something costs, for a quote, or about payment or insurance",
  reschedule: "wants to move, reschedule or cancel an existing booking",
  complaint: "is unhappy, complaining, or reporting a problem with past work",
  question: "asks any other question that needs an answer",
};

export function isIntent(value: unknown): value is Intent {
  return typeof value === "string" && (INTENTS as readonly string[]).includes(value);
}

export const AI_PROVIDERS: { id: AiProvider; label: string; model: string; hint: string }[] = [
  { id: "anthropic", label: "Claude (Anthropic)", model: "claude-opus-5-5", hint: "Get a key at console.anthropic.com." },
  { id: "openai", label: "ChatGPT (OpenAI)", model: "", hint: "Get a key at platform.openai.com." },
  { id: "gemini", label: "Gemini (Google)", model: "", hint: "Get a key at aistudio.google.com." },
  {
    id: "openai_compatible",
    label: "Another service (OpenAI-compatible)",
    model: "",
    hint: "OpenRouter, Groq, Mistral, DeepSeek, Together, or a local Ollama or LM Studio. Use its API address, like https://openrouter.ai/api/v1.",
  },
];
