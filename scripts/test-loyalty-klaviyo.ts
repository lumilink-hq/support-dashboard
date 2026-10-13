// =============================================================================
// test-loyalty-klaviyo.ts — unit tests for loyalty-klaviyo/lib.ts (0205):
// request headers and bodies for Klaviyo's events and profile-import
// endpoints, error text and retry timing.
//
//   npx tsx scripts/test-loyalty-klaviyo.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  errorText,
  eventBody,
  isRetryable,
  KLAVIYO_REVISION,
  klaviyoHeaders,
  profileBody,
  retryAfterMs,
} from "../supabase/functions/loyalty-klaviyo/lib.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
  }
}

function eq(label: string, got: unknown, want: unknown) {
  ok(label, JSON.stringify(got) === JSON.stringify(want), got);
}

function main() {
  eq("headers: private key auth + JSON:API + pinned revision", klaviyoHeaders("pk_x"), {
    Authorization: "Klaviyo-API-Key pk_x",
    accept: "application/vnd.api+json",
    "content-type": "application/vnd.api+json",
    revision: "2026-07-15",
  });
  eq("revision", KLAVIYO_REVISION, "2026-07-15");

  eq("event: metric by name, profile by email, unique_id, time", eventBody({
    id: 9, metric: "Joy: Tier Downgrade", unique_id: "ll-p-9", time: "2026-10-13T00:00:00Z", email: "a@example.com",
    properties: { tier: "Silver", previous_tier: "Gold" },
  }), {
    data: {
      type: "event",
      attributes: {
        properties: { tier: "Silver", previous_tier: "Gold" },
        time: "2026-10-13T00:00:00Z",
        unique_id: "ll-p-9",
        metric: { data: { type: "metric", attributes: { name: "Joy: Tier Downgrade" } } },
        profile: { data: { type: "profile", attributes: { email: "a@example.com" } } },
      },
    },
  });

  const profile = profileBody({ member_id: "m", email: "a@example.com", hash: "h", properties: { "Joy Vip tier": "Gold", "Joy Loyalty Points": 10 } });
  eq("profile: email + custom properties only", profile, {
    data: { type: "profile", attributes: { email: "a@example.com", properties: { "Joy Vip tier": "Gold", "Joy Loyalty Points": 10 } } },
  });
  ok("profile: never touches subscriptions or consent", !JSON.stringify(profile).match(/subscri|consent/i));

  eq("error: JSON:API errors flattened", errorText(400, { errors: [{ code: "invalid", detail: "bad email" }, { title: "Other" }] }),
    "Klaviyo 400: invalid: bad email; Other");
  eq("error: no body", errorText(503, null), "Klaviyo 503");

  eq("retry-after: seconds", retryAfterMs("3"), 3000);
  eq("retry-after: capped", retryAfterMs("600"), 30000);
  eq("retry-after: missing", retryAfterMs(null), 2000);
  eq("retryable: 429", isRetryable(429), true);
  eq("retryable: 500", isRetryable(500), true);
  eq("retryable: 400", isRetryable(400), false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
