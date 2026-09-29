"use client";

// "Find what your business needs": a four-question quiz at the top of
// /pricing (2026-09-28). The page lists everything we sell, which is the
// right reference but a lot to read for someone who just wants to know what
// to buy. This asks what they want automated and how big they are, then
// recommends the products and a monthly estimate.
//
// EVERY PRICE IS A PROP. lib/entitlements.ts pulls in the server Supabase
// client, so a client component can't import it; /pricing reads the prices
// from their real sources (PLAN_TIERS, ADDONS, SEO_PLANS) and hands them in.
// Nothing here types a number.
//
// NO STATE LEAVES THE PAGE. Answers aren't stored or sent anywhere; the
// result just links to signup and to the sections below.

import Link from "next/link";
import { useState } from "react";

export type FinderPrices = {
  /** `calls` is the tier's advertised monthly call count; `volume` its highlight line. */
  phoneTiers: { key: string; label: string; monthlyUsd: number; calls: number; volume: string }[];
  websiteChatUsd: number | null;
  workflowUsd: number | null;
  integrationUsd: number | null;
  seoWebsiteUsd: number;
  seoLocalUsd: number;
  seoBundleUsd: number;
  seoExtraLocationUsd: number;
};

type Goal = "calls" | "chat" | "google" | "ai" | "workflows";
type Size = "one" | "few" | "many" | "enterprise";
type SeoTarget = "website" | "locations" | "both";

const GOALS: { key: Goal; title: string; body: string }[] = [
  { key: "calls", title: "Answer Phone Calls", body: "Every call answered, jobs booked, leads captured, 24/7." },
  { key: "chat", title: "Answer Website Visitors", body: "Instant answers on your site, no phone call needed." },
  { key: "google", title: "Rank Higher On Google", body: "Search results and the local map pack." },
  { key: "ai", title: "Show Up In AI Answers", body: "ChatGPT and Google's AI Overviews." },
  { key: "workflows", title: "Connect My Tools", body: "Follow-ups and actions in the software you already use." },
];

const SIZES: { key: Size; title: string; locations: number }[] = [
  { key: "one", title: "1 Location", locations: 1 },
  { key: "few", title: "2–5 Locations", locations: 3 },
  { key: "many", title: "6–20 Locations", locations: 10 },
  { key: "enterprise", title: "20+ Or Multiple Brands", locations: 20 },
];

const SEO_TARGETS: { key: SeoTarget; title: string; body: string }[] = [
  { key: "website", title: "My Website", body: "Customers find us through our site." },
  { key: "locations", title: "My Locations", body: "Customers find us on Google Maps." },
  { key: "both", title: "Both", body: "We need the website and the map pack." },
];

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

type Rec = { name: string; price: string; monthly: number; why: string; href: string };

function recommend(
  prices: FinderPrices,
  goals: Goal[],
  size: Size,
  seoTarget: SeoTarget | null,
  tierKey: string | null,
): Rec[] {
  const recs: Rec[] = [];
  const locations = SIZES.find((s) => s.key === size)?.locations ?? 1;
  // A size band is a range; say which count the estimate assumed.
  const estimateNote = size === "one" ? "" : `, estimated at ${locations} locations`;
  const needsPhonePlan = goals.includes("calls") || goals.includes("chat") || goals.includes("workflows");

  if (needsPhonePlan) {
    const tier =
      prices.phoneTiers.find((t) => t.key === tierKey) ?? prices.phoneTiers[0];
    recs.push({
      name: `Phone Agent: ${tier.label}`,
      price: `${usd(tier.monthlyUsd)}/mo`,
      monthly: tier.monthlyUsd,
      why: goals.includes("calls")
        ? `${tier.volume}. Free setup: we build and test it for you.`
        : "Website chat and workflows ride a phone plan, so this is your base.",
      href: "#phone",
    });
  }
  if (goals.includes("chat") && prices.websiteChatUsd !== null) {
    recs.push({
      name: "Website Chat",
      price: `${usd(prices.websiteChatUsd)}/mo`,
      monthly: prices.websiteChatUsd,
      why: "The same agent on your website, on the same subscription.",
      href: "#addons",
    });
  }
  if (goals.includes("workflows")) {
    const price = prices.workflowUsd ?? prices.integrationUsd;
    if (price !== null) {
      recs.push({
        name: "Advanced Workflow Or Managed Integration",
        price: `from ${usd(Math.min(prices.workflowUsd ?? price, prices.integrationUsd ?? price))}/mo`,
        monthly: Math.min(prices.workflowUsd ?? price, prices.integrationUsd ?? price),
        why: "We connect the agent to your tools and keep it running.",
        href: "#addons",
      });
    }
  }

  const wantsSeo = goals.includes("google") || goals.includes("ai");
  if (wantsSeo) {
    // AI answers are part of the website plans, so asking for them alone
    // still means a website plan.
    const target: SeoTarget =
      goals.includes("ai") && seoTarget === "locations" ? "both" : seoTarget ?? "website";
    if (target === "website") {
      recs.push({
        name: "Website SEO + AI Search",
        price: `${usd(prices.seoWebsiteUsd)}/mo`,
        monthly: prices.seoWebsiteUsd,
        why: "Audits, rank tracking, fixes you approve, and AI search visibility included.",
        href: "#seo",
      });
    } else if (target === "locations") {
      const total = prices.seoLocalUsd * locations;
      recs.push({
        name: "Local SEO",
        price: `${usd(total)}/mo`,
        monthly: total,
        why: `Map-pack rank tracking and a geo grid for each location: ${usd(prices.seoLocalUsd)} × ${locations}${estimateNote}.`,
        href: "#seo",
      });
    } else {
      const total = prices.seoBundleUsd + Math.max(locations - 1, 0) * prices.seoExtraLocationUsd;
      const separately = prices.seoWebsiteUsd + prices.seoLocalUsd * locations;
      recs.push({
        name: "Full SEO + AI Search",
        price: `${usd(total)}/mo`,
        monthly: total,
        why: `Website, local and AI search in one plan${locations > 1 ? `: ${usd(prices.seoBundleUsd)} + ${usd(prices.seoExtraLocationUsd)} × ${locations - 1} extra locations${estimateNote}` : ""}. Saves ${usd(separately - total)}/mo against buying separately.`,
        href: "#seo",
      });
    }
  }
  return recs;
}

function Choice({
  selected,
  onClick,
  title,
  body,
  multi = false,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  body?: string;
  multi?: boolean;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition ${
        selected
          ? "border-gray-900 bg-gray-900 text-white"
          : "border-gray-200 bg-white text-gray-900 hover:border-gray-400"
      }`}
    >
      <span
        aria-hidden
        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center border text-[10px] ${
          multi ? "rounded" : "rounded-full"
        } ${selected ? "border-white bg-white text-gray-900" : "border-gray-300"}`}
      >
        {selected ? "✓" : ""}
      </span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        {body ? (
          <span className={`mt-0.5 block text-xs ${selected ? "text-gray-300" : "text-gray-500"}`}>
            {body}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function Question({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-sm font-semibold text-gray-900">
        <span className="mr-2 text-gray-400">{n}.</span>
        {title}
      </p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function PlanFinder({
  prices,
  signupHref,
  seoSignupHref,
  enterpriseHref,
}: {
  prices: FinderPrices;
  signupHref: string;
  seoSignupHref: string;
  enterpriseHref: string;
}) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [size, setSize] = useState<Size | null>(null);
  const [seoTarget, setSeoTarget] = useState<SeoTarget | null>(null);
  const [tierKey, setTierKey] = useState<string | null>(null);

  const toggleGoal = (g: Goal) =>
    setGoals((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));

  const wantsSeo = goals.includes("google") || goals.includes("ai");
  const wantsCalls = goals.includes("calls");
  const ready =
    goals.length > 0 &&
    size !== null &&
    (!wantsSeo || seoTarget !== null) &&
    (!wantsCalls || tierKey !== null);

  const recs = ready ? recommend(prices, goals, size, seoTarget, tierKey) : [];
  const total = recs.reduce((sum, r) => sum + r.monthly, 0);
  const onlySeo = recs.length > 0 && recs.every((r) => r.href === "#seo");
  let n = 0;

  return (
    <div className="grid gap-8 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm md:p-8 lg:grid-cols-[1.2fr_1fr]">
      <div className="space-y-7">
        <Question n={++n} title="What do you want to automate? Pick all that apply.">
          <div className="grid gap-2 sm:grid-cols-2">
            {GOALS.map((g) => (
              <Choice
                key={g.key}
                multi
                selected={goals.includes(g.key)}
                onClick={() => toggleGoal(g.key)}
                title={g.title}
                body={g.body}
              />
            ))}
          </div>
        </Question>

        <Question n={++n} title="How big is your business?">
          <div className="grid gap-2 sm:grid-cols-2">
            {SIZES.map((s) => (
              <Choice key={s.key} selected={size === s.key} onClick={() => setSize(s.key)} title={s.title} />
            ))}
          </div>
        </Question>

        {wantsCalls ? (
          <Question n={++n} title="Roughly how many calls do you get a month?">
            <div className="grid gap-2 sm:grid-cols-3">
              {prices.phoneTiers.map((t, i, all) => (
                <Choice
                  key={t.key}
                  selected={tierKey === t.key}
                  onClick={() => setTierKey(t.key)}
                  title={
                    i === 0
                      ? `Up To ${t.calls}`
                      : i === all.length - 1
                        ? `${all[i - 1].calls} Or More`
                        : `${all[i - 1].calls}–${t.calls}`
                  }
                />
              ))}
            </div>
          </Question>
        ) : null}

        {wantsSeo ? (
          <Question n={++n} title="Where do customers find you?">
            <div className="grid gap-2 sm:grid-cols-3">
              {SEO_TARGETS.map((t) => (
                <Choice
                  key={t.key}
                  selected={seoTarget === t.key}
                  onClick={() => setSeoTarget(t.key)}
                  title={t.title}
                  body={t.body}
                />
              ))}
            </div>
          </Question>
        ) : null}
      </div>

      <div className="flex flex-col rounded-xl bg-gray-50 p-6" aria-live="polite">
        <p className="text-xs font-semibold uppercase tracking-widest text-lumi-700">
          Our Recommendation
        </p>
        {!ready ? (
          <p className="mt-4 text-sm leading-relaxed text-gray-500">
            Answer the questions and we&rsquo;ll put together what your
            business needs, with a monthly estimate.
          </p>
        ) : size === "enterprise" ? (
          <>
            <h3 className="mt-4 text-xl font-semibold text-gray-900">Enterprise</h3>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">
              At your size, a custom plan across every location and brand costs
              less and fits better than stacking self-serve plans. Tell us what
              you picked and we&rsquo;ll put a quote together.
            </p>
            <div className="mt-auto pt-6">
              <a
                href={enterpriseHref}
                className="block rounded-md bg-gray-900 px-4 py-3 text-center text-sm font-medium text-white hover:bg-gray-800"
              >
                Talk To Us About Enterprise
              </a>
            </div>
          </>
        ) : (
          <>
            <ul className="mt-4 space-y-4">
              {recs.map((r) => (
                <li key={r.name} className="border-b border-gray-200 pb-4 last:border-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <a href={r.href} className="text-sm font-semibold text-gray-900 hover:underline">
                      {r.name}
                    </a>
                    <span className="shrink-0 text-sm font-medium text-gray-900">{r.price}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">{r.why}</p>
                </li>
              ))}
            </ul>
            <div className="mt-auto pt-4">
              <p className="flex items-baseline justify-between text-sm text-gray-600">
                Estimated total{" "}
                <span className="text-2xl font-semibold tracking-tight text-gray-900">
                  {usd(total)}
                  <span className="text-sm font-normal text-gray-500">/mo</span>
                </span>
              </p>
              <Link
                href={onlySeo ? seoSignupHref : signupHref}
                className="mt-4 block rounded-md bg-gray-900 px-4 py-3 text-center text-sm font-medium text-white hover:bg-gray-800"
              >
                Create Your Account
              </Link>
              <p className="mt-2 text-center text-xs text-gray-400">
                Add or remove products any time from your dashboard.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
