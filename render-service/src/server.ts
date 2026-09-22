// =============================================================================
// seo-render-service — module 6's headless-browser fallback (plan.md: "a
// JavaScript-rendered site... writes one critical finding... Railway headless-
// browser fallback not built"). A small, standalone HTTP service, deployed
// separately from the Next app (its own Railway service, built from this
// directory's Dockerfile) because it needs a real Chromium, which the Next
// app and the Deno edge functions don't carry.
//
//   GET  /healthz                          — for Railway's health check
//   POST /render   header: x-render-secret: <RENDER_SERVICE_SECRET>
//                  body:   { "url": "https://..." }
//                  ->      { "html": "...", "status": 200 }
//
// Called only by supabase/functions/seo-crawl, and only after a plain fetch
// already looked JS-rendered (see that function's header) — never on every
// crawl, so a quiet week here means nothing was routed to it, not that it's
// broken.
//
// Env: PORT (default 8080), RENDER_SERVICE_SECRET (required),
//      RENDER_USER_AGENT (optional, should match SEO_CRAWL_USER_AGENT so a
//      site sees the same bot either way), MAX_CONCURRENT_RENDERS (default 2
//      — a Railway Hobby instance has limited memory and Chromium is heavy;
//      a request beyond this limit gets a 503 rather than queueing forever).
// =============================================================================

import express from "express";
import { chromium, type Browser } from "playwright";
import { isBlockedUrl } from "./ssrf-guard.js";
import { renderPage } from "./render.js";

const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.RENDER_SERVICE_SECRET;
const USER_AGENT =
  process.env.RENDER_USER_AGENT ??
  "LumilinkSeoBot/1.0 (+https://lumilinkhub.com/bot; SEO audit for our customer's own site)";
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_RENDERS ?? 2);

if (!SECRET) throw new Error("RENDER_SERVICE_SECRET is required");

let browser: Browser | null = null;
let inFlight = 0;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
  browser.on("disconnected", () => {
    console.error("render-service: browser disconnected, will relaunch on next request");
    browser = null;
  });
  return browser;
}

const app = express();
app.use(express.json({ limit: "16kb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, browserConnected: browser?.isConnected() ?? false, inFlight });
});

app.post("/render", async (req, res) => {
  if (req.header("x-render-secret") !== SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const url = String((req.body as Record<string, unknown> | undefined)?.url ?? "");
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  if (isBlockedUrl(url)) {
    res.status(400).json({ error: "That URL isn't allowed" });
    return;
  }

  if (inFlight >= MAX_CONCURRENT) {
    res.status(503).json({ error: "Busy — try again shortly" });
    return;
  }

  inFlight += 1;
  try {
    const b = await getBrowser();
    const result = await renderPage(b, url, USER_AGENT);
    res.json(result);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "render failed";
    console.error(`render-service: ${url} failed: ${reason}`);
    res.status(502).json({ error: reason });
  } finally {
    inFlight -= 1;
  }
});

const server = app.listen(PORT, () => {
  console.log(`render-service listening on :${PORT}`);
});

// Launch the browser at startup rather than on the first request, so the
// (slow) first real request isn't the one paying for it, and so /healthz can
// report a real browser-connected state right away.
getBrowser().catch((e) => console.error("render-service: initial browser launch failed:", e));

async function shutdown() {
  console.log("render-service: shutting down");
  server.close();
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
