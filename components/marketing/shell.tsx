// Public marketing chrome: top nav + footer, wrapped around any unauthenticated
// page. Deliberately a component rather than a Next route group — the dashboard
// already owns app/page.tsx's slot, and a shared component converts to a
// (marketing) route group later without touching the pages themselves.
//
// Server component: it reads the session so the nav CTA can say "Go to
// dashboard" instead of "Get started" for someone already signed in.

import Image from "next/image";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

// Mixed routes and in-page anchors. Anchors must resolve to a section that is
// actually rendered on the page: a nav link that scrolls nowhere reads as a
// broken site. "#faq" now resolves on the landing page AND both vertical pages,
// because all three render <FaqList>, which hardcodes id="faq" for this reason.
// It still does nothing on /plans.
//
// "How it works" (#how) was removed when that section was commented out in
// components/marketing/landing.tsx. Restore both together.
const NAV_LINKS = [
  { href: "/solutions/ecommerce", label: "Online stores" },
  { href: "/solutions/service", label: "Service businesses" },
  { href: "/plans", label: "Plans" },
  { href: "#faq", label: "FAQ" },
];

/**
 * Exported for blocks.tsx's planCtaHref — the pricing cards need the same
 * answer the nav CTA does. shell.tsx does not import blocks.tsx, so this
 * direction creates no cycle.
 */
export async function isSignedIn(): Promise<boolean> {
  // getUser() verifies the token with Supabase rather than trusting the cookie.
  // That costs a round trip and makes this page dynamic, which is the right
  // trade at current traffic. If the landing page ever needs to render
  // statically, move this CTA into a client component — the destination is
  // gated by the proxy regardless, so being wrong here is only ever cosmetic.
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return Boolean(user);
  } catch {
    // A Supabase outage must not take the marketing site down with it.
    return false;
  }
}

/**
 * The wordmark.
 *
 * Was a hand-built "L" tile plus the word "Lumilink" in the UI font, which was a
 * placeholder standing in for a logo that did not exist yet. It does now
 * (2026-08-12).
 *
 * TWO FILES, ONE FOR EACH BACKGROUND. public/lumilink-wordmark.png is dark ink
 * for light surfaces; -light.png is white ink for dark ones. Both are
 * transparent PNGs cut from the supplied artwork with the antialiasing kept, so
 * neither carries a white box that would show a seam on the gray-50 footer.
 *
 * `priority` because it sits in the header above the fold on every page — a
 * lazily-loaded logo pops in after paint and reads as a slow site.
 */
function Wordmark({ href }: { href: string }) {
  return (
    <Link href={href} className="flex items-center" aria-label="Lumilink — home">
      <Image
        src="/lumilink-wordmark.png"
        alt="Lumilink"
        width={1000}
        height={192}
        priority
        className="h-6 w-auto"
      />
    </Link>
  );
}

export async function MarketingShell({
  children,
  /**
   * Where the wordmark links. Defaults to "/", which is correct once the
   * marketing site owns the root. While the page is parked at /preview, that
   * route redirects into the dashboard, so the preview passes its own path.
   */
  homeHref = "/",
}: {
  children: React.ReactNode;
  homeHref?: string;
}) {
  const signedIn = await isSignedIn();

  return (
    <div className="flex min-h-full flex-1 flex-col bg-white text-gray-900">
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Wordmark href={homeHref} />

          <nav className="hidden items-center gap-8 md:flex">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="text-sm font-medium text-gray-600 hover:text-gray-900"
              >
                {l.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            {signedIn ? (
              <Link
                href="/conversations"
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
              >
                Go to dashboard
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="text-sm font-medium text-gray-600 hover:text-gray-900"
                >
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
                >
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-gray-200 bg-gray-50">
        <div className="mx-auto max-w-6xl px-6 py-10">
          <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <Wordmark href={homeHref} />
            <nav className="flex flex-wrap gap-x-6 gap-y-2">
              {NAV_LINKS.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  className="text-sm text-gray-500 hover:text-gray-900"
                >
                  {l.label}
                </a>
              ))}
              <Link
                href="/login"
                className="text-sm text-gray-500 hover:text-gray-900"
              >
                Sign in
              </Link>
            </nav>
          </div>

          {/*
            RESTORED 2026-08-13, now pointing at pages we actually wrote. They
            previously pointed at the Wix site's stock template — fictional
            address, 2035 copyright, a shipping policy for a product with
            nothing to ship — and were removed rather than left lying.
          */}
          <div className="mt-8 flex flex-col gap-3 border-t border-gray-200 pt-6 text-xs text-gray-400 sm:flex-row sm:items-center sm:justify-between">
            <p>&copy; {new Date().getFullYear()} LumiLink. All rights reserved.</p>
            <nav className="flex gap-4">
              <Link href="/legal/terms" className="hover:text-gray-900">
                Terms Of Service
              </Link>
              <Link href="/legal/privacy" className="hover:text-gray-900">
                Privacy Policy
              </Link>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
