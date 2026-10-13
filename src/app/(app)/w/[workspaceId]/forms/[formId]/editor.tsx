"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import type { FormField } from "@/db/schema";
import { deleteFormAction, saveFormAction } from "@/actions/forms";
import { CopyField } from "@/components/copy-field";
import { Button, Card, FormError, Input, Label, Textarea } from "@/components/ui";

type State = {
  name: string;
  enabled: boolean;
  slug: string;
  title: string;
  description: string;
  fields: FormField[];
  submitLabel: string;
  thankYou: string;
  redirectUrl: string;
  smsConsentText: string;
  tags: string;
};

const KIND_LABEL: Record<FormField["kind"], string> = {
  first_name: "First name",
  last_name: "Last name",
  full_name: "Full name",
  email: "Email",
  phone: "Phone",
  company: "Company",
  text: "Short answer",
  textarea: "Paragraph",
  select: "Dropdown",
};
const CONTACT_KINDS: FormField["kind"][] = ["full_name", "first_name", "last_name", "email", "phone", "company"];
const QUESTION_KINDS: FormField["kind"][] = ["text", "textarea", "select"];
const NEW_LABEL: Partial<Record<FormField["kind"], string>> = { text: "Your question", textarea: "Anything else?", select: "Which service?" };

const newId = () => Math.random().toString(36).slice(2, 10);

export function FormEditor({
  workspaceId,
  form,
  appUrl,
  responseCount,
  responses,
}: {
  workspaceId: string;
  form: State & { id: string };
  appUrl: string;
  responseCount: number;
  responses: ReactNode;
}) {
  const { id, ...initial } = form;
  const [state, setState] = useState<State>(initial);
  const [saved, setSaved] = useState(initial);
  const [tab, setTab] = useState<"build" | "responses" | "share">("build");
  const [notice, setNotice] = useState<{ error?: string | null; message?: string | null }>({});
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = JSON.stringify(state) !== JSON.stringify(saved);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = (patch: Partial<State>) => {
    setNotice({});
    setState((s) => ({ ...s, ...patch }));
  };
  const setField = (fieldId: string, patch: Partial<FormField>) => update({ fields: state.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)) });
  const moveField = (index: number, by: -1 | 1) => {
    const j = index + by;
    if (j < 0 || j >= state.fields.length) return;
    const fields = [...state.fields];
    [fields[index], fields[j]] = [fields[j], fields[index]];
    update({ fields });
  };
  const addField = (kind: FormField["kind"]) =>
    update({
      fields: [...state.fields, { id: newId(), kind, label: NEW_LABEL[kind] ?? KIND_LABEL[kind], required: kind === "email", ...(kind === "select" ? { options: ["Option 1", "Option 2"] } : {}) }],
    });

  function save(next: State) {
    next = { ...next, fields: next.fields.map((f) => (f.options ? { ...f, options: f.options.map((o) => o.trim()).filter(Boolean) } : f)) };
    startTransition(async () => {
      const result = await saveFormAction(workspaceId, id, next);
      setNotice(result);
      if (result.ok) {
        // The server tidies the address (e.g. "My Form" becomes "my-form").
        const tidy = { ...next, slug: next.slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") };
        setState(tidy);
        setSaved(tidy);
      } else if (next.enabled !== saved.enabled) {
        setState((s) => ({ ...s, enabled: saved.enabled }));
      }
    });
  }

  const link = `${appUrl}/f/${saved.slug}`;
  const frameId = `shabcrm-form-${saved.slug}`;
  const embed = `<iframe id="${frameId}" src="${link}?embed=1" title="${saved.title.replace(/"/g, "&quot;")}" style="width:100%;max-width:560px;height:640px;border:0"></iframe>
<script>addEventListener("message",function(e){if(e.origin==="${appUrl}"&&e.data&&e.data.shabcrmForm==="${saved.slug}"){document.getElementById("${frameId}").style.height=e.data.height+"px"}})</script>`;
  const has = (kind: FormField["kind"]) => state.fields.some((f) => f.kind === kind);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/w/${workspaceId}/forms`} className="text-sm text-slate-500 hover:text-slate-800">
          Forms /
        </Link>
        <input
          aria-label="Form name"
          value={state.name}
          onChange={(e) => update({ name: e.target.value })}
          className="min-w-48 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-xl font-semibold tracking-tight hover:border-slate-200 focus:border-brand-500 focus:bg-white focus:outline-none"
        />
        <label className="flex items-center gap-2 text-sm font-medium">
          <button
            type="button"
            role="switch"
            aria-checked={state.enabled}
            aria-label="Accept responses"
            disabled={pending}
            onClick={() => {
              const next = { ...state, enabled: !state.enabled };
              setState(next);
              save(next);
            }}
            className={clsx("relative h-6 w-11 rounded-full transition-colors", state.enabled ? "bg-emerald-500" : "bg-slate-300")}
          >
            <span className={clsx("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", state.enabled ? "left-[22px]" : "left-0.5")} />
          </button>
          {state.enabled ? "Live" : "Off"}
        </label>
        <a href={link} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand-700 hover:underline">
          Open form
        </a>
        <Button onClick={() => save(state)} disabled={pending || !dirty}>
          {pending ? "Saving…" : dirty ? "Save" : "Saved"}
        </Button>
      </div>

      {notice.error && <FormError message={notice.error} />}
      {notice.message && !dirty && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice.message}</p>}

      <div className="flex gap-1 border-b border-slate-200 text-sm" role="tablist">
        {(
          [
            ["build", "Build"],
            ["responses", `Responses (${responseCount}${responseCount >= 100 ? "+" : ""})`],
            ["share", "Share"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={clsx("-mb-px border-b-2 px-3 py-2 font-medium", tab === key ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "build" && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="min-w-0 space-y-6">
            <Card className="space-y-4 p-5">
              <h2 className="font-semibold">Heading</h2>
              <div>
                <Label htmlFor="form-title">Title</Label>
                <Input id="form-title" value={state.title} onChange={(e) => update({ title: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="form-description">Intro text (optional)</Label>
                <Textarea id="form-description" rows={2} value={state.description} onChange={(e) => update({ description: e.target.value })} />
              </div>
            </Card>

            <Card className="space-y-3 p-5">
              <h2 className="font-semibold">Fields</h2>
              {state.fields.map((f, i) => (
                <div key={f.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-40 flex-1">
                      <Label htmlFor={`label-${f.id}`}>{KIND_LABEL[f.kind]}</Label>
                      <Input id={`label-${f.id}`} value={f.label} onChange={(e) => setField(f.id, { label: e.target.value })} />
                    </div>
                    <label className="flex h-10 items-center gap-2 text-sm">
                      <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={f.required} onChange={(e) => setField(f.id, { required: e.target.checked })} />
                      Required
                    </label>
                    <div className="flex h-10 items-center gap-1">
                      <SmallButton label={`Move ${f.label} up`} onClick={() => moveField(i, -1)}>
                        ↑
                      </SmallButton>
                      <SmallButton label={`Move ${f.label} down`} onClick={() => moveField(i, 1)}>
                        ↓
                      </SmallButton>
                      <SmallButton label={`Remove ${f.label}`} onClick={() => update({ fields: state.fields.filter((x) => x.id !== f.id) })}>
                        ×
                      </SmallButton>
                    </div>
                  </div>
                  {f.kind === "select" && (
                    <div className="mt-2">
                      <Label htmlFor={`options-${f.id}`}>Choices, one per line</Label>
                      <Textarea
                        id={`options-${f.id}`}
                        rows={3}
                        value={(f.options ?? []).join("\n")}
                        onChange={(e) => setField(f.id, { options: e.target.value.split("\n").map((o) => o.trimStart()) })}
                        onBlur={(e) => setField(f.id, { options: e.target.value.split("\n").map((o) => o.trim()).filter(Boolean) })}
                      />
                    </div>
                  )}
                </div>
              ))}
              <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1 text-sm">
                <span className="text-slate-500">Add:</span>
                {[...CONTACT_KINDS, ...QUESTION_KINDS].map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={CONTACT_KINDS.includes(k) && has(k)}
                    onClick={() => addField(k)}
                    className="font-medium text-brand-700 hover:underline disabled:cursor-default disabled:text-slate-300 disabled:no-underline"
                  >
                    + {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500">
                Name, email, phone and company fill in the contact. Answers to your own questions are saved with the response and can go in workflow messages.
              </p>
            </Card>

            <Card className="space-y-4 p-5">
              <h2 className="font-semibold">After they send it</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="form-submit">Button text</Label>
                  <Input id="form-submit" value={state.submitLabel} onChange={(e) => update({ submitLabel: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="form-tags">Tag new leads (comma separated)</Label>
                  <Input id="form-tags" value={state.tags} placeholder="e.g. website lead" onChange={(e) => update({ tags: e.target.value })} />
                </div>
              </div>
              <div>
                <Label htmlFor="form-thanks">Thank-you message</Label>
                <Textarea id="form-thanks" rows={2} value={state.thankYou} onChange={(e) => update({ thankYou: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="form-redirect">Or send them to a page (optional)</Label>
                <Input id="form-redirect" value={state.redirectUrl} placeholder="https://example.com/thank-you" onChange={(e) => update({ redirectUrl: e.target.value })} />
              </div>
              {has("phone") && (
                <div>
                  <Label htmlFor="form-consent">Text message consent checkbox</Label>
                  <Textarea id="form-consent" rows={3} value={state.smsConsentText} onChange={(e) => update({ smsConsentText: e.target.value })} />
                  <p className="mt-1 text-xs text-slate-500">
                    Shown next to an unticked checkbox. Ticking it records text consent on the contact. Leave empty to hide the checkbox. Anyone who opted out stays opted out.
                  </p>
                </div>
              )}
            </Card>
          </div>

          <div className="min-w-0">
            <div className="lg:sticky lg:top-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Preview</div>
              <Preview state={state} />
            </div>
          </div>
        </div>
      )}

      {tab === "responses" && responses}

      {tab === "share" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="space-y-4 p-5">
            <h2 className="font-semibold">Link</h2>
            <p className="text-sm text-slate-500">Share it in ads, social posts, texts or emails.</p>
            <CopyField label="Form link" value={link} open />
            <div>
              <Label htmlFor="form-slug">Address</Label>
              <div className="flex items-center gap-1 text-sm">
                <span className="shrink-0 text-slate-500">/f/</span>
                <Input id="form-slug" value={state.slug} onChange={(e) => update({ slug: e.target.value })} />
              </div>
              <p className="mt-1 text-xs text-slate-500">Changing it breaks links and embeds you&apos;ve already shared.</p>
            </div>
          </Card>
          <Card className="space-y-4 p-5">
            <h2 className="font-semibold">Put it on a website</h2>
            <p className="text-sm text-slate-500">
              Paste this where the form should go, using an &ldquo;HTML&rdquo; or &ldquo;Embed code&rdquo; block (Wix, Squarespace, WordPress and most site builders have one).
            </p>
            <EmbedCode code={embed} />
          </Card>
          <Card className="space-y-2 p-5 lg:col-span-2">
            <h2 className="font-semibold">Follow up automatically</h2>
            <p className="text-sm text-slate-500">
              In <Link href={`/w/${workspaceId}/automations`} className="font-medium text-brand-700 hover:underline">Automations</Link>, start a workflow with the &ldquo;Form filled in&rdquo; trigger and pick this form, for example to text new leads within a minute.
            </p>
          </Card>
          <Card className="space-y-3 p-5 lg:col-span-2">
            <h2 className="font-semibold">Danger zone</h2>
            {confirmDelete ? (
              <div className="flex items-center gap-2 text-sm">
                Delete this form and its responses? The contacts stay.
                <Button size="sm" variant="danger" onClick={() => startTransition(() => deleteFormAction(workspaceId, id))}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete form
              </Button>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/** What visitors will see, updated as you edit. */
function Preview({ state }: { state: State }) {
  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="Form preview">
      <div>
        <div className="text-xl font-semibold tracking-tight">{state.title || "Untitled form"}</div>
        {state.description && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{state.description}</p>}
      </div>
      {state.fields.map((f) => (
        <div key={f.id}>
          <div className="mb-1 text-sm font-medium text-slate-700">
            {f.label}
            {f.required && <span className="text-red-600"> *</span>}
          </div>
          {f.kind === "textarea" ? (
            <div className="h-20 rounded-lg border border-slate-300" />
          ) : f.kind === "select" ? (
            <div className="flex h-10 items-center justify-between rounded-lg border border-slate-300 px-3 text-sm text-slate-400">
              Choose… <span>▾</span>
            </div>
          ) : (
            <div className="h-10 rounded-lg border border-slate-300" />
          )}
        </div>
      ))}
      {state.fields.some((f) => f.kind === "phone") && state.smsConsentText.trim() && (
        <div className="flex gap-2 text-xs text-slate-600">
          <span className="mt-0.5 h-4 w-4 shrink-0 rounded border border-slate-300" />
          <span>{state.smsConsentText}</span>
        </div>
      )}
      <div className="flex h-10 items-center justify-center rounded-lg bg-brand-600 text-sm font-medium text-white">{state.submitLabel || "Send"}</div>
    </div>
  );
}

function EmbedCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <Textarea readOnly rows={6} value={code} aria-label="Embed code" className="font-mono text-xs" onFocus={(e) => e.target.select()} />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={async () => {
          await navigator.clipboard?.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy code"}
      </Button>
    </div>
  );
}

function SmallButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">
      {children}
    </button>
  );
}
