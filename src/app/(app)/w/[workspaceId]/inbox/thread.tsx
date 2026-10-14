"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { draftReplyAction } from "@/actions/ai";
import { markReadAction, sendMessageAction, simulateIncomingAction } from "@/actions/messaging";
import { Button, FormError, Input, Select, Textarea } from "@/components/ui";
import { useActionForm } from "@/components/use-action-form";
import { CHANNEL_DOT, CHANNEL_LABEL, type Channel } from "@/lib/channels";

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

const PLACEHOLDER: Record<Channel, string> = {
  sms: "Type a text…",
  imessage: "Type an iMessage…",
  whatsapp: "Type a WhatsApp message…",
  email: "Write an email…",
};

export function Composer({
  workspaceId,
  contactId,
  channels,
  defaultChannel,
  replySubject,
  canDraft,
}: {
  workspaceId: string;
  contactId: string;
  channels: { id: Channel; permission: Permission }[];
  defaultChannel: Channel;
  replySubject: string;
  canDraft: boolean;
}) {
  // Reply the way they last wrote, unless that's not allowed right now.
  const allowed = (id: Channel) => channels.find((c) => c.id === id)?.permission.allowed;
  const [channel, setChannel] = useState<Channel>(
    allowed(defaultChannel) ? defaultChannel : (channels.find((c) => c.permission.allowed)?.id ?? channels[0].id),
  );
  const [body, setBody] = useState("");
  const [state, onSubmit, pending] = useActionForm(sendMessageAction.bind(null, workspaceId, contactId), {
    onSuccess: () => setBody(""),
  });
  const permission = channels.find((c) => c.id === channel)?.permission ?? { allowed: false, reason: "Pick how to send it." };
  const [drafting, startDraft] = useTransition();
  const [draftError, setDraftError] = useState<string | null>(null);
  const draft = () =>
    startDraft(async () => {
      setDraftError(null);
      const res = await draftReplyAction(workspaceId, contactId, channel);
      if (res.draft) setBody(res.draft);
      else setDraftError(res.error ?? "Couldn't write a draft.");
    });

  return (
    <form onSubmit={onSubmit} className="space-y-2 border-t border-slate-200 p-4">
      <input type="hidden" name="channel" value={channel} />
      <div className="flex flex-wrap gap-1 text-sm" role="tablist" aria-label="Send as">
        {channels.map(({ id }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={channel === id}
            onClick={() => setChannel(id)}
            className={clsx(
              "flex items-center gap-1.5 rounded-md px-3 py-1",
              channel === id ? "bg-brand-50 font-medium text-brand-700" : "text-slate-500 hover:bg-slate-100",
            )}
          >
            <span className={clsx("h-1.5 w-1.5 rounded-full", CHANNEL_DOT[id])} />
            {CHANNEL_LABEL[id]}
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
            placeholder={PLACEHOLDER[channel]}
            aria-label="Message"
          />
          <FormError message={state.error ?? draftError} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-400">
              {channel === "sms" && body.length > 0 && `${body.length} characters · ${Math.ceil(body.length / 160)} text${body.length > 160 ? "s" : ""}`}
            </span>
            <div className="flex gap-2">
              {canDraft && (
                <Button type="button" variant="ghost" disabled={drafting || pending} onClick={draft}>
                  {drafting ? "Writing…" : body.trim() ? "Redo with AI" : "Draft with AI"}
                </Button>
              )}
              <Button type="submit" disabled={pending || !body.trim()}>
                {pending ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
        </>
      )}
    </form>
  );
}

type SimKind = "text" | "imessage" | "whatsapp" | "email" | "call";
const SIM_LABEL: Record<SimKind, string> = {
  text: "They text you",
  imessage: "They iMessage you",
  whatsapp: "They message you on WhatsApp",
  email: "They email you",
  call: "They call and you miss it",
};

export function SimulateIncoming({ workspaceId, kinds, hasNumber }: { workspaceId: string; kinds: readonly SimKind[]; hasNumber: boolean }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<SimKind>(kinds[0] ?? "text");
  const [state, onSubmit, pending] = useActionForm(simulateIncomingAction.bind(null, workspaceId), { resetOnSuccess: true });

  if (!kinds.length) return null;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-2 font-medium underline">
        Pretend a customer messaged you
      </button>
    );
  }
  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-2">
      {!hasNumber && (kind === "text" || kind === "call") && (
        <p>Add a texting number in Settings first. In test mode any number works, like (415) 555-0100.</p>
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value as SimKind)} aria-label="What happens">
          {kinds.map((k) => (
            <option key={k} value={k}>
              {SIM_LABEL[k]}
            </option>
          ))}
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
