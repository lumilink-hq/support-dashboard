// =============================================================================
// seo-crawl — module 6 (plan.md), extended by module 24: crawl a location's
// site and write on-page and site-wide SEO findings.
//
//   POST /seo-crawl
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "location_id": "<uuid>" }
//
// Admin endpoint, same posture as product-sync/google-token-refresh: the
// shared secret is the whole gate, dispatched only by request_seo_crawl
// (0049, 0064) via pg_cron -> pg_net. Deploy with --no-verify-jwt.
//
// A CRAWL IS A RUN (module 24, 0064). The page set is the sitemap plus links
// found on the pages, up to the client's crawl_page_limit (default 100). That
// doesn't fit one call, so each call does one ~40-second STEP and saves its
// place in seo_crawl_runs:
//   pages — fetch queued pages politely (robots.txt, 250 ms apart), record
//           each page's facts and its own findings in seo_crawl_pages;
//   links — check linked URLs that weren't crawled (internal ones beyond the
//           limit, and outbound ones) into seo_crawl_link_checks;
//   done  — run the site-wide rules (site.ts), write all findings at once,
//           drop older runs' rows, settle the job for next week.
// An unfinished step settles the job CONTINUE_MINUTES out instead of a week;
// the cron tick (every 5 minutes since 0064) picks it up. A small site still
// finishes in one call.
//
// FINDING LIFECYCLE: unchanged. Open 'crawl' findings for the location are
// DELETED and replaced with the finished run's set; dismissed/actioned ones
// are untouched. Nothing is written mid-run, so a half-done crawl never
// replaces a complete set with a partial one.
//
// "FAIL CLEARLY INSTEAD OF RETURNING EMPTY RESULTS" (plan.md): a robots.txt
// block, a homepage that can't be fetched, or a JavaScript-rendered site
// still writes ONE critical finding and ends the run, as before.
//
// HEADLESS-BROWSER FALLBACK (2026-09-22, render-service/): unchanged. When the
// homepage looks JS-rendered and RENDER_SERVICE_URL is set, one render is
// tried; if it has real content it replaces the homepage's HTML for its audit
// and its links. Other pages are fetched plainly.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET, SEO_CRAWL_USER_AGENT (optional), RENDER_SERVICE_URL
//      and RENDER_SERVICE_SECRET (optional), SEO_CRAWL_STEP_MS (optional, tests).
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import {
  auditPage,
  extractMetaDescription,
  extractTitle,
  isAllowedByRobots,
  normalizeUrl,
  visibleWordCount,
  type CrawlFinding,
} from "./lib.ts";
import {
  auditSite,
  DEFAULT_PAGE_LIMIT,
  extractCanonicals,
  extractLinks,
  isNoindex,
  type LinkCheck,
  MAX_CHILD_SITEMAPS,
  MAX_INTERNAL_CHECKS,
  MAX_OUTBOUND_CHECKS,
  type PageFact,
  parseSitemap,
  sameSite,
  sitemapPages,
  sitemapsFromRobots,
} from "./site.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");
const RENDER_SERVICE_URL = Deno.env.get("RENDER_SERVICE_URL");
const RENDER_SERVICE_SECRET = Deno.env.get("RENDER_SERVICE_SECRET");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const USER_AGENT =
  Deno.env.get("SEO_CRAWL_USER_AGENT") ??
  "LumilinkSeoBot/1.0 (+https://lumilinkhub.com/bot; SEO audit for our customer's own site)";

const FETCH_TIMEOUT_MS = 15_000;
const LINK_CHECK_TIMEOUT_MS = 10_000;
const RENDER_TIMEOUT_MS = 20_000; // generous: the render service's own Playwright nav timeout is 15s
const MAX_REDIRECT_HOPS = 5;
const PAGE_GAP_MS = 250; // between requests to the client's own server
const OUTBOUND_BATCH = 5; // outbound checks hit other sites, so a few at once
// A JS-rendered shell has SOME markup but almost no prose — far below
// thin-content's 300-word bar. This catches "basically nothing rendered".
const JS_RENDERED_WORD_THRESHOLD = 40;

const STEP_BUDGET_MS = Number(Deno.env.get("SEO_CRAWL_STEP_MS") ?? 40_000);
const STALE_RUN_MS = 24 * 60 * 60 * 1000; // an unfinished run older than this starts over
const CONTINUE_MINUTES = 2;
const BASE_INTERVAL_MINUTES = 7 * 24 * 60; // weekly, per plan.md's scheduled-jobs table
const MAX_BACKOFF_MINUTES = 24 * 60;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// Fetching
// -----------------------------------------------------------------------------

type Fetched = {
  status: number; // 0 = no answer
  finalUrl: string;
  hops: number;
  html: string | null;
  xRobots: string | null;
  error: string | null;
};

function classifyError(e: unknown): string {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (/abort/i.test(msg)) return "timeout";
  if (/dns|name.*(not|resolution)|lookup|resolve|getaddrinfo|ENOTFOUND/i.test(msg)) return "dns";
  return "network";
}

/**
 * Follows redirects by hand so the hops are counted. Reads the body only when
 * HTML is wanted and the answer is HTML; otherwise cancels it.
 */
async function fetchPage(url: string, opts: { wantHtml: boolean; method?: "GET" | "HEAD"; timeoutMs?: number }): Promise<Fetched> {
  let current = url;
  let hops = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    for (;;) {
      const res = await fetch(current, {
        method: opts.method ?? "GET",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
        redirect: "manual",
        signal: controller.signal,
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        hops++;
        const next = new URL(location, current).href;
        if (hops > MAX_REDIRECT_HOPS) {
          return { status: res.status, finalUrl: normalizeUrl(next), hops, html: null, xRobots: null, error: "too_many_redirects" };
        }
        current = next;
        continue;
      }
      const ctype = res.headers.get("content-type") ?? "";
      const isHtml = /text\/html|application\/xhtml/i.test(ctype);
      let html: string | null = null;
      if (opts.wantHtml && res.ok && isHtml) html = await res.text();
      else await res.body?.cancel();
      return { status: res.status, finalUrl: normalizeUrl(current), hops, html, xRobots: res.headers.get("x-robots-tag"), error: null };
    }
  } catch (e) {
    return { status: 0, finalUrl: normalizeUrl(current), hops, html: null, xRobots: null, error: classifyError(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** A plain GET for a robots.txt or sitemap: text, any content type. */
async function fetchTextFile(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One call to render-service, if configured. Null on any failure, never throws. */
async function tryRender(url: string): Promise<string | null> {
  if (!RENDER_SERVICE_URL || !RENDER_SERVICE_SECRET) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    const res = await fetch(RENDER_SERVICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-render-secret": RENDER_SERVICE_SECRET },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { html?: unknown } | null;
    return typeof body?.html === "string" ? body.html : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Run state
// -----------------------------------------------------------------------------

type LocationRow = {
  id: string;
  client_id: string;
  name: string | null;
  website_url: string | null;
  phone_number: string | null;
};

type Run = {
  location_id: string;
  client_id: string;
  run_id: string;
  phase: "pages" | "links" | "done";
  site_host: string;
  root_url: string;
  page_limit: number;
  queue: string[];
  link_queue: string[];
  sitemap_found: boolean;
  sitemap_url_count: number;
  sitemap_urls: string[];
  pages_crawled: number;
  truncated: boolean;
  rendered_root: boolean;
  started_at: string;
};

type PageRow = PageFact & { word_count: number | null; page_findings: CrawlFinding[] };

async function saveRun(run: Run): Promise<void> {
  const { error } = await supabase.from("seo_crawl_runs").upsert(
    {
      location_id: run.location_id,
      client_id: run.client_id,
      run_id: run.run_id,
      phase: run.phase,
      site_host: run.site_host,
      root_url: run.root_url,
      page_limit: run.page_limit,
      queue: run.queue,
      link_queue: run.link_queue,
      sitemap_found: run.sitemap_found,
      sitemap_url_count: run.sitemap_url_count,
      sitemap_urls: run.sitemap_urls,
      pages_crawled: run.pages_crawled,
      truncated: run.truncated,
      rendered_root: run.rendered_root,
      started_at: run.started_at,
      finished_at: run.phase === "done" ? new Date().toISOString() : null,
    },
    { onConflict: "location_id" },
  );
  if (error) throw new Error(`saving the crawl run failed: ${error.message}`);
}

async function savePages(loc: LocationRow, run: Run, rows: PageRow[]): Promise<void> {
  if (!rows.length) return;
  const { error } = await supabase.from("seo_crawl_pages").upsert(
    rows.map((r) => ({
      location_id: loc.id,
      client_id: loc.client_id,
      run_id: run.run_id,
      url: r.url,
      status_code: r.status_code,
      final_url: r.final_url,
      redirect_hops: r.redirect_hops,
      in_sitemap: r.in_sitemap,
      is_root: r.is_root,
      title: r.title,
      meta_description: r.meta_description,
      canonicals: r.canonicals,
      noindex: r.noindex,
      word_count: r.word_count,
      internal_links: r.internal_links,
      outbound_links: r.outbound_links,
      page_findings: r.page_findings,
    })),
    { onConflict: "location_id,run_id,url" },
  );
  if (error) throw new Error(`saving crawled pages failed: ${error.message}`);
}

async function pageLimitFor(clientId: string): Promise<number> {
  const { data } = await supabase.from("seo_client_settings").select("crawl_page_limit").eq("client_id", clientId).maybeSingle();
  const n = Number(data?.crawl_page_limit);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_PAGE_LIMIT;
}

function robotsCheck(robots: string | null) {
  return (u: string) => {
    try {
      return isAllowedByRobots(robots, new URL(u).pathname, "lumilinkseobot");
    } catch {
      return false;
    }
  };
}

/** Facts about one fetched page, plus its own (page-level) findings. */
function pageRow(url: string, f: Fetched, html: string | null, loc: LocationRow, siteHost: string, inSitemap: boolean, isRoot: boolean): PageRow {
  const base = f.hops > 0 ? f.finalUrl : url;
  const links = html ? extractLinks(html, base, siteHost) : { internal: [], outbound: [] };
  return {
    url,
    status_code: f.status,
    final_url: f.hops > 0 ? f.finalUrl : null,
    redirect_hops: f.hops,
    in_sitemap: inSitemap,
    is_root: isRoot,
    title: html ? extractTitle(html) : null,
    meta_description: html ? extractMetaDescription(html) : null,
    canonicals: html ? extractCanonicals(html, base) : [],
    noindex: html ? isNoindex(html, f.xRobots) : !!f.xRobots && /\bnoindex\b/i.test(f.xRobots),
    word_count: html ? visibleWordCount(html) : null,
    internal_links: links.internal,
    outbound_links: links.outbound,
    page_findings: html ? auditPage(html, { name: loc.name, phone_number: loc.phone_number }, { isRoot }) : [],
  };
}

// -----------------------------------------------------------------------------
// Steps
// -----------------------------------------------------------------------------

/** Starts a run: robots, homepage, render fallback, sitemap, first queue.
 * Returns null when the run ended right away with a "couldn't audit" finding. */
async function startRun(loc: LocationRow): Promise<Run | null> {
  const startUrl = normalizeUrl(loc.website_url!);
  const origin = new URL(startUrl).origin;
  const robots = await fetchTextFile(new URL("/robots.txt", origin).toString());
  const allowed = robotsCheck(robots);

  const endRun = async (status: Parameters<typeof settleCrawl>[1], error: string, finding: CrawlFinding) => {
    await settleCrawl(loc, status, error, [{ ...finding, target_url: startUrl }]);
    await supabase.from("seo_crawl_runs").delete().eq("location_id", loc.id);
    return null;
  };

  if (!allowed(startUrl)) {
    return endRun("robots_disallowed", `robots.txt on ${origin} disallows crawling`, {
      finding_type: "robots_disallowed",
      severity: "critical",
      title: "robots.txt blocks LumiLink from auditing this site",
      details: { origin },
    });
  }

  const root = await fetchPage(startUrl, { wantHtml: true });
  if (root.html === null) {
    return endRun("fetch_failed", `could not fetch ${startUrl}`, {
      finding_type: "crawl_fetch_failed",
      severity: "critical",
      title: "Couldn't fetch this site to audit it",
      details: { url: startUrl, status: root.status, error: root.error },
    });
  }

  let rootHtml = root.html;
  let rendered = false;
  if (visibleWordCount(root.html) < JS_RENDERED_WORD_THRESHOLD) {
    const html = await tryRender(startUrl);
    const renderedWords = html !== null ? visibleWordCount(html) : null;
    if (html !== null && renderedWords !== null && renderedWords >= JS_RENDERED_WORD_THRESHOLD) {
      rootHtml = html;
      rendered = true;
    } else {
      const note =
        html !== null
          ? "Rendered with a headless browser, but the page still had almost no text — likely broken, not just JS-rendered."
          : RENDER_SERVICE_URL
            ? "The headless-browser fallback was attempted but failed or timed out."
            : "The headless-browser fallback isn't configured (RENDER_SERVICE_URL unset).";
      return endRun("js_rendered", `root page has almost no visible text after a plain fetch (${note})`, {
        finding_type: "javascript_rendered_site",
        severity: "critical",
        title: "This site appears JavaScript-rendered — a plain fetch can't audit it",
        details: {
          url: startUrl,
          word_count: visibleWordCount(root.html),
          render_attempted: html !== null || RENDER_SERVICE_URL != null,
          render_word_count: renderedWords,
          note,
        },
      });
    }
  }

  const siteHost = new URL(root.finalUrl).host;

  // Sitemap: robots.txt's Sitemap lines, else /sitemap.xml. An index is
  // followed one level, up to MAX_CHILD_SITEMAPS children.
  const locs: string[] = [];
  let sitemapFound = false;
  const declared = sitemapsFromRobots(robots);
  for (const sm of declared.length ? declared : [new URL("/sitemap.xml", root.finalUrl).toString()]) {
    const parsed = parseSitemap(await fetchTextFile(sm));
    if (parsed.kind === "unknown") continue;
    sitemapFound = true;
    if (parsed.kind === "urlset") locs.push(...parsed.locs);
    else {
      for (const child of parsed.locs.slice(0, MAX_CHILD_SITEMAPS)) {
        await sleep(PAGE_GAP_MS);
        const c = parseSitemap(await fetchTextFile(child));
        if (c.kind === "urlset") locs.push(...c.locs);
      }
    }
  }
  const sitemap = sitemapPages(locs, siteHost);
  const sitemapSet = new Set(sitemap);

  const pageLimit = await pageLimitFor(loc.client_id);
  // The homepage is recorded where it lands (website_url → https://www. is
  // normal, and module 17 already reports a long redirect chain there), so a
  // sitemap listing the final URL isn't mistaken for "lists a redirect".
  const rootRow = pageRow(root.finalUrl, { ...root, hops: 0 }, rootHtml, loc, siteHost, sitemapSet.has(root.finalUrl), true);

  const seen = new Set([startUrl, root.finalUrl]);
  const queue: string[] = [];
  for (const u of [...sitemap, ...rootRow.internal_links]) {
    if (seen.has(u) || !allowed(u)) continue;
    seen.add(u);
    queue.push(u);
  }

  const run: Run = {
    location_id: loc.id,
    client_id: loc.client_id,
    run_id: crypto.randomUUID(),
    phase: "pages",
    site_host: siteHost,
    root_url: startUrl,
    page_limit: pageLimit,
    queue,
    link_queue: [],
    sitemap_found: sitemapFound,
    sitemap_url_count: sitemap.length,
    sitemap_urls: sitemap,
    pages_crawled: 1,
    truncated: false,
    rendered_root: rendered,
    started_at: new Date().toISOString(),
  };
  await saveRun(run);
  await savePages(loc, run, [rootRow]);
  return run;
}

/** Fetch queued pages until the queue is empty, the limit is reached, or the
 * step's time is up. Discovered links join the end of the queue. */
async function crawlPages(loc: LocationRow, run: Run, deadline: number): Promise<void> {
  const robots = await fetchTextFile(new URL("/robots.txt", run.root_url).toString());
  const allowed = robotsCheck(robots);
  const sitemapSet = new Set(run.sitemap_urls);

  const { data: done, error } = await supabase.from("seo_crawl_pages").select("url, final_url").eq("location_id", loc.id).eq("run_id", run.run_id);
  if (error) throw new Error(`reading crawled pages failed: ${error.message}`);
  const seen = new Set<string>();
  for (const d of done ?? []) {
    seen.add(d.url);
    if (d.final_url) seen.add(d.final_url);
  }
  const queued = new Set(run.queue);

  let batch: PageRow[] = [];
  while (run.queue.length && run.pages_crawled < run.page_limit && Date.now() < deadline) {
    const url = run.queue.shift()!;
    queued.delete(url);
    if (seen.has(url)) continue;
    seen.add(url);

    await sleep(PAGE_GAP_MS);
    const f = await fetchPage(url, { wantHtml: true });
    // A URL that redirects records only its status and hops. Its HTML belongs
    // to the page it lands on, which is crawled in its own right (below), so
    // auditing it here would report that page's copy twice.
    const row = pageRow(url, f, f.hops > 0 ? null : f.html, loc, run.site_host, sitemapSet.has(url), false);
    batch.push(row);
    run.pages_crawled++;

    // A redirect to another page on the site: crawl where it lands, too.
    const next = [...row.internal_links];
    if (f.hops > 0 && sameSite(f.finalUrl, run.site_host)) next.unshift(f.finalUrl);
    for (const l of next) {
      if (seen.has(l) || queued.has(l) || !allowed(l)) continue;
      queued.add(l);
      run.queue.push(l);
    }

    if (batch.length >= 10) {
      await savePages(loc, run, batch);
      batch = [];
      await saveRun(run);
    }
  }
  await savePages(loc, run, batch);

  if (!run.queue.length || run.pages_crawled >= run.page_limit) {
    run.truncated = run.queue.some((u) => !seen.has(u));
    run.link_queue = await buildLinkQueue(loc, run, allowed);
    run.queue = [];
    run.phase = "links";
  }
  await saveRun(run);
}

/** Linked URLs the rules need a status for but that weren't crawled: internal
 * targets (and canonicals) beyond the crawl, then outbound links. Prefixed
 * "i:" / "o:" so the check knows how to treat each. */
async function buildLinkQueue(loc: LocationRow, run: Run, allowed: (u: string) => boolean): Promise<string[]> {
  const { data, error } = await supabase
    .from("seo_crawl_pages")
    .select("url, final_url, internal_links, outbound_links, canonicals")
    .eq("location_id", loc.id)
    .eq("run_id", run.run_id);
  if (error) throw new Error(`reading crawled pages failed: ${error.message}`);
  const rows = (data ?? []) as { url: string; final_url: string | null; internal_links: string[]; outbound_links: string[]; canonicals: string[] }[];
  const crawled = new Set(rows.flatMap((r) => [r.url, ...(r.final_url ? [r.final_url] : [])]));
  const internal = new Set<string>();
  const outbound = new Set<string>();
  for (const r of rows) {
    for (const t of [...r.internal_links, ...r.canonicals.filter((c) => sameSite(c, run.site_host))]) {
      // robots.txt applies to a status check of the client's site too.
      if (!crawled.has(t) && allowed(t) && internal.size < MAX_INTERNAL_CHECKS) internal.add(t);
    }
    for (const t of r.outbound_links) if (outbound.size < MAX_OUTBOUND_CHECKS) outbound.add(t);
  }
  return [...[...internal].map((u) => `i:${u}`), ...[...outbound].map((u) => `o:${u}`)];
}

async function checkOne(item: string): Promise<LinkCheck> {
  const internal = item.startsWith("i:");
  const url = item.slice(2);
  // HEAD first; plenty of servers refuse or mishandle it, so a refusal is
  // retried as a GET whose body is never read.
  let f = await fetchPage(url, { wantHtml: false, method: "HEAD", timeoutMs: LINK_CHECK_TIMEOUT_MS });
  if (f.status === 0 || f.status === 400 || f.status === 403 || f.status === 405 || f.status === 501) {
    const g = await fetchPage(url, { wantHtml: false, method: "GET", timeoutMs: LINK_CHECK_TIMEOUT_MS });
    if (g.status !== 0 || f.status === 0) f = g;
  }
  return {
    url,
    status_code: f.status,
    final_url: f.hops > 0 ? f.finalUrl : null,
    redirect_hops: internal ? f.hops : 0,
    error: f.error,
  };
}

async function checkLinks(loc: LocationRow, run: Run, deadline: number): Promise<void> {
  const results: LinkCheck[] = [];
  while (run.link_queue.length && Date.now() < deadline) {
    const head = run.link_queue[0];
    if (head.startsWith("i:")) {
      run.link_queue.shift();
      await sleep(PAGE_GAP_MS);
      results.push(await checkOne(head));
    } else {
      const batch = run.link_queue.splice(0, OUTBOUND_BATCH).filter((x) => x.startsWith("o:"));
      results.push(...(await Promise.all(batch.map(checkOne))));
    }
  }
  if (results.length) {
    const { error } = await supabase.from("seo_crawl_link_checks").upsert(
      results.map((r) => ({ location_id: loc.id, client_id: loc.client_id, run_id: run.run_id, ...r })),
      { onConflict: "location_id,run_id,url" },
    );
    if (error) throw new Error(`saving link checks failed: ${error.message}`);
  }
  if (!run.link_queue.length) run.phase = "done";
  await saveRun(run);
}

/** Site-wide rules over the finished run, then the one findings write. */
async function finish(loc: LocationRow, run: Run): Promise<number> {
  const [{ data: pageData, error: pErr }, { data: checkData, error: cErr }] = await Promise.all([
    supabase
      .from("seo_crawl_pages")
      .select("url, status_code, final_url, redirect_hops, in_sitemap, is_root, title, meta_description, canonicals, noindex, internal_links, outbound_links, page_findings")
      .eq("location_id", loc.id)
      .eq("run_id", run.run_id),
    supabase.from("seo_crawl_link_checks").select("url, status_code, final_url, redirect_hops, error").eq("location_id", loc.id).eq("run_id", run.run_id),
  ]);
  if (pErr) throw new Error(`reading crawled pages failed: ${pErr.message}`);
  if (cErr) throw new Error(`reading link checks failed: ${cErr.message}`);
  const pages = (pageData ?? []) as (PageFact & { page_findings: CrawlFinding[] })[];

  const findings: (CrawlFinding & { target_url: string })[] = [];
  for (const p of pages) for (const f of p.page_findings ?? []) findings.push({ ...f, target_url: p.url });
  findings.push(
    ...auditSite({
      siteHost: run.site_host,
      pages,
      checks: (checkData ?? []) as LinkCheck[],
      pageLimit: run.page_limit,
      truncated: run.truncated,
      sitemapFound: run.sitemap_found,
      sitemapUrlCount: run.sitemap_url_count,
    }),
  );
  if (run.rendered_root) {
    findings.push({
      finding_type: "javascript_rendered_site_audited_via_render",
      severity: "info",
      title: "This site needed a headless-browser render to audit — a plain fetch alone wasn't enough",
      details: { url: run.root_url },
      target_url: run.root_url,
    });
  }

  await settleCrawl(loc, "ok", null, findings, pages.length);

  // Keep only this run's rows.
  await supabase.from("seo_crawl_pages").delete().eq("location_id", loc.id).neq("run_id", run.run_id);
  await supabase.from("seo_crawl_link_checks").delete().eq("location_id", loc.id).neq("run_id", run.run_id);
  return findings.length;
}

async function step(loc: LocationRow): Promise<Record<string, unknown>> {
  const deadline = Date.now() + STEP_BUDGET_MS;

  const { data: existing, error } = await supabase.from("seo_crawl_runs").select("*").eq("location_id", loc.id).maybeSingle();
  if (error) throw new Error(`reading the crawl run failed: ${error.message}`);
  let run = existing as Run | null;
  const stale = run && run.phase !== "done" && Date.now() - new Date(run.started_at).getTime() > STALE_RUN_MS;

  if (!run || run.phase === "done" || stale) {
    run = await startRun(loc);
    if (!run) return { phase: "ended_early" };
  }

  if (run.phase === "pages") await crawlPages(loc, run, deadline);
  if (run.phase === "links" && Date.now() < deadline) await checkLinks(loc, run, deadline);

  if (run.phase === "done") {
    const n = await finish(loc, run);
    return { phase: "done", pages: run.pages_crawled, findings: n, truncated: run.truncated };
  }

  // Unfinished: come back in a couple of minutes, not next week.
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: loc.client_id,
    p_job_type: "seo_crawl",
    p_success: true,
    p_error: null,
    p_base_interval_minutes: CONTINUE_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: loc.id,
  });
  if (jobError) console.error(`seo-crawl ${loc.id}: complete_job_attempt failed: ${jobError.message}`);
  return { phase: run.phase, pages: run.pages_crawled, queued: run.queue.length, links_queued: run.link_queue.length };
}

async function settleCrawl(
  loc: LocationRow,
  status: "ok" | "js_rendered" | "fetch_failed" | "robots_disallowed",
  error: string | null,
  findings: (CrawlFinding & { target_url?: string })[],
  pagesCrawled = 0,
): Promise<void> {
  // Replace this location's OPEN crawl findings with the fresh set — a fixed
  // issue disappears on its own next week instead of accumulating duplicate
  // rows for a persistent one. Dismissed/actioned findings are untouched.
  const { error: delErr } = await supabase
    .from("seo_findings")
    .delete()
    .eq("location_id", loc.id)
    .eq("module", "crawl")
    .eq("status", "open");
  if (delErr) console.error(`seo-crawl ${loc.id}: clearing old findings failed: ${delErr.message}`);

  if (findings.length > 0) {
    const rows = findings.map((f) => ({
      client_id: loc.client_id,
      location_id: loc.id,
      module: "crawl",
      finding_type: f.finding_type,
      severity: f.severity,
      title: f.title,
      details: f.details,
      target_url: f.target_url ?? loc.website_url,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error: insErr } = await supabase.from("seo_findings").insert(rows.slice(i, i + 500));
      if (insErr) console.error(`seo-crawl ${loc.id}: inserting findings failed: ${insErr.message}`);
    }
  }

  const { error: updErr } = await supabase
    .from("seo_locations")
    .update({ last_crawled_at: new Date().toISOString(), crawl_status: status, crawl_error: error })
    .eq("id", loc.id);
  if (updErr) console.error(`seo-crawl ${loc.id}: updating location status failed: ${updErr.message}`);

  // js_rendered/robots_disallowed are steady states, not transient failures:
  // they settle on the normal weekly cadence. Only a genuine fetch failure
  // backs off.
  const success = status !== "fetch_failed";
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: loc.client_id,
    p_job_type: "seo_crawl",
    p_success: success,
    p_error: success ? null : error,
    p_base_interval_minutes: BASE_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: loc.id,
  });
  if (jobError) console.error(`seo-crawl ${loc.id}: complete_job_attempt failed: ${jobError.message}`);

  console.log(`seo-crawl ${loc.id}: status=${status} pages=${pagesCrawled} findings=${findings.length}` + (error ? ` error=${error}` : ""));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!VOICE_TOOL_SECRET) {
    console.error("VOICE_TOOL_SECRET unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }
  if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const locationId = String(body.location_id ?? "").trim();
  if (!locationId) return json({ error: "location_id is required" }, 400);

  const { data: loc, error } = await supabase
    .from("seo_locations")
    .select("id, client_id, name, website_url, phone_number")
    .eq("id", locationId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!loc) return json({ error: "location not found" }, 404);
  if (!loc.website_url) return json({ status: "no_website", location_id: locationId });

  try {
    const result = await step(loc as LocationRow);
    console.log(`seo-crawl ${locationId}: ${JSON.stringify(result)}`);
    return json({ ok: true, location_id: locationId, ...result });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "crawl failed";
    console.error(`seo-crawl ${locationId} unhandled: ${reason}`);
    await supabase.rpc("complete_job_attempt", {
      p_client_id: loc.client_id,
      p_job_type: "seo_crawl",
      p_success: false,
      p_error: reason,
      p_base_interval_minutes: BASE_INTERVAL_MINUTES,
      p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
      p_entity_id: loc.id,
    });
    return json({ ok: false, error: reason }, 500);
  }
});
