"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar, type ProductAccess } from "@/components/sidebar";

/**
 * The sidebar below `md`: a menu button for the header that opens the same
 * <Sidebar> in a modal drawer. Native <dialog showModal()> gives us the focus
 * move, inert background and Escape-to-close; we only keep React state in
 * step with it and close on navigation. At `md` and up the layout renders the
 * plain sidebar instead and this button is hidden.
 */
export function MobileNav({
  clientName,
  access,
}: {
  clientName: string;
  access: ProductAccess;
}) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on any route change (back/forward included). The layout persists
  // across navigations, so without this the drawer would stay open.
  const pathname = usePathname();
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setOpen(false);
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Growing past `md` swaps in the desktop sidebar; don't leave a modal
  // (and an inert page) behind it.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 48rem)");
    const onChange = () => mq.matches && setOpen(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav"
        onClick={() => setOpen(true)}
        className="-ml-1.5 rounded-md p-1.5 text-gray-700 hover:bg-gray-100 md:hidden"
      >
        <span className="sr-only">Open menu</span>
        <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
          <path
            fillRule="evenodd"
            d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 5.25a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 10Zm.75 4.5a.75.75 0 0 0 0 1.5h14.5a.75.75 0 0 0 0-1.5H2.75Z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      <dialog
        id="mobile-nav"
        ref={dialogRef}
        aria-label="Navigation"
        // Escape fires cancel → close; keep state in step either way.
        onClose={() => {
          setOpen(false);
          buttonRef.current?.focus();
        }}
        // A followed link closes the drawer even when it points at the
        // current page (no pathname change to catch).
        onClick={(e) => {
          const link = (e.target as Element).closest("a");
          if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey) setOpen(false);
        }}
        className="m-0 h-dvh max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-gray-900/40 md:hidden"
      >
        <div className="flex h-full">
          <Sidebar clientName={clientName} access={access} />
          {/* The dimmed area beside the panel closes it too. */}
          <div className="flex-1" onClick={() => setOpen(false)}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="m-3 rounded-md bg-white p-1.5 text-gray-700 shadow hover:bg-gray-100"
            >
              <span className="sr-only">Close menu</span>
              <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
              </svg>
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
