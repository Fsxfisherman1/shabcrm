import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import { db } from "@/db";
import { EmptyState } from "@/components/ui";
import { contactName } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { requireWorkspace } from "@/lib/session";
import { markItemsSeen } from "@/server/badges";
import { messagingConfig } from "@/server/messaging/config";
import { getForm, listSubmissions } from "@/server/forms";
import { FormEditor } from "./editor";
import { WebsiteForm } from "./website-form";

export const metadata: Metadata = { title: "Form" };

export default async function FormEditorPage({ params }: { params: Promise<{ workspaceId: string; formId: string }> }) {
  const { workspaceId, formId } = await params;
  const { workspace, user } = await requireWorkspace(workspaceId);
  if (!/^[0-9a-f-]{36}$/i.test(formId)) notFound();
  const form = await getForm(db, workspaceId, formId);
  if (!form) notFound();
  const submissions = await listSubmissions(db, workspaceId, formId);
  await markItemsSeen(db, user.id, workspaceId, "submission", submissions.map(({ submission }) => submission.id));
  const { appUrl } = messagingConfig();
  const when = (d: Date) => DateTime.fromJSDate(d, { zone: workspace.timezone }).toFormat("LLL d, h:mm a");

  // Saved answers come back in Postgres's key order; show them in the form's order.
  const position = new Map(form.fields.map((f, i) => [f.label, i]));
  const ordered = (answers: Record<string, string>) =>
    Object.entries(answers).sort(([a], [b]) => (position.get(a) ?? Infinity) - (position.get(b) ?? Infinity));

  const responses =
    submissions.length === 0 ? (
      <EmptyState title="No responses yet">
        {form.source === "website" ? "Responses show up here when the form is sent on their website." : "Share the form link or put it on a website, and responses show up here."}
      </EmptyState>
    ) : (
      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
        {submissions.map(({ submission, contact }) => (
          <div key={submission.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {contact ? (
                <Link href={`/w/${workspaceId}/contacts/${contact.id}`} className="font-medium hover:text-brand-700">
                  {contactName({ ...contact, phone: formatPhone(contact.phone) })}
                </Link>
              ) : (
                <span className="font-medium text-slate-500">Deleted contact</span>
              )}
              <span className="ml-auto text-xs text-slate-500">{when(submission.createdAt)}</span>
            </div>
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]">
              {ordered(submission.answers).map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words">{value}</dd>
                </div>
              ))}
            </dl>
            {submission.page && <p className="mt-1 truncate text-xs text-slate-400">From {submission.page}</p>}
          </div>
        ))}
      </div>
    );

  if (form.source === "website") {
    return (
      <WebsiteForm
        workspaceId={workspaceId}
        form={{ id: form.id, name: form.name, enabled: form.enabled, tags: form.tags.join(", ") }}
        page={form.externalKey?.startsWith("#") ? null : (form.externalKey?.split("#")[0] ?? null)}
        responses={responses}
      />
    );
  }

  return (
    <FormEditor
      workspaceId={workspaceId}
      form={{
        id: form.id,
        name: form.name,
        enabled: form.enabled,
        slug: form.slug,
        title: form.title,
        description: form.description,
        fields: form.fields,
        submitLabel: form.submitLabel,
        thankYou: form.thankYou,
        redirectUrl: form.redirectUrl ?? "",
        smsConsentText: form.smsConsentText ?? "",
        tags: form.tags.join(", "),
      }}
      appUrl={appUrl}
      responseCount={submissions.length}
      responses={responses}
    />
  );
}
