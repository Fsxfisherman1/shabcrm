import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { bookingPages, forms, sitePages } from "@/db/schema";
import { blankBlock, videoEmbedUrl, type SiteBlock } from "@/lib/sites";
import { getBookingPage } from "@/server/calendars";
import { createForm } from "@/server/forms";
import { createSite, getSite, listSites, recordSiteEvent, resolveLink, saveSite, siteBySlug, SiteError, siteStats, type SiteInput } from "@/server/sites";
import { db, makeUser, makeWorkspace, resetDb } from "./helpers";

async function setup(kind: "website" | "funnel" = "funnel") {
  const alex = await makeUser();
  const ws = await makeWorkspace(alex.id);
  const site = await createSite(db, ws.id, kind, "");
  const found = (await getSite(db, ws.id, site.id))!;
  return { alex, ws, site, pages: found.pages };
}

function input(site: { name: string; slug: string; enabled: boolean }, pages: { id?: string; slug: string; title: string; blocks: SiteBlock[] }[], patch: Partial<SiteInput> = {}): SiteInput {
  return { name: site.name, slug: site.slug, enabled: site.enabled, color: "#2563eb", font: "sans", pages: pages.map(({ id, slug, title, blocks }) => ({ id, slug, title, blocks })), ...patch };
}

describe("sites", () => {
  beforeEach(resetDb);

  it("starts websites and funnels filled in, each with its own form", async () => {
    const { ws, pages } = await setup("funnel");
    expect(pages.map((p) => p.slug)).toEqual(["start", "thank-you"]);
    const formBlock = pages[0].blocks.find((b) => b.type === "form");
    const [form] = await db.select().from(forms).where(eq(forms.workspaceId, ws.id));
    expect(formBlock).toMatchObject({ formId: form.id });
    expect(form.name).toBe("Free quote funnel form");

    const website = await createSite(db, ws.id, "website", "");
    const found = (await getSite(db, ws.id, website.id))!;
    expect(found.site).toMatchObject({ name: "Acme Plumbing website", enabled: false });
    expect(found.pages.map((p) => p.title)).toEqual(["Home", "About", "Contact"]);
    const list = await listSites(db, ws.id);
    expect(list.map((s) => s.pages).sort()).toEqual([2, 3]);
  });

  it("saves pages in order, keeping ids, swapping addresses, adding and removing", async () => {
    const { ws, site, pages } = await setup("website");
    const [home, about, contact] = pages;
    const swapped = [
      { ...home },
      { ...contact, slug: "about" },
      { ...about, slug: "contact" },
      { slug: "", title: "Our Prices!", blocks: [blankBlock("text")] },
    ];
    const saved = await saveSite(db, ws.id, site.id, input(site, swapped, { name: " Acme site ", slug: "Acme Site", color: "#FF0000", font: "serif" }));
    expect(saved.site).toMatchObject({ name: "Acme site", slug: "acme-site", theme: { color: "#ff0000", font: "serif" } });
    expect(saved.pages.map((p) => [p.id === home.id, p.slug, p.position])).toEqual([
      [true, "home", 0],
      [false, "about", 1],
      [false, "contact", 2],
      [false, "our-prices", 3],
    ]);
    expect(saved.pages[1].id).toBe(contact.id);
    expect(saved.pages[2].id).toBe(about.id);

    // Leaving a page out removes it.
    await saveSite(db, ws.id, site.id, input(saved.site, saved.pages.slice(0, 3)));
    expect((await getSite(db, ws.id, site.id))!.pages).toHaveLength(3);
  });

  it("refuses broken buttons, pictures, videos and addresses", async () => {
    const { alex, ws, site, pages } = await setup("funnel");
    const tryBlocks = (blocks: SiteBlock[]) => saveSite(db, ws.id, site.id, input(site, [{ ...pages[0], blocks }, pages[1]]));
    const cta = (buttonLink: string) => ({ ...blankBlock("cta"), buttonLink }) as SiteBlock;

    await expect(tryBlocks([cta("http://example.com")])).rejects.toThrow("must start with https://");
    await expect(tryBlocks([cta("javascript:alert(1)")])).rejects.toThrow(SiteError);
    await expect(tryBlocks([cta("page:nowhere")])).rejects.toThrow("isn't there anymore");
    await expect(tryBlocks([cta("form")])).rejects.toThrow("has no form");
    await expect(tryBlocks([{ ...blankBlock("image"), url: "http://x.com/a.png" } as SiteBlock])).rejects.toThrow("Picture addresses");
    await expect(tryBlocks([{ ...blankBlock("video"), url: "https://example.com/video" } as SiteBlock])).rejects.toThrow("YouTube or Vimeo");
    await expect(tryBlocks([{ id: "x", type: "script", src: "evil" } as unknown as SiteBlock])).rejects.toThrow(SiteError);
    await expect(tryBlocks([cta("page:thank-you"), cta("next"), cta("https://example.com")])).resolves.toBeTruthy();

    await expect(saveSite(db, ws.id, site.id, input(site, [pages[0], { ...pages[1], slug: "start" }]))).rejects.toThrow("same address");
    await expect(saveSite(db, ws.id, site.id, input(site, []))).rejects.toThrow("at least one page");
    await expect(saveSite(db, ws.id, site.id, input(site, pages, { color: "red" }))).rejects.toThrow("color");

    // Another account's address, and another account's form.
    const other = await makeWorkspace(alex.id, "Other Co");
    const theirs = await createSite(db, other.id, "website", "Theirs");
    await expect(saveSite(db, ws.id, site.id, input(site, pages, { slug: theirs.slug }))).rejects.toThrow("taken");
    const theirForm = await createForm(db, other.id, "Theirs");
    await expect(tryBlocks([{ ...blankBlock("form"), formId: theirForm.id } as SiteBlock])).rejects.toThrow("deleted");
    // Another account's page id is treated as a new page, not taken over.
    const [theirPage] = await db.select().from(sitePages).where(eq(sitePages.siteId, theirs.id));
    const saved = await saveSite(db, ws.id, site.id, input(site, [...pages, { ...theirPage, slug: "copied", blocks: [] }]));
    expect(saved.pages[2].id).not.toBe(theirPage.id);
    expect((await db.select().from(sitePages).where(eq(sitePages.id, theirPage.id)))[0].siteId).toBe(theirs.id);
  });

  it("looks up public sites with only their own forms and an open booking page", async () => {
    const { ws, site } = await setup("funnel");
    let found = (await siteBySlug(db, site.slug.toUpperCase()))!;
    expect(found.pages).toHaveLength(2);
    expect(found.forms).toHaveLength(1);
    expect(found.bookingSlug).toBeNull();
    const booking = await getBookingPage(db, ws.id);
    await db.update(bookingPages).set({ enabled: true }).where(eq(bookingPages.id, booking.id));
    found = (await siteBySlug(db, site.slug))!;
    expect(found.bookingSlug).toBe(booking.slug);
    expect(await siteBySlug(db, "nope")).toBeNull();
  });

  it("works out where buttons go", () => {
    const ctx = { siteSlug: "acme", pages: [{ slug: "start" }, { slug: "thanks" }], index: 0, bookingSlug: "acme-book" };
    expect(resolveLink("next", ctx)).toBe("/s/acme/thanks");
    expect(resolveLink("next", { ...ctx, index: 1 })).toBeNull();
    expect(resolveLink("page:start", { ...ctx, index: 1 })).toBe("/s/acme");
    expect(resolveLink("booking", ctx)).toBe("/book/acme-book");
    expect(resolveLink("booking", { ...ctx, bookingSlug: null })).toBeNull();
    expect(resolveLink("form", ctx)).toBe("#form");
    expect(resolveLink("https://example.com", ctx)).toBe("https://example.com");
    expect(resolveLink("javascript:alert(1)", ctx)).toBeNull();
  });

  it("turns YouTube and Vimeo links into players", () => {
    expect(videoEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(videoEmbedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(videoEmbedUrl("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(videoEmbedUrl("https://vimeo.com/123456789")).toBe("https://player.vimeo.com/video/123456789");
    expect(videoEmbedUrl("http://youtu.be/dQw4w9WgXcQ")).toBeNull();
    expect(videoEmbedUrl("https://evil.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("counts each visitor once per page, only once published, and only for its account", async () => {
    const { alex, ws, site, pages } = await setup("funnel");
    const [start, thanks] = pages;
    await recordSiteEvent(db, { pageId: start.id, kind: "view", visitorId: "visitor-aaaa" });
    expect(await siteStats(db, ws.id, site.id)).toEqual({});

    await saveSite(db, ws.id, site.id, input({ ...site, enabled: true }, pages));
    for (const v of ["visitor-aaaa", "visitor-aaaa", "visitor-bbbb", "visitor-cccc"]) await recordSiteEvent(db, { pageId: start.id, kind: "view", visitorId: v });
    await recordSiteEvent(db, { pageId: start.id, kind: "submit", visitorId: "visitor-aaaa" });
    await recordSiteEvent(db, { pageId: thanks.id, kind: "view", visitorId: "visitor-aaaa" });
    await recordSiteEvent(db, { pageId: start.id, kind: "view", visitorId: "bad id!" });
    await recordSiteEvent(db, { pageId: "not-a-uuid", kind: "view", visitorId: "visitor-dddd" });

    expect(await siteStats(db, ws.id, site.id)).toEqual({ [start.id]: { visitors: 3, submits: 1 }, [thanks.id]: { visitors: 1, submits: 0 } });
    expect((await listSites(db, ws.id))[0].visitors).toBe(3);

    const other = await makeWorkspace(alex.id, "Other Co");
    expect(await siteStats(db, other.id, site.id)).toEqual({});
    expect(await getSite(db, other.id, site.id)).toBeNull();
  });
});
