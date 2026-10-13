import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requireWorkspace } from "@/lib/session";
import { Importer } from "./importer";

export const metadata: Metadata = { title: "Import contacts" };

export default async function ImportPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { workspace } = await requireWorkspace(workspaceId);
  return (
    <div className="max-w-4xl">
      <Link href={`/w/${workspaceId}/contacts`} className="text-sm text-slate-500 hover:text-slate-900">
        ← Contacts
      </Link>
      <PageHeader
        title="Import contacts"
        description={`Upload a CSV into ${workspace.name}. Contacts that already exist (same email or phone) are updated instead of duplicated.`}
      />
      <Importer workspaceId={workspaceId} />
    </div>
  );
}
