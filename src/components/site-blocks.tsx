import clsx from "clsx";
import type { CSSProperties, ReactNode } from "react";
import { videoEmbedUrl, type SiteBlock, type SiteTheme } from "@/lib/sites";

// Draws a site page's sections. Used by the public pages and by the editor's
// preview, so what you see while editing is what visitors get. No hooks, so it
// renders on the server and in the browser alike.

export type BlockContext = {
  /** Where a button goes, or null to hide it. */
  href: (to: string) => string | null;
  /** The form section's form. */
  form: (block: Extract<SiteBlock, { type: "form" }>) => ReactNode;
  bookingHref: string | null;
};

export function themeStyle(theme: SiteTheme): CSSProperties {
  return { "--site": theme.color } as CSSProperties;
}

export function themeFont(theme: SiteTheme) {
  return theme.font === "serif" ? "font-[Georgia,'Times_New_Roman',serif]" : "";
}

export function SiteBlocks({ blocks, ctx }: { blocks: SiteBlock[]; ctx: BlockContext }) {
  return (
    <>
      {blocks.map((b) => (
        <Block key={b.id} block={b} ctx={ctx} />
      ))}
    </>
  );
}

function SiteButton({ label, href }: { label: string; href: string | null }) {
  if (!label || !href) return null;
  const outside = /^https:/.test(href);
  return (
    <a
      href={href}
      {...(outside ? { target: "_blank", rel: "noreferrer" } : {})}
      className="inline-flex items-center justify-center rounded-lg bg-[var(--site)] px-6 py-3 text-base font-semibold text-white shadow-sm hover:opacity-90"
    >
      {label}
    </a>
  );
}

function Section({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={clsx("px-4 py-12 @2xl:py-16", className)}>{children}</section>;
}

function Heading({ children }: { children: ReactNode }) {
  return children ? <h2 className="text-balance text-2xl font-bold tracking-tight @2xl:text-3xl">{children}</h2> : null;
}

function Block({ block: b, ctx }: { block: SiteBlock; ctx: BlockContext }) {
  switch (b.type) {
    case "hero":
      return (
        <section className="bg-[color-mix(in_srgb,var(--site)_8%,white)] px-4 py-16 @2xl:py-24">
          <div className={clsx("mx-auto grid max-w-5xl items-center gap-10", b.imageUrl && "@3xl:grid-cols-2")}>
            <div className={clsx("space-y-5", !b.imageUrl && "mx-auto max-w-2xl text-center")}>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight @2xl:text-5xl">{b.heading}</h1>
              {b.text && <p className="whitespace-pre-wrap text-lg text-slate-600">{b.text}</p>}
              <SiteButton label={b.buttonLabel} href={ctx.href(b.buttonLink)} />
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element -- outside picture addresses */}
            {b.imageUrl && <img src={b.imageUrl} alt="" className="w-full rounded-2xl object-cover shadow-lg" />}
          </div>
        </section>
      );
    case "text":
      return (
        <Section>
          <div className="mx-auto max-w-2xl space-y-4">
            <Heading>{b.heading}</Heading>
            {b.text && <p className="whitespace-pre-wrap text-lg leading-relaxed text-slate-700">{b.text}</p>}
          </div>
        </Section>
      );
    case "image":
      return b.url ? (
        <Section className="py-8 @2xl:py-10">
          {/* eslint-disable-next-line @next/next/no-img-element -- outside picture addresses */}
          <img src={b.url} alt={b.alt} className="mx-auto w-full max-w-4xl rounded-2xl object-cover" />
        </Section>
      ) : null;
    case "video": {
      const src = videoEmbedUrl(b.url);
      return src ? (
        <Section className="py-8 @2xl:py-10">
          <div className="mx-auto aspect-video w-full max-w-4xl overflow-hidden rounded-2xl bg-slate-900">
            <iframe src={src} title="Video" className="h-full w-full" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />
          </div>
        </Section>
      ) : null;
    }
    case "features":
      return (
        <Section>
          <div className="mx-auto max-w-5xl space-y-8">
            <div className="text-center">
              <Heading>{b.heading}</Heading>
            </div>
            <div className="flex flex-wrap justify-center gap-4">
              {b.items.map((item, i) => (
                <div key={i} className="w-full rounded-2xl border border-slate-200 p-5 @2xl:w-[calc(50%-0.5rem)] @5xl:w-[calc(33.333%-0.667rem)]">
                  <div className="mb-2 h-1.5 w-8 rounded-full bg-[var(--site)]" />
                  <h3 className="font-semibold">{item.title}</h3>
                  {item.text && <p className="mt-1 whitespace-pre-wrap text-slate-600">{item.text}</p>}
                </div>
              ))}
            </div>
          </div>
        </Section>
      );
    case "testimonials":
      return (
        <Section className="bg-slate-50">
          <div className="mx-auto max-w-5xl space-y-8">
            <div className="text-center">
              <Heading>{b.heading}</Heading>
            </div>
            <div className="grid gap-4 @3xl:grid-cols-2">
              {b.items.map((item, i) => (
                <figure key={i} className="rounded-2xl bg-white p-6 shadow-sm">
                  <div className="text-[var(--site)]" aria-hidden>
                    ★★★★★
                  </div>
                  <blockquote className="mt-2 whitespace-pre-wrap text-lg text-slate-800">&ldquo;{item.text}&rdquo;</blockquote>
                  {item.title && <figcaption className="mt-3 text-sm font-medium text-slate-500">{item.title}</figcaption>}
                </figure>
              ))}
            </div>
          </div>
        </Section>
      );
    case "faq":
      return (
        <Section>
          <div className="mx-auto max-w-2xl space-y-6">
            <Heading>{b.heading}</Heading>
            <div className="divide-y divide-slate-200 border-y border-slate-200">
              {b.items.map((item, i) => (
                <details key={i} className="group py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                    {item.title}
                    <span className="text-[var(--site)] transition-transform group-open:rotate-45" aria-hidden>
                      +
                    </span>
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap text-slate-600">{item.text}</p>
                </details>
              ))}
            </div>
          </div>
        </Section>
      );
    case "cta":
      return (
        <Section>
          <div className="mx-auto max-w-3xl space-y-4 rounded-3xl bg-[var(--site)] px-6 py-12 text-center text-white">
            <h2 className="text-balance text-2xl font-bold tracking-tight @2xl:text-3xl">{b.heading}</h2>
            {b.text && <p className="whitespace-pre-wrap text-lg opacity-90">{b.text}</p>}
            {b.buttonLabel && ctx.href(b.buttonLink) && (
              <a
                href={ctx.href(b.buttonLink)!}
                className="inline-flex items-center justify-center rounded-lg bg-white px-6 py-3 font-semibold text-[var(--site)] shadow-sm hover:opacity-90"
              >
                {b.buttonLabel}
              </a>
            )}
          </div>
        </Section>
      );
    case "form":
      return (
        <Section>
          <div id="form" className="mx-auto max-w-xl scroll-mt-8 space-y-4">
            <Heading>{b.heading}</Heading>
            {ctx.form(b)}
          </div>
        </Section>
      );
    case "booking":
      return ctx.bookingHref ? (
        <Section>
          <div className="mx-auto max-w-2xl space-y-4 text-center">
            <Heading>{b.heading}</Heading>
            {b.text && <p className="whitespace-pre-wrap text-lg text-slate-600">{b.text}</p>}
            <SiteButton label={b.buttonLabel || "Book a time"} href={ctx.bookingHref} />
          </div>
        </Section>
      ) : null;
  }
}
