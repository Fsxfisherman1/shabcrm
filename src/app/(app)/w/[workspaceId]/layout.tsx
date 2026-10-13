import { requireWorkspace } from "@/lib/session";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { workspace } = await requireWorkspace(workspaceId);
  return (
    <>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
        {workspace.kind === "agency" ? "Your agency" : "Client"} · {workspace.name}
      </div>
      {children}
    </>
  );
}
