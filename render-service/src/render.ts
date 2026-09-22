// Renders one URL with a headless Chromium and returns the DOM's HTML after
// JavaScript has run — module 6's fallback for a site a plain fetch can't
// audit (plan.md: "Railway headless-browser fallback").
//
// ONE BROWSER, SHARED. Launching Chromium is the expensive part (hundreds of
// ms and real memory); server.ts launches it once at startup and every
// request opens its own short-lived page in that browser, closed when done.
// A crashed browser is relaunched by server.ts's health check, not by this
// module.

import { Browser } from "playwright";

export type RenderResult = { html: string; status: number };

const NAV_TIMEOUT_MS = 15_000;

export async function renderPage(browser: Browser, url: string, userAgent: string): Promise<RenderResult> {
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 900 },
    // This service only ever reads a page to audit it; it never needs to log
    // in or carry state between requests, and every request should see the
    // site exactly as a fresh visitor would.
    javaScriptEnabled: true,
  });
  try {
    const page = await context.newPage();
    // Images/fonts/media don't affect the rendered text or structure this is
    // for, and skipping them is most of the speed difference between this and
    // a full "real browser" load.
    await page.route(/.*/, (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") return route.abort();
      return route.continue();
    });

    const response = await page.goto(url, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
    const status = response?.status() ?? 0;
    const html = await page.content();
    return { html, status };
  } finally {
    await context.close();
  }
}
