import { db } from "@/db";
import { receiveWorkflowWebhook } from "@/server/workflows";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await request.json().catch(() => null);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  }
  if (type.includes("form")) {
    const form = await request.formData().catch(() => null);
    if (!form) return null;
    return Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
  }
  return null;
}

// Other apps (a website form, Zapier, Make…) send contact details here to start
// a workflow. The secret token in the address is what makes it private.
export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; token: string }> }) {
  const { workspaceId, token } = await params;
  if (!UUID.test(workspaceId)) return Response.json({ error: "Not found" }, { status: 404 });
  const data = await readBody(request);
  if (!data) return Response.json({ error: "Send JSON or form data." }, { status: 400 });
  const result = await receiveWorkflowWebhook(db, workspaceId, token, data);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true, contactId: result.contactId });
}
