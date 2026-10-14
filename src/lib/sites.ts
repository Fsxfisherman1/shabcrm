// Websites and funnels: the sections a page is built from, shared by the
// editor, its preview and the public pages.

export type SiteKind = "website" | "funnel";

export const SITE_KIND_LABEL: Record<SiteKind, string> = { website: "Website", funnel: "Funnel" };

export type SiteFont = "sans" | "serif";

export type SiteTheme = { color: string; font: SiteFont };

export const DEFAULT_THEME: SiteTheme = { color: "#2563eb", font: "sans" };

/**
 * Where a button goes: "next" (the next page, for funnels), "booking" (the
 * account's booking page), "form" (the form on this page), "page:<address>"
 * (a page of this site) or an https:// address.
 */
export type SiteLink = string;

export type Item = { title: string; text: string };

export type SiteBlock =
  | { id: string; type: "hero"; heading: string; text: string; buttonLabel: string; buttonLink: SiteLink; imageUrl: string }
  | { id: string; type: "text"; heading: string; text: string }
  | { id: string; type: "image"; url: string; alt: string }
  | { id: string; type: "video"; url: string }
  | { id: string; type: "features"; heading: string; items: Item[] }
  | { id: string; type: "testimonials"; heading: string; items: Item[] }
  | { id: string; type: "faq"; heading: string; items: Item[] }
  | { id: string; type: "cta"; heading: string; text: string; buttonLabel: string; buttonLink: SiteLink }
  | { id: string; type: "form"; heading: string; formId: string }
  | { id: string; type: "booking"; heading: string; text: string; buttonLabel: string };

export type BlockType = SiteBlock["type"];

export const BLOCK_TYPES: BlockType[] = ["hero", "text", "features", "testimonials", "faq", "image", "video", "cta", "form", "booking"];

export const BLOCK_LABEL: Record<BlockType, string> = {
  hero: "Big heading",
  text: "Text",
  image: "Picture",
  video: "Video",
  features: "List of benefits",
  testimonials: "Reviews",
  faq: "Questions and answers",
  cta: "Call to action",
  form: "Form",
  booking: "Book a time",
};

/** What the item fields are called, for sections with a list. */
export const ITEM_LABELS: Record<"features" | "testimonials" | "faq", { title: string; text: string; add: string }> = {
  features: { title: "Benefit", text: "Details", add: "Add a benefit" },
  testimonials: { title: "Who said it", text: "What they said", add: "Add a review" },
  faq: { title: "Question", text: "Answer", add: "Add a question" },
};

const newId = () => Math.random().toString(36).slice(2, 10);

export function blankBlock(type: BlockType, opts: { formId?: string } = {}): SiteBlock {
  const id = newId();
  switch (type) {
    case "hero":
      return { id, type, heading: "Your headline here", text: "One or two sentences on what you offer and who it's for.", buttonLabel: "Get started", buttonLink: "next", imageUrl: "" };
    case "text":
      return { id, type, heading: "A heading", text: "Write a few lines here." };
    case "image":
      return { id, type, url: "", alt: "" };
    case "video":
      return { id, type, url: "" };
    case "features":
      return { id, type, heading: "Why people choose us", items: [{ title: "Fast", text: "We show up when we say we will." }, { title: "Fair prices", text: "A clear quote before we start." }] };
    case "testimonials":
      return { id, type, heading: "What customers say", items: [{ title: "Jamie R.", text: "Quick, friendly and fairly priced." }] };
    case "faq":
      return { id, type, heading: "Questions", items: [{ title: "How soon can you come out?", text: "Usually within a day or two." }] };
    case "cta":
      return { id, type, heading: "Ready to get started?", text: "", buttonLabel: "Book a time", buttonLink: "booking" };
    case "form":
      return { id, type, heading: "", formId: opts.formId ?? "" };
    case "booking":
      return { id, type, heading: "Pick a time", text: "Choose a time that suits you.", buttonLabel: "See open times" };
  }
}

/** A YouTube or Vimeo link turned into the address for its player, or null. */
export function videoEmbedUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\.|^m\./, "");
  const id = (s: string | null | undefined) => (s && /^[\w-]{6,20}$/.test(s) ? s : null);
  if (host === "youtube.com") {
    const v = id(u.searchParams.get("v")) ?? id(u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1]);
    return v ? `https://www.youtube-nocookie.com/embed/${v}` : null;
  }
  if (host === "youtu.be") {
    const v = id(u.pathname.slice(1));
    return v ? `https://www.youtube-nocookie.com/embed/${v}` : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const v = u.pathname.match(/(\d{5,12})/)?.[1];
    return v ? `https://player.vimeo.com/video/${v}` : null;
  }
  return null;
}

export function slugify(name: string, fallback = "page") {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || fallback
  );
}
