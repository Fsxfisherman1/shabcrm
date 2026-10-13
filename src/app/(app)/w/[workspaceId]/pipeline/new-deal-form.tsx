"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { createDealAction } from "@/actions/pipelines";
import { Button, Card, Field, FormError, Input, Select } from "@/components/ui";
import { useActionForm } from "@/components/use-action-form";

export function NewDealForm({
  workspaceId,
  pipelineId,
  stages,
  contacts,
  defaultContactId,
}: {
  workspaceId: string;
  pipelineId: string;
  stages: { id: string; name: string }[];
  contacts: { id: string; label: string }[];
  defaultContactId?: string;
}) {
  const [open, setOpen] = useState(Boolean(defaultContactId));
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [state, onSubmit, pending] = useActionForm(createDealAction.bind(null, workspaceId, pipelineId), {
    onSuccess: () => {
      setOpen(false);
      // Drop ?contact= so a reload doesn't reopen the form.
      if (searchParams.has("contact")) {
        const next = new URLSearchParams(searchParams);
        next.delete("contact");
        router.replace(next.size ? `${pathname}?${next}` : pathname);
      }
    },
  });
  const defaultTitle = defaultContactId ? contacts.find((c) => c.id === defaultContactId)?.label : undefined;

  if (!open) {
    return (
      <div className="mb-4">
        <Button onClick={() => setOpen(true)}>Add deal</Button>
      </div>
    );
  }
  return (
    <Card className="mb-4 p-4">
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
        <Field label="Deal name" name="title">
          <Input id="title" name="title" defaultValue={defaultTitle} placeholder="e.g. Kitchen remodel" required autoFocus />
        </Field>
        <Field label="Value ($)" name="value">
          <Input id="value" name="value" inputMode="decimal" placeholder="0" />
        </Field>
        <Field label="Stage" name="stageId">
          <Select id="stageId" name="stageId" defaultValue={stages[0]?.id}>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Contact" name="contactId">
          <Select id="contactId" name="contactId" defaultValue={defaultContactId ?? ""}>
            <option value="">None</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
      <div className="mt-2">
        <FormError message={state.error} />
      </div>
    </Card>
  );
}
