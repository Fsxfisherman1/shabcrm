import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pgClients?: Map<string, postgres.Sql> };

// Reuse one connection pool per URL so dev hot-reloads don't leak connections.
export function createDb(url: string) {
  globalForDb.pgClients ??= new Map();
  let client = globalForDb.pgClients.get(url);
  if (!client) {
    client = postgres(url, { max: 10 });
    globalForDb.pgClients.set(url, client);
  }
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
