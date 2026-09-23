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
import { PRODUCTS, SOLUTIONS } from "@/lib/catalog";

// TWO MENUS, THEN FLAT LINKS (2026-09-23). Products (what you buy) and
// Solutions (who you are) both come from lib/catalog.ts, so a new product or
// industry page is one entry there, not an edit here. The nav used to list
// eight flat links, mixing industries with a product, and wrapped at ~800px.
//
// "Home" ISN'T ALWAYS "/". app/page.tsx redirects a signed-in visitor to
// /conversations, and a hash is dropped in that redirect, so "/#how" for a
// signed-in visitor silently lands them in the dashboard. "/home" is the same
// content with no redirect (see its own file comment), so any link to "/"
// goes through homeHref(), which uses "/home" whenever there's a session.
//
// "#how" AND "#faq" ONLY EXIST ON THE LANDING PAGE (landing.tsx renders both
// ids), so they always carry the full home path, never a bare "#anchor" that
// scrolls nowhere on every other page. They live in the footer now.
type NavItem = { href: string; label: string; blurb?: string };

function navGroups(marketingHome: string) {
  const home = (href: string) => (href === "/" ? marketingHome : href);
  return {
    products: PRODUCTS.map((p) => ({
      href: home(p.marketingHref),
      label: p.name,
      blurb: p.blurb,
    })),
    solutions: SOLUTIONS.map((s) => ({ href: s.href, label: s.name, blurb: s.blurb })),
    top: [
      { href: "/pricing", label: "Pricing" },
      { href: "/story", label: "Our Story" },
    ] as NavItem[],
    company: [
      { href: `${marketingHome}#how`, label: "How It Works" },
      { href: "/pricing", label: "Pricing" },
      { href: "/story", label: "Our Story" },
      { href: `${marketingHome}#faq`, label: "FAQ" },
      { href: "/contact", label: "Contact" },
    ] as NavItem[],
  };
}

/**
 * A hover/focus dropdown with no client JS: the panel shows while the pointer
 * is over the group or focus is inside it, so keyboard users can Tab from the
 * button into the links.
 */
function NavMenu({ label, items }: { label: string; items: NavItem[] }) {
  return (
    <div className="group relative">
      <button
        type="button"
        aria-haspopup="true"
        className="flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-gray-900 group-focus-within:text-gray-900"
      >
        {label}
        <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 fill-current">
          <path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4z" />
        </svg>
      </button>
      <div className="invisible absolute left-1/2 top-full z-50 -translate-x-1/2 pt-3 opacity-0 transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
        <div className="w-72 rounded-xl border border-gray-200 bg-white p-2 shadow-lg shadow-gray-900/10">
          {items.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="block rounded-lg px-3 py-2.5 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none"
            >
              <span className="block text-sm font-medium text-gray-900">{item.label}</span>
              {item.blurb ? (
                <span className="mt-0.5 block text-xs leading-relaxed text-gray-500">
                  {item.blurb}
                </span>
              ) : null}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Below md the header has no room for the menus, so this is the phone nav: a
 * native <details> disclosure, no client JS. There was no phone nav at all
 * before 2026-09-23.
 */
function MobileMenu({
  groups,
  signedIn,
}: {
  groups: ReturnType<typeof navGroups>;
  signedIn: boolean;
}) {
  const sections: { title: string; items: NavItem[] }[] = [
    { title: "Products", items: groups.products },
    { title: "Solutions", items: groups.solutions },
    { title: "Company", items: groups.company },
  ];
  return (
    <details className="group md:hidden">
      <summary className="flex cursor-pointer list-none items-center rounded-md p-2 text-gray-600 hover:bg-gray-100 [&::-webkit-details-marker]:hidden">
        <span className="sr-only">Menu</span>
        <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 stroke-current" fill="none" strokeWidth="2" strokeLinecap="round">
          <path className="group-open:hidden" d="M4 7h16M4 12h16M4 17h16" />
          <path className="hidden group-open:block" d="M6 6l12 12M18 6L6 18" />
        </svg>
      </summary>
      <div className="absolute inset-x-0 top-16 z-50 max-h-[calc(100vh-4rem)] overflow-y-auto border-b border-gray-200 bg-white px-6 pb-6 shadow-lg">
        {sections.map((section) => (
          <div key={section.title} className="pt-5">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
              {section.title}
            </p>
            <ul className="mt-2 space-y-1">
              {section.items.map((item) => (
                <li key={item.label}>
                  <a
                    href={item.href}
                    className="block py-1.5 text-sm font-medium text-gray-700 hover:text-gray-900"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {signedIn ? null : (
          <a
            href="/login"
            className="mt-5 block border-t border-gray-200 pt-4 text-sm font-medium text-gray-700 hover:text-gray-900"
          >
            Sign in
          </a>
        )}
      </div>
    </details>
  );
}

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
  // Not the same as `homeHref` — that's about where THIS page's own wordmark
  // should point (e.g. /home passes its own path so the logo doesn't bounce
  // a signed-in visitor away from the page they're already reading). This is
  // about where an "#how"/"#faq" anchor needs to land to find its section at
  // all, which is always the canonical landing content, never "wherever this
  // particular page's logo happens to point."
  const marketingHome = signedIn ? "/home" : "/";
  const groups = navGroups(marketingHome);

  return (
    <div className="flex min-h-full flex-1 flex-col bg-white text-gray-900">
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Wordmark href={homeHref} />

          <nav className="hidden items-center gap-8 md:flex">
            <NavMenu label="Products" items={groups.products} />
            <NavMenu label="Solutions" items={groups.solutions} />
            {groups.top.map((l) => (
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
                className="whitespace-nowrap rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
              >
                Go to dashboard
              </Link>
            ) : (
              <>
                {/* Below sm it moves into MobileMenu: at 375px the header
                    has room for the wordmark, one button and the menu. */}
                <Link
                  href="/login"
                  className="hidden text-sm font-medium text-gray-600 hover:text-gray-900 sm:inline"
                >
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="whitespace-nowrap rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
                >
                  Get started
                </Link>
              </>
            )}
            <MobileMenu groups={groups} signedIn={signedIn} />
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-gray-200 bg-gray-50">
        <div className="mx-auto max-w-6xl px-6 py-10">
          <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-4">
            <div>
              <Wordmark href={homeHref} />
              <Link
                href="/login"
                className="mt-4 block text-sm text-gray-500 hover:text-gray-900"
              >
                Sign in
              </Link>
            </div>
            {[
              { title: "Products", items: groups.products },
              { title: "Solutions", items: groups.solutions },
              { title: "Company", items: groups.company },
            ].map((col) => (
              <nav key={col.title} aria-label={col.title}>
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
                  {col.title}
                </p>
                <ul className="mt-3 space-y-2">
                  {col.items.map((l) => (
                    <li key={l.label}>
                      <a href={l.href} className="text-sm text-gray-500 hover:text-gray-900">
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
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
              <Link href="/contact" className="hover:text-gray-900">
                Contact
              </Link>
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
