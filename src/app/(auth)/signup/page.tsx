import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { count } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { Card } from "@/components/ui";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Create owner account" };

export default async function SignupPage() {
  await connection();
  const [{ n }] = await db.select({ n: count() }).from(user);
  if (n > 0) {
    return (
      <Card className="p-6 text-center text-sm text-slate-600">
        Sign-ups are closed.{" "}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Sign in
        </Link>
      </Card>
    );
  }
  return (
    <Card className="p-6">
      <p className="mb-4 text-sm text-slate-500">
        This creates the owner account and your agency workspace. Only one person can sign up.
      </p>
      <SignupForm />
    </Card>
  );
}
