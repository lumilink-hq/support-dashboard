// =============================================================================
// test-billing-webhook.ts — unit tests for the Stripe adapter in
// supabase/functions/billing-webhook/lib.ts.
//
//   npx tsx scripts/test-billing-webhook.ts
//   (or: node --experimental-strip-types scripts/test-billing-webhook.ts)
//
// No network, no Stripe account, no database. Signatures are generated here
// with the same Web Crypto primitives the function uses, so the verifier is
// tested against real HMACs rather than a mock of itself.
//
// Everything runs inside main() rather than at the top level. package.json has
// no "type": "module", so tsx compiles this to CJS, where top-level await is a
// build error. An async wrapper keeps the file runnable under both tsx and
// node --experimental-strip-types without touching the package's module mode.
//
// WHAT MATTERS MOST, in order:
//   1. A forged or stale signature must be REFUSED. Accepting one grants a paid
//      plan to whoever sent the request.
//   2. An event we can't route to a tenant must arrive with clientId = null so
//      apply_billing_event parks it. Guessing a tenant grants one customer's
//      plan to another customer's workspace.
//   3. A one-off payment must not be mistaken for a subscription starting.
// =============================================================================

import {
  parseStripeEvent,
  parseStripeSignatureHeader,
  parseWebhookSecrets,
  timingSafeEqualHex,
  unixToIso,
  verifyStripeSignature,
} from "../supabase/functions/billing-webhook/lib.ts";

let failures = 0;

function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(
      `  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
    );
  }
}

const SECRET = "whsec_test_2f8a9c1e4b7d6a5f3e2c1b0a9d8e7f6c";
const NOW = 1_800_000_000; // fixed clock so tests never depend on wall time

/** Produce a valid Stripe-Signature header for a body, the way Stripe does. */
async function sign(
  body: string,
  timestamp: number,
  secret = SECRET,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${timestamp}.${body}`),
  );
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
}

const BODY = JSON.stringify({
  id: "evt_1",
  type: "customer.subscription.created",
  data: { object: { object: "subscription", id: "sub_1" } },
});

function evt(
  type: string,
  object: Record<string, unknown>,
  id = "evt_x",
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({ id, type, data: { object }, ...extra });
}

async function main() {
// ---------------------------------------------------------------------------
console.log("\nBILLING_WEBHOOK_SECRETS parsing — must never throw");
// ---------------------------------------------------------------------------
{
  // The regression: a bare whsec_ was pasted in, JSON.parse threw at module
  // load, and every delivery 5xx'd before a handler ran.
  const bare = parseWebhookSecrets("whsec_igwBexample123");
  ok("bare whsec_ is accepted as a fallback secret", bare.fallback[0] === "whsec_igwBexample123");
  ok("bare whsec_ raises no config error", bare.configError === null);
  ok("bare whsec_ leaves the map empty", Object.keys(bare.map).length === 0);

  const bareSpaced = parseWebhookSecrets("  whsec_padded  ");
  ok("surrounding whitespace is trimmed", bareSpaced.fallback[0] === "whsec_padded");

  const mapped = parseWebhookSecrets('{"stripe":"whsec_a","square":"sq_b"}');
  ok(
    "JSON map still works",
    mapped.map.stripe?.[0] === "whsec_a" && mapped.map.square?.[0] === "sq_b",
  );
  ok("JSON map sets no fallback", mapped.fallback.length === 0);

  // The cutover case: test and live endpoints have different secrets and both
  // deliver to this one function.
  const bareList = parseWebhookSecrets("whsec_live,whsec_test");
  ok("comma-separated bare secrets both load", bareList.fallback.length === 2, bareList.fallback);
  ok(
    "comma-separated secrets keep their order",
    bareList.fallback[0] === "whsec_live" && bareList.fallback[1] === "whsec_test",
  );

  const mappedList = parseWebhookSecrets('{"stripe":["whsec_live","whsec_test"]}');
  ok("JSON array of secrets loads", mappedList.map.stripe?.length === 2, mappedList.map.stripe);

  const spacedList = parseWebhookSecrets("whsec_a , whsec_b ,, ");
  ok(
    "list entries are trimmed and empties dropped",
    spacedList.fallback.length === 2 && spacedList.fallback[1] === "whsec_b",
    spacedList.fallback,
  );

  const broken = parseWebhookSecrets('{"stripe":"whsec_a"');
  ok("truncated JSON reports a config error instead of throwing", broken.configError !== null);
  ok("truncated JSON yields no usable secret", broken.fallback.length === 0);

  const arr = parseWebhookSecrets("[1,2,3]");
  ok("a JSON array is not treated as a secret map", arr.configError !== null || arr.fallback.length > 0);

  const blank = parseWebhookSecrets("");
  ok("empty value yields no secret and no error", blank.fallback.length === 0 && blank.configError === null);
  const undef = parseWebhookSecrets(undefined);
  ok("undefined value is handled", undef.fallback.length === 0 && undef.configError === null);
}

// ---------------------------------------------------------------------------
console.log("\nsignature header parsing");
// ---------------------------------------------------------------------------
{
  const h = parseStripeSignatureHeader("t=123,v1=aaa,v1=bbb,v0=ccc");
  ok("reads the timestamp", h.timestamp === 123);
  ok("collects every v1 (secret rotation sends more than one)", h.v1.length === 2);
  ok("ignores the legacy v0 scheme", !h.v1.includes("ccc"));

  const empty = parseStripeSignatureHeader(null);
  ok("null header yields no timestamp", empty.timestamp === null);
  ok("null header yields no signatures", empty.v1.length === 0);

  const junk = parseStripeSignatureHeader("garbage");
  ok("unparseable header yields no signatures", junk.v1.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\nsignature verification — the security boundary");
// ---------------------------------------------------------------------------
{
  const good = await sign(BODY, NOW);

  ok(
    "accepts a correctly signed, fresh request",
    await verifyStripeSignature(BODY, good, SECRET, { nowSecs: NOW }),
  );

  ok(
    "REFUSES when the body was tampered with after signing",
    !(await verifyStripeSignature(
      BODY.replace("sub_1", "sub_ATTACKER"),
      good,
      SECRET,
      { nowSecs: NOW },
    )),
  );

  ok(
    "REFUSES a signature made with a different secret",
    !(await verifyStripeSignature(
      BODY,
      await sign(BODY, NOW, "whsec_wrong_secret_value_here"),
      SECRET,
      { nowSecs: NOW },
    )),
  );

  ok(
    "REFUSES when no secret is configured (never trusts by default)",
    !(await verifyStripeSignature(BODY, good, undefined, { nowSecs: NOW })),
  );

  ok(
    "REFUSES an empty secret",
    !(await verifyStripeSignature(BODY, good, "", { nowSecs: NOW })),
  );

  ok(
    "REFUSES a missing signature header",
    !(await verifyStripeSignature(BODY, null, SECRET, { nowSecs: NOW })),
  );

  ok(
    "REFUSES a header with a timestamp but no v1",
    !(await verifyStripeSignature(BODY, `t=${NOW}`, SECRET, { nowSecs: NOW })),
  );

  // Replay protection.
  ok(
    "REFUSES a replayed request older than the tolerance",
    !(await verifyStripeSignature(BODY, await sign(BODY, NOW - 400), SECRET, {
      nowSecs: NOW,
      toleranceSecs: 300,
    })),
  );
  ok(
    "accepts a request inside the tolerance window",
    await verifyStripeSignature(BODY, await sign(BODY, NOW - 120), SECRET, {
      nowSecs: NOW,
      toleranceSecs: 300,
    }),
  );
  ok(
    "REFUSES a far-FUTURE timestamp (clock-skew forgery, not just staleness)",
    !(await verifyStripeSignature(BODY, await sign(BODY, NOW + 4000), SECRET, {
      nowSecs: NOW,
      toleranceSecs: 300,
    })),
  );

  // Rotation: Stripe sends both the old and new signature during a rollover.
  const rotated = `t=${NOW},v1=deadbeef,${(await sign(BODY, NOW)).split(",")[1]}`;
  ok(
    "accepts when any offered v1 matches (secret rotation)",
    await verifyStripeSignature(BODY, rotated, SECRET, { nowSecs: NOW }),
  );

  ok("timingSafeEqualHex matches equal strings", timingSafeEqualHex("abc", "abc"));
  ok("timingSafeEqualHex rejects different lengths", !timingSafeEqualHex("abc", "abcd"));
  ok("timingSafeEqualHex rejects same-length mismatch", !timingSafeEqualHex("abc", "abd"));
}

// ---------------------------------------------------------------------------
console.log("\nevent type mapping");
// ---------------------------------------------------------------------------
{
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["checkout.session.completed", { mode: "subscription" }, "subscription_activated"],
    ["customer.subscription.created", { object: "subscription" }, "subscription_activated"],
    ["invoice.paid", {}, "subscription_renewed"],
    ["invoice.payment_succeeded", {}, "subscription_renewed"],
    ["invoice.payment_failed", {}, "payment_failed"],
    ["customer.subscription.deleted", { object: "subscription" }, "subscription_canceled"],
    ["customer.subscription.updated", { object: "subscription" }, "ignored"],
    ["payment_intent.succeeded", {}, "ignored"],
    ["charge.refunded", {}, "ignored"],
  ];

  for (const [stripeType, obj, expected] of cases) {
    const parsed = parseStripeEvent(evt(stripeType, obj));
    ok(`${stripeType} -> ${expected}`, parsed?.type === expected, parsed?.type);
  }

  // A one-off payment is not a subscription starting.
  const oneOff = parseStripeEvent(
    evt("checkout.session.completed", { mode: "payment" }),
  );
  ok(
    "checkout.session.completed in payment mode is IGNORED, not an activation",
    oneOff?.type === "ignored",
    oneOff?.type,
  );

  ok(
    "event id is carried through as the idempotency key",
    parseStripeEvent(evt("invoice.paid", {}, "evt_abc"))?.externalEventId === "evt_abc",
  );
  ok(
    "an event with no id returns null rather than a half-built event",
    parseStripeEvent(JSON.stringify({ type: "invoice.paid" })) === null,
  );
}

// ---------------------------------------------------------------------------
console.log("\ntenant routing — the wrong-tenant guard");
// ---------------------------------------------------------------------------
{
  const CLIENT = "8f2c1e00-0000-0000-0000-000000000000";

  const viaMetadata = parseStripeEvent(
    evt("customer.subscription.created", {
      object: "subscription",
      metadata: { client_id: CLIENT, feature: "voice" },
    }),
  );
  ok("reads client_id from metadata", viaMetadata?.clientId === CLIENT);
  ok("reads feature from metadata", viaMetadata?.feature === "voice");

  const viaRef = parseStripeEvent(
    evt("checkout.session.completed", {
      mode: "subscription",
      client_reference_id: CLIENT,
    }),
  );
  ok(
    "falls back to client_reference_id (what checkoutUrl appends)",
    viaRef?.clientId === CLIENT,
  );

  const viaSubDetails = parseStripeEvent(
    evt("invoice.paid", {
      subscription_details: { metadata: { client_id: CLIENT, feature: "voice" } },
    }),
  );
  ok(
    "reads an invoice's subscription_details.metadata",
    viaSubDetails?.clientId === CLIENT,
  );

  // The one that matters.
  const anonymous = parseStripeEvent(
    evt("checkout.session.completed", { mode: "subscription" }),
  );
  ok(
    "UNROUTABLE event yields clientId null, so the RPC parks it as unmapped",
    anonymous?.clientId === null,
    anonymous?.clientId,
  );

  const bogusFeature = parseStripeEvent(
    evt("invoice.paid", { metadata: { feature: "wire-me-everything" } }),
  );
  ok(
    "an unrecognised feature string is dropped, not passed through",
    bogusFeature?.feature === null,
    bogusFeature?.feature,
  );
}

// ---------------------------------------------------------------------------
console.log("\nplan_tier metadata (0031 — which tier was bought)");
// ---------------------------------------------------------------------------
{
  const TIER_CLIENT = "8f2c1e00-0000-0000-0000-000000000000";

  // THE CASE THE WHOLE TIER LAYER RESTS ON.
  //
  // checkout.session.completed is the only event that can create a grant (it
  // alone carries client_reference_id) and it carries NO price — so the price
  // map cannot answer "which tier?" on the one event where the answer is
  // needed, and that same event kicks provisioning. If the tier doesn't come
  // off the link's metadata here, a $279 Growth buyer is provisioned with
  // Starter's 100 minutes.
  const grant = parseStripeEvent(
    evt("checkout.session.completed", {
      mode: "subscription",
      client_reference_id: TIER_CLIENT,
      metadata: { feature: "voice", plan_tier: "growth" },
    }),
  );
  ok(
    "the grant event carries plan_tier from link metadata",
    grant?.planTier === "growth",
    grant?.planTier,
  );
  ok(
    "...and still carries the tenant, so the grant is routable",
    grant?.clientId === TIER_CLIENT,
    grant?.clientId,
  );

  // Same place feature metadata is read from on renewals.
  const renewal = parseStripeEvent(
    evt("invoice.paid", {
      subscription_details: { metadata: { feature: "voice", plan_tier: "scale" } },
    }),
  );
  ok(
    "plan_tier is read from an invoice's subscription_details.metadata",
    renewal?.planTier === "scale",
    renewal?.planTier,
  );

  // Normalised, because a human types this into the Stripe dashboard by hand.
  const messy = parseStripeEvent(
    evt("invoice.paid", { metadata: { plan_tier: "  Growth  " } }),
  );
  ok(
    "plan_tier is trimmed and lowercased",
    messy?.planTier === "growth",
    messy?.planTier,
  );

  // NOT validated against a fixed list in the adapter — the tiers live in the
  // plan_tiers table so adding one is an INSERT. apply_billing_event checks the
  // value against that table and drops what it doesn't recognise, which is why
  // passing a typo through here is safe rather than sloppy: it degrades to "no
  // tier" instead of raising an FK violation that would abort the transaction
  // and take the billing_events audit row down with it.
  const typo = parseStripeEvent(
    evt("invoice.paid", { metadata: { plan_tier: "groth" } }),
  );
  ok(
    "an unknown tier is passed through for the DB to reject, not guessed at",
    typo?.planTier === "groth",
    typo?.planTier,
  );

  const noTier = parseStripeEvent(
    evt("invoice.paid", { metadata: { feature: "voice" } }),
  );
  ok(
    "a missing plan_tier is null, so the price map gets its turn",
    noTier?.planTier === null,
    noTier?.planTier,
  );

  const emptyTier = parseStripeEvent(
    evt("invoice.paid", { metadata: { plan_tier: "   " } }),
  );
  ok(
    "a blank plan_tier is null, not an empty string",
    emptyTier?.planTier === null,
    emptyTier?.planTier,
  );

  const numericTier = parseStripeEvent(
    evt("invoice.paid", { metadata: { plan_tier: 3 } }),
  );
  ok(
    "a non-string plan_tier is dropped",
    numericTier?.planTier === null,
    numericTier?.planTier,
  );
}

// ---------------------------------------------------------------------------
console.log("\naddon_key metadata (0040 — which add-on was bought)");
// ---------------------------------------------------------------------------
{
  const ADDON_CLIENT = "3a1b2c00-0000-0000-0000-000000000000";

  // THE CASE THE WHOLE WEBHOOK PATH RESTS ON, same reasoning as plan_tier
  // above: checkout.session.completed is the only event carrying
  // client_reference_id, and it carries no price — so on a BRAND NEW add-on,
  // the price map has nothing to match and the Payment Link's own
  // `addon_key` metadata is the only source.
  const grant = parseStripeEvent(
    evt("checkout.session.completed", {
      mode: "subscription",
      client_reference_id: ADDON_CLIENT,
      metadata: { feature: "voice", addon_key: "website_chat" },
    }),
  );
  ok(
    "the grant event carries addon_key from the add-on's own link metadata",
    grant?.addonKey === "website_chat",
    grant?.addonKey,
  );
  ok(
    "...and still carries the tenant, so it's routable",
    grant?.clientId === ADDON_CLIENT,
    grant?.clientId,
  );

  const renewal = parseStripeEvent(
    evt("invoice.paid", {
      subscription_details: { metadata: { addon_key: "additional_phone_line" } },
    }),
  );
  ok(
    "addon_key is read from an invoice's subscription_details.metadata",
    renewal?.addonKey === "additional_phone_line",
    renewal?.addonKey,
  );

  const messy = parseStripeEvent(
    evt("invoice.paid", { metadata: { addon_key: "  Managed_Integration  " } }),
  );
  ok(
    "addon_key is trimmed and lowercased",
    messy?.addonKey === "managed_integration",
    messy?.addonKey,
  );

  const noKey = parseStripeEvent(
    evt("invoice.paid", { metadata: { feature: "voice" } }),
  );
  ok(
    "a missing addon_key is null, so the price map gets its turn",
    noKey?.addonKey === null,
    noKey?.addonKey,
  );

  const emptyKey = parseStripeEvent(
    evt("invoice.paid", { metadata: { addon_key: "   " } }),
  );
  ok(
    "a blank addon_key is null, not an empty string",
    emptyKey?.addonKey === null,
    emptyKey?.addonKey,
  );

  const numericKey = parseStripeEvent(
    evt("invoice.paid", { metadata: { addon_key: 7 } }),
  );
  ok(
    "a non-string addon_key is dropped",
    numericKey?.addonKey === null,
    numericKey?.addonKey,
  );

  // A plan grant and an add-on grant can arrive as the SAME event (a plan
  // bought with an optional item at checkout has one client_id but two
  // things happening) — plan_tier and addon_key must not clobber each other.
  const both = parseStripeEvent(
    evt("checkout.session.completed", {
      mode: "subscription",
      client_reference_id: ADDON_CLIENT,
      metadata: { feature: "voice", plan_tier: "growth", addon_key: "website_chat" },
    }),
  );
  ok(
    "plan_tier and addon_key coexist on the same event",
    both?.planTier === "growth" && both?.addonKey === "website_chat",
    { planTier: both?.planTier, addonKey: both?.addonKey },
  );
}

// ---------------------------------------------------------------------------
console.log("\nfield extraction across Stripe's object shapes");
// ---------------------------------------------------------------------------
{
  const sub = parseStripeEvent(
    evt("customer.subscription.created", {
      object: "subscription",
      id: "sub_42",
      current_period_end: 1_800_003_600,
      items: { data: [{ price: { id: "price_starter" } }] },
    }),
  );
  ok("subscription: price id", sub?.externalPriceId === "price_starter");
  ok("subscription: its own id is the subscription ref", sub?.subscriptionRef === "sub_42");
  ok(
    "subscription: period end converted to ISO",
    sub?.currentPeriodEnd === new Date(1_800_003_600 * 1000).toISOString(),
    sub?.currentPeriodEnd,
  );

  const invoice = parseStripeEvent(
    evt("invoice.paid", {
      subscription: "sub_99",
      lines: { data: [{ price: { id: "price_x" }, period: { end: 1_800_007_200 } }] },
    }),
  );
  ok("invoice: subscription ref from the string field", invoice?.subscriptionRef === "sub_99");
  ok("invoice: price id from lines", invoice?.externalPriceId === "price_x");
  ok("invoice: period end from the line", invoice?.currentPeriodEnd !== null);

  // Stripe moved invoice line pricing in later API versions; both shapes work.
  const newShape = parseStripeEvent(
    evt("invoice.paid", {
      lines: { data: [{ pricing: { price_details: { price: "price_new" } } }] },
    }),
  );
  ok(
    "invoice: newer lines[].pricing.price_details.price shape",
    newShape?.externalPriceId === "price_new",
    newShape?.externalPriceId,
  );

  // The production bug: the first invoice for a plan with a setup fee lists the
  // one-time line FIRST, so reading only lines[0] resolved the $299 setup price
  // (not in the price map) and parked a good renewal as 'unmapped'.
  const withSetupFee = parseStripeEvent(
    evt("invoice.paid", {
      subscription: "sub_1",
      lines: {
        data: [
          { price: { id: "price_SETUP_299" } },
          { price: { id: "price_RECURRING_179" } },
        ],
      },
    }),
  );
  ok(
    "invoice with a setup-fee line exposes BOTH price ids",
    withSetupFee?.externalPriceIds?.length === 2,
    withSetupFee?.externalPriceIds,
  );
  ok(
    "the recurring price is among them even though setup is line 0",
    withSetupFee?.externalPriceIds?.includes("price_RECURRING_179") === true,
    withSetupFee?.externalPriceIds,
  );

  // Subscription items are collected ahead of invoice lines: on a subscription
  // object those are the recurring prices, which is what should match first.
  const multiItem = parseStripeEvent(
    evt("customer.subscription.created", {
      object: "subscription",
      items: { data: [{ price: { id: "price_a" } }, { price: { id: "price_b" } }] },
    }),
  );
  ok(
    "every subscription item price is collected",
    multiItem?.externalPriceIds?.join(",") === "price_a,price_b",
    multiItem?.externalPriceIds,
  );

  const deduped = parseStripeEvent(
    evt("invoice.paid", {
      lines: { data: [{ price: { id: "price_dupe" } }, { price: { id: "price_dupe" } }] },
    }),
  );
  ok("duplicate price ids are collapsed", deduped?.externalPriceIds?.length === 1);

  const bare = parseStripeEvent(evt("invoice.paid", {}));
  ok("missing price id is null, not undefined-ish", bare?.externalPriceId === null);
  ok("missing period end is null", bare?.currentPeriodEnd === null);
  ok("missing subscription ref is null", bare?.subscriptionRef === null);

  // livemode separates real money from test noise in one shared table.
  const live = parseStripeEvent(
    evt("invoice.paid", {}, "evt_live", { livemode: true }),
  );
  ok("livemode true is carried through", live?.livemode === true);

  const test = parseStripeEvent(
    evt("invoice.paid", {}, "evt_test", { livemode: false }),
  );
  ok("livemode false is carried through", test?.livemode === false);

  const ignoredLive = parseStripeEvent(
    evt("charge.refunded", {}, "evt_ign", { livemode: true }),
  );
  ok(
    "livemode is recorded even on ignored events",
    ignoredLive?.livemode === true && ignoredLive?.type === "ignored",
  );

  const noFlag = parseStripeEvent(evt("invoice.paid", {}, "evt_noflag"));
  ok("missing livemode is null, not false", noFlag?.livemode === null);

  ok("unixToIso rejects zero", unixToIso(0) === null);
  ok("unixToIso rejects non-numeric", unixToIso("later") === null);
  ok("unixToIso accepts a numeric string", unixToIso("1800003600") !== null);
}

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? "\nAll billing-webhook tests passed.\n"
    : `\n${failures} billing-webhook test(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nbilling-webhook tests crashed:", e);
  process.exit(1);
});
