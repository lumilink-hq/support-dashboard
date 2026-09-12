"use client";

import { useState } from "react";
import type { PlanTierKey } from "@/lib/entitlements";

// Replaces app/plans/page.tsx's old `<a href={tierCheckoutUrl(...)}>` — that
// was a static Payment Link URL computed server-side; this POSTs to create a
// Checkout Session on click instead, since the price/client_id are now set
// dynamically server-side rather than baked into a pre-made link.
export function CheckoutButton({
  tier,
  featured,
}: {
  tier: PlanTierKey;
  featured: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        setError(body.error ?? "Something went wrong. Try again.");
        setPending(false);
        return;
      }
      window.location.href = body.url;
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
        className={`block w-full rounded-md px-4 py-2.5 text-center text-sm font-medium disabled:opacity-60 ${
          featured
            ? "bg-gray-900 text-white hover:bg-gray-800"
            : "border border-gray-300 text-gray-700 hover:bg-gray-50"
        }`}
      >
        {pending ? "Redirecting…" : "Continue to checkout"}
      </button>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
