/** Tabs whose count is "new since you last looked". */
export const SEEN_TABS = ["contacts", "calendar", "pipeline", "forms", "automations"] as const;
export type SeenTab = (typeof SEEN_TABS)[number];
export type BadgeTab = SeenTab | "inbox";

export type WorkspaceBadges = Record<BadgeTab, number>;
export type Badges = { accounts: Record<string, WorkspaceBadges>; todos: number };

export const BADGE_LABEL: Record<BadgeTab, (n: number) => string> = {
  inbox: (n) => `${n} unread`,
  contacts: (n) => `${n} new contact${n === 1 ? "" : "s"}`,
  calendar: (n) => `${n} new booking${n === 1 ? "" : "s"}`,
  pipeline: (n) => `${n} new deal${n === 1 ? "" : "s"}`,
  forms: (n) => `${n} new response${n === 1 ? "" : "s"}`,
  automations: (n) => `${n} failed run${n === 1 ? "" : "s"}`,
};

export const accountTotal = (b: WorkspaceBadges | undefined) => (b ? Object.values(b).reduce((a, n) => a + n, 0) : 0);
