import Link from "next/link";
import { db } from "@/db";
import { ConsentBadge } from "@/components/consent-badge";
import { Badge, buttonClass, Card, EmptyState, Input, PageHeader } from "@/components/ui";
import { contactName, formatDate } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { requireWorkspace } from "@/lib/session";
import { markTabSeen } from "@/server/badges";
import { listContacts, listTags } from "@/server/contacts";

const PAGE_SIZE = 50;

export default async function ContactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ q?: string; tag?: string; page?: string }>;
}) {
  const { workspaceId } = await params;
  const { q, tag, page: pageParam } = await searchParams;
  const { user } = await requireWorkspace(workspaceId);
  await markTabSeen(db, user.id, workspaceId, "contacts");
  const page = Math.max(1, Number(pageParam) || 1);
  const [{ rows, total }, tags] = await Promise.all([
    listContacts(db, workspaceId, { search: q, tag, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    listTags(db, workspaceId),
  ]);
  const base = `/w/${workspaceId}/contacts`;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (overrides: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    const merged = { q, tag, page: undefined as string | undefined, ...overrides };
    for (const [k, v] of Object.entries(merged)) if (v) sp.set(k, v);
    const s = sp.toString();
    return s ? `${base}?${s}` : base;
  };

  return (
    <>
      <PageHeader
        title="Contacts"
        description={`${total.toLocaleString()} ${total === 1 ? "contact" : "contacts"}${tag ? ` tagged "${tag}"` : ""}${q ? ` matching "${q}"` : ""}`}
        actions={
          <>
            <Link href={`${base}/import`} className={buttonClass("secondary")}>
              Import CSV
            </Link>
            <Link href={`${base}/new`} className={buttonClass()}>
              Add contact
            </Link>
          </>
        }
      />

      <form className="mb-4 flex gap-2" action={base}>
        <Input name="q" defaultValue={q} placeholder="Search name, email, phone or company" aria-label="Search contacts" />
        {tag && <input type="hidden" name="tag" value={tag} />}
        <button className={buttonClass("secondary")}>Search</button>
      </form>

      {tags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          <Link
            href={link({ tag: undefined })}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${!tag ? "bg-brand-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
          >
            All
          </Link>
          {tags.map((t) => (
            <Link
              key={t.tag}
              href={link({ tag: t.tag })}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${tag === t.tag ? "bg-brand-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
            >
              {t.tag} <span className="opacity-60">{t.n}</span>
            </Link>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title={q || tag ? "No matches" : "No contacts yet"}>
          {q || tag ? "Try a different search." : "Import a CSV or add contacts by hand."}
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Phone</th>
                <th className="hidden px-4 py-3 font-medium lg:table-cell">Tags</th>
                <th className="px-4 py-3 font-medium">SMS</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Added</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link href={`${base}/${c.id}`} className="font-medium hover:text-brand-600">
                      {contactName(c)}
                    </Link>
                    {c.company && <div className="text-xs text-slate-500">{c.company}</div>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{c.email}</td>
                  <td className="hidden whitespace-nowrap px-4 py-3 text-slate-600 md:table-cell">{formatPhone(c.phone)}</td>
                  <td className="hidden px-4 py-3 lg:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {c.tags.slice(0, 4).map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <ConsentBadge consent={c.smsConsent} />
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-3 text-slate-500 md:table-cell">{formatDate(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <span>
            Page {page} of {pages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={link({ page: String(page - 1) })} className={buttonClass("secondary", "sm")}>
                Previous
              </Link>
            )}
            {page < pages && (
              <Link href={link({ page: String(page + 1) })} className={buttonClass("secondary", "sm")}>
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  );
}
