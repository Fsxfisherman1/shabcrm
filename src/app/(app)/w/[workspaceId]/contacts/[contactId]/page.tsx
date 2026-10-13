import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { ConsentBadge } from "@/components/consent-badge";
import { Badge, Card } from "@/components/ui";
import { contactName, formatDate, formatMoney } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { requireWorkspace } from "@/lib/session";
import { getContact } from "@/server/contacts";
import { ConsentForm, DeleteContactButton, EditContactForm, NoteForm } from "./forms";

export const metadata: Metadata = { title: "Contact" };

const KIND_LABEL: Record<string, string> = {
  note: "Note",
  created: "Created",
  imported: "Imported",
  deal_created: "Deal",
  stage_changed: "Pipeline",
  consent_changed: "Consent",
};

export default async function ContactPage({ params }: { params: Promise<{ workspaceId: string; contactId: string }> }) {
  const { workspaceId, contactId } = await params;
  await requireWorkspace(workspaceId);
  if (!/^[0-9a-f-]{36}$/i.test(contactId)) notFound();
  const detail = await getContact(db, workspaceId, contactId);
  if (!detail) notFound();
  const { contact, timeline, deals } = detail;

  return (
    <>
      <Link href={`/w/${workspaceId}/contacts`} className="text-sm text-slate-500 hover:text-slate-900">
        ← Contacts
      </Link>
      <div className="mb-6 mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{contactName(contact)}</h1>
        <ConsentBadge consent={contact.smsConsent} />
        {contact.tags.map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <h2 className="mb-3 font-semibold">Activity</h2>
            <NoteForm workspaceId={workspaceId} contactId={contact.id} />
            <ol className="mt-5 space-y-4">
              {timeline.map((a) => (
                <li key={a.id} className="flex gap-3">
                  <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-500" />
                  <div className="min-w-0">
                    <div className="text-xs text-slate-500">
                      <span className="font-medium text-slate-700">{KIND_LABEL[a.kind]}</span> ·{" "}
                      {a.createdAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{a.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 font-semibold">Details</h2>
            <EditContactForm workspaceId={workspaceId} contact={contact} />
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-5 text-sm">
            <dl className="space-y-2">
              <Row label="Email">{contact.email ? <a href={`mailto:${contact.email}`} className="text-brand-600 hover:underline">{contact.email}</a> : "—"}</Row>
              <Row label="Phone">{contact.phone ? <a href={`tel:${contact.phone}`} className="text-brand-600 hover:underline">{formatPhone(contact.phone)}</a> : "—"}</Row>
              <Row label="Company">{contact.company || "—"}</Row>
              <Row label="Source">{contact.source || "—"}</Row>
              <Row label="Added">{formatDate(contact.createdAt)}</Row>
            </dl>
          </Card>

          <Card className="p-5">
            <h2 className="mb-1 font-semibold">Text message consent</h2>
            {contact.smsConsent === "granted" && (
              <p className="mb-3 text-xs text-slate-500">
                {contact.smsConsentSource} · {formatDate(contact.smsConsentAt)}
              </p>
            )}
            <ConsentForm key={contact.smsConsent} workspaceId={workspaceId} contactId={contact.id} current={contact.smsConsent} />
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Deals</h2>
              <Link href={`/w/${workspaceId}/pipeline?contact=${contact.id}`} className="text-sm font-medium text-brand-600 hover:underline">
                Add deal
              </Link>
            </div>
            {deals.length === 0 ? (
              <p className="text-sm text-slate-500">No deals yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {deals.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{d.title}</span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums text-slate-600">{formatMoney(d.valueCents)}</span>
                      {d.status !== "open" && <Badge tone={d.status === "won" ? "green" : "red"}>{d.status}</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <DeleteContactButton workspaceId={workspaceId} contactId={contact.id} />
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="truncate text-right">{children}</dd>
    </div>
  );
}
