"use client";

import clsx from "clsx";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { BADGE_LABEL, type BadgeTab } from "@/lib/badges";
import { CountBubble, useBadges } from "./badges";
import { useLastWorkspace } from "./use-last-workspace";

/**
 * A sidebar link. `workspaceHref` links are relative to the account being
 * viewed (or the last one viewed, when on an agency page).
 */
export function NavLink({
  href,
  workspaceHref,
  exact,
  compact,
  badge: tab,
  children,
}: {
  href?: string;
  workspaceHref?: string;
  exact?: boolean;
  compact?: boolean;
  /** Which red count to show next to the link: an account tab, or the to-do list. */
  badge?: BadgeTab | "todos";
  children: React.ReactNode;
}) {
  const badges = useBadges();
  const pathname = usePathname();
  const params = useParams<{ workspaceId?: string }>();
  const lastWorkspace = useLastWorkspace();
  const workspaceId = params.workspaceId ?? lastWorkspace;

  let target = href;
  if (workspaceHref !== undefined) {
    if (!workspaceId) return null;
    target = `/w/${workspaceId}${workspaceHref}`;
  }
  if (!target) return null;

  const active = exact ? pathname === target : pathname === target || pathname.startsWith(`${target}/`);
  // "New since you looked" counts hide while you're looking; unread and due counts stay.
  const count = !tab
    ? 0
    : tab === "todos"
      ? badges.todos
      : active && tab !== "inbox"
        ? 0
        : (workspaceId && badges.accounts[workspaceId]?.[tab]) || 0;
  const label = tab === "todos" ? `${count} due` : tab ? BADGE_LABEL[tab](count) : "";
  return (
    <Link
      href={target}
      className={clsx(
        "flex items-center justify-between gap-2 rounded-lg text-sm font-medium transition-colors",
        compact ? "shrink-0 px-3 py-1.5" : "px-2 py-1.5",
        active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
      )}
    >
      {children}
      <CountBubble count={count} label={label} />
    </Link>
  );
}
