"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  PRODUCTS,
  WORKSPACE_PAGES,
  type DashboardPage,
  type ProductKey,
} from "@/lib/catalog";
import type { FeatureState } from "@/lib/entitlements";

/**
 * What the layout decided about each product for this tenant. `usable` opens
 * the product's pages; otherwise the section collapses to one row pointing at
 * `addHref` (checkout, or the product page where checkout can't work yet —
 * see addProductHref in lib/catalog.ts).
 */
export type ProductAccess = Record<
  ProductKey,
  { usable: boolean; state: FeatureState; addHref: string }
>;

// The one row a product without usable access collapses to.
const LOCKED_ROW: Record<Exclude<FeatureState, "active" | "past_due">, (name: string) => string> = {
  locked: (name) => `Add ${name}`,
  setup: () => "Setting up",
  canceled: () => "Reactivate",
};

export function Sidebar({
  clientName,
  access,
}: {
  clientName: string;
  access: ProductAccess;
}) {
  const pathname = usePathname();

  // Longest matching href wins, so /seo/reports lights up Reports and not
  // Overview (/seo) as well.
  const allHrefs = [...PRODUCTS.flatMap((p) => p.pages), ...WORKSPACE_PAGES]
    .filter((p) => !p.soon)
    .map((p) => p.href);
  const activeHref = allHrefs
    .filter((h) => pathname === h || pathname.startsWith(h + "/"))
    .sort((a, b) => b.length - a.length)[0];

  // Products the tenant can use first, then the ones it can add.
  const products = [...PRODUCTS].sort(
    (a, b) => Number(access[b.key].usable) - Number(access[a.key].usable),
  );

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-200 px-5 py-4">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
          Workspace
        </p>
        <p className="mt-0.5 truncate text-sm font-semibold text-gray-900">
          {clientName}
        </p>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto p-3">
        {products.map((product) => {
          const a = access[product.key];
          return (
            <div key={product.key}>
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                {product.name}
              </p>
              <div className="space-y-1">
                {a.usable ? (
                  product.pages.map((page) => (
                    <NavRow key={page.href} page={page} active={page.href === activeHref} />
                  ))
                ) : (
                  <Link
                    href={a.addHref}
                    className="flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                  >
                    <span>
                      {LOCKED_ROW[a.state as keyof typeof LOCKED_ROW]?.(product.name) ??
                        `Add ${product.name}`}
                    </span>
                    <span aria-hidden>→</span>
                  </Link>
                )}
              </div>
            </div>
          );
        })}

        <div className="space-y-1 border-t border-gray-200 pt-4">
          {WORKSPACE_PAGES.map((page) => (
            <NavRow key={page.href} page={page} active={page.href === activeHref} />
          ))}
        </div>
      </nav>

      {/*
        Points at /home, not "/". The root redirects a signed-in user straight
        back into the dashboard, so linking there would do nothing at all.
      */}
      <div className="border-t border-gray-200 px-3 py-2">
        <Link
          href="/home"
          className="block rounded-md px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-900"
        >
          View public site
        </Link>
      </div>
    </aside>
  );
}

function NavRow({ page, active }: { page: DashboardPage; active: boolean }) {
  if (page.soon) {
    return (
      <div
        aria-disabled="true"
        title="Coming soon"
        className="flex cursor-not-allowed select-none items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-gray-400"
      >
        <span>{page.label}</span>
        <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
          Soon
        </span>
      </div>
    );
  }
  return (
    <Link
      href={page.href}
      className={`block rounded-md px-3 py-2 text-sm font-medium ${
        active ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-100"
      }`}
    >
      {page.label}
    </Link>
  );
}
