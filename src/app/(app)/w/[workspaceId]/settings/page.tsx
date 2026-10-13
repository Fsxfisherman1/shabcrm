import type { Metadata } from "next";
import { asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { pipelineStages } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { Card, PageHeader } from "@/components/ui";
import { requireWorkspace } from "@/lib/session";
import { listPipelines } from "@/server/pipelines";
import { NewPipelineForm, PipelineEditor, RenameAccountForm } from "./forms";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { workspace } = await requireWorkspace(workspaceId);
  const pipelines = await listPipelines(db, workspaceId);
  const stages = pipelines.length
    ? await withWorkspace(db, workspaceId, (tx) =>
        tx
          .select()
          .from(pipelineStages)
          .where(inArray(pipelineStages.pipelineId, pipelines.map((p) => p.id)))
          .orderBy(asc(pipelineStages.position)),
      )
    : [];

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Settings" />
      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Account name</h2>
        <RenameAccountForm workspaceId={workspaceId} name={workspace.name} />
      </Card>

      <div>
        <h2 className="mb-1 font-semibold">Pipelines</h2>
        <p className="mb-3 text-sm text-slate-500">
          Rename, reorder or add stages. A stage can only be deleted once it has no open deals.
        </p>
        <div className="space-y-4">
          {pipelines.map((p) => (
            <PipelineEditor
              key={p.id}
              workspaceId={workspaceId}
              pipeline={{ id: p.id, name: p.name }}
              stages={stages.filter((s) => s.pipelineId === p.id).map((s) => ({ id: s.id, name: s.name }))}
            />
          ))}
        </div>
      </div>

      <Card className="p-5">
        <h2 className="mb-3 font-semibold">New pipeline</h2>
        <NewPipelineForm workspaceId={workspaceId} />
      </Card>
    </div>
  );
}
