"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/conversations", label: "Conversations" },
  { href: "/review-queue", label: "Review Queue" },
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

      <div className="border-t border-gray-200 px-5 py-3">
        <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
          Email channel
        </span>
      </div>
    </aside>
  );
}
