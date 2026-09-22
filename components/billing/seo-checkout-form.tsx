"use client";

import { useState } from "react";
import { SEO_PRICE_PER_LOCATION_USD, seoMonthlyUsd } from "@/lib/seo-pricing";

// The module 12 gap this closes: createSeoCheckoutSessionForClient existed
// with no UI calling it. Location count defaults to whatever the client has
// already entered via onboarding's locations step (0 if none yet) — they can
// still adjust it here, but the common case is "I already added my
// locations, now let me pay for them."
export function SeoCheckoutForm({ initialLocationCount }: { initialLocationCount: number }) {
  const [locationCount, setLocationCount] = useState(Math.max(initialLocationCount, 1));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubscribe() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/seo-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationCount }),
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
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <label className="block text-sm font-medium text-gray-700" htmlFor="seo_location_count">
        Number of locations
      </label>
      <input
        id="seo_location_count"
        type="number"
        min={1}
        max={1000}
        value={locationCount}
        onChange={(e) => setLocationCount(Math.max(Number(e.target.value) || 1, 1))}
        className="mt-1 w-32 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
      />
      {initialLocationCount > 0 ? (
        <p className="mt-1 text-xs text-gray-400">
          Matches the {initialLocationCount} location{initialLocationCount === 1 ? "" : "s"} you&rsquo;ve
          already added. Change it if that&rsquo;s not right.
        </p>
      ) : (
        <p className="mt-1 text-xs text-gray-400">
          You can add the actual locations afterward — this is just how many
          you&rsquo;re starting with.
        </p>
      )}

      <p className="mt-3 text-sm text-gray-900">
        ${SEO_PRICE_PER_LOCATION_USD.toLocaleString()}/location/mo &middot;{" "}
        <span className="font-medium">${seoMonthlyUsd(locationCount).toLocaleString()}/mo total</span>
      </p>

      <button
        type="button"
        onClick={handleSubscribe}
        disabled={pending}
        className="mt-3 w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
      >
        {pending ? "Redirecting…" : "Subscribe"}
      </button>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
