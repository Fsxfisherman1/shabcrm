"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { ActionState } from "@/actions/types";

/**
 * Submits a form to a server action. Unlike a plain `<form action>`, the
 * fields keep what the person typed when the action returns an error, and
 * are only cleared on success (when `resetOnSuccess` is set).
 */
export function useActionForm(
  action: (prev: ActionState, form: FormData) => Promise<ActionState>,
  { resetOnSuccess = false, onSuccess }: { resetOnSuccess?: boolean; onSuccess?: () => void } = {},
) {
  const [state, setState] = useState<ActionState>({});
  const [pending, startTransition] = useTransition();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    startTransition(async () => {
      const result = await action(state, data);
      setState(result ?? {});
      if (result?.ok) {
        if (resetOnSuccess) form.reset();
        onSuccess?.();
      }
    });
  }

  return [state, onSubmit, pending] as const;
}
