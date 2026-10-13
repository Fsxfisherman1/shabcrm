import { sql } from "drizzle-orm";
import type { Db, Tx } from "./client";

/**
 * Runs `fn` in a transaction scoped to one workspace. Postgres row-level
 * security then only lets the queries see and write that workspace's rows,
 * so a bug in a query can't leak one client's data into another's.
 */
export async function withWorkspace<T>(
  db: Db,
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    await tx.execute(sql`set local role shab_app`);
    return fn(tx);
  });
}
