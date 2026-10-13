"use client";

import clsx from "clsx";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
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
  badges,
  children,
}: {
  href?: string;
  workspaceHref?: string;
  exact?: boolean;
  compact?: boolean;
  /** Unread counts by account id, shown next to the link. */
  badges?: Record<string, number>;
  children: React.ReactNode;
}) {
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

  const badge = workspaceId ? (badges?.[workspaceId] ?? 0) : 0;
  const active = exact ? pathname === target : pathname === target || pathname.startsWith(`${target}/`);
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
      {badge > 0 && (
        <span className="rounded-full bg-brand-600 px-1.5 text-xs font-medium text-white" aria-label={`${badge} unread`}>
          {badge}
        </span>
      )}
    </Link>
  );
}
