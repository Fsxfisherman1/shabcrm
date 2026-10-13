"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { Badges } from "@/lib/badges";

const BadgeContext = createContext<Badges>({ accounts: {}, todos: 0 });

export const useBadges = () => useContext(BadgeContext);

/**
 * Holds the sidebar's red counts. Starts with the counts the server rendered,
 * then refreshes on every page change and every 20 seconds while visible.
 */
export function BadgeProvider({ initial, children }: { initial: Badges; children: React.ReactNode }) {
  const [badges, setBadges] = useState(initial);
  const pathname = usePathname();
  // A server refresh (after sending, reading, saving…) brings fresh counts down as props.
  const [lastInitial, setLastInitial] = useState(initial);
  if (initial !== lastInitial) {
    setLastInitial(initial);
    setBadges(initial);
  }

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const res = await fetch("/api/badges", { cache: "no-store" }).catch(() => null);
      if (res?.ok && !stopped) setBadges(await res.json());
    };
    void load();
    const id = setInterval(load, 20_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", load);
    };
  }, [pathname]);

  return <BadgeContext value={badges}>{children}</BadgeContext>;
}

export function CountBubble({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span
      className="min-w-5 rounded-full bg-red-600 px-1.5 text-center text-xs font-semibold leading-5 text-white tabular-nums"
      aria-label={label}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
