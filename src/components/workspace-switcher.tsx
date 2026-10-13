"use client";

import { useParams, useRouter } from "next/navigation";
import { accountTotal } from "@/lib/badges";
import { useBadges } from "./badges";
import { useLastWorkspace } from "./use-last-workspace";

type WorkspaceOption = { id: string; name: string; kind: "agency" | "client" };

export function WorkspaceSwitcher({ workspaces }: { workspaces: WorkspaceOption[] }) {
  const router = useRouter();
  const params = useParams<{ workspaceId?: string }>();
  const lastWorkspace = useLastWorkspace();
  const badges = useBadges();
  // A select can't hold a red bubble, so other accounts show their count in the name.
  const label = (w: WorkspaceOption) => {
    const n = accountTotal(badges.accounts[w.id]);
    return n > 0 && w.id !== current ? `${w.name} (${n > 99 ? "99+" : n})` : w.name;
  };
  const current = params.workspaceId ?? lastWorkspace ?? "";
  const agency = workspaces.filter((w) => w.kind === "agency");
  const clients = workspaces.filter((w) => w.kind === "client");

  return (
    <select
      aria-label="Switch account"
      value={workspaces.some((w) => w.id === current) ? current : ""}
      onChange={(e) => e.target.value && router.push(`/w/${e.target.value}`)}
      className="h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm font-medium focus:border-brand-500 focus:outline-none"
    >
      <option value="">Choose an account…</option>
      {agency.length > 0 && (
        <optgroup label="Your agency">
          {agency.map((w) => (
            <option key={w.id} value={w.id}>
              {label(w)}
            </option>
          ))}
        </optgroup>
      )}
      {clients.length > 0 && (
        <optgroup label="Clients">
          {clients.map((w) => (
            <option key={w.id} value={w.id}>
              {label(w)}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
