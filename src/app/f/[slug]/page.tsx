import type { Metadata } from "next";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { db } from "@/db";
import { formBySlug } from "@/server/forms";
import { PublicForm } from "./public-form";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const found = await formBySlug(db, (await params).slug);
  return { title: found ? found.form.title : "Form" };
}

// A lead form, at /f/<address>. With ?embed=1 it drops the page frame so it can
// sit inside a client's website.
export default async function FormPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ embed?: string }> }) {
  const found = await formBySlug(db, (await params).slug);
  if (!found) notFound();
  const embed = (await searchParams).embed === "1";
  const { form, workspace } = found;

  return (
    <main className={clsx("mx-auto max-w-xl", embed ? "p-1" : "min-h-screen px-4 py-10")}>
      {/* Let the website's own background show around an embedded form. */}
      {embed && <style>{"html,body{background:transparent}"}</style>}
      {!embed && <div className="mb-2 text-sm font-medium text-slate-500">{workspace.name}</div>}
      {!form.enabled ? (
        <p className="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-600">This form isn&apos;t taking responses right now.</p>
      ) : (
        <PublicForm
          slug={form.slug}
          embed={embed}
          title={form.title}
          description={form.description}
          fields={form.fields}
          submitLabel={form.submitLabel}
          thankYou={form.thankYou}
          smsConsentText={form.fields.some((f) => f.kind === "phone") ? form.smsConsentText : null}
        />
      )}
    </main>
  );
}
