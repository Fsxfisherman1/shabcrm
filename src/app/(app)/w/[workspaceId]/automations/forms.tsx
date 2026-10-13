"use client";

import { useState, useTransition } from "react";
import { createWorkflowAction } from "@/actions/workflows";
import { Button } from "@/components/ui";

export function NewWorkflow({ workspaceId, templates }: { workspaceId: string; templates: { key: string; name: string; description: string }[] }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <Button onClick={() => setOpen(true)}>New workflow</Button>
      {open && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[10vh]" onClick={() => setOpen(false)}>
          <div className="w-full max-w-2xl rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="New workflow">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Start a workflow</h2>
              <button className="text-sm text-slate-500 hover:text-slate-800" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            <p className="mb-4 text-sm text-slate-500">Pick a starting point. Everything can be changed, and it stays off until you turn it on.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {templates.map((t) => (
                <button
                  key={t.key}
                  disabled={pending}
                  onClick={() => startTransition(() => createWorkflowAction(workspaceId, t.key))}
                  className="rounded-lg border border-slate-200 p-4 text-left transition-colors hover:border-brand-500 hover:bg-brand-50 disabled:opacity-50"
                >
                  <div className="font-medium">{t.name}</div>
                  <div className="mt-1 text-sm text-slate-500">{t.description}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
