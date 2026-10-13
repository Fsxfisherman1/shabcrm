import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { count } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { Card } from "@/components/ui";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  await connection();
  const [{ n }] = await db.select({ n: count() }).from(user);
  return (
    <Card className="p-6">
      <LoginForm />
      {n === 0 && (
        <p className="mt-4 text-center text-sm text-slate-500">
          First time here?{" "}
          <Link href="/signup" className="font-medium text-brand-600 hover:underline">
            Create the owner account
          </Link>
        </p>
      )}
    </Card>
  );
}
