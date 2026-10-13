"use client";

import { createClientAccount } from "@/actions/workspaces";
import { Button, FormError, Input } from "@/components/ui";
import { useActionForm } from "@/components/use-action-form";

export function NewClientForm() {
  const [state, onSubmit, pending] = useActionForm(createClientAccount);
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="flex gap-2">
        <Input name="name" placeholder="Business name, e.g. Acme Plumbing" aria-label="Business name" required />
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>
      <FormError message={state.error} />
    </form>
  );
}
