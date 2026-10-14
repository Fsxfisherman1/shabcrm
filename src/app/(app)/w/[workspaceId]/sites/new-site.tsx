"use client";

import { useTransition } from "react";
import { createSiteAction } from "@/actions/sites";
import { Button } from "@/components/ui";

export function NewSiteButtons({ workspaceId }: { workspaceId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex gap-2">
      <Button variant="secondary" disabled={pending} onClick={() => startTransition(() => createSiteAction(workspaceId, "funnel"))}>
        New funnel
      </Button>
      <Button disabled={pending} onClick={() => startTransition(() => createSiteAction(workspaceId, "website"))}>
        New website
      </Button>
    </div>
  );
}
