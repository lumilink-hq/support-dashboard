// Shared by the three Wave Rewards UI targets. Data: loyalty-ext (0212).
// State shape (loyalty_extension_state): program {name}; member {first_name,
// points, tier, tier_spend_cents} | null (guest); rate (points per $ at the
// member's tier); order {recorded, points_earned} | null; next_tier
// {name, remaining_cents}; next_reward {name, points_cost, remaining_points};
// codes [{code, value_cents}]; nudges (purchase-moment nudges are on).

import { useEffect, useState } from "preact/hooks";

// Production loyalty-ext. Same project as shopify.app.toml's URLs.
const API = "https://xqsxjxrzpxhosedkmufg.supabase.co/functions/v1/loyalty-ext";

export async function loadState(orderGid) {
  const token = await shopify.sessionToken.get();
  const url = orderGid ? `${API}?order=${encodeURIComponent(orderGid)}` : API;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`loyalty-ext ${res.status}`);
  return res.json();
}

/**
 * Loads the state; while the order isn't recorded yet (orders/paid lands
 * seconds after checkout) it asks again a few times.
 */
export function useLoyalty(orderGid, { retryUntilRecorded = false } = {}) {
  const [state, setState] = useState(undefined); // undefined = loading, null = unavailable
  useEffect(() => {
    let alive = true;
    let tries = 0;
    async function run() {
      try {
        const s = await loadState(orderGid);
        if (!alive) return;
        setState(s);
        if (retryUntilRecorded && s?.member && s.order && !s.order.recorded && ++tries < 4) setTimeout(run, 4000);
      } catch {
        if (alive) setState(null);
      }
    }
    run();
    return () => { alive = false; };
  }, [orderGid]);
  return state;
}

export function money(cents) {
  const v = (cents ?? 0) / 100;
  try {
    return shopify.i18n.formatCurrency(v, { currency: "USD" });
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

export const fmt = (n) => {
  try {
    return shopify.i18n.formatNumber(n);
  } catch {
    return String(n);
  }
};

/** Next tier + next reward lines. Only rendered when state.nudges (holdout never). */
export function Progress({ state }) {
  const { next_tier: tier, next_reward: reward } = state;
  return (
    <s-stack gap="small-200">
      {tier && tier.remaining_cents > 0 ? (
        <s-text>{money(tier.remaining_cents)} more to reach {tier.name}.</s-text>
      ) : null}
      {reward ? (
        reward.remaining_points > 0
          ? <s-text>{fmt(reward.remaining_points)} more points for {reward.name}.</s-text>
          : <s-text>You have enough points for {reward.name}.</s-text>
      ) : null}
    </s-stack>
  );
}

/**
 * The thank-you / order status block: points for this order, balance, and
 * (treatment only) progress. subtotalCents: the estimate while the order
 * isn't recorded yet.
 */
export function OrderBlock({ state, subtotalCents }) {
  if (!state) return null;
  const name = state.program?.name ?? "Rewards";

  if (!state.member) {
    return (
      <s-section heading={name}>
        <s-text>This order earns {name} points. Sign in with your email to see your balance and rewards.</s-text>
      </s-section>
    );
  }

  const m = state.member;
  const earned = state.order?.recorded ? state.order.points_earned : null;
  const estimate = earned === null && subtotalCents ? Math.floor((subtotalCents / 100) * state.rate) : null;

  return (
    <s-section heading={name}>
      <s-stack gap="small-200">
        {earned !== null && earned > 0 ? <s-text type="strong">You earned {fmt(earned)} points on this order.</s-text> : null}
        {estimate ? <s-text type="strong">You'll earn about {fmt(estimate)} points once your order is confirmed.</s-text> : null}
        <s-text>
          {m.tier} member · {fmt(m.points)} points
        </s-text>
        {state.nudges ? <Progress state={state} /> : null}
      </s-stack>
    </s-section>
  );
}
