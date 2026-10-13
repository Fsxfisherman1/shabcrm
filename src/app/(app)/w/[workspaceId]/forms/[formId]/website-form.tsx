"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import { deleteFormAction, saveWebsiteFormAction } from "@/actions/forms";
import { Button, Card, FormError, Input, Label } from "@/components/ui";

/** Settings for a form that lives on the client's own website. */
export function WebsiteForm({
  workspaceId,
  form,
  page,
  responses,
}: {
  workspaceId: string;
  form: { id: string; name: string; enabled: boolean; tags: string };
  page: string | null;
  responses: ReactNode;
}) {
  const [name, setName] = useState(form.name);
  const [enabled, setEnabled] = useState(form.enabled);
  const [tags, setTags] = useState(form.tags);
  const [notice, setNotice] = useState<{ error?: string | null; message?: string | null }>({});
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/w/${workspaceId}/forms`} className="text-sm text-slate-500 hover:text-slate-800">
          Forms /
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{form.name}</h1>
        <p className="mt-1 text-sm text-slate-500">
          A form on the client&apos;s website{page && <> ({page})</>}. It&apos;s edited there; responses are copied here.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-3">
          <h2 className="font-semibold">Responses</h2>
          {responses}
        </div>
        <Card className="space-y-4 self-start p-5">
          <h2 className="font-semibold">Settings</h2>
          <div>
            <Label htmlFor="wf-name">Name in ShabCRM</Label>
            <Input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <label className="flex gap-3">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>
              <span className="block text-sm font-medium">Collect responses</span>
              <span className="block text-xs text-slate-500">Turn off for forms you don&apos;t want here, like a newsletter box.</span>
            </span>
          </label>
          <div>
            <Label htmlFor="wf-tags">Tag new leads (comma separated)</Label>
            <Input id="wf-tags" value={tags} placeholder="e.g. website lead" onChange={(e) => setTags(e.target.value)} />
          </div>
          <p className="text-xs text-slate-500">
            Start a workflow from it with the &ldquo;Form filled in&rdquo; trigger in Automations. Text consent isn&apos;t recorded from website forms, since
            ShabCRM can&apos;t see what their checkbox said.
          </p>
          <FormError message={notice.error} />
          {notice.message && <p className="text-sm text-emerald-700">{notice.message}</p>}
          <Button disabled={pending} onClick={() => startTransition(async () => setNotice(await saveWebsiteFormAction(workspaceId, form.id, { name, enabled, tags })))}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <div className="border-t border-slate-100 pt-3">
            {confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                Remove it and its responses? It comes back if the form is sent again; to stop that, turn off Collect responses instead.
                <Button size="sm" variant="danger" onClick={() => startTransition(() => deleteFormAction(workspaceId, form.id))}>
                  Remove
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                Remove form
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
