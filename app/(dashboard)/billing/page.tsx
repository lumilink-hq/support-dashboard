import { formatDateTime } from "@/lib/format";
import {
  FEATURES,
  checkoutUrl,
  entitlementsEnforced,
  featureState,
  getEntitlements,
  type FeatureState,
} from "@/lib/entitlements";

const PILL: Record<FeatureState, string> = {
  active: "bg-green-50 text-green-700",
  past_due: "bg-amber-50 text-amber-700",
  setup: "bg-blue-50 text-blue-700",
  canceled: "bg-gray-100 text-gray-500",
  locked: "bg-gray-100 text-gray-500",
};

const PILL_LABEL: Record<FeatureState, string> = {
  active: "Active",
  past_due: "Past due",
  setup: "Setting up",
  canceled: "Canceled",
  locked: "Not on your plan",
};

export default async function BillingPage() {
  const ent = await getEntitlements();

  return (
    <div className="max-w-4xl">
      <h1 className="text-lg font-semibold text-gray-900">Plans &amp; billing</h1>
      <p className="mt-1 text-sm text-gray-500">
        Turn features on for your workspace. Each plan is billed separately;
        unlock one and it&rsquo;s set up automatically.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {FEATURES.map((f) => {
          const row = ent[f.key];
          const state = featureState(row);
          const url = checkoutUrl(f.key);

          return (
            <div
              key={f.key}
              className="flex flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">
                    {f.label}
                  </h2>
                  <p className="text-sm text-gray-500">{f.tagline}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${PILL[state]}`}
                >
                  {PILL_LABEL[state]}
                </span>
              </div>

              <p className="mt-3 text-sm text-gray-600">{f.blurb}</p>

              <ul className="mt-3 space-y-1.5">
                {f.bullets.map((b) => (
                  <li
                    key={b}
                    className="flex items-start gap-2 text-sm text-gray-700"
                  >
                    <span aria-hidden className="mt-0.5 text-green-600">
                      ✓
                    </span>
                    {b}
                  </li>
                ))}
              </ul>

              <div className="mt-4 flex-1" />

              {state === "active" || state === "past_due" ? (
                <div className="border-t border-gray-100 pt-3 text-sm">
                  {state === "past_due" ? (
                    <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      There&rsquo;s a payment issue &mdash; please update your
                      billing to avoid losing access.
                    </p>
                  ) : null}
                  <p className="text-gray-500">
                    {row?.current_period_end
                      ? `Renews ${formatDateTime(row.current_period_end)}`
                      : "Active on your workspace."}
                  </p>
                </div>
              ) : state === "setup" ? (
                <div className="border-t border-gray-100 pt-3">
                  <button
                    disabled
                    className="w-full cursor-default rounded-md bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700"
                  >
                    Setting up your plan&hellip;
                  </button>
                  <p className="mt-2 text-xs text-gray-400">
                    Payment received. We&rsquo;re provisioning this now &mdash;
                    it unlocks automatically, usually within a few minutes.
                  </p>
                </div>
              ) : (
                <div className="border-t border-gray-100 pt-3">
                  <p className="mb-2 text-sm font-medium text-gray-900">
                    {f.price}
                  </p>
                  {url ? (
                    <a
                      href={url}
                      className="block w-full rounded-md bg-gray-900 px-4 py-2 text-center text-sm font-medium text-white hover:bg-gray-800"
                    >
                      {state === "canceled" ? "Reactivate" : "Unlock this plan"}
                    </a>
                  ) : (
                    <>
                      <button
                        disabled
                        className="w-full cursor-not-allowed rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-500"
                      >
                        Checkout not connected yet
                      </button>
                      <p className="mt-2 text-xs text-gray-400">
                        Contact us to enable this plan while checkout is being
                        set up.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!entitlementsEnforced() ? (
        <p className="mt-6 text-xs text-gray-400">
          Feature access is currently open for all workspaces during rollout.
        </p>
      ) : null}
    </div>
  );
}
