import { db } from "@/db";
import { captureSubmission, flattenBody, type Capture } from "@/server/form-capture";

// Websites post here from any domain, so allow it (there are no cookies involved).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

async function readBody(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("form")) {
    const form = await request.formData().catch(() => null);
    return form ? Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")) : null;
  }
  // The snippet sends JSON as text/plain so browsers skip the extra CORS round trip.
  const text = await request.text().catch(() => "");
  if (text.length > 200_000) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Submissions from a website's own forms: from the ShabCRM snippet, or from a
 * site builder's webhook (Wix, Zapier…), with ?form=<name> naming the form.
 */
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const body = await readBody(request);
  if (!body || typeof body !== "object") return Response.json({ error: "Send JSON or form data." }, { status: 400, headers: CORS });

  let capture: Capture;
  const b = body as Record<string, unknown>;
  if (b.__shabcrm === 1 && Array.isArray(b.fields)) {
    capture = {
      formKey: String(b.formKey ?? ""),
      formName: String(b.formName ?? ""),
      page: String(b.page ?? ""),
      fields: (b.fields as Record<string, unknown>[]).filter((f) => f && typeof f === "object").map((f) => ({
        name: String(f.name ?? ""),
        label: String(f.label ?? ""),
        type: String(f.type ?? "text").toLowerCase(),
        value: String(f.value ?? ""),
      })),
    };
  } else {
    const url = new URL(request.url);
    const formName = url.searchParams.get("form") ?? "Website form";
    capture = { formKey: `webhook:${formName.toLowerCase()}`, formName, page: url.searchParams.get("page") ?? "", fields: flattenBody(body) };
  }

  const result = await captureSubmission(db, key, capture);
  if (!result.ok) return Response.json({ ok: false, reason: result.reason }, { status: result.status, headers: CORS });
  return Response.json({ ok: true }, { headers: CORS });
}
