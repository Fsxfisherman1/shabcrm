"use client";

import Link from "next/link";
import Papa from "papaparse";
import { useMemo, useState } from "react";
import { importContactsAction } from "@/actions/contacts";
import { Button, Card, Field, FormError, Input, Select } from "@/components/ui";
import type { ImportResult } from "@/server/contacts";

const FIELDS = [
  { key: "firstName", label: "First name", guess: ["first name", "firstname", "first", "given name"] },
  { key: "lastName", label: "Last name", guess: ["last name", "lastname", "last", "surname", "family name"] },
  { key: "fullName", label: "Full name (split automatically)", guess: ["name", "full name", "fullname", "contact name", "customer name"] },
  { key: "email", label: "Email", guess: ["email", "email address", "e-mail"] },
  { key: "phone", label: "Phone", guess: ["phone", "mobile", "cell", "phone number", "mobile phone", "cell phone"] },
  { key: "company", label: "Company", guess: ["company", "business", "organization", "company name"] },
  { key: "tags", label: "Tags (comma separated)", guess: ["tags", "tag", "labels"] },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type Mapping = Record<string, FieldKey | "">;

const CHUNK = 500;

function guessMapping(headers: string[]): Mapping {
  const used = new Set<string>();
  const mapping: Mapping = {};
  for (const h of headers) {
    const norm = h.trim().toLowerCase().replace(/[_-]/g, " ");
    const match = FIELDS.find((f) => !used.has(f.key) && (f.guess as readonly string[]).includes(norm));
    mapping[h] = match?.key ?? "";
    if (match) used.add(match.key);
  }
  return mapping;
}

export function Importer({ workspaceId }: { workspaceId: string }) {
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [data, setData] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [consent, setConsent] = useState<"none" | "granted">("none");
  const [consentSource, setConsentSource] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  function onFile(file: File) {
    setError(null);
    setResult(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      complete: (res) => {
        const fields = (res.meta.fields ?? []).filter(Boolean);
        if (!fields.length || !res.data.length) {
          setError("That file looks empty. Make sure the first row has column names.");
          return;
        }
        setFileName(file.name);
        setHeaders(fields);
        setData(res.data);
        setMapping(guessMapping(fields));
      },
      error: (err) => setError(err.message),
    });
  }

  const rows = useMemo(() => {
    return data.map((record) => {
      const row: { firstName?: string; lastName?: string; email?: string; phone?: string; company?: string; tags?: string[] } = {};
      for (const [header, field] of Object.entries(mapping)) {
        const value = (record[header] ?? "").trim();
        if (!field || !value) continue;
        if (field === "fullName") {
          const [first, ...rest] = value.split(/\s+/);
          row.firstName ??= first;
          row.lastName ??= rest.join(" ");
        } else if (field === "tags") {
          row.tags = value.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
        } else {
          row[field] = value;
        }
      }
      return row;
    });
  }, [data, mapping]);

  const usable = rows.filter((r) => r.email || r.phone).length;
  const mapped = new Set(Object.values(mapping).filter(Boolean));
  const canImport = usable > 0 && (consent === "none" || consentSource.trim()) && progress === null;

  async function runImport() {
    setError(null);
    const total: ImportResult = { created: 0, updated: 0, skipped: 0 };
    setProgress(0);
    for (let i = 0; i < rows.length; i += CHUNK) {
      const res = await importContactsAction(workspaceId, {
        rows: rows.slice(i, i + CHUNK),
        consent,
        consentSource,
        tags,
        fileName,
      });
      if ("error" in res) {
        setError(res.error);
        setProgress(null);
        return;
      }
      total.created += res.result.created;
      total.updated += res.result.updated;
      total.skipped += res.result.skipped;
      setProgress(Math.min(rows.length, i + CHUNK));
    }
    setProgress(null);
    setResult(total);
  }

  if (result) {
    return (
      <Card className="p-6">
        <h2 className="text-lg font-semibold">Import finished</h2>
        <ul className="mt-3 space-y-1 text-sm">
          <li>
            <strong>{result.created.toLocaleString()}</strong> new contacts added
          </li>
          <li>
            <strong>{result.updated.toLocaleString()}</strong> existing contacts updated
          </li>
          {result.skipped > 0 && (
            <li className="text-slate-500">
              {result.skipped.toLocaleString()} rows skipped because they had no email or phone
            </li>
          )}
        </ul>
        <div className="mt-5 flex gap-2">
          <Link href={`/w/${workspaceId}/contacts`} className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">
            View contacts
          </Link>
          <Button variant="secondary" onClick={() => { setResult(null); setHeaders([]); setData([]); }}>
            Import another file
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <h2 className="font-semibold">1. Choose a CSV file</h2>
        <p className="mb-3 mt-1 text-sm text-slate-500">Export from a spreadsheet, another CRM or a booking tool. The first row should be column names.</p>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          className="block text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100"
        />
        {fileName && <p className="mt-2 text-sm text-slate-600">{fileName}: {data.length.toLocaleString()} rows</p>}
      </Card>

      {headers.length > 0 && (
        <>
          <Card className="p-6">
            <h2 className="font-semibold">2. Match the columns</h2>
            <p className="mb-4 mt-1 text-sm text-slate-500">Each row needs an email or a phone number to be imported.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">Column in your file</th>
                    <th className="pb-2 pr-4 font-medium">Example</th>
                    <th className="pb-2 font-medium">Import as</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {headers.map((h) => (
                    <tr key={h}>
                      <td className="py-2 pr-4 font-medium">{h}</td>
                      <td className="max-w-48 truncate py-2 pr-4 text-slate-500">{data.find((r) => r[h])?.[h] ?? ""}</td>
                      <td className="py-2">
                        <Select
                          aria-label={`Import ${h} as`}
                          value={mapping[h] ?? ""}
                          onChange={(e) => setMapping({ ...mapping, [h]: e.target.value as FieldKey | "" })}
                          className="h-9"
                        >
                          <option value="">Don&apos;t import</option>
                          {FIELDS.map((f) => (
                            <option key={f.key} value={f.key} disabled={mapped.has(f.key) && mapping[h] !== f.key}>
                              {f.label}
                            </option>
                          ))}
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm text-slate-600">
              {usable.toLocaleString()} of {rows.length.toLocaleString()} rows have an email or phone.
            </p>
          </Card>

          <Card className="p-6">
            <h2 className="font-semibold">3. Text message consent</h2>
            <p className="mb-4 mt-1 text-sm text-slate-500">
              Only text people who agreed to it. Contacts who opted out stay opted out, whatever you pick here.
            </p>
            <div className="space-y-2 text-sm">
              <label className="flex items-start gap-2">
                <input type="radio" name="consent" checked={consent === "none"} onChange={() => setConsent("none")} className="mt-1 accent-brand-600" />
                <span>
                  <strong>Not sure, or no.</strong> Import them for email only. You can record consent later.
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="consent" checked={consent === "granted"} onChange={() => setConsent("granted")} className="mt-1 accent-brand-600" />
                <span>
                  <strong>Yes, everyone on this list agreed to receive texts.</strong>
                </span>
              </label>
              {consent === "granted" && (
                <div className="ml-6 max-w-md">
                  <Field label="How did they agree?" name="consentSource">
                    <Input
                      id="consentSource"
                      value={consentSource}
                      onChange={(e) => setConsentSource(e.target.value)}
                      placeholder="e.g. Past customers who opted in at checkout"
                    />
                  </Field>
                </div>
              )}
            </div>
          </Card>

          <Card className="p-6">
            <h2 className="font-semibold">4. Tag this import (optional)</h2>
            <div className="mt-3 max-w-md">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. past customer, 2025 list" aria-label="Tags for this import" />
            </div>
          </Card>

          <FormError message={error} />
          <Button onClick={runImport} disabled={!canImport}>
            {progress !== null
              ? `Importing… ${progress.toLocaleString()} of ${rows.length.toLocaleString()}`
              : `Import ${usable.toLocaleString()} contacts`}
          </Button>
        </>
      )}
      {!headers.length && <FormError message={error} />}
    </div>
  );
}
