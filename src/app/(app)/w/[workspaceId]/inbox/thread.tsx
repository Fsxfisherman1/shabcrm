"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { markReadAction, sendMessageAction, simulateIncomingAction } from "@/actions/messaging";
import { Button, FormError, Input, Select, Textarea } from "@/components/ui";
import { useActionForm } from "@/components/use-action-form";

/** Re-fetches the page every few seconds so new messages show up. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

export function MarkRead({ workspaceId, contactId, unread }: { workspaceId: string; contactId: string; unread: boolean }) {
  useEffect(() => {
    if (unread) void markReadAction(workspaceId, contactId);
  }, [workspaceId, contactId, unread]);
  return null;
}

type Permission = { allowed: true } | { allowed: false; reason: string };

export function Composer({
  workspaceId,
  contactId,
  sms,
  email,
  defaultChannel,
  replySubject,
}: {
  workspaceId: string;
  contactId: string;
  sms: Permission;
  email: Permission;
  defaultChannel: "sms" | "email";
  replySubject: string;
}) {
  const [channel, setChannel] = useState<"sms" | "email">(
    defaultChannel === "sms" && !sms.allowed && email.allowed ? "email" : defaultChannel === "email" && !email.allowed ? "sms" : defaultChannel,
  );
  const [body, setBody] = useState("");
  const [state, onSubmit, pending] = useActionForm(sendMessageAction.bind(null, workspaceId, contactId), {
    onSuccess: () => setBody(""),
  });
  const permission = channel === "sms" ? sms : email;

  return (
    <form onSubmit={onSubmit} className="space-y-2 border-t border-slate-200 p-4">
      <input type="hidden" name="channel" value={channel} />
      <div className="flex gap-1 text-sm" role="tablist">
        {(["sms", "email"] as const).map((ch) => (
          <button
            key={ch}
            type="button"
            role="tab"
            aria-selected={channel === ch}
            onClick={() => setChannel(ch)}
            className={clsx("rounded-md px-3 py-1", channel === ch ? "bg-brand-50 font-medium text-brand-700" : "text-slate-500 hover:bg-slate-100")}
          >
            {ch === "sms" ? "Text" : "Email"}
          </button>
        ))}
      </div>
      {!permission.allowed ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{permission.reason}</p>
      ) : (
        <>
          {channel === "email" && <Input name="subject" placeholder="Subject" aria-label="Subject" defaultValue={replySubject} />}
          <Textarea
            name="body"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
            }}
            placeholder={channel === "sms" ? "Type a text…" : "Write an email…"}
            aria-label="Message"
          />
          <FormError message={state.error} />
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">
              {channel === "sms" && body.length > 0 && `${body.length} characters · ${Math.ceil(body.length / 160)} text${body.length > 160 ? "s" : ""}`}
            </span>
            <Button type="submit" disabled={pending || !body.trim()}>
              {pending ? "Sending…" : "Send"}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

export function SimulateIncoming({ workspaceId, hasNumber }: { workspaceId: string; hasNumber: boolean }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("text");
  const [state, onSubmit, pending] = useActionForm(simulateIncomingAction.bind(null, workspaceId), { resetOnSuccess: true });

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-2 font-medium underline">
        Pretend a customer messaged you
      </button>
    );
  }
  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-2">
      {!hasNumber && kind !== "email" && (
        <p>Add a texting number in Settings first. In test mode any number works, like (415) 555-0100.</p>
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="What happens">
          <option value="text">They text you</option>
          <option value="email">They email you</option>
          <option value="call">They call and you miss it</option>
        </Select>
        <Input
          name="from"
          aria-label="From"
          placeholder={kind === "email" ? "customer@example.com" : "Their phone number"}
        />
        {kind === "email" && <Input name="subject" aria-label="Email subject" placeholder="Subject" />}
      </div>
      {kind !== "call" && <Textarea name="body" rows={2} aria-label="What they say" placeholder="What they say" />}
      <FormError message={state.error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          Simulate
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}
