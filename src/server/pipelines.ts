import { and, asc, count, eq, gt, gte, sql, sum } from "drizzle-orm";
import type { Db } from "@/db/client";
import { activities, contacts, deals, pipelines, pipelineStages } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { fireTrigger } from "@/server/workflows/triggers";

export async function listPipelines(db: Db, workspaceId: string) {
  return withWorkspace(db, workspaceId, (tx) =>
    tx.select().from(pipelines).orderBy(asc(pipelines.position), asc(pipelines.createdAt)),
  );
}

/** Every pipeline with its stages, for pickers. */
export async function listPipelinesWithStages(db: Db, workspaceId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const list = await tx.select().from(pipelines).orderBy(asc(pipelines.position), asc(pipelines.createdAt));
    const stages = await tx.select().from(pipelineStages).orderBy(asc(pipelineStages.position));
    return list.map((p) => ({ id: p.id, name: p.name, stages: stages.filter((s) => s.pipelineId === p.id).map((s) => ({ id: s.id, name: s.name })) }));
  });
}

export async function getBoard(db: Db, workspaceId: string, pipelineId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [pipeline] = await tx.select().from(pipelines).where(eq(pipelines.id, pipelineId));
    if (!pipeline) return null;
    const stages = await tx
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId))
      .orderBy(asc(pipelineStages.position));
    const cards = await tx
      .select({
        id: deals.id,
        stageId: deals.stageId,
        title: deals.title,
        valueCents: deals.valueCents,
        status: deals.status,
        position: deals.position,
        contactId: deals.contactId,
        contactFirstName: contacts.firstName,
        contactLastName: contacts.lastName,
        contactEmail: contacts.email,
        contactPhone: contacts.phone,
      })
      .from(deals)
      .leftJoin(contacts, eq(contacts.id, deals.contactId))
      .where(and(eq(deals.pipelineId, pipelineId), eq(deals.status, "open")))
      .orderBy(asc(deals.position), asc(deals.createdAt));
    return { pipeline, stages, cards };
  });
}

export type BoardCard = NonNullable<Awaited<ReturnType<typeof getBoard>>>["cards"][number];

export async function createPipeline(db: Db, workspaceId: string, name: string, stageNames: string[]) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [{ n }] = await tx.select({ n: count() }).from(pipelines);
    const [pipeline] = await tx
      .insert(pipelines)
      .values({ workspaceId, name: name.trim(), position: n })
      .returning();
    const names = stageNames.map((s) => s.trim()).filter(Boolean);
    if (names.length) {
      await tx.insert(pipelineStages).values(
        names.map((stage, position) => ({ workspaceId, pipelineId: pipeline.id, name: stage, position })),
      );
    }
    return pipeline;
  });
}

export async function renamePipeline(db: Db, workspaceId: string, pipelineId: string, name: string) {
  await withWorkspace(db, workspaceId, (tx) =>
    tx.update(pipelines).set({ name: name.trim() }).where(eq(pipelines.id, pipelineId)),
  );
}

export async function addStage(db: Db, workspaceId: string, pipelineId: string, name: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${pipelineStages.position}), -1)::int` })
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId));
    const [stage] = await tx
      .insert(pipelineStages)
      .values({ workspaceId, pipelineId, name: name.trim(), position: max + 1 })
      .returning();
    return stage;
  });
}

export async function renameStage(db: Db, workspaceId: string, stageId: string, name: string) {
  await withWorkspace(db, workspaceId, (tx) =>
    tx.update(pipelineStages).set({ name: name.trim() }).where(eq(pipelineStages.id, stageId)),
  );
}

export async function reorderStages(db: Db, workspaceId: string, pipelineId: string, stageIds: string[]) {
  await withWorkspace(db, workspaceId, async (tx) => {
    for (const [position, id] of stageIds.entries()) {
      await tx
        .update(pipelineStages)
        .set({ position })
        .where(and(eq(pipelineStages.id, id), eq(pipelineStages.pipelineId, pipelineId)));
    }
  });
}

export class StageNotEmptyError extends Error {}

export async function deleteStage(db: Db, workspaceId: string, stageId: string) {
  await withWorkspace(db, workspaceId, async (tx) => {
    const [{ n }] = await tx.select({ n: count() }).from(deals).where(eq(deals.stageId, stageId));
    if (n > 0) throw new StageNotEmptyError("Move or close the deals in this stage first.");
    await tx.delete(pipelineStages).where(eq(pipelineStages.id, stageId));
  });
}

export async function createDeal(
  db: Db,
  workspaceId: string,
  input: { pipelineId: string; stageId: string; title: string; valueCents: number; contactId?: string | null },
  userId: string | null,
) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [stage] = await tx
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.id, input.stageId), eq(pipelineStages.pipelineId, input.pipelineId)));
    if (!stage) throw new Error("Stage not found");
    // New deals go to the top of their column.
    await tx
      .update(deals)
      .set({ position: sql`${deals.position} + 1` })
      .where(eq(deals.stageId, stage.id));
    const [deal] = await tx
      .insert(deals)
      .values({
        workspaceId,
        pipelineId: input.pipelineId,
        stageId: stage.id,
        title: input.title.trim(),
        valueCents: Math.max(0, Math.round(input.valueCents)),
        contactId: input.contactId || null,
        position: 0,
      })
      .returning();
    if (deal.contactId) {
      await tx.insert(activities).values({
        workspaceId,
        contactId: deal.contactId,
        kind: "deal_created",
        body: `Deal "${deal.title}" added to ${stage.name}`,
        createdBy: userId,
      });
      await fireTrigger(tx, workspaceId, { type: "deal_stage_changed", contactId: deal.contactId, dealId: deal.id, stageId: stage.id });
    }
    return deal;
  });
}

/** Moves a deal to `stageId` at `index`, shifting the other cards to make room. */
export async function moveDeal(
  db: Db,
  workspaceId: string,
  dealId: string,
  stageId: string,
  index: number,
  userId: string | null,
) {
  await withWorkspace(db, workspaceId, async (tx) => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId));
    if (!deal) throw new Error("Deal not found");
    const [target] = await tx
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, deal.pipelineId)));
    if (!target) throw new Error("Stage not found");

    // Close the gap in the old column, then open one in the new column.
    await tx
      .update(deals)
      .set({ position: sql`${deals.position} - 1` })
      .where(and(eq(deals.stageId, deal.stageId), gt(deals.position, deal.position)));
    await tx
      .update(deals)
      .set({ position: sql`${deals.position} + 1` })
      .where(and(eq(deals.stageId, stageId), gte(deals.position, index), sql`${deals.id} <> ${dealId}`));
    await tx
      .update(deals)
      .set({ stageId, position: Math.max(0, index), updatedAt: new Date() })
      .where(eq(deals.id, dealId));

    if (deal.stageId !== stageId && deal.contactId) {
      await tx.insert(activities).values({
        workspaceId,
        contactId: deal.contactId,
        kind: "stage_changed",
        body: `"${deal.title}" moved to ${target.name}`,
        createdBy: userId,
      });
      await fireTrigger(tx, workspaceId, { type: "deal_stage_changed", contactId: deal.contactId, dealId, stageId });
    }
  });
}

export async function updateDeal(
  db: Db,
  workspaceId: string,
  dealId: string,
  input: { title?: string; valueCents?: number; status?: "open" | "won" | "lost"; contactId?: string | null },
) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [before] = await tx.select({ status: deals.status }).from(deals).where(eq(deals.id, dealId));
    const [deal] = await tx
      .update(deals)
      .set({ ...input, title: input.title?.trim(), updatedAt: new Date() })
      .where(eq(deals.id, dealId))
      .returning();
    if (deal?.contactId && before && deal.status !== before.status) {
      await fireTrigger(tx, workspaceId, { type: "deal_status_changed", contactId: deal.contactId, dealId, status: deal.status });
    }
    return deal ?? null;
  });
}

export async function deleteDeal(db: Db, workspaceId: string, dealId: string) {
  await withWorkspace(db, workspaceId, (tx) => tx.delete(deals).where(eq(deals.id, dealId)));
}

/** Headline numbers for a workspace's overview page. */
export async function getWorkspaceStats(db: Db, workspaceId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [[c], [newC], [open], [won]] = await Promise.all([
      tx.select({ n: count() }).from(contacts),
      tx.select({ n: count() }).from(contacts).where(gte(contacts.createdAt, monthAgo)),
      tx
        .select({ n: count(), value: sum(deals.valueCents).mapWith(Number) })
        .from(deals)
        .where(eq(deals.status, "open")),
      tx
        .select({ n: count(), value: sum(deals.valueCents).mapWith(Number) })
        .from(deals)
        .where(and(eq(deals.status, "won"), gte(deals.updatedAt, monthAgo))),
    ]);
    return {
      contacts: c.n,
      newContacts30d: newC.n,
      openDeals: open.n,
      openValueCents: open.value ?? 0,
      wonDeals30d: won.n,
      wonValueCents30d: won.value ?? 0,
    };
  });
}
