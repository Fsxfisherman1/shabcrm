"use client";

import { useEffect, useRef } from "react";
import type { FormField } from "@/db/schema";
import { submitFormAction } from "@/actions/forms";
import { Button, FormError, Input, Label, Select, Textarea } from "@/components/ui";
import { useActionForm } from "@/components/use-action-form";

const INPUT: Partial<Record<FormField["kind"], { type: string; autoComplete: string }>> = {
  first_name: { type: "text", autoComplete: "given-name" },
  last_name: { type: "text", autoComplete: "family-name" },
  full_name: { type: "text", autoComplete: "name" },
  email: { type: "email", autoComplete: "email" },
  phone: { type: "tel", autoComplete: "tel" },
  company: { type: "text", autoComplete: "organization" },
};

export function PublicForm({
  slug,
  embed,
  title,
  description,
  fields,
  submitLabel,
  thankYou,
  smsConsentText,
}: {
  slug: string;
  embed: boolean;
  title: string;
  description: string;
  fields: FormField[];
  submitLabel: string;
  thankYou: string;
  smsConsentText: string | null;
}) {
  const [state, onSubmit, pending] = useActionForm(submitFormAction.bind(null, slug));
  const pageInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  // When embedded, remember which page it was on and tell the page how tall to make the frame.
  useEffect(() => {
    if (!embed) return;
    if (pageInput.current) pageInput.current.value = document.referrer;
    const send = () => window.parent.postMessage({ shabcrmForm: slug, height: document.documentElement.scrollHeight }, "*");
    send();
    const observer = new ResizeObserver(send);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [embed, slug]);

  useEffect(() => {
    if (!state.ok || !state.message) return;
    try {
      (window.top ?? window).location.href = state.message;
    } catch {
      window.location.href = state.message;
    }
  }, [state]);

  return (
    <div ref={box}>
      {state.ok ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center">
          <p className="whitespace-pre-wrap text-lg font-medium text-emerald-900">{state.message ? "Thanks!" : thankYou}</p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{description}</p>}
          </div>
          {fields.map((f) => {
            const id = `field_${f.id}`;
            const label = (
              <Label htmlFor={id}>
                {f.label}
                {f.required && <span className="text-red-600"> *</span>}
              </Label>
            );
            if (f.kind === "textarea")
              return (
                <div key={f.id}>
                  {label}
                  <Textarea id={id} name={id} rows={4} required={f.required} maxLength={5000} />
                </div>
              );
            if (f.kind === "select")
              return (
                <div key={f.id}>
                  {label}
                  <Select id={id} name={id} required={f.required} defaultValue="">
                    <option value="">Choose…</option>
                    {f.options?.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            return (
              <div key={f.id}>
                {label}
                <Input id={id} name={id} required={f.required} maxLength={500} {...(INPUT[f.kind] ?? { type: "text" })} />
              </div>
            );
          })}
          {smsConsentText && (
            <label className="flex gap-2 text-xs text-slate-600">
              <input type="checkbox" name="smsOptIn" className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600" />
              <span>{smsConsentText}</span>
            </label>
          )}
          {/* Bots fill in every field; people never see this one. */}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden className="hidden" />
          <input type="hidden" name="page" ref={pageInput} />
          <FormError message={state.error} />
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Sending…" : submitLabel}
          </Button>
        </form>
      )}
    </div>
  );
}
