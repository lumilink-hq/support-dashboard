// =============================================================================
// test-voice-lookup.mjs — drive the voice-order-lookup function end to end
// without Twilio / ElevenLabs / live store creds.
//
// Prereqs (one terminal):
//   supabase start                      # local stack; applies migrations
//   psql "$(supabase status -o json | jq -r .DB_URL)" \
//     -f supabase/seed_clients.sql       # seed Bud Club (woo-store)
//   # give the pilot client a phone number so resolve_client_by_number matches:
//   psql "$DB_URL" -c "update clients set phone_number='+14155550123' where slug='woo-store';"
//   MOCK_STORE=1 VOICE_TOOL_SECRET=dev-secret \
//     supabase functions serve voice-order-lookup --no-verify-jwt --env-file scripts/.env.test
//
// Then (another terminal):
//   FUNCTION_URL=http://localhost:54321/functions/v1/voice-order-lookup \
//   VOICE_TOOL_SECRET=dev-secret CALLED_NUMBER=+14155550123 \
//     node scripts/test-voice-lookup.mjs
//
// Exits non-zero if any case fails.
// =============================================================================

const URL = process.env.FUNCTION_URL ??
  "http://localhost:54321/functions/v1/voice-order-lookup";
const SECRET = process.env.VOICE_TOOL_SECRET ?? "dev-secret";
const CALLED = process.env.CALLED_NUMBER ?? "+14155550123";

let failures = 0;

async function call(body) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-voice-tool-secret": SECRET },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const cases = [
  {
    name: "unknown dialed number -> unknown_number",
    body: { called_number: "+19998887777", order_number: "5", call_sid: "CA_x" },
    assert: (r) => r.json.unknown_number === true && r.json.found === false,
  },
  {
    name: "no order number -> need_order_number",
    body: { called_number: CALLED, call_sid: "CA_a" },
    assert: (r) => r.json.need_order_number === true,
  },
  {
    name: "normal order (mock) -> found, not escalated",
    body: { called_number: CALLED, order_number: "12345", call_sid: "CA_b" },
    assert: (r) =>
      r.json.found === true &&
      r.json.should_escalate === false &&
      Array.isArray(r.json.items),
  },
  {
    name: "flagged order (mock '0' -> on-hold) -> should_escalate",
    body: { called_number: CALLED, order_number: "0", call_sid: "CA_c" },
    assert: (r) =>
      r.json.found === true &&
      r.json.should_escalate === true &&
      r.json.flag_reason === "abnormal_status",
  },
  {
    name: "bad secret -> 401",
    raw: async () => {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-voice-tool-secret": "wrong" },
        body: JSON.stringify({ called_number: CALLED, order_number: "1" }),
      });
      return { status: res.status };
    },
    assert: (r) => r.status === 401,
  },
];

console.log(`Testing ${URL}`);
for (const c of cases) {
  try {
    const r = c.raw ? await c.raw() : await call(c.body);
    check(c.name, c.assert(r), JSON.stringify(r.json ?? r));
  } catch (e) {
    failures++;
    console.error(`  FAIL ${c.name} — threw ${e.message}`);
  }
}

if (failures) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("\nAll voice-lookup cases passed.");
