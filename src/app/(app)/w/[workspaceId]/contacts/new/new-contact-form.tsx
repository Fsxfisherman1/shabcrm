"use client";

import { useState } from "react";
import { createContactAction } from "@/actions/contacts";
import { ContactFields } from "@/components/contact-fields";
import { Button, Field, FormError, Input, Select } from "@/components/ui";
import { useActionForm } from "@/components/use-action-form";

export function NewContactForm({ workspaceId }: { workspaceId: string }) {
  const [state, onSubmit, pending] = useActionForm(createContactAction.bind(null, workspaceId));
  const [consent, setConsent] = useState("none");
  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <ContactFields />
      <div className="rounded-lg bg-slate-50 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Can we text them?" name="smsConsent">
            <Select id="smsConsent" name="smsConsent" value={consent} onChange={(e) => setConsent(e.target.value)}>
              <option value="none">No consent recorded yet</option>
              <option value="granted">Yes, they agreed to texts</option>
            </Select>
          </Field>
          {consent === "granted" && (
            <Field label="How did they agree?" name="smsConsentSource">
              <Input id="smsConsentSource" name="smsConsentSource" placeholder="e.g. Checked the box on our form" required />
            </Field>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Texts only go to contacts with consent on record. This protects you from TCPA complaints.
        </p>
      </div>
      <FormError message={state.error} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save contact"}
      </Button>
    </form>
  );
}
