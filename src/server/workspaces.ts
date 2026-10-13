import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { memberships, pipelines, pipelineStages, workspaces } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { DEFAULT_STAGES } from "@/lib/default-stages";

export { DEFAULT_STAGES };

export async function createWorkspace(
  db: Db,
  input: { name: string; kind: "agency" | "client"; ownerId: string },
) {
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: input.name, kind: input.kind })
    .returning();
  await db
    .insert(memberships)
    .values({ userId: input.ownerId, workspaceId: workspace.id, role: "owner" });

  await withWorkspace(db, workspace.id, async (tx) => {
    const [pipeline] = await tx
      .insert(pipelines)
      .values({ workspaceId: workspace.id, name: "Sales pipeline" })
      .returning();
    await tx.insert(pipelineStages).values(
      DEFAULT_STAGES.map((name, position) => ({
        workspaceId: workspace.id,
        pipelineId: pipeline.id,
        name,
        position,
      })),
    );
  });

  return workspace;
}

export async function listWorkspacesForUser(db: Db, userId: string) {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      kind: workspaces.kind,
      role: memberships.role,
      createdAt: workspaces.createdAt,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(workspaces.kind), asc(workspaces.name));
}

export async function getMembership(db: Db, userId: string, workspaceId: string) {
  const [row] = await db
    .select({ workspace: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)));
  return row ?? null;
}

export async function renameWorkspace(db: Db, workspaceId: string, name: string) {
  await db.update(workspaces).set({ name }).where(eq(workspaces.id, workspaceId));
}
