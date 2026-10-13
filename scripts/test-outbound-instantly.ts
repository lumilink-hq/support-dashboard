// =============================================================================
// test-outbound-instantly.ts — unit tests for the outbound-instantly pure
// helpers (docs/OUTBOUND-PLAN.md, Phase 2).
//
//   npx tsx scripts/test-outbound-instantly.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  planUpdate,
  pushQuota,
  replySnippet,
  shouldRemove,
  toInstantlyLead,
} from "../supabase/functions/outbound-instantly/lib.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${got === undefined ? "" : `  (got: ${JSON.stringify(got)})`}`);
  }
}

console.log("toInstantlyLead");
{
  const p = toInstantlyLead({
    id: "lead-1", email: "info@greenleaf.com", business_name: "Green Leaf", website_url: "https://greenleaf.com",
    phone: "+13135550100", city: "Detroit", region: "MI", category: "Cannabis store",
  });
  ok("documented fields only", JSON.stringify(Object.keys(p).sort()) === '["company_name","custom_variables","email","phone","website"]', Object.keys(p));
  ok("our id rides in custom_variables", (p.custom_variables as Record<string, string>).lumilink_lead_id === "lead-1");
  ok("city, state, category for the copy", JSON.stringify(p.custom_variables) ===
    '{"lumilink_lead_id":"lead-1","city":"Detroit","state":"MI","category":"Cannabis store"}', p.custom_variables);
  const bare = toInstantlyLead({ id: "x", email: "a@b.com", business_name: "B", website_url: null, phone: null, city: null, region: null, category: null });
  ok("empty values are left out", !("website" in bare) && !("phone" in bare) &&
    JSON.stringify(bare.custom_variables) === '{"lumilink_lead_id":"x"}', bare);
}

console.log("pushQuota");
ok("what's left of today's target", pushQuota({ dailyTarget: 50, pushedToday: 20, inInstantly: 100, contactCap: 1000 }) === 30);
ok("nothing once the target is met", pushQuota({ dailyTarget: 50, pushedToday: 60, inInstantly: 0, contactCap: 1000 }) === 0);
ok("stops short of the contact cap", pushQuota({ dailyTarget: 50, pushedToday: 0, inInstantly: 930, contactCap: 1000 }) === 20,
  pushQuota({ dailyTarget: 50, pushedToday: 0, inInstantly: 930, contactCap: 1000 }));
ok("nothing at the cap margin", pushQuota({ dailyTarget: 50, pushedToday: 0, inInstantly: 960, contactCap: 1000 }) === 0);
ok("never over the API's 1,000 per call", pushQuota({ dailyTarget: 5000, pushedToday: 0, inInstantly: 0, contactCap: 100000 }) === 1000);

console.log("planUpdate");
const q = { stage: "queued", last_reply_at: null };
ok("unsubscribed is suppressed", planUpdate(q, { id: "i", status: -2 }).suppress === "unsubscribed");
ok("bounced is suppressed", planUpdate(q, { id: "i", status: -1 }).suppress === "bounced");
ok("still sending: no change", JSON.stringify(planUpdate(q, { id: "i", status: 1, email_reply_count: 0 })) === "{}");
{
  const u = planUpdate(q, { id: "i", status: 1, email_reply_count: 1, timestamp_last_reply: "2026-10-13T15:00:00Z" });
  ok("a first reply moves to replied and asks for the text", u.stage === "replied" && u.fetchReply === true &&
    u.last_reply_at === "2026-10-13T15:00:00Z", u);
}
{
  const u = planUpdate({ stage: "replied", last_reply_at: "2026-10-13T15:00:00Z" },
    { id: "i", status: 1, email_reply_count: 1, timestamp_last_reply: "2026-10-13T15:00:00Z" });
  ok("the same reply again: no change, no refetch", JSON.stringify(u) === "{}", u);
}
ok("sequence done, no reply: finished", planUpdate(q, { id: "i", status: 3, email_reply_count: 0 }).stage === "finished");
ok("interested in Instantly: positive", planUpdate(q, { id: "i", status: 1, email_reply_count: 1, lt_interest_status: 1 }).stage === "positive");
ok("not interested: negative", planUpdate(q, { id: "i", status: 3, email_reply_count: 1, lt_interest_status: -1 }).stage === "negative");
ok("wrong person: negative", planUpdate(q, { id: "i", status: 3, email_reply_count: 1, lt_interest_status: -2 }).stage === "negative");
ok("meeting booked: booked", planUpdate(q, { id: "i", lt_interest_status: 2 }).stage === "booked");
ok("won: won", planUpdate(q, { id: "i", lt_interest_status: 4 }).stage === "won");
ok("out of office: just replied", planUpdate(q, { id: "i", email_reply_count: 1, lt_interest_status: 0 }).stage === "replied");
ok("a person's 'called' isn't undone by a reply", planUpdate({ stage: "called", last_reply_at: null },
  { id: "i", email_reply_count: 2, timestamp_last_reply: "2026-10-14T00:00:00Z" }).stage === undefined);
ok("but a newer reply time is still recorded", planUpdate({ stage: "called", last_reply_at: null },
  { id: "i", email_reply_count: 2, timestamp_last_reply: "2026-10-14T00:00:00Z" }).last_reply_at === "2026-10-14T00:00:00Z");
ok("booked can still become won", planUpdate({ stage: "booked", last_reply_at: null }, { id: "i", lt_interest_status: 4 }).stage === "won");
ok("a reply after finishing moves on", planUpdate({ stage: "finished", last_reply_at: null },
  { id: "i", status: 3, email_reply_count: 1, timestamp_last_reply: "2026-10-20T00:00:00Z" }).stage === "replied");
ok("won is final", JSON.stringify(planUpdate({ stage: "won", last_reply_at: null }, { id: "i", status: -2 })) === "{}");
ok("suppressed is final", JSON.stringify(planUpdate({ stage: "suppressed", last_reply_at: null }, { id: "i", lt_interest_status: 1 })) === "{}");

console.log("shouldRemove");
const now = Date.parse("2026-11-30T00:00:00Z");
ok("finished leaves", shouldRemove({ stage: "finished", last_reply_at: null, pushed_at: "2026-11-01T00:00:00Z" }, now));
ok("suppressed leaves", shouldRemove({ stage: "suppressed", last_reply_at: null, pushed_at: null }, now));
ok("negative, lost and won leave", ["negative", "lost", "won"].every((s) => shouldRemove({ stage: s, last_reply_at: null, pushed_at: null }, now)));
ok("still sending stays", !shouldRemove({ stage: "queued", last_reply_at: null, pushed_at: "2026-01-01T00:00:00Z" }, now));
ok("a recent conversation stays", !shouldRemove({ stage: "positive", last_reply_at: "2026-11-20T00:00:00Z", pushed_at: null }, now));
ok("a conversation quiet for 30+ days leaves", shouldRemove({ stage: "replied", last_reply_at: "2026-10-01T00:00:00Z", pushed_at: null }, now));

console.log("replySnippet");
ok("keeps the new text, drops the quoted thread", replySnippet(
  "Yes, call me Thursday after 2.\n\nOn Mon, Oct 12, 2026 at 9:00 AM Alex <alex@getlumilink.com> wrote:\n> Hey, quick question") ===
  "Yes, call me Thursday after 2.", replySnippet("Yes, call me Thursday after 2.\n\nOn Mon, Oct 12, 2026 at 9:00 AM Alex <alex@getlumilink.com> wrote:\n> Hey"));
ok("drops 'Sent from my iPhone'", replySnippet("Sure thing\nSent from my iPhone") === "Sure thing");
ok("falls back to the HTML body", replySnippet("", "<p>Sounds good &amp; thanks</p><br>") === "Sounds good & thanks");
ok("empty gives null", replySnippet("> only quoted") === null && replySnippet(null) === null);
ok("long replies are cut to 500", (replySnippet("x".repeat(900)) ?? "").length === 500);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
