// Blog posts for /blog, read from content/blog/<slug>.html.
//
// ONE FILE PER POST, IN THE FORMAT MODULE 16 PRODUCES. LumiLink's site isn't
// Shopify, so an approved seo-content article arrives as a "Do by hand" step:
// a headline, a meta description, an image link and body HTML. Publishing it
// is a new file here with that HTML pasted below a short header:
//
//   ---
//   title: How Missed Calls Cost Service Businesses
//   description: The meta description, 150 characters or so.
//   date: 2026-10-06
//   updated: 2026-10-20          (optional)
//   image: https://...           (optional, absolute URL)
//   imageAlt: What the image shows   (required when image is set)
//   ---
//   <h2>...</h2>
//   <p>...</p>
//
// The file name is the URL: content/blog/missed-calls.html → /blog/missed-calls.
//
// THE BODY USES MODULE 16'S WHITELIST, CHECKED HERE TOO. Only h2, h3, p, ul,
// ol, li, strong and em, with no attributes, balanced (seo-content/lib.ts
// ALLOWED_TAG). That's what makes rendering it with dangerouslySetInnerHTML
// safe, so a hand-written post gets held to the same rule: anything else
// (a link, an image, a script) throws, and the page errors rather than
// publishing it. scripts/test-blog.ts checks every file in content/blog.
//
// No dependencies: the header is "key: value" lines, not YAML.

import fs from "node:fs";
import path from "node:path";

export type BlogPost = {
  slug: string;
  title: string;
  description: string;
  /** YYYY-MM-DD */
  date: string;
  updated: string | null;
  image: string | null;
  imageAlt: string | null;
  html: string;
};

// process.cwd() is the app root under `next start` (Railway) and a plain
// `next dev`. The documented local preview (support-dashboard-local in the
// parent folder's .claude/launch.json) runs `next dev support-dashboard` from
// one level up, where cwd is the parent, so look there too. Without this the
// blog renders empty in that preview with no error.
function blogDir(): string {
  const candidates = [
    path.join(process.cwd(), "content", "blog"),
    path.join(process.cwd(), "support-dashboard", "content", "blog"),
  ];
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
}
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_TAG = /^<(\/?)(h2|h3|p|ul|ol|li|strong|em)>$/i;
const HEADER_KEYS = ["title", "description", "date", "updated", "image", "imageAlt"];

/** null when the markup is fine; otherwise why not. Same rule as seo-content. */
export function checkMarkup(html: string): string | null {
  const stack: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const gt = html.indexOf(">", lt);
    if (gt === -1) return "an unterminated tag";
    const tag = html.slice(lt, gt + 1);
    const m = tag.match(ALLOWED_TAG);
    if (!m) return `a disallowed tag or attribute: ${tag.slice(0, 40)}`;
    const name = m[2].toLowerCase();
    if (m[1]) {
      if (stack.pop() !== name) return `mismatched </${name}>`;
    } else {
      stack.push(name);
    }
    i = gt + 1;
  }
  if (stack.length) return `an unclosed <${stack[stack.length - 1]}>`;
  return null;
}

function isValidDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Parses one post file. Throws with the file name and the reason. */
export function parsePost(slug: string, source: string): BlogPost {
  const fail = (why: string): never => {
    throw new Error(`content/blog/${slug}.html: ${why}`);
  };
  if (!SLUG.test(slug)) fail("file name must be lowercase words joined by hyphens");

  const text = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) fail("must start with a --- header block");
  const [, header, body] = m!;

  const fields: Record<string, string> = {};
  for (const line of header.split("\n")) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon === -1) fail(`header line has no "key: value": ${line}`);
    const key = line.slice(0, colon).trim();
    if (!HEADER_KEYS.includes(key)) fail(`unknown header key "${key}"`);
    fields[key] = line.slice(colon + 1).trim();
  }

  const title = fields.title || fail("title is required");
  const description = fields.description || fail("description is required");
  const date = fields.date || fail("date is required");
  if (!isValidDate(date)) fail(`date must be a real YYYY-MM-DD date, got "${date}"`);
  const updated = fields.updated || null;
  if (updated && !isValidDate(updated)) fail(`updated must be YYYY-MM-DD, got "${updated}"`);
  if (updated && updated < date) fail("updated is earlier than date");

  const image = fields.image || null;
  if (image && !/^https:\/\//.test(image)) fail("image must be an https:// URL");
  const imageAlt = fields.imageAlt || null;
  if (image && !imageAlt) fail("imageAlt is required when image is set");

  const html = body.trim();
  if (!html) fail("the body is empty");
  const markup = checkMarkup(html);
  if (markup) fail(`the body has ${markup}`);

  return { slug, title, description, date, updated, image, imageAlt, html };
}

let cache: BlogPost[] | null = null;

/**
 * Every post, newest first. In production the files are read once per server
 * process (they only change with a deploy); in dev, on every call, so a new
 * post shows up without a restart.
 */
export function getAllPosts(): BlogPost[] {
  if (cache && process.env.NODE_ENV === "production") return cache;
  const dir = blogDir();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
  } catch {
    files = []; // no content/blog directory yet: no posts
  }
  const posts = files.map((f) =>
    parsePost(f.slice(0, -".html".length), fs.readFileSync(path.join(dir, f), "utf8")),
  );
  posts.sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : b.date.localeCompare(a.date)));
  cache = posts;
  return posts;
}

export function getPost(slug: string): BlogPost | null {
  return getAllPosts().find((p) => p.slug === slug) ?? null;
}

/** "October 6, 2026". Dates are calendar days, so format in UTC. */
export function formatPostDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
