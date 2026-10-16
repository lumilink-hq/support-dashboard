// The /pricing comparison table reads PlanTier's numbers, careHoursPerMonth
// and transfer flags; the plan cards read the typed highlights. This keeps the
// two saying the same thing. Run: npx tsx scripts/test-plan-compare.ts
import assert from "node:assert/strict";

async function main() {
  const { PLAN_TIERS } = await import("../lib/entitlements");

  for (const t of PLAN_TIERS) {
    const text = t.highlights.join(" | ");
    const inherits = text.includes("Everything in ");

    assert.ok(
      text.includes(`${t.careHoursPerMonth} hours of platform care`),
      `${t.key}: care hours ${t.careHoursPerMonth} not in highlights`,
    );
    if (t.numbers > 1) {
      assert.ok(text.includes(`${t.numbers} local phone numbers`), `${t.key}: numbers`);
    } else if (!inherits) {
      assert.ok(text.includes("1 local phone number"), `${t.key}: numbers`);
    }
    if (t.advancedTransfers && !text.includes("Advanced transfers")) {
      // Scale's card says "Advanced routing" instead; it still has 0036's four
      // transfer destinations, so the table ticks transfers for it too.
      assert.ok(t.advancedRouting, `${t.key}: transfers claimed but not on the card`);
    }
    if (t.advancedRouting) assert.ok(text.includes("Advanced routing"), `${t.key}: routing`);
  }

  // Ticks only ever increase up the ladder.
  for (let i = 1; i < PLAN_TIERS.length; i++) {
    const [a, b] = [PLAN_TIERS[i - 1], PLAN_TIERS[i]];
    assert.ok(b.includedMinutes >= a.includedMinutes, "minutes");
    assert.ok(b.numbers >= a.numbers, "numbers");
    assert.ok(b.careHoursPerMonth >= a.careHoursPerMonth, "care hours");
    assert.ok(!a.advancedTransfers || b.advancedTransfers, "transfers");
    assert.ok(!a.advancedRouting || b.advancedRouting, "routing");
  }

  console.log("plan compare: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
