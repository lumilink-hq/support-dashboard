"use client";

import { useState } from "react";

/**
 * Read-only value with a copy-to-clipboard button. Used for the per-client
 * inbound forwarding address in Settings.
 */
export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — silently ignore;
      // the value is still selectable in the input.
    }
  }

  return (
    <div className="mt-1 flex gap-2">
      <input
        value={value}
        readOnly
        onFocus={(e) => e.currentTarget.select()}
        className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-900 outline-none"
      />
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
