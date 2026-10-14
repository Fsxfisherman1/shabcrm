import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { db } from "@/db";
import { SiteBlocks, themeFont, themeStyle } from "@/components/site-blocks";
import { auth } from "@/lib/auth";
import { getMembership } from "@/server/workspaces";
import { resolveLink, siteBySlug, type PublicSite } from "@/server/sites";
import { SiteForm, TrackVisit } from "./site-client";

type Params = Promise<{ slug: string; page?: string[] }>;

function pick(found: PublicSite, page?: string[]) {
  if (page && page.length > 1) return null;
  const index = page?.[0] ? found.pages.findIndex((p) => p.slug === page[0].toLowerCase()) : 0;
  return index >= 0 && found.pages[index] ? index : null;
}

/** People in the account can look at a site before it's published. */
async function canPreview(workspaceId: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  return Boolean(session && (await getMembership(db, session.user.id, workspaceId)));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, page } = await params;
  const found = await siteBySlug(db, slug);
  const index = found ? pick(found, page) : null;
  if (!found || index === null) return { title: "Not found" };
  const p = found.pages[index];
  const hero = p.blocks.find((b) => b.type === "hero");
  return {
    title: index === 0 && found.site.kind === "website" ? found.workspace.name : `${p.title} · ${found.workspace.name}`,
    description: hero && "text" in hero ? hero.text.slice(0, 160) : undefined,
  };
}

// A published website or funnel page, at /s/<site>/<page>. The first page is at /s/<site>.
export default async function SitePage({ params }: { params: Params }) {
  const { slug, page } = await params;
  const found = await siteBySlug(db, slug);
  if (!found) notFound();
  const index = pick(found, page);
  if (index === null) notFound();
  const { site, workspace, pages, forms, bookingSlug } = found;
  const preview = !site.enabled;
  if (preview && !(await canPreview(site.workspaceId))) notFound();

  const current = pages[index];
  const href = (to: string) => resolveLink(to, { siteSlug: site.slug, pages, index, bookingSlug });
  const nextHref = site.kind === "funnel" ? href("next") : null;

  return (
    <div style={themeStyle(site.theme)} className={clsx("@container min-h-screen bg-white text-slate-900", themeFont(site.theme))}>
      {preview && (
        <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">Only people in your account can see this. Publish it to share it.</div>
      )}
      {!preview && <TrackVisit pageId={current.id} />}
      {site.kind === "website" && (
        <header className="border-b border-slate-200">
          <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-4">
            <Link href={`/s/${site.slug}`} className="mr-auto text-lg font-bold">
              {workspace.name}
            </Link>
            {pages.map((p, i) => (
              <Link
                key={p.id}
                href={i === 0 ? `/s/${site.slug}` : `/s/${site.slug}/${p.slug}`}
                aria-current={i === index ? "page" : undefined}
                className={clsx("text-sm font-medium", i === index ? "text-[var(--site)]" : "text-slate-600 hover:text-slate-900")}
              >
                {p.title}
              </Link>
            ))}
          </nav>
        </header>
      )}
      <main>
        <SiteBlocks
          blocks={current.blocks}
          ctx={{
            href,
            bookingHref: bookingSlug ? `/book/${bookingSlug}` : null,
            form: (b) => {
              const form = forms.find((f) => f.id === b.formId);
              if (!form) return null;
              if (!form.enabled) return <p className="rounded-xl border border-slate-200 p-6 text-center text-slate-600">This form isn&apos;t taking responses right now.</p>;
              return (
                <SiteForm
                  pageId={preview ? null : current.id}
                  nextHref={nextHref}
                  showHeading={!b.heading}
                  form={{
                    slug: form.slug,
                    title: form.title,
                    description: form.description,
                    fields: form.fields,
                    submitLabel: form.submitLabel,
                    thankYou: form.thankYou,
                    smsConsentText: form.fields.some((f) => f.kind === "phone") ? form.smsConsentText : null,
                  }}
                />
              );
            },
          }}
        />
      </main>
      <footer className="border-t border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
        © {new Date().getFullYear()} {workspace.name}
      </footer>
    </div>
  );
}
