import "server-only";
import { createDb } from "./client";

export const db = createDb(process.env.DATABASE_URL!);
export type { Db, Tx } from "./client";
