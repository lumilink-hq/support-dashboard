// Public marketing chrome: top nav + footer, wrapped around any unauthenticated
// page. Deliberately a component rather than a Next route group — the dashboard
// already owns app/page.tsx's slot, and a shared component converts to a
// (marketing) route group later without touching the pages themselves.
//
// Server component: it reads the session so the nav CTA can say "Go to
// dashboard" instead of "Get started" for someone already signed in.

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

async function isSignedIn(): Promise<boolean> {
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

function Wordmark({ href }: { href: string }) {
  return (
    <Link href={href} className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid h-7 w-7 place-items-center rounded-lg bg-gray-900 text-sm font-bold text-white"
      >
        L
      </span>
      <span className="text-base font-semibold tracking-tight text-gray-900">
        Lumilink
      </span>
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
            The Terms and Privacy links pointed at the Wix site, whose pages are
            still the stock template (fictional address, 2035 copyright, a
            shipping policy for a product with nothing to ship). Removed rather
            than left pointing at text nobody wrote.

            THEY HAVE TO COME BACK before selling to anyone outside the company.
            You take payments, hold your clients' customer data, and store call
            transcripts. Add /legal/terms and /legal/privacy here, and register
            them in lib/route-access.ts PUBLIC_PREFIXES as "/legal".
          */}
          <div className="mt-8 border-t border-gray-200 pt-6 text-xs text-gray-400">
            <p>&copy; {new Date().getFullYear()} Lumilink. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
