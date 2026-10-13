"use client";

import { useState } from "react";
import { Button, buttonClass, Input } from "./ui";

/** A read-only value with a Copy button (and an Open button for links). */
export function CopyField({ label, value, open }: { label: string; value: string; open?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 text-sm font-medium text-slate-700">{label}</div>
      <div className="flex gap-2">
        <Input readOnly value={value} aria-label={label} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button
          type="button"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        {open && (
          <a href={value} target="_blank" rel="noreferrer" className={buttonClass("secondary")}>
            Open
          </a>
        )}
      </div>
    </div>
  );
}
