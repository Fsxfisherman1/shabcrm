"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { deleteSiteAction, saveSiteAction } from "@/actions/sites";
import { CopyField } from "@/components/copy-field";
import { SiteBlocks, themeFont, themeStyle } from "@/components/site-blocks";
import { Button, Card, FormError, Input, Label, Select, Textarea } from "@/components/ui";
import {
  BLOCK_LABEL,
  BLOCK_TYPES,
  blankBlock,
  ITEM_LABELS,
  slugify,
  videoEmbedUrl,
  type BlockType,
  type Item,
  type SiteBlock,
  type SiteFont,
  type SiteKind,
} from "@/lib/sites";

type Page = { id?: string; key: string; slug: string; title: string; blocks: SiteBlock[] };
type State = { name: string; slug: string; enabled: boolean; color: string; font: SiteFont; pages: Page[] };
type FormOption = { id: string; name: string; enabled: boolean; submitLabel: string; fields: { id: string; label: string; kind: string; required: boolean }[] };

const COLORS = ["#2563eb", "#0d9488", "#16a34a", "#ea580c", "#dc2626", "#db2777", "#7c3aed", "#0f172a"];

const newKey = () => Math.random().toString(36).slice(2, 10);

export function SiteEditor({
  workspaceId,
  businessName,
  appUrl,
  bookingOn,
  forms,
  stats,
  site,
}: {
  workspaceId: string;
  businessName: string;
  appUrl: string;
  bookingOn: boolean;
  forms: FormOption[];
  stats: Record<string, { visitors: number; submits: number }>;
  site: State & { id: string; kind: SiteKind };
}) {
  const { id, kind, ...initial } = site;
  const funnel = kind === "funnel";
  const [state, setState] = useState<State>(initial);
  const [saved, setSaved] = useState(initial);
  const [tab, setTab] = useState<"build" | "numbers" | "settings">("build");
  const [current, setCurrent] = useState(initial.pages[0]?.key ?? "");
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ error?: string | null; message?: string | null }>({});
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = JSON.stringify(state) !== JSON.stringify(saved);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = (patch: Partial<State>) => {
    setNotice({});
    setState((s) => ({ ...s, ...patch }));
  };
  const index = Math.max(
    0,
    state.pages.findIndex((p) => p.key === current),
  );
  const page = state.pages[index];
  const setPage = (patch: Partial<Page>) => update({ pages: state.pages.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  /** Buttons that go to a page follow it when its address changes, and go nowhere once it's removed. */
  const relink = (pages: Page[], from: string, to: string) =>
    pages.map((p) => ({
      ...p,
      blocks: p.blocks.map((b) => ("buttonLink" in b && b.buttonLink === `page:${from}` ? ({ ...b, buttonLink: to && `page:${to}` } as SiteBlock) : b)),
    }));
  const setBlock = (blockId: string, patch: Partial<SiteBlock>) =>
    setPage({ blocks: page.blocks.map((b) => (b.id === blockId ? ({ ...b, ...patch } as SiteBlock) : b)) });
  const move = <T,>(list: T[], i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };

  function addPage() {
    const title = funnel ? `Step ${state.pages.length + 1}` : "New page";
    let slug = slugify(title);
    for (let n = 2; state.pages.some((p) => p.slug === slug); n++) slug = `${slugify(title)}-${n}`;
    const p: Page = { key: newKey(), slug, title, blocks: [blankBlock("text")] };
    update({ pages: [...state.pages, p] });
    setCurrent(p.key);
  }

  function addBlock(type: BlockType) {
    let b = blankBlock(type, { formId: forms[0]?.id });
    if (!funnel && "buttonLink" in b && b.buttonLink === "next") b = { ...b, buttonLink: bookingOn ? "booking" : "" };
    setPage({ blocks: [...page.blocks, b] });
    setOpen(b.id);
  }

  function save(next: State) {
    startTransition(async () => {
      const result = await saveSiteAction(workspaceId, id, { ...next, pages: next.pages.map((p) => ({ id: p.id, slug: p.slug, title: p.title, blocks: p.blocks })) });
      setNotice(result);
      if (result.ok && result.pageIds) {
        // The server tidies addresses and gives new pages their ids.
        const tidy: State = {
          ...next,
          slug: slugify(next.slug, ""),
          pages: next.pages.map((p, i) => ({ ...p, id: result.pageIds![i], slug: slugify(p.slug || p.title) })),
        };
        setState(tidy);
        setSaved(tidy);
      } else if (!result.ok && next.enabled !== saved.enabled) {
        setState((s) => ({ ...s, enabled: saved.enabled }));
      }
    });
  }

  const pageUrl = (i: number) => `${appUrl}/s/${saved.slug}${i === 0 ? "" : `/${saved.pages[i]?.slug ?? ""}`}`;
  const links = linkChoices(state.pages, index, funnel, bookingOn, page?.blocks.some((b) => b.type === "form") ?? false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/w/${workspaceId}/sites`} className="text-sm text-slate-500 hover:text-slate-800">
          Sites /
        </Link>
        <input
          aria-label="Site name"
          value={state.name}
          onChange={(e) => update({ name: e.target.value })}
          className="min-w-48 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-xl font-semibold tracking-tight hover:border-slate-200 focus:border-brand-500 focus:bg-white focus:outline-none"
        />
        <label className="flex items-center gap-2 text-sm font-medium">
          <button
            type="button"
            role="switch"
            aria-checked={state.enabled}
            aria-label="Published"
            disabled={pending}
            onClick={() => {
              const next = { ...state, enabled: !state.enabled };
              setState(next);
              save(next);
            }}
            className={clsx("relative h-6 w-11 rounded-full transition-colors", state.enabled ? "bg-emerald-500" : "bg-slate-300")}
          >
            <span className={clsx("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", state.enabled ? "left-[22px]" : "left-0.5")} />
          </button>
          {state.enabled ? "Published" : "Draft"}
        </label>
        <a href={pageUrl(Math.min(index, saved.pages.length - 1))} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand-700 hover:underline">
          Open page
        </a>
        <Button onClick={() => save(state)} disabled={pending || !dirty}>
          {pending ? "Saving…" : dirty ? "Save" : "Saved"}
        </Button>
      </div>

      {notice.error && <FormError message={notice.error} />}
      {notice.message && !dirty && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice.message}</p>}

      <div className="flex gap-1 border-b border-slate-200 text-sm" role="tablist">
        {(
          [
            ["build", "Pages"],
            ["numbers", "Visitors"],
            ["settings", "Settings"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={clsx("-mb-px border-b-2 px-3 py-2 font-medium", tab === key ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "build" && page && (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            <Card className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{funnel ? "Steps" : "Pages"}</h2>
                <button type="button" onClick={addPage} className="text-sm font-medium text-brand-700 hover:underline">
                  + Add {funnel ? "a step" : "a page"}
                </button>
              </div>
              <ol className="space-y-1">
                {state.pages.map((p, i) => (
                  <li key={p.key} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setCurrent(p.key)}
                      aria-current={i === index ? "page" : undefined}
                      className={clsx(
                        "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                        i === index ? "bg-brand-50 font-medium text-brand-700" : "hover:bg-slate-50",
                      )}
                    >
                      <span className="w-5 shrink-0 text-xs tabular-nums text-slate-400">{i + 1}</span>
                      <span className="truncate">{p.title || "Untitled"}</span>
                      {i === 0 && <span className="ml-auto shrink-0 text-xs text-slate-400">{funnel ? "first step" : "home"}</span>}
                    </button>
                    <SmallButton label={`Move ${p.title} up`} onClick={() => update({ pages: move(state.pages, i, -1) })}>
                      ↑
                    </SmallButton>
                    <SmallButton label={`Move ${p.title} down`} onClick={() => update({ pages: move(state.pages, i, 1) })}>
                      ↓
                    </SmallButton>
                  </li>
                ))}
              </ol>
              <div className="grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="page-title">{funnel ? "Step title" : "Page title"}</Label>
                  <Input id="page-title" value={page.title} onChange={(e) => setPage({ title: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="page-slug">Address</Label>
                  <Input
                    id="page-slug"
                    value={page.slug}
                    onChange={(e) => update({ pages: relink(state.pages, slugify(page.slug || page.title), slugify(e.target.value || page.title)).map((p, i) => (i === index ? { ...p, slug: e.target.value } : p)) })}
                  />
                </div>
              </div>
              {index === 0 && <p className="text-xs text-slate-500">The first {funnel ? "step" : "page"} also opens at the site&apos;s own address.</p>}
              {state.pages.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    update({ pages: relink(state.pages.filter((_, i) => i !== index), slugify(page.slug || page.title), "") });
                    setCurrent(state.pages[index === 0 ? 1 : index - 1].key);
                  }}
                  className="text-sm font-medium text-red-600 hover:underline"
                >
                  Remove this {funnel ? "step" : "page"}
                </button>
              )}
            </Card>

            <Card className="space-y-2 p-4">
              <h2 className="font-semibold">Sections</h2>
              {page.blocks.length === 0 && <p className="text-sm text-slate-500">This page is empty. Add a section below.</p>}
              {page.blocks.map((b, i) => (
                <div key={b.id} className="rounded-lg border border-slate-200">
                  <div className="flex items-center gap-1 p-2">
                    <button type="button" onClick={() => setOpen(open === b.id ? null : b.id)} aria-expanded={open === b.id} className="min-w-0 flex-1 truncate px-1 text-left text-sm">
                      <span className="font-medium">{BLOCK_LABEL[b.type]}</span>
                      <span className="ml-2 text-slate-500">{blockSummary(b, forms)}</span>
                    </button>
                    <SmallButton label={`Move ${BLOCK_LABEL[b.type]} up`} onClick={() => setPage({ blocks: move(page.blocks, i, -1) })}>
                      ↑
                    </SmallButton>
                    <SmallButton label={`Move ${BLOCK_LABEL[b.type]} down`} onClick={() => setPage({ blocks: move(page.blocks, i, 1) })}>
                      ↓
                    </SmallButton>
                    <SmallButton label={`Remove ${BLOCK_LABEL[b.type]}`} onClick={() => setPage({ blocks: page.blocks.filter((x) => x.id !== b.id) })}>
                      ×
                    </SmallButton>
                  </div>
                  {open === b.id && (
                    <div className="space-y-3 border-t border-slate-100 p-3">
                      <BlockFields block={b} set={(patch) => setBlock(b.id, patch)} links={links} forms={forms} workspaceId={workspaceId} bookingOn={bookingOn} />
                    </div>
                  )}
                </div>
              ))}
              <AddSection onAdd={addBlock} />
            </Card>
          </div>

          <div className="min-w-0">
            <div className="xl:sticky xl:top-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Preview</div>
              <div
                aria-label="Page preview"
                style={themeStyle({ color: state.color, font: state.font })}
                className={clsx("@container max-h-[80vh] overflow-y-auto rounded-xl border border-slate-200 bg-white text-slate-900 shadow-sm", themeFont({ color: state.color, font: state.font }))}
              >
                {!funnel && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-200 px-4 py-3 text-sm">
                    <span className="mr-auto font-bold">{businessName}</span>
                    {state.pages.map((p, i) => (
                      <span key={p.key} className={i === index ? "font-medium text-[var(--site)]" : "text-slate-600"}>
                        {p.title}
                      </span>
                    ))}
                  </div>
                )}
                {/* Clicks in the preview stay here. */}
                <div onClickCapture={(e) => (e.target as HTMLElement).closest("a") && e.preventDefault()}>
                  <SiteBlocks
                    blocks={page.blocks}
                    ctx={{
                      href: (to) => (links.some((l) => l.value === to) || /^https:\/\/\S+$/.test(to) ? "#" : null),
                      bookingHref: bookingOn ? "#" : null,
                      form: (b) => <FormPreview form={forms.find((f) => f.id === b.formId)} showName={!b.heading} />,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "numbers" && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">{funnel ? "Step" : "Page"}</th>
                <th className="px-4 py-3 text-right font-medium">Visitors</th>
                <th className="px-4 py-3 text-right font-medium">Sent a form</th>
                {funnel && <th className="px-4 py-3 text-right font-medium">Went on to the next step</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {saved.pages.map((p, i) => {
                const s = (p.id && stats[p.id]) || { visitors: 0, submits: 0 };
                const next = saved.pages[i + 1]?.id;
                const nextVisitors = next ? (stats[next]?.visitors ?? 0) : null;
                return (
                  <tr key={p.key}>
                    <td className="px-4 py-3 font-medium">
                      <span className="mr-2 text-xs tabular-nums text-slate-400">{i + 1}</span>
                      {p.title}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{s.visitors}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {s.submits}
                      {s.visitors > 0 && s.submits > 0 && <span className="ml-1 text-slate-400">({percent(s.submits, s.visitors)})</span>}
                    </td>
                    {funnel && (
                      <td className="px-4 py-3 text-right tabular-nums">
                        {nextVisitors === null ? <span className="text-slate-400">last step</span> : s.visitors ? percent(Math.min(nextVisitors, s.visitors), s.visitors) : "–"}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            The last 30 days. Each visitor counts once per page. Visits from people signed in here looking at a draft aren&apos;t counted.
          </p>
        </Card>
      )}

      {tab === "settings" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="space-y-4 p-5">
            <h2 className="font-semibold">Address</h2>
            <CopyField label="Link" value={pageUrl(0)} open />
            <div>
              <Label htmlFor="site-slug">Address</Label>
              <div className="flex items-center gap-1 text-sm">
                <span className="shrink-0 text-slate-500">/s/</span>
                <Input id="site-slug" value={state.slug} onChange={(e) => update({ slug: e.target.value })} />
              </div>
              <p className="mt-1 text-xs text-slate-500">Changing it breaks links you&apos;ve already shared. Your own domain name can point here once ShabCRM is hosted.</p>
            </div>
          </Card>
          <Card className="space-y-4 p-5">
            <h2 className="font-semibold">Look</h2>
            <div>
              <div className="mb-1 text-sm font-medium text-slate-700">Main color</div>
              <div className="flex flex-wrap items-center gap-2">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Color ${c}`}
                    aria-pressed={state.color === c}
                    onClick={() => update({ color: c })}
                    style={{ background: c }}
                    className={clsx("h-8 w-8 rounded-full ring-offset-2", state.color === c && "ring-2 ring-slate-900")}
                  />
                ))}
                <input type="color" aria-label="Pick any color" value={state.color} onChange={(e) => update({ color: e.target.value })} className="h-8 w-10 cursor-pointer rounded border border-slate-200" />
              </div>
            </div>
            <div>
              <Label htmlFor="site-font">Lettering</Label>
              <Select id="site-font" value={state.font} onChange={(e) => update({ font: e.target.value as SiteFont })}>
                <option value="sans">Clean and modern</option>
                <option value="serif">Classic</option>
              </Select>
            </div>
          </Card>
          <Card className="space-y-3 p-5 lg:col-span-2">
            <h2 className="font-semibold">Danger zone</h2>
            {confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                Delete this {funnel ? "funnel" : "website"} and its visitor numbers? Its forms, their responses and the contacts stay.
                <Button size="sm" variant="danger" onClick={() => startTransition(() => deleteSiteAction(workspaceId, id))}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete {funnel ? "funnel" : "website"}
              </Button>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function percent(n: number, of: number) {
  return `${Math.round((n / of) * 100)}%`;
}

type LinkChoice = { value: string; label: string };

/** Where a button on this page can go. */
function linkChoices(pages: Page[], index: number, funnel: boolean, bookingOn: boolean, hasForm: boolean): LinkChoice[] {
  const list: LinkChoice[] = [];
  if (funnel && index + 1 < pages.length) list.push({ value: "next", label: `Next step (${pages[index + 1].title})` });
  if (hasForm) list.push({ value: "form", label: "The form on this page" });
  if (bookingOn) list.push({ value: "booking", label: "Your booking page" });
  pages.forEach((p, i) => i !== index && list.push({ value: `page:${slugify(p.slug || p.title)}`, label: `${funnel ? "Step" : "Page"}: ${p.title}` }));
  return list;
}

function blockSummary(b: SiteBlock, forms: FormOption[]) {
  if (b.type === "form") return forms.find((f) => f.id === b.formId)?.name ?? "no form picked";
  if (b.type === "image" || b.type === "video") return b.url ? "" : "no link yet";
  return "heading" in b ? b.heading : "";
}

function AddSection({ onAdd }: { onAdd: (type: BlockType) => void }) {
  const [type, setType] = useState<BlockType>("text");
  return (
    <div className="flex gap-2 pt-1">
      <Select aria-label="Section to add" value={type} onChange={(e) => setType(e.target.value as BlockType)}>
        {BLOCK_TYPES.map((t) => (
          <option key={t} value={t}>
            {BLOCK_LABEL[t]}
          </option>
        ))}
      </Select>
      <Button type="button" variant="secondary" className="shrink-0 whitespace-nowrap" onClick={() => onAdd(type)}>
        Add section
      </Button>
    </div>
  );
}

function TextField({ label, value, onChange, rows, placeholder }: { label: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  const id = `f-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {rows ? (
        <Textarea id={id} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input id={id} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function LinkField({ value, onChange, links }: { value: string; onChange: (v: string) => void; links: LinkChoice[] }) {
  const custom = value !== "" && !links.some((l) => l.value === value);
  return (
    <div className="space-y-2">
      <div>
        <Label htmlFor="f-button-goes-to">Button goes to</Label>
        <Select id="f-button-goes-to" value={custom ? "url" : value} onChange={(e) => onChange(e.target.value === "url" ? "https://" : e.target.value)}>
          {links.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
          <option value="url">Another website…</option>
          <option value="">Nowhere (hide the button)</option>
        </Select>
      </div>
      {custom && <TextField label="Website address" value={value} placeholder="https://" onChange={onChange} />}
    </div>
  );
}

function BlockFields({
  block: b,
  set,
  links,
  forms,
  workspaceId,
  bookingOn,
}: {
  block: SiteBlock;
  set: (patch: Partial<SiteBlock>) => void;
  links: LinkChoice[];
  forms: FormOption[];
  workspaceId: string;
  bookingOn: boolean;
}) {
  const heading = "heading" in b && <TextField label="Heading" value={b.heading} onChange={(heading) => set({ heading })} />;
  switch (b.type) {
    case "hero":
      return (
        <>
          {heading}
          <TextField label="Text" rows={3} value={b.text} onChange={(text) => set({ text })} />
          <TextField label="Button text" value={b.buttonLabel} onChange={(buttonLabel) => set({ buttonLabel })} />
          <LinkField value={b.buttonLink} links={links} onChange={(buttonLink) => set({ buttonLink })} />
          <TextField label="Picture address (optional)" value={b.imageUrl} placeholder="https://" onChange={(imageUrl) => set({ imageUrl })} />
        </>
      );
    case "text":
      return (
        <>
          {heading}
          <TextField label="Text" rows={6} value={b.text} onChange={(text) => set({ text })} />
        </>
      );
    case "image":
      return (
        <>
          <TextField label="Picture address" value={b.url} placeholder="https://" onChange={(url) => set({ url })} />
          <TextField label="What it shows, for screen readers" value={b.alt} onChange={(alt) => set({ alt })} />
          <p className="text-xs text-slate-500">Paste the address of a picture that&apos;s already online, for example from the client&apos;s current website or Google Drive.</p>
        </>
      );
    case "video":
      return (
        <>
          <TextField label="YouTube or Vimeo link" value={b.url} placeholder="https://www.youtube.com/watch?v=…" onChange={(url) => set({ url })} />
          {b.url && !videoEmbedUrl(b.url) && <p className="text-xs text-red-600">That doesn&apos;t look like a YouTube or Vimeo link.</p>}
        </>
      );
    case "features":
    case "testimonials":
    case "faq":
      return (
        <>
          {heading}
          <ItemsField items={b.items} labels={ITEM_LABELS[b.type]} onChange={(items) => set({ items })} />
        </>
      );
    case "cta":
      return (
        <>
          {heading}
          <TextField label="Text (optional)" rows={2} value={b.text} onChange={(text) => set({ text })} />
          <TextField label="Button text" value={b.buttonLabel} onChange={(buttonLabel) => set({ buttonLabel })} />
          <LinkField value={b.buttonLink} links={links} onChange={(buttonLink) => set({ buttonLink })} />
        </>
      );
    case "form":
      return (
        <>
          <TextField label="Heading (optional)" value={b.heading} onChange={(heading) => set({ heading })} />
          <div>
            <Label htmlFor="f-form">Form</Label>
            <Select id="f-form" value={b.formId} onChange={(e) => set({ formId: e.target.value })}>
              <option value="">Pick a form…</option>
              {forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {f.enabled ? "" : " (off)"}
                </option>
              ))}
            </Select>
          </div>
          {b.formId && (
            <Link href={`/w/${workspaceId}/forms/${b.formId}`} className="text-sm font-medium text-brand-700 hover:underline">
              Change this form&apos;s questions
            </Link>
          )}
          <p className="text-xs text-slate-500">People who fill it in land in Contacts and start any workflow for this form. In a funnel, they go on to the next step.</p>
        </>
      );
    case "booking":
      return (
        <>
          {heading}
          <TextField label="Text" rows={2} value={b.text} onChange={(text) => set({ text })} />
          <TextField label="Button text" value={b.buttonLabel} onChange={(buttonLabel) => set({ buttonLabel })} />
          {!bookingOn && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Your booking page is off, so this section is hidden. Turn it on in{" "}
              <Link href={`/w/${workspaceId}/calendar`} className="font-medium underline">
                Calendar
              </Link>
              .
            </p>
          )}
        </>
      );
  }
}

function ItemsField({ items, labels, onChange }: { items: Item[]; labels: { title: string; text: string; add: string }; onChange: (items: Item[]) => void }) {
  const setItem = (i: number, patch: Partial<Item>) => onChange(items.map((item, j) => (j === i ? { ...item, ...patch } : item)));
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="space-y-2 rounded-lg bg-slate-50 p-2">
          <div className="flex gap-2">
            <Input aria-label={`${labels.title} ${i + 1}`} placeholder={labels.title} value={item.title} onChange={(e) => setItem(i, { title: e.target.value })} />
            <SmallButton label={`Remove ${labels.title.toLowerCase()} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
              ×
            </SmallButton>
          </div>
          <Textarea aria-label={`${labels.text} ${i + 1}`} placeholder={labels.text} rows={2} value={item.text} onChange={(e) => setItem(i, { text: e.target.value })} />
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, { title: "", text: "" }])} className="text-sm font-medium text-brand-700 hover:underline">
        + {labels.add}
      </button>
    </div>
  );
}

/** A stand-in for the form in the preview, so typing in it doesn't send anything. */
function FormPreview({ form, showName }: { form?: FormOption; showName: boolean }) {
  if (!form) return <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">Pick a form for this section.</p>;
  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      {showName && <div className="text-xl font-semibold tracking-tight">{form.name}</div>}
      {form.fields.map((f) => (
        <div key={f.id}>
          <div className="mb-1 text-sm font-medium text-slate-700">
            {f.label}
            {f.required && <span className="text-red-600"> *</span>}
          </div>
          <div className={clsx("rounded-lg border border-slate-300", f.kind === "textarea" ? "h-20" : "h-10")} />
        </div>
      ))}
      <div className="flex h-10 items-center justify-center rounded-lg bg-[var(--site)] text-sm font-medium text-white">{form.submitLabel}</div>
    </div>
  );
}

function SmallButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">
      {children}
    </button>
  );
}
