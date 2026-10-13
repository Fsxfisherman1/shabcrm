import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import { markTabSeen } from "@/server/badges";
import { CopyField } from "@/components/copy-field";
import { getCaptureKey } from "@/server/form-capture";
import { listForms } from "@/server/forms";
import { messagingConfig } from "@/server/messaging/config";
import { NewFormButton } from "./new-form";

export const metadata: Metadata = { title: "Forms" };

export default async function FormsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { user } = await requireWorkspace(workspaceId);
  await markTabSeen(db, user.id, workspaceId, "forms");
  const [list, key] = await Promise.all([listForms(db, workspaceId), getCaptureKey(db, workspaceId)]);
  const { appUrl } = messagingConfig();
  const snippet = `<script src="${appUrl}/api/capture/${key}/script.js" async></script>`;
  const webhook = `${appUrl}/api/capture/${key}?form=Contact%20form`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Forms"
        description="Lead forms for websites, ads and social links. Everyone who fills one in lands in Contacts."
        actions={<NewFormButton workspaceId={workspaceId} />}
      />
      {list.length === 0 ? (
        <EmptyState title="No forms yet">
          Click New form to make a form here, or connect the forms already on the client&apos;s website below.
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Form</th>
                <th className="px-4 py-3 font-medium">Kind</th>
                <th className="px-4 py-3 text-right font-medium">Responses</th>
                <th className="px-4 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((f) => (
                <tr key={f.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link href={`/w/${workspaceId}/forms/${f.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                      {f.name}
                    </Link>
                    <span className="ml-2">{f.enabled ? <Badge tone="green">{f.source === "website" ? "Collecting" : "Live"}</Badge> : <Badge>Off</Badge>}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{f.source === "website" ? "On their website" : "Built here"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{f.submissions}</td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(f.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card className="space-y-5 p-5">
        <div>
          <h2 className="font-semibold">Connect the forms already on their website</h2>
          <p className="mt-1 text-sm text-slate-500">
            Keep the client&apos;s own forms. Each time one is sent, a copy of the answers comes here: the person is added to Contacts, and the form appears in
            the list above (named after its page) with its responses. Their form keeps working exactly as before.
          </p>
        </div>
        <div className="space-y-2">
          <CopyField label="Website snippet (WordPress, Squarespace, Webflow, Shopify and most sites)" value={snippet} />
          <p className="text-xs text-slate-500">
            Paste it once into the site&apos;s header or footer code, so it&apos;s on every page. Squarespace: Settings › Advanced › Code Injection. Webflow: Site
            settings › Custom code. WordPress: a header and footer code plugin. Sign-in and payment forms are always skipped, and only forms with an email or
            phone are kept.
          </p>
        </div>
        <div className="space-y-2">
          <CopyField label="Webhook address (Wix and other builders)" value={webhook} />
          <p className="text-xs text-slate-500">
            Wix forms can&apos;t be read by a snippet. Instead, in Wix open Automations, start one from the form being submitted, and add the action that sends
            the data to a webhook URL, then paste this address. Change &ldquo;Contact%20form&rdquo; at the end to name the form. Zapier and Make can post to
            the same address.
          </p>
        </div>
      </Card>
    </div>
  );
}
