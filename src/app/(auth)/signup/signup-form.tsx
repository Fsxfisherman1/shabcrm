"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Field, FormError, Input } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

export function SignupForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await authClient.signUp.email({
      name: String(form.get("name")),
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (error) return setError(error.message ?? "Couldn't create the account.");
    router.push("/agency");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Your name" name="name">
        <Input id="name" name="name" autoComplete="name" required />
      </Field>
      <Field label="Email" name="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Password (10+ characters)" name="password">
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
      </Field>
      <FormError message={error} />
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creating…" : "Create account"}
      </Button>
    </form>
  );
}
