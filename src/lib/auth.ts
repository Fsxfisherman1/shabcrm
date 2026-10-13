import "server-only";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { count } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { createWorkspace } from "@/server/workspaces";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: { enabled: true, minPasswordLength: 10 },
  databaseHooks: {
    user: {
      create: {
        // ShabCRM is a private tool: only the first person can sign up, and
        // they become the agency owner. Teammates will be invited later.
        before: async () => {
          const [{ n }] = await db.select({ n: count() }).from(schema.user);
          if (n > 0) {
            throw new APIError("FORBIDDEN", { message: "Sign-ups are closed." });
          }
        },
        after: async (user) => {
          await createWorkspace(db, { name: "My Agency", kind: "agency", ownerId: user.id });
        },
      },
    },
  },
  plugins: [nextCookies()],
});
