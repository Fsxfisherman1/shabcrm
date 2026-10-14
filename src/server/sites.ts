import { randomBytes } from "node:crypto";
import { and, asc, count, countDistinct, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { bookingPages, forms, siteEvents, sitePages, sites, workspaces, type Form, type Site, type SitePage, type Workspace } from "@/db/schema";
import { withWorkspace } from "@/db/tenant";
import { blankBlock, DEFAULT_THEME, slugify, videoEmbedUrl, type SiteBlock, type SiteKind } from "@/lib/sites";
import { createForm } from "@/server/forms";

// ---------------------------------------------------------------------------
// Websites and funnels: pages built from sections, published at /s/<address>.
// ---------------------------------------------------------------------------

export class SiteError extends Error {}

const MAX_PAGES = 20;

export async function listSites(db: Db, workspaceId: string, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  return withWorkspace(db, workspaceId, async (tx) => {
    const list = await tx.select().from(sites).orderBy(desc(sites.updatedAt));
    const pages = await tx.select({ siteId: sitePages.siteId, n: count() }).from(sitePages).groupBy(sitePages.siteId);
    const visitors = await tx
      .select({ siteId: siteEvents.siteId, n: countDistinct(siteEvents.visitorId) })
      .from(siteEvents)
      .where(and(eq(siteEvents.kind, "view"), gte(siteEvents.createdAt, since)))
      .groupBy(siteEvents.siteId);
    return list.map((s) => ({
      ...s,
      pages: pages.find((p) => p.siteId === s.id)?.n ?? 0,
      visitors: visitors.find((v) => v.siteId === s.id)?.n ?? 0,
    }));
  });
}

export async function getSite(db: Db, workspaceId: string, siteId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [site] = await tx.select().from(sites).where(eq(sites.id, siteId));
    if (!site) return null;
    const pages = await tx.select().from(sitePages).where(eq(sitePages.siteId, siteId)).orderBy(asc(sitePages.position));
    return { site, pages };
  });
}

type PageDraft = { slug: string; title: string; blocks: SiteBlock[] };

/** The pages a new site starts with, so there's something to edit rather than a blank page. */
function template(kind: SiteKind, business: string, formId: string): PageDraft[] {
  const block = <T extends SiteBlock["type"]>(type: T, patch: Partial<Extract<SiteBlock, { type: T }>>) =>
    ({ ...blankBlock(type, { formId }), ...patch }) as SiteBlock;
  if (kind === "funnel") {
    return [
      {
        slug: "start",
        title: "Get your free quote",
        blocks: [
          block("hero", { heading: "Get your free quote today", text: `Tell ${business} what you need and we'll get back to you fast.`, buttonLabel: "Get my quote", buttonLink: "form" }),
          block("features", { heading: "What you get", items: [{ title: "A clear price", text: "No surprises." }, { title: "A quick answer", text: "Usually the same day." }] }),
          block("form", { heading: "Where should we send it?" }),
        ],
      },
      {
        slug: "thank-you",
        title: "Thanks!",
        blocks: [
          block("text", { heading: "Thanks, we've got it", text: "Want to talk sooner? Pick a time below." }),
          block("booking", {}),
        ],
      },
    ];
  }
  return [
    {
      slug: "home",
      title: "Home",
      blocks: [
        block("hero", { heading: business, text: "Say what you do and who you do it for, in a sentence or two.", buttonLabel: "Book a time", buttonLink: "booking" }),
        block("features", {}),
        block("testimonials", {}),
        block("cta", { buttonLink: "page:contact", buttonLabel: "Get in touch" }),
      ],
    },
    { slug: "about", title: "About", blocks: [block("text", { heading: `About ${business}`, text: "Tell people your story: how you started, and what you care about." })] },
    { slug: "contact", title: "Contact", blocks: [block("text", { heading: "Get in touch", text: "Send us a message and we'll get back to you." }), block("form", {})] },
  ];
}

export async function createSite(db: Db, workspaceId: string, kind: SiteKind, name: string) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const siteName = name.trim() || (kind === "funnel" ? "Free quote funnel" : `${workspace.name} website`);
  // Each new site gets its own form, so its leads are easy to tell apart.
  const form = await createForm(db, workspaceId, `${siteName} form`);
  return withWorkspace(db, workspaceId, async (tx) => {
    const [site] = await tx
      .insert(sites)
      .values({ workspaceId, kind, name: siteName, slug: `${slugify(siteName, "site")}-${randomBytes(3).toString("hex")}`, theme: DEFAULT_THEME })
      .returning();
    const pages = template(kind, workspace.name, form.id);
    await tx.insert(sitePages).values(pages.map((p, position) => ({ ...p, workspaceId, siteId: site.id, position })));
    return site;
  });
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

const short = (max = 200) => z.string().trim().max(max);
const long = (max = 5000) => z.string().trim().max(max);
const link = z
  .string()
  .trim()
  .max(500)
  .refine((l) => l === "" || l === "next" || l === "booking" || l === "form" || /^page:[a-z0-9-]{1,40}$/.test(l) || /^https:\/\/\S+$/.test(l), {
    message: "Each button needs somewhere to go. Links to other websites must start with https://.",
  });
const imageUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((u) => u === "" || /^https:\/\/\S+$/.test(u), { message: "Picture addresses must start with https://." });
const items = z.array(z.object({ title: short(), text: long(2000) })).max(30);
const id = z.string().min(1).max(40);

const blockSchema = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("hero"), heading: short(), text: long(), buttonLabel: short(60), buttonLink: link, imageUrl }),
  z.object({ id, type: z.literal("text"), heading: short(), text: long(20000) }),
  z.object({ id, type: z.literal("image"), url: imageUrl, alt: short() }),
  z.object({
    id,
    type: z.literal("video"),
    url: z
      .string()
      .trim()
      .max(500)
      .refine((u) => u === "" || videoEmbedUrl(u) !== null, { message: "Videos need a YouTube or Vimeo link." }),
  }),
  z.object({ id, type: z.literal("features"), heading: short(), items }),
  z.object({ id, type: z.literal("testimonials"), heading: short(), items }),
  z.object({ id, type: z.literal("faq"), heading: short(), items }),
  z.object({ id, type: z.literal("cta"), heading: short(), text: long(), buttonLabel: short(60), buttonLink: link }),
  z.object({ id, type: z.literal("form"), heading: short(), formId: z.string().max(40) }),
  z.object({ id, type: z.literal("booking"), heading: short(), text: long(), buttonLabel: short(60) }),
]);

const pageSchema = z.object({
  id: z.uuid().optional(),
  slug: z.string(),
  title: z.string().trim().min(1, "Give each page a title.").max(120),
  blocks: z.array(blockSchema).max(40, "A page can have up to 40 sections."),
});

export type SiteInput = {
  name: string;
  slug: string;
  enabled: boolean;
  color: string;
  font: string;
  pages: unknown;
};

export async function saveSite(db: Db, workspaceId: string, siteId: string, input: SiteInput) {
  const name = input.name.trim();
  if (!name) throw new SiteError("Give it a name.");
  const slug = slugify(input.slug, "");
  if (slug.length < 3) throw new SiteError("The address needs at least 3 letters or numbers.");
  if (!/^#[0-9a-f]{6}$/i.test(input.color)) throw new SiteError("Pick a color.");
  const font = input.font === "serif" ? "serif" : "sans";
  const parsed = z.array(pageSchema).min(1, "Add at least one page.").max(MAX_PAGES, `A site can have up to ${MAX_PAGES} pages.`).safeParse(input.pages);
  if (!parsed.success) throw new SiteError(parsed.error.issues[0].message);
  const pages = parsed.data.map((p) => ({ ...p, slug: slugify(p.slug || p.title) }));
  if (new Set(pages.map((p) => p.slug)).size !== pages.length) throw new SiteError("Two pages have the same address. Give each one its own.");
  const slugs = new Set(pages.map((p) => p.slug));
  for (const p of pages) {
    for (const b of p.blocks) {
      const to = "buttonLink" in b ? b.buttonLink : "";
      if (to.startsWith("page:") && !slugs.has(to.slice(5))) throw new SiteError(`A button on "${p.title}" goes to a page that isn't there anymore.`);
      if (to === "form" && !p.blocks.some((x) => x.type === "form")) throw new SiteError(`A button on "${p.title}" goes to the form, but that page has no form.`);
    }
  }

  const [taken] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.slug, slug), ne(sites.id, siteId)));
  if (taken) throw new SiteError("That address is taken. Try another.");

  return withWorkspace(db, workspaceId, async (tx) => {
    const [site] = await tx
      .update(sites)
      .set({ name, slug, enabled: input.enabled, theme: { color: input.color.toLowerCase(), font }, updatedAt: new Date() })
      .where(eq(sites.id, siteId))
      .returning();
    if (!site) throw new SiteError("Not found.");

    const formIds = [...new Set(pages.flatMap((p) => p.blocks.flatMap((b) => (b.type === "form" && b.formId ? [b.formId] : []))))];
    if (formIds.length) {
      const found = await tx.select({ id: forms.id }).from(forms).where(and(inArray(forms.id, formIds), eq(forms.source, "shabcrm")));
      if (found.length !== formIds.length) throw new SiteError("One of the forms on these pages was deleted. Pick another.");
    }

    // Keep each page's id (its visit numbers hang off it); add new ones; remove the rest.
    const existing = await tx.select({ id: sitePages.id }).from(sitePages).where(eq(sitePages.siteId, siteId));
    const known = new Set(existing.map((p) => p.id));
    const keep = pages.filter((p) => p.id && known.has(p.id)).map((p) => p.id!);
    const gone = existing.filter((p) => !keep.includes(p.id)).map((p) => p.id);
    if (gone.length) await tx.delete(sitePages).where(inArray(sitePages.id, gone));
    // Addresses are unique per site: park the kept pages on temporary ones before renaming.
    for (const pageId of keep) await tx.update(sitePages).set({ slug: `tmp-${pageId}` }).where(eq(sitePages.id, pageId));
    const saved: SitePage[] = [];
    for (const [position, p] of pages.entries()) {
      const values = { slug: p.slug, title: p.title, blocks: p.blocks as SiteBlock[], position, updatedAt: new Date() };
      if (p.id && known.has(p.id)) {
        const [row] = await tx.update(sitePages).set(values).where(eq(sitePages.id, p.id)).returning();
        saved.push(row);
      } else {
        const [row] = await tx.insert(sitePages).values({ ...values, workspaceId, siteId }).returning();
        saved.push(row);
      }
    }
    return { site, pages: saved };
  });
}

export async function deleteSite(db: Db, workspaceId: string, siteId: string) {
  await withWorkspace(db, workspaceId, (tx) => tx.delete(sites).where(eq(sites.id, siteId)));
}

// ---------------------------------------------------------------------------
// The public pages
// ---------------------------------------------------------------------------

export type PublicSite = {
  site: Site;
  workspace: Workspace;
  pages: SitePage[];
  forms: Form[];
  bookingSlug: string | null;
};

/** A published site by its address, with what its pages need. Read without row-level security, like forms. */
export async function siteBySlug(db: Db, slug: string): Promise<PublicSite | null> {
  const [row] = await db.select({ site: sites, workspace: workspaces }).from(sites).innerJoin(workspaces, eq(workspaces.id, sites.workspaceId)).where(eq(sites.slug, slug.toLowerCase()));
  if (!row) return null;
  const pages = await db.select().from(sitePages).where(eq(sitePages.siteId, row.site.id)).orderBy(asc(sitePages.position));
  const formIds = [...new Set(pages.flatMap((p) => p.blocks.flatMap((b) => (b.type === "form" && b.formId ? [b.formId] : []))))];
  const used = formIds.length
    ? await db
        .select()
        .from(forms)
        .where(and(inArray(forms.id, formIds), eq(forms.workspaceId, row.site.workspaceId), eq(forms.source, "shabcrm")))
    : [];
  const [booking] = await db
    .select({ slug: bookingPages.slug })
    .from(bookingPages)
    .where(and(eq(bookingPages.workspaceId, row.site.workspaceId), eq(bookingPages.enabled, true)));
  return { ...row, pages, forms: used, bookingSlug: booking?.slug ?? null };
}

/** Where a button goes on the public site, or null when it has nowhere to go. */
export function resolveLink(to: string, ctx: { siteSlug: string; pages: { slug: string }[]; index: number; bookingSlug: string | null }): string | null {
  const pageHref = (i: number) => (i === 0 ? `/s/${ctx.siteSlug}` : `/s/${ctx.siteSlug}/${ctx.pages[i].slug}`);
  if (to === "next") return ctx.index + 1 < ctx.pages.length ? pageHref(ctx.index + 1) : null;
  if (to === "booking") return ctx.bookingSlug ? `/book/${ctx.bookingSlug}` : null;
  if (to === "form") return "#form";
  if (to.startsWith("page:")) {
    const i = ctx.pages.findIndex((p) => p.slug === to.slice(5));
    return i >= 0 ? pageHref(i) : null;
  }
  return /^https:\/\/\S+$/.test(to) ? to : null;
}

/** A visit or a form send on a published page. The page is found from its id; nothing is read back. */
export async function recordSiteEvent(db: Db, input: { pageId: string; kind: "view" | "submit"; visitorId: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(input.pageId) || !/^[\w-]{8,64}$/.test(input.visitorId)) return;
  const [page] = await db
    .select({ id: sitePages.id, siteId: sitePages.siteId, workspaceId: sitePages.workspaceId, enabled: sites.enabled })
    .from(sitePages)
    .innerJoin(sites, eq(sites.id, sitePages.siteId))
    .where(eq(sitePages.id, input.pageId));
  if (!page || !page.enabled) return;
  await withWorkspace(db, page.workspaceId, (tx) =>
    tx.insert(siteEvents).values({ workspaceId: page.workspaceId, siteId: page.siteId, pageId: page.id, kind: input.kind, visitorId: input.visitorId }),
  );
}

/** Per page: how many people visited and how many sent a form, over the last `days` days. */
export async function siteStats(db: Db, workspaceId: string, siteId: string, days = 30, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000);
  return withWorkspace(db, workspaceId, async (tx) => {
    const rows = await tx
      .select({ pageId: siteEvents.pageId, kind: siteEvents.kind, n: countDistinct(siteEvents.visitorId) })
      .from(siteEvents)
      .where(and(eq(siteEvents.siteId, siteId), gte(siteEvents.createdAt, since)))
      .groupBy(siteEvents.pageId, siteEvents.kind);
    const stats: Record<string, { visitors: number; submits: number }> = {};
    for (const r of rows) {
      stats[r.pageId] ??= { visitors: 0, submits: 0 };
      stats[r.pageId][r.kind === "view" ? "visitors" : "submits"] = r.n;
    }
    return stats;
  });
}
