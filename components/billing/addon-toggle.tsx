"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Replaces the old `<a href={stampClientRef(a.url, clientId)}>Add To Plan</a>`
// on /billing and /welcome. `active` is read directly from the prop (not
// copied into local state) on purpose: after a successful mutation this calls
// router.refresh(), which re-runs the parent Server Component's
// activeAddonsForClient() call and passes a fresh `active` value down — an
// already-mounted client component picks up new props automatically, it just
// wouldn't pick up a NEW useState initial value, which is why there's no
// local "active" state to go stale.
//
// No optimistic update, matching the sibling Construction CRM project's
// AddonsPanel — the round-trip lag is an acceptable tradeoff for always
// showing what Stripe actually has, not what we hope it has.
export function AddonToggle({
  addonKey,
  active,
}: {
  addonKey: string;
  active: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/addons", {
        method: active ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addonKey }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(body.error ?? "Something went wrong. Try again.");
        setPending(false);
        return;
      }
      router.refresh();
      setPending(false);
    } catch {
      setError("Something went wrong. Try again.");
      setPending(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className={
          active
            ? "block w-full rounded-md border border-gray-300 px-3 py-2 text-center text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            : "block w-full rounded-md bg-gray-900 px-3 py-2 text-center text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-60"
        }
      >
        {pending ? "Working…" : active ? "Remove" : "Add To Plan"}
      </button>
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
