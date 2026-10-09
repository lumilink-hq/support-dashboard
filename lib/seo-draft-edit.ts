// Editing a draft on /seo-approvals before approving it (2026-10-09).
//
// HELD TO THE ENGINE'S RULES. An edited page fix goes through seo-draft's
// validateDraft and an edited article through seo-content's
// validateArticleBody, the same checks the model's output passes: lengths, no
// URLs or phone numbers, no unbacked claims, the tag whitelist. A person's
// edit is still published under the business's name, and the publisher
// (seo-publish) trusts what's stored.
//
// THE ARTICLE IS EDITED AS PLAIN TEXT, not HTML:
//   ## Heading          → <h2>
//   ### Subheading      → <h3>
//   - item              → <ul><li>   (consecutive lines)
//   1. item             → <ol><li>   (consecutive lines)
//   **bold** / *italic* → <strong> / <em>
//   anything else       → <p>, paragraphs separated by a blank line
// htmlToEditText goes the other way, so the box opens with the draft as the
// engine wrote it. Only the whitelisted tags exist on either side.
//
// Pure (no Next, no Supabase): scripts/test-seo-draft-edit.ts.

import { validateDraft, type DraftField } from "../supabase/functions/seo-draft/lib";
import { validateArticleBody, type ArticleCtx, type Block } from "../supabase/functions/seo-content/lib";

export type EditableField = Exclude<DraftField, "local_business_schema">;
export const EDITABLE_FIELDS: readonly EditableField[] = ["title_tag", "meta_description", "h1"];

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m);
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Inline **bold** and *italic*, on already-escaped text. */
function inline(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, "$1<em>$2</em>");
}

/** The engine's body HTML as editable text. */
export function htmlToEditText(html: string): string {
  let s = html.replace(/\r\n/g, "\n");
  s = s.replace(/<strong>([\s\S]*?)<\/strong>/gi, "**$1**").replace(/<em>([\s\S]*?)<\/em>/gi, "*$1*");
  s = s.replace(/<ol>([\s\S]*?)<\/ol>/gi, (_, inner: string) => {
    let n = 0;
    return "\n\n" + inner.replace(/<li>([\s\S]*?)<\/li>/gi, (_m: string, t: string) => `${++n}. ${t.trim()}\n`).trim() + "\n\n";
  });
  s = s.replace(/<ul>([\s\S]*?)<\/ul>/gi, (_, inner: string) => "\n\n" + inner.replace(/<li>([\s\S]*?)<\/li>/gi, (_m: string, t: string) => `- ${t.trim()}\n`).trim() + "\n\n");
  s = s.replace(/<h2>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n").replace(/<h3>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n");
  s = s.replace(/<p>([\s\S]*?)<\/p>/gi, "\n\n$1\n\n");
  s = s.replace(/<[^>]+>/g, "");
  return decode(s).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Editable text back to whitelisted HTML. */
export function editTextToHtml(text: string): string {
  const out: string[] = [];
  const chunks = text.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
  for (const chunk of chunks) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 1 && /^###\s+/.test(lines[0])) {
      out.push(`<h3>${inline(escape(lines[0].replace(/^###\s+/, "")))}</h3>`);
    } else if (lines.length === 1 && /^##\s+/.test(lines[0])) {
      out.push(`<h2>${inline(escape(lines[0].replace(/^##\s+/, "")))}</h2>`);
    } else if (lines.every((l) => /^[-*]\s+/.test(l))) {
      out.push(`<ul>${lines.map((l) => `<li>${inline(escape(l.replace(/^[-*]\s+/, "")))}</li>`).join("")}</ul>`);
    } else if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
      out.push(`<ol>${lines.map((l) => `<li>${inline(escape(l.replace(/^\d+[.)]\s+/, "")))}</li>`).join("")}</ol>`);
    } else {
      out.push(`<p>${inline(escape(lines.join(" ")))}</p>`);
    }
  }
  return out.join("\n");
}

export type PageFixEdit = { ok: true; text: string } | { ok: false; reason: string };

/** A title, meta description or H1. `previous` is what's on the page now. */
export function editPageFix(field: string, raw: string, previous: string | null): PageFixEdit {
  if (!(EDITABLE_FIELDS as readonly string[]).includes(field)) return { ok: false, reason: "this kind of draft can't be edited" };
  const v = validateDraft(field as EditableField, raw, previous);
  return v.ok ? v : { ok: false, reason: v.reason.replace(/^draft /, "it ") };
}

export type ArticleEdit =
  | { ok: true; title: string; meta_description: string; body_html: string; blocks: Block[]; word_count: number }
  | { ok: false; reason: string };

export function editArticle(input: { title: string; meta: string; body: string }, ctx: ArticleCtx): ArticleEdit {
  const title = input.title.replace(/\s+/g, " ").trim();
  const meta = input.meta.replace(/\s+/g, " ").trim();
  const html = editTextToHtml(input.body);
  const v = validateArticleBody({ title, meta, html }, ctx);
  if (!v.ok) return v;
  return { ok: true, title, meta_description: meta, body_html: html, blocks: v.article.blocks, word_count: v.article.word_count };
}
