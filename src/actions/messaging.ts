"use server";

import { refresh } from "next/cache";
import { db } from "@/db";
import { normalizePhone } from "@/lib/phone";
import { requireWorkspace } from "@/lib/session";
import {
  handleCallEnded,
  markConversationRead,
  MessagingError,
  receiveEmail,
  receivePhoneMessage,
  sendMessage,
  type Channel,
  updateMessagingSettings,
} from "@/server/messaging";
import { allProviders, messagingConfig, replyToAddress } from "@/server/messaging/config";
import type { ActionState } from "./types";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const providers = allProviders;
const CHANNELS = new Set<Channel>(["sms", "email", "whatsapp", "imessage"]);

export async function sendMessageAction(workspaceId: string, contactId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { user } = await requireWorkspace(workspaceId);
  const config = messagingConfig();
  const raw = String(form.get("channel") ?? "sms") as Channel;
  const channel = CHANNELS.has(raw) ? raw : "sms";
  try {
    const message = await sendMessage(
      db,
      workspaceId,
      { contactId, channel, body: String(form.get("body") ?? ""), subject: String(form.get("subject") ?? "") },
      user.id,
      providers(),
      // Delivery updates only make sense once Twilio or Sendblue can reach us.
      { appUrl: config.twilio || config.sendblue ? config.appUrl : undefined, replyTo: replyToAddress(workspaceId) },
    );
    refresh();
    if (message.status === "failed") return { error: `Couldn't send: ${message.error}` };
    return { ok: true };
  } catch (err) {
    if (err instanceof MessagingError) return { error: err.message };
    throw err;
  }
}

export async function markReadAction(workspaceId: string, contactId: string) {
  await requireWorkspace(workspaceId);
  await markConversationRead(db, workspaceId, contactId);
  refresh();
}

export async function updateMessagingSettingsAction(workspaceId: string, _: ActionState, form: FormData): Promise<ActionState> {
  await requireWorkspace(workspaceId);
  const rawSms = String(form.get("smsNumber") ?? "").trim();
  const rawForward = String(form.get("forwardCallsTo") ?? "").trim();
  const rawWhatsApp = String(form.get("whatsappNumber") ?? "").trim();
  const rawIMessage = String(form.get("imessageNumber") ?? "").trim();
  const smsNumber = normalizePhone(rawSms);
  const forwardCallsTo = normalizePhone(rawForward);
  const whatsappNumber = normalizePhone(rawWhatsApp);
  const imessageNumber = normalizePhone(rawIMessage);
  if (rawSms && !smsNumber) return { error: "The texting number doesn't look right." };
  if (rawWhatsApp && !whatsappNumber) return { error: "The WhatsApp number doesn't look right." };
  if (rawIMessage && !imessageNumber) return { error: "The iMessage number doesn't look right." };
  if (rawForward && !forwardCallsTo) return { error: "The forward-calls-to number doesn't look right." };
  const emailFromAddress = String(form.get("emailFromAddress") ?? "").trim().toLowerCase();
  if (emailFromAddress && !EMAIL.test(emailFromAddress)) return { error: "The from email address doesn't look right." };
  const missedCallText = String(form.get("missedCallText") ?? "").trim();
  if (!missedCallText) return { error: "Write the missed-call text." };
  if (missedCallText.length > 320) return { error: "Keep the missed-call text under 320 characters." };

  try {
    await updateMessagingSettings(db, workspaceId, {
      smsNumber,
      forwardCallsTo,
      missedCallTextEnabled: form.get("missedCallTextEnabled") === "on",
      missedCallText,
      emailFromName: String(form.get("emailFromName") ?? "").trim() || null,
      emailFromAddress: emailFromAddress || null,
      whatsappNumber,
      imessageNumber,
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    if (cause?.code === "23505") {
      const which = cause.constraint?.includes("whatsapp") ? "WhatsApp" : cause.constraint?.includes("imessage") ? "iMessage" : "texting";
      return { error: `Another account already uses that ${which} number.` };
    }
    throw err;
  }
  refresh();
  return { ok: true, message: "Saved." };
}

/**
 * Test mode only: pretend a customer texted, emailed, called or messaged on
 * WhatsApp or iMessage, so the inbox can be tried before accounts are connected.
 */
export async function simulateIncomingAction(workspaceId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { workspace } = await requireWorkspace(workspaceId);
  const kind = String(form.get("kind") ?? "text");
  const from = String(form.get("from") ?? "").trim();
  const body = String(form.get("body") ?? "").trim();
  const config = messagingConfig();

  if (kind === "email") {
    if (config.postmark) return { error: "Email is connected, so send a real email instead." };
    if (!EMAIL.test(from)) return { error: "Enter the email address it comes from." };
    if (!body) return { error: "Write the email." };
    await receiveEmail(db, { workspaceId, from, subject: String(form.get("subject") ?? "") || "Question", text: body });
  } else if (kind === "whatsapp" || kind === "imessage") {
    const name = kind === "whatsapp" ? "WhatsApp" : "iMessage";
    const to = kind === "whatsapp" ? workspace.whatsappNumber : workspace.imessageNumber;
    if (kind === "whatsapp" ? config.twilio : config.sendblue) return { error: `${name} is connected, so send a real message instead.` };
    if (!to) return { error: `Add a ${name} number in Settings first. Any number works in test mode.` };
    if (!normalizePhone(from)) return { error: "Enter the phone number it comes from." };
    if (!body) return { error: "Write the message." };
    await receivePhoneMessage(db, { channel: kind, from, to, body });
  } else {
    if (config.twilio) return { error: "Texting is connected, so send a real text instead." };
    if (!workspace.smsNumber) return { error: "Add a texting number in Settings first. Any number works in test mode." };
    if (!normalizePhone(from)) return { error: "Enter the phone number it comes from." };
    if (kind === "call") {
      await handleCallEnded(db, { to: workspace.smsNumber, from, dialStatus: "no-answer" }, providers());
    } else {
      if (!body) return { error: "Write the text." };
      await receivePhoneMessage(db, { channel: "sms", from, to: workspace.smsNumber, body });
    }
  }
  refresh();
  return { ok: true };
}
