import Link from "next/link";
import { db } from "@/db";
import { getCurrentUser } from "@/lib/session";
import { unreadCount } from "@/server/messaging";
import { listWorkspacesForUser } from "@/server/workspaces";
import { NavLink } from "./nav-link";
import { SignOutButton } from "./sign-out-button";
import { WorkspaceSwitcher } from "./workspace-switcher";

export async function Shell({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const workspaces = await listWorkspacesForUser(db, user.id);
  const unread = Object.fromEntries(await Promise.all(workspaces.map(async (w) => [w.id, await unreadCount(db, w.id)] as const)));

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <Link href="/agency" className="flex items-center gap-2 px-5 py-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            S
          </span>
          <span className="font-semibold">ShabCRM</span>
        </Link>

        <div className="px-3">
          <WorkspaceSwitcher workspaces={workspaces.map(({ id, name, kind }) => ({ id, name, kind }))} />
        </div>

        <nav className="mt-4 flex-1 space-y-6 overflow-y-auto px-3">
          <WorkspaceNav unread={unread} />
          <div>
            <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Agency</div>
            <NavLink href="/agency" exact>
              All accounts
            </NavLink>
            <NavLink href="/todos">To-do</NavLink>
          </div>
        </nav>

        <div className="border-t border-slate-200 px-5 py-4">
          <div className="truncate text-sm font-medium">{user.name}</div>
          <div className="truncate text-xs text-slate-500">{user.email}</div>
          <SignOutButton />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <MobileBar workspaces={workspaces.map(({ id, name, kind }) => ({ id, name, kind }))} unread={unread} />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}

function WorkspaceNav({ unread }: { unread: Record<string, number> }) {
  return (
    <div>
      <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-slate-400">This account</div>
      <NavLink workspaceHref="" exact>
        Overview
      </NavLink>
      <NavLink workspaceHref="/inbox" badges={unread}>
        Inbox
      </NavLink>
      <NavLink workspaceHref="/contacts">Contacts</NavLink>
      <NavLink workspaceHref="/pipeline">Pipeline</NavLink>
      <NavLink workspaceHref="/settings">Settings</NavLink>
    </div>
  );
}

function MobileBar({
  workspaces,
  unread,
}: {
  workspaces: { id: string; name: string; kind: "agency" | "client" }[];
  unread: Record<string, number>;
}) {
  return (
    <div className="border-b border-slate-200 bg-white px-4 py-3 md:hidden">
      <div className="mb-2 flex items-center justify-between">
        <Link href="/agency" className="font-semibold">
          ShabCRM
        </Link>
        <Link href="/todos" className="text-sm text-slate-600">
          To-do
        </Link>
      </div>
      <WorkspaceSwitcher workspaces={workspaces} />
      <div className="mt-2 flex gap-1 overflow-x-auto">
        <NavLink workspaceHref="" exact compact>
          Overview
        </NavLink>
        <NavLink workspaceHref="/inbox" compact badges={unread}>
          Inbox
        </NavLink>
        <NavLink workspaceHref="/contacts" compact>
          Contacts
        </NavLink>
        <NavLink workspaceHref="/pipeline" compact>
          Pipeline
        </NavLink>
        <NavLink workspaceHref="/settings" compact>
          Settings
        </NavLink>
      </div>
    </div>
  );
}
