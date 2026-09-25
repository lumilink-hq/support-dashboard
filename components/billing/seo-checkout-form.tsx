"use client";

import { useState } from "react";
import {
  SEO_EXTRA_LOCATION,
  seoBilledLocations,
  seoMonthlyUsd,
  seoPlanByKey,
  type SeoPlanKey,
} from "@/lib/seo-pricing";

// The module 12 checkout: pick one of the SEO plans (lib/seo-pricing.ts),
// and a location count where the plan bills for locations. The count defaults
// to whatever the client has already entered via onboarding's locations step
// — they can still adjust it here, but the common case is "I already added my
// locations, now let me pay for them."
//
// `plans` comes from the server (availableSeoPlans): the Stripe price ids are
// server-only env vars, so this component can't tell which plans are live.
export function SeoCheckoutForm({
  plans,
  initialLocationCount,
}: {
  plans: SeoPlanKey[];
  initialLocationCount: number;
}) {
  const [plan, setPlan] = useState<SeoPlanKey>(
    plans.includes("bundle") ? "bundle" : (plans[0] ?? "local"),
  );
  const [locationCount, setLocationCount] = useState(Math.max(initialLocationCount, 1));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = seoPlanByKey(plan);
  const hasLocations = plan !== "website";
  const billed = seoBilledLocations(plan, locationCount);

  async function handleSubscribe() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/seo-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, locationCount: hasLocations ? locationCount : 0 }),
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

  function priceLabel(key: SeoPlanKey): string {
    const p = seoPlanByKey(key);
    return p.perLocation
      ? `$${p.monthlyUsd.toLocaleString()}/location/mo`
      : `$${p.monthlyUsd.toLocaleString()}/mo`;
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <fieldset>
        <legend className="block text-sm font-medium text-gray-700">Plan</legend>
        <div className="mt-2 space-y-2">
          {plans.map((key) => {
            const p = seoPlanByKey(key);
            return (
              <label
                key={key}
                className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm ${
                  plan === key ? "border-gray-900" : "border-gray-200"
                }`}
              >
                <input
                  type="radio"
                  name="seo_plan"
                  value={key}
                  checked={plan === key}
                  onChange={() => setPlan(key)}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium text-gray-900">{p.name}</span>
                  <span className="text-gray-500"> &middot; {priceLabel(key)}</span>
                  <span className="block text-xs text-gray-500">{p.headline}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {hasLocations ? (
        <div className="mt-4">
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
          {plan === "bundle" && billed > 1 ? (
            <p className="mt-1 text-xs text-gray-500">
              Includes 1 location, plus {billed - 1} additional at $
              {SEO_EXTRA_LOCATION.monthlyUsd.toLocaleString()}/mo each.
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 text-sm text-gray-900">
        {selected.name} &middot;{" "}
        <span className="font-medium">${seoMonthlyUsd(plan, locationCount).toLocaleString()}/mo total</span>
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
