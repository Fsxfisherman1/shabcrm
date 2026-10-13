"use client";

import { useParams } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

const KEY = "shabcrm:last-workspace";
const listeners = new Set<() => void>();

function read() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Remembers the last account viewed so the sidebar can link back to it. */
export function useLastWorkspace() {
  const params = useParams<{ workspaceId?: string }>();
  useEffect(() => {
    if (!params.workspaceId) return;
    try {
      localStorage.setItem(KEY, params.workspaceId);
    } catch {}
    listeners.forEach((l) => l());
  }, [params.workspaceId]);

  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => null,
  );
}
