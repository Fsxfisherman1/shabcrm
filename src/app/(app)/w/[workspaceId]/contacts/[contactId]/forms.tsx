"use client";

import { useState, useTransition } from "react";
import { createAppointmentAction } from "@/actions/calendar";
import { addNoteAction, deleteContactAction, setConsentAction, updateContactAction } from "@/actions/contacts";
import { ContactFields } from "@/components/contact-fields";
import { Button, FormError, Input, Select, Textarea } from "@/components/ui";
import { useActionForm } from "@/components/use-action-form";
import type { Contact } from "@/db/schema";

export function NoteForm({ workspaceId, contactId }: { workspaceId: string; contactId: string }) {
  const [state, onSubmit, pending] = useActionForm(addNoteAction.bind(null, workspaceId, contactId), {
    resetOnSuccess: true,
  });
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <Textarea name="body" rows={2} placeholder="Add a note…" aria-label="Note" />
      <FormError message={state.error} />
      <Button type="submit" size="sm" disabled={pending}>
        Add note
      </Button>
    </form>
  );
}

export function EditContactForm({ workspaceId, contact }: { workspaceId: string; contact: Contact }) {
  const [state, onSubmit, pending] = useActionForm(updateContactAction.bind(null, workspaceId, contact.id));
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <ContactFields contact={contact} />
      <FormError message={state.error} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        {state.ok && <span className="text-sm text-emerald-600">{state.message}</span>}
      </div>
    </form>
  );
}

export function ConsentForm({
  workspaceId,
  contactId,
  current,
}: {
  workspaceId: string;
  contactId: string;
  current: "granted" | "none" | "revoked";
}) {
  const [state, onSubmit, pending] = useActionForm(setConsentAction.bind(null, workspaceId, contactId));
  const [value, setValue] = useState<string>(current);
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <Select name="smsConsent" value={value} onChange={(e) => setValue(e.target.value)} aria-label="SMS consent">
        <option value="none">No consent recorded</option>
        <option value="granted">Agreed to texts</option>
        <option value="revoked">Opted out (never text)</option>
      </Select>
      {value === "granted" && current !== "granted" && (
        <Input name="smsConsentSource" placeholder="How did they agree?" aria-label="How they agreed" />
      )}
      <FormError message={state.error} />
      {value !== current && (
        <Button type="submit" size="sm" disabled={pending}>
          Update consent
        </Button>
      )}
    </form>
  );
}

export function DeleteContactButton({ workspaceId, contactId }: { workspaceId: string; contactId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="danger"
      size="sm"
      disabled={pending}
      onClick={() => {
        if (confirm("Delete this contact and their history? This can't be undone.")) {
          startTransition(() => deleteContactAction(workspaceId, contactId));
        }
      }}
    >
      Delete contact
    </Button>
  );
}

export function AppointmentForm({
  workspaceId,
  contactId,
  defaultTitle,
  defaultMinutes,
}: {
  workspaceId: string;
  contactId: string;
  defaultTitle: string;
  defaultMinutes: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, onSubmit, pending] = useActionForm(createAppointmentAction.bind(null, workspaceId, contactId), {
    onSuccess: () => setOpen(false),
  });
  if (!open) {
    return (
      <>
        {state.ok && <p className="mb-2 text-sm text-emerald-600">{state.message}</p>}
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Book appointment
        </Button>
      </>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <Input name="title" aria-label="Appointment title" defaultValue={defaultTitle} required />
      <div className="grid grid-cols-2 gap-2">
        <Input name="date" type="date" aria-label="Date" required />
        <Input name="time" type="time" aria-label="Time" step={300} required />
      </div>
      <Select name="durationMinutes" aria-label="Length" defaultValue={String(defaultMinutes)}>
        {[...new Set([15, 30, 45, 60, 90, 120, defaultMinutes])].sort((a, b) => a - b).map((m) => (
          <option key={m} value={m}>
            {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}
          </option>
        ))}
      </Select>
      <FormError message={state.error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          Book
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
