import type { Metadata } from "next";
import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { EmptyState, PageHeader } from "@/components/ui";
import { contactName, formatMoney } from "@/lib/format";
import { requireWorkspace } from "@/lib/session";
import { getBoard, listPipelines } from "@/server/pipelines";
import { Board } from "./board";
import { NewDealForm } from "./new-deal-form";

export const metadata: Metadata = { title: "Pipeline" };

export default async function PipelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ p?: string; contact?: string }>;
}) {
  const { workspaceId } = await params;
  const { p, contact } = await searchParams;
  await requireWorkspace(workspaceId);
  const pipelines = await listPipelines(db, workspaceId);
  const current = pipelines.find((x) => x.id === p) ?? pipelines[0];
  if (!current) {
    return (
      <EmptyState title="No pipelines yet">
        <Link href={`/w/${workspaceId}/settings`} className="font-medium text-brand-600 hover:underline">
          Create one in settings
        </Link>
      </EmptyState>
    );
  }
  const [board, contactOptions] = await Promise.all([
    getBoard(db, workspaceId, current.id),
    withWorkspace(db, workspaceId, (tx) =>
      tx
        .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, phone: contacts.phone })
        .from(contacts)
        .orderBy(desc(contacts.updatedAt))
        .limit(500),
    ),
  ]);
  if (!board) return null;
  const total = board.cards.reduce((sum, c) => sum + c.valueCents, 0);

  return (
    <>
      <PageHeader
        title={current.name}
        description={`${board.cards.length} open deals · ${formatMoney(total)}`}
        actions={
          pipelines.length > 1 ? (
            <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
              {pipelines.map((x) => (
                <Link
                  key={x.id}
                  href={`/w/${workspaceId}/pipeline?p=${x.id}`}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium ${x.id === current.id ? "bg-white shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
                >
                  {x.name}
                </Link>
              ))}
            </div>
          ) : undefined
        }
      />
      <NewDealForm
        workspaceId={workspaceId}
        pipelineId={current.id}
        stages={board.stages.map((s) => ({ id: s.id, name: s.name }))}
        contacts={contactOptions.map((c) => ({ id: c.id, label: contactName(c) }))}
        defaultContactId={contactOptions.some((c) => c.id === contact) ? contact : undefined}
      />
      <Board
        key={current.id}
        workspaceId={workspaceId}
        stages={board.stages.map((s) => ({ id: s.id, name: s.name }))}
        cards={board.cards}
      />
    </>
  );
}
