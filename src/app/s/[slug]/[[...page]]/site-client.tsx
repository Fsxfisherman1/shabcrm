"use client";

import { useCallback, useEffect } from "react";
import type { FormField } from "@/db/schema";
import { recordSiteEventAction } from "@/actions/sites";
import { PublicForm } from "@/app/f/[slug]/public-form";

/** A random id this browser keeps, so each visitor counts once. Nothing personal. */
function visitorId() {
  try {
    let id = localStorage.getItem("shabcrm-visitor");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("shabcrm-visitor", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function TrackVisit({ pageId }: { pageId: string }) {
  useEffect(() => {
    void recordSiteEventAction(pageId, "view", visitorId());
  }, [pageId]);
  return null;
}

/** A form on a site page: counts the send, then goes to the next step when there is one. */
export function SiteForm({
  pageId,
  nextHref,
  showHeading,
  form,
}: {
  pageId: string | null;
  nextHref: string | null;
  showHeading: boolean;
  form: { slug: string; title: string; description: string; fields: FormField[]; submitLabel: string; thankYou: string; smsConsentText: string | null };
}) {
  const onSent = useCallback(
    (redirectUrl: string | null) => {
      void (async () => {
        if (pageId) await recordSiteEventAction(pageId, "submit", visitorId());
        const to = redirectUrl ?? nextHref;
        if (to) window.location.href = to;
      })();
    },
    [pageId, nextHref],
  );
  return (
    // The send button takes the site's color.
    <div className="[&_button[type=submit]]:bg-[var(--site)] [&_button[type=submit]]:hover:opacity-90">
      <PublicForm {...form} embed={false} showHeading={showHeading} onSent={onSent} />
    </div>
  );
}
