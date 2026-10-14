export type Channel = "sms" | "imessage" | "whatsapp" | "email";

/** Order channels appear in the inbox. */
export const CHANNELS: Channel[] = ["sms", "imessage", "whatsapp", "email"];

export const CHANNEL_LABEL: Record<Channel, string> = { sms: "Text", imessage: "iMessage", whatsapp: "WhatsApp", email: "Email" };

/** Outgoing bubble colors, so a glance tells you which app a message went through. */
export const CHANNEL_BUBBLE: Record<Channel, string> = {
  sms: "bg-brand-600 text-white",
  imessage: "bg-sky-500 text-white",
  whatsapp: "bg-emerald-600 text-white",
  email: "bg-slate-700 text-white",
};

export const CHANNEL_DOT: Record<Channel, string> = {
  sms: "bg-brand-500",
  imessage: "bg-sky-500",
  whatsapp: "bg-emerald-500",
  email: "bg-slate-500",
};
