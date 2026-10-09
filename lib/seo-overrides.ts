// Page titles and meta descriptions set from /seo-approvals (2026-10-09).
//
// When a title or description fix for lumilinkhub.com is approved, the SEO
// publisher (supabase/functions/seo-publish, GitHub connection) commits it to
// content/seo-overrides.json:
//
//   { "/pricing": { "title": "...", "description": "..." } }
//
// and each indexable page passes its metadata through withSeoOverrides, so the
// approved text replaces what's in the code. Rolling back from /seo-approvals
// removes the entry again. GITHUB_OVERRIDE_PATHS (github-lib.ts) lists the pages
// the publisher may write to; scripts/test-seo-overrides.ts checks every one
// of them calls this.

import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { parseOverrides, type Overrides } from "@/supabase/functions/seo-publish/github-lib";

// Same working-directory rule as lib/blog.ts: the documented local preview runs
// `next dev support-dashboard` from the parent folder.
function overridesFile(): string {
  const candidates = [
    path.join(process.cwd(), "content", "seo-overrides.json"),
    path.join(process.cwd(), "support-dashboard", "content", "seo-overrides.json"),
  ];
  return candidates.find((f) => fs.existsSync(f)) ?? candidates[0];
}

let cache: Overrides | null = null;

/** In production the file is read once per server process (it only changes with a deploy). */
export function loadOverrides(): Overrides {
  if (cache && process.env.NODE_ENV === "production") return cache;
  let text: string | null = null;
  try {
    text = fs.readFileSync(overridesFile(), "utf8");
  } catch {
    text = null; // no overrides yet
  }
  cache = parseOverrides(text);
  return cache;
}

/** `metadata` with any approved title/description for `pagePath` applied. */
export function applySeoOverrides(pagePath: string, metadata: Metadata, overrides: Overrides): Metadata {
  const o = overrides[pagePath];
  if (!o) return metadata;
  const out: Metadata = { ...metadata };
  if (o.title) out.title = o.title;
  if (o.description) out.description = o.description;
  if (metadata.openGraph && (o.title || o.description)) {
    out.openGraph = { ...metadata.openGraph, ...(o.title ? { title: o.title } : {}), ...(o.description ? { description: o.description } : {}) };
  }
  return out;
}

export function withSeoOverrides(pagePath: string, metadata: Metadata): Metadata {
  return applySeoOverrides(pagePath, metadata, loadOverrides());
}
