"use client";

import { useState } from "react";

// New capability — no self-serve cancel/card-update existed before this
// migration. Opens Stripe's hosted Billing Portal for the signed-in client's
// existing customer.
export function ManageBillingButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
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
        className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
      >
        {pending ? "Opening…" : "Manage billing"}
      </button>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
