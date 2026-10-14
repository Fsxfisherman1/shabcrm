import type { Metadata } from "next";
import clsx from "clsx";
import Link from "next/link";
import { db } from "@/db";
import { Badge, Card, PageHeader } from "@/components/ui";
import { contactName } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { requireWorkspace } from "@/lib/session";
import { INTENT_LABEL, isIntent } from "@/lib/ai";
import { getAiSettings } from "@/server/ai";
import { getConversation, isStopWord, listConversations } from "@/server/messaging";
import { messagingConfig } from "@/server/messaging/config";
import type { Message } from "@/db/schema";
import { CHANNEL_BUBBLE, CHANNEL_DOT, CHANNEL_LABEL, CHANNELS, type Channel } from "@/lib/channels";
import { AutoRefresh, Composer, MarkRead, SimulateIncoming } from "./thread";

export const metadata: Metadata = { title: "Inbox" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ c?: string; filter?: string; ch?: string }>;
}) {
  const { workspaceId } = await params;
  const { c, filter, ch } = await searchParams;
  const { workspace } = await requireWorkspace(workspaceId);
  const unreadOnly = filter === "unread";
  const channel = CHANNELS.find((x) => x === ch);
  const conversations = await listConversations(db, workspaceId, { unreadOnly, channel });
  const convo = c && UUID.test(c) ? await getConversation(db, workspaceId, c) : null;
  const config = messagingConfig();
  const ai = await getAiSettings(db, workspaceId);
  // With speed-to-lead alerts on, conversations past the limit say how long they've waited.
  const alertAfterMs = workspace.leadAlertMinutes ? workspace.leadAlertMinutes * 60_000 : null;
  const loadedAt = new Date();
  // Text and email are always offered; WhatsApp and iMessage once the account has a number for them.
  const channels = CHANNELS.filter(
    (x) => (x !== "whatsapp" || workspace.whatsappNumber) && (x !== "imessage" || workspace.imessageNumber),
  );
  const connected: Record<Channel, boolean> = {
    sms: Boolean(config.twilio),
    whatsapp: Boolean(config.twilio),
    imessage: Boolean(config.sendblue),
    email: Boolean(config.postmark),
  };
  const notConnected = channels.filter((x) => !connected[x]);
  const base = `/w/${workspaceId}/inbox`;
  const query = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ filter: unreadOnly ? "unread" : undefined, ch: channel, ...extra })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader title="Inbox" description="Texts, iMessages, WhatsApp and email with your contacts, in one place." />

      {notConnected.length > 0 && (
        <Card className="mb-4 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p>
            <strong>Test mode.</strong> {listOf(notConnected.map((x) => (x === "sms" ? "Texting" : CHANNEL_LABEL[x])))}{" "}
            {notConnected.length === 1 ? "isn't" : "aren't"} connected yet, so those messages don&apos;t actually go out. They&apos;re saved here so you
            can try everything out.
          </p>
          <SimulateIncoming
            workspaceId={workspaceId}
            kinds={[
              ...(!connected.sms ? (["text", "call"] as const) : []),
              ...(!connected.imessage && workspace.imessageNumber ? (["imessage"] as const) : []),
              ...(!connected.whatsapp && workspace.whatsappNumber ? (["whatsapp"] as const) : []),
              ...(!connected.email ? (["email"] as const) : []),
            ]}
            hasNumber={Boolean(workspace.smsNumber)}
          />
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-[320px_1fr]">
        <Card className={clsx("overflow-hidden", convo && "hidden md:block")}>
          <div className="space-y-1 border-b border-slate-200 p-2 text-sm">
            <div className="flex gap-1">
              <Link href={query({ filter: "" })} className={clsx("rounded-md px-3 py-1", !unreadOnly ? "bg-slate-100 font-medium" : "text-slate-500")}>
                All
              </Link>
              <Link href={query({ filter: "unread" })} className={clsx("rounded-md px-3 py-1", unreadOnly ? "bg-slate-100 font-medium" : "text-slate-500")}>
                Unread
              </Link>
            </div>
            <nav aria-label="Channel" className="flex flex-wrap gap-1">
              <Link href={query({ ch: "" })} className={clsx("rounded-full px-2.5 py-0.5 text-xs", !channel ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600")}>
                Every channel
              </Link>
              {channels.map((x) => (
                <Link
                  key={x}
                  href={query({ ch: x })}
                  aria-current={channel === x ? "true" : undefined}
                  className={clsx(
                    "flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs",
                    channel === x ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600",
                  )}
                >
                  <span className={clsx("h-1.5 w-1.5 rounded-full", CHANNEL_DOT[x])} />
                  {CHANNEL_LABEL[x]}
                </Link>
              ))}
            </nav>
          </div>
          {conversations.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-500">
              {unreadOnly
                ? "You're all caught up."
                : channel
                  ? `No ${CHANNEL_LABEL[channel]} conversations yet.`
                  : "No conversations yet. Open a contact and press Message to start one."}
            </p>
          ) : (
            <ul className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">
              {conversations.map((row) => {
                const name = contactName({ firstName: row.first_name, lastName: row.last_name, email: row.email, phone: formatPhone(row.phone) });
                const waitedMs = loadedAt.getTime() - row.created_at.getTime();
                const waiting = alertAfterMs !== null && row.direction === "inbound" && !isStopWord(row.body) && waitedMs >= alertAfterMs;
                return (
                  <li key={row.contact_id}>
                    <Link
                      href={query({ c: row.contact_id })}
                      className={clsx("block px-4 py-3 hover:bg-slate-50", row.contact_id === convo?.contact.id && "bg-brand-50")}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={clsx("truncate text-sm", row.unread ? "font-semibold" : "font-medium")}>{name}</span>
                        <span className="shrink-0 text-xs text-slate-400">{shortTime(row.created_at)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <span className={clsx("h-2 w-2 shrink-0 rounded-full", CHANNEL_DOT[row.channel])} title={CHANNEL_LABEL[row.channel]} />
                        <span className="sr-only">{CHANNEL_LABEL[row.channel]}:</span>
                        <span className={clsx("truncate text-sm", row.unread ? "text-slate-900" : "text-slate-500")}>
                          {row.direction === "outbound" && "You: "}
                          {row.body}
                        </span>
                        {row.unread > 0 && (
                          <span className="ml-auto shrink-0 rounded-full bg-brand-600 px-1.5 text-xs font-medium text-white">{row.unread}</span>
                        )}
                      </div>
                      {(waiting || (row.direction === "inbound" && isIntent(row.intent))) && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {waiting && <Badge tone="red">Waiting {waitedFor(waitedMs)}</Badge>}
                          {row.direction === "inbound" && isIntent(row.intent) && <Badge tone="brand">{INTENT_LABEL[row.intent]}</Badge>}
                        </div>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {convo ? (
          <Card className="flex min-h-[60vh] flex-col">
            <MarkRead workspaceId={workspaceId} contactId={convo.contact.id} unread={convo.messages.some((m) => m.direction === "inbound" && !m.readAt)} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 px-5 py-3">
              <Link href={query({})} className="text-sm text-slate-500 md:hidden">
                ←
              </Link>
              <Link href={`/w/${workspaceId}/contacts/${convo.contact.id}`} className="font-semibold hover:underline">
                {contactName({ ...convo.contact, phone: formatPhone(convo.contact.phone) })}
              </Link>
              <span className="text-sm text-slate-500">
                {[formatPhone(convo.contact.phone), convo.contact.email].filter(Boolean).join(" · ")}
              </span>
              {convo.contact.smsConsent === "revoked" && <Badge tone="red">Opted out of texts</Badge>}
            </div>
            <ol className="flex max-h-[55vh] flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
              {convo.messages.length === 0 && <li className="m-auto text-sm text-slate-400">No messages yet. Say hello below.</li>}
              {convo.messages.map((m) => (
                <Bubble key={m.id} message={m} />
              ))}
            </ol>
            <Composer
              key={convo.contact.id}
              workspaceId={workspaceId}
              contactId={convo.contact.id}
              channels={channels.map((x) => ({
                id: x,
                permission:
                  x === "email"
                    ? !convo.contact.email
                      ? { allowed: false, reason: "This contact has no email address." }
                      : convo.contact.emailOptOut
                        ? { allowed: false, reason: "This contact unsubscribed from email." }
                        : { allowed: true }
                    : convo.permissions[x].allowed
                      ? { allowed: true }
                      : { allowed: false, reason: convo.permissions[x].reason },
              }))}
              defaultChannel={convo.messages.at(-1)?.channel ?? (convo.contact.phone ? "sms" : "email")}
              replySubject={replySubject(convo.messages)}
              canDraft={Boolean(ai)}
            />
          </Card>
        ) : (
          <Card className="hidden min-h-[60vh] items-center justify-center text-sm text-slate-400 md:flex">
            Pick a conversation to read it.
          </Card>
        )}
      </div>
    </>
  );
}

function Bubble({ message: m }: { message: Message }) {
  const outbound = m.direction === "outbound";
  return (
    <li className={clsx("flex max-w-[80%] flex-col", outbound ? "items-end self-end" : "items-start self-start")}>
      <div
        className={clsx(
          "whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm",
          outbound ? CHANNEL_BUBBLE[m.channel] : "bg-slate-100 text-slate-900",
          m.status === "failed" && "bg-red-100 text-red-900",
        )}
      >
        {m.subject && <div className="mb-1 font-semibold">{m.subject}</div>}
        {m.body}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-slate-400">
        {!outbound && isIntent(m.intent) && <Badge tone="brand">{INTENT_LABEL[m.intent]}</Badge>}
        {CHANNEL_LABEL[m.channel]} · {shortTime(m.createdAt)}
        {outbound && ` · ${STATUS[m.status]}`}
        {m.status === "failed" && m.error && <span className="text-red-600"> ({m.error})</span>}
      </div>
    </li>
  );
}

const STATUS: Record<string, string> = { queued: "Sending", sent: "Sent", delivered: "Delivered", failed: "Not delivered", received: "" };

function replySubject(messages: Message[]) {
  const last = messages.findLast((m) => m.channel === "email" && m.subject);
  if (!last?.subject) return "";
  return /^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`;
}

function waitedFor(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

function listOf(items: string[]) {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function shortTime(d: Date) {
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
