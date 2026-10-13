"use client";

import { useTransition } from "react";
import { createFormAction } from "@/actions/forms";
import { Button } from "@/components/ui";

export function NewFormButton({ workspaceId }: { workspaceId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button disabled={pending} onClick={() => startTransition(() => createFormAction(workspaceId))}>
      New form
    </Button>
  );
}
