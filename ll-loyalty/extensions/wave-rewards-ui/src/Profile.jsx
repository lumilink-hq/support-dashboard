// customer-account.profile.block.render — balance, tier, progress and unused
// reward codes. Mirrors the Wave Rewards page (Phase 1), so it's the same for
// the holdout (0212 header).
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { fmt, money, useLoyalty } from "./shared.jsx";

export default function extension() {
  render(<Profile />, document.body);
}

function Profile() {
  const state = useLoyalty(null);
  if (!state?.member) return null;
  const { member: m, next_tier: tier, next_reward: reward, codes } = state;
  const store = (shopify.shop?.storefrontUrl ?? "").replace(/\/+$/, "");

  return (
    <s-section heading={state.program?.name ?? "Rewards"}>
      <s-stack gap="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-badge>{m.tier}</s-badge>
          <s-text type="strong">{fmt(m.points)} points</s-text>
        </s-stack>
        {tier && tier.remaining_cents > 0 ? <s-text>{money(tier.remaining_cents)} more to reach {tier.name}.</s-text> : null}
        {reward && reward.remaining_points > 0 ? <s-text>{fmt(reward.remaining_points)} more points for {reward.name}.</s-text> : null}
        {codes?.length ? (
          <s-stack gap="small-200">
            <s-text type="strong">Your reward codes</s-text>
            {codes.map((c) => <s-text key={c.code}>{c.code} · {money(c.value_cents)} off</s-text>)}
          </s-stack>
        ) : null}
        {store ? <s-link href={`${store}/pages/wave-rewards`}>Redeem points and see ways to earn</s-link> : null}
      </s-stack>
    </s-section>
  );
}
