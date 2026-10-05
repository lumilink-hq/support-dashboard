// =============================================================================
// test-contact-rule.ts — the agent must not hand out a support email when
// escalation_mode is 'callback'.
//
//   npx tsx scripts/test-contact-rule.ts
//
// Regression: a caller asked Bud Club's agent whether it had a support email and
// it answered with one, read straight out of settings.policies. escalation_mode
// governs escalation, not knowledge, so the rule has to sit above the policies.
// =============================================================================

import {
  readClientConfig,
  withContactRule,
} from "../supabase/functions/voice-personalization/lib.ts";

let f = 0;
const ok = (l: string, c: boolean, d?: unknown) => {
  if (c) console.log(`  ok   ${l}`);
  else { f++; console.error(`  FAIL ${l}${d === undefined ? "" : ` — ${JSON.stringify(d)}`}`); }
};

const POLICIES =
  "REFUNDS: all sales are final. CONTACT: hey@budclub.com or budclub.com/contact.";

const cfgWith = (settings: Record<string, unknown>) =>
  readClientConfig({ name: "Bud Club", slug: "budmember001", settings });

console.log("\ncallback mode (the default)");
{
  const cfg = cfgWith({ policies: POLICIES });
  const out = withContactRule(cfg);
  ok("defaults to callback when unset", cfg.escalationMode === "callback");
  ok("a contact rule is prepended", out.startsWith("CONTACT RULE"));
  ok("the rule forbids reading an address aloud", /[Nn]ever read out/.test(out));
  ok("the rule appears BEFORE the policies it overrides",
     out.indexOf("CONTACT RULE") < out.indexOf("REFUNDS"));
  ok("policy substance is preserved, not stripped", out.includes("all sales are final"));
}

console.log("\nemail mode (opt-in)");
{
  const cfg = cfgWith({ policies: POLICIES, escalation_mode: "email" });
  ok("reads as email mode", cfg.escalationMode === "email");
  ok("policies pass through untouched", withContactRule(cfg) === POLICIES);
}

console.log("\npolarity cannot be got backwards");
{
  ok("unknown value falls back to callback",
     cfgWith({ escalation_mode: "e-mail" }).escalationMode === "callback");
  ok("empty string falls back to callback",
     cfgWith({ escalation_mode: "" }).escalationMode === "callback");
  ok("boolean true falls back to callback",
     cfgWith({ escalation_mode: true }).escalationMode === "callback");
}

console.log("\nno policies configured");
{
  const cfg = cfgWith({});
  const out = withContactRule(cfg);
  ok("the rule still ships when there are no policies", out.startsWith("CONTACT RULE"));
  ok("no stray separator on an empty blob", !out.includes("\n\n"));
}

console.log(f === 0 ? "\nAll contact-rule tests passed.\n" : `\n${f} FAILED\n`);
process.exit(f === 0 ? 0 : 1);
