import type { Metadata } from "next";
import { requireWorkspace } from "@/lib/session";
import { Card, PageHeader } from "@/components/ui";
import { NewContactForm } from "./new-contact-form";

export const metadata: Metadata = { title: "Add contact" };

export default async function NewContactPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  await requireWorkspace(workspaceId);
  return (
    <div className="max-w-2xl">
      <PageHeader title="Add contact" />
      <Card className="p-6">
        <NewContactForm workspaceId={workspaceId} />
      </Card>
    </div>
  );
}
