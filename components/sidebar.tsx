"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string; soon?: boolean };

const NAV: NavItem[] = [
  { href: "/conversations", label: "Conversations" },
  { href: "/appointments", label: "Appointments" },
  { href: "/leads", label: "Leads" },
  { href: "/review-queue", label: "Review Queue" },
  { href: "/services", label: "Services" },
  { href: "/knowledge-base", label: "Knowledge base", soon: true },
  { href: "/settings", label: "Settings" },
];

export function Sidebar({ clientName }: { clientName: string }) {
  const pathname = usePathname();

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

      <nav className="flex-1 space-y-1 p-3">
        {NAV.map((item) => {
          if (item.soon) {
            return (
              <div
                key={item.href}
                aria-disabled="true"
                title="Coming soon"
                className="flex cursor-not-allowed select-none items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-gray-400"
              >
                <span>{item.label}</span>
                <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                  Soon
                </span>
              </div>
            );
          }
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-md px-3 py-2 text-sm font-medium ${
                active
                  ? "bg-gray-900 text-white"
                  : "text-gray-700 hover:bg-gray-100"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-wrap gap-1.5 border-t border-gray-200 px-5 py-3">
        <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
          Email
        </span>
        <span className="inline-flex items-center rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
          Voice
        </span>
      </div>
    </aside>
  );
}
