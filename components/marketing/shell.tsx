// Public marketing chrome: top nav + footer, wrapped around any unauthenticated
// page. Deliberately a component rather than a Next route group — the dashboard
// already owns app/page.tsx's slot, and a shared component converts to a
// (marketing) route group later without touching the pages themselves.
//
// Server component: it reads the session so the nav CTA can say "Go to
// dashboard" instead of "Get started" for someone already signed in.

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

// In-page anchors only. Every link here has to resolve to a section that is
// actually rendered on the landing page: a nav link that scrolls nowhere reads
// as a broken site.
//
// "How it works" (#how) was removed when that section was commented out in
// app/page.tsx. Restore both together.
const NAV_LINKS = [
  { href: "#pricing", label: "Pricing" },
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

function Wordmark() {
  return (
    <Link href="/" className="flex items-center gap-2">
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
}: {
  children: React.ReactNode;
}) {
  const signedIn = await isSignedIn();

  return (
    <div className="flex min-h-full flex-1 flex-col bg-white text-gray-900">
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Wordmark />

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
            <Wordmark />
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
            TEMPORARY: these point at the Wix site because that is where the
            published legal pages currently live, and Stripe will not approve a
            live account without reachable terms + privacy URLs. Repoint them
            when the apex domain moves here — and review the content first: the
            Wix pages are still largely template text.
          */}
          <div className="mt-8 flex flex-col gap-2 border-t border-gray-200 pt-6 text-xs text-gray-400 md:flex-row md:items-center md:justify-between">
            <p>&copy; {new Date().getFullYear()} Lumilink. All rights reserved.</p>
            <div className="flex gap-4">
              <a
                href="https://lumilinkhq.wixsite.com/lumilink/terms-and-conditions"
                className="hover:text-gray-600"
              >
                Terms
              </a>
              <a
                href="https://lumilinkhq.wixsite.com/lumilink/privacy-policy"
                className="hover:text-gray-600"
              >
                Privacy
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
