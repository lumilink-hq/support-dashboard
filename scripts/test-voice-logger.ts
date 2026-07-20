// =============================================================================
// test-voice-logger.ts — unit tests for the voice-call-logger pure helpers.
// No Supabase / Deno needed. Run with tsx:
//   npx tsx scripts/test-voice-logger.ts
// Exercises payload extraction, role mapping, stable/idempotent turn refs,
// human-handoff detection, and the HMAC signature round-trip (Web Crypto works
// under Node 22's global `crypto`).
// =============================================================================

import {
  buildTurns,
  detectHumanHandoff,
  extractCallFields,
  hmacSha256Hex,
  mapRole,
  parseSignatureHeader,
  verifySignature,
  type PostCallPayload,
} from "../supabase/functions/voice-call-logger/lib.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {

// A representative ElevenLabs post-call payload.
const payload: PostCallPayload = {
  type: "post_call_transcription",
  event_timestamp: 1739537297,
  data: {
    conversation_id: "conv_abc",
    status: "done",
    transcript: [
      { role: "agent", message: "Thanks for calling Bud Club, how can I help?" },
      { role: "user", message: "Where's order 12345?" },
      { role: "agent", message: "", tool_calls: [{ name: "lookup_order" }] }, // blank -> dropped
      { role: "user", message: "Can I talk to a person?" },
      {
        role: "agent",
        message: "Sure, connecting you.",
        tool_calls: [{ name: "transfer_to_number", params: { number: "+1..." } }],
      },
    ],
    conversation_initiation_client_data: {
      dynamic_variables: {
        system__call_sid: "CA_realistic_001",
        system__called_number: "+14155550123",
        system__caller_id: "+16505551212",
        system__conversation_id: "conv_abc",
      },
    },
  },
};

// --- extractCallFields ---
const f = extractCallFields(payload);
check("extract: call SID", f.callSid === "CA_realistic_001");
check("extract: called number", f.calledNumber === "+14155550123");
check("extract: caller id", f.callerId === "+16505551212");
check("extract: status", f.status === "done");
check(
  "extract: missing dynamic vars -> nulls",
  ((): boolean => {
    const g = extractCallFields({ data: { transcript: [] } });
    return g.callSid === null && g.calledNumber === null;
  })(),
);

// --- mapRole ---
check("role: user -> customer", mapRole("user") === "customer");
check("role: agent -> agent", mapRole("agent") === "agent");
check("role: unknown -> agent", mapRole("system") === "agent");

// --- buildTurns: blanks dropped, refs use ORIGINAL index (stable) ---
const turns = buildTurns(payload.data!.transcript, f.callSid!);
check("turns: blank message dropped", turns.length === 4, `got ${turns.length}`);
check(
  "turns: stable refs skip the dropped index",
  turns.map((t) => t.turnRef).join(",") ===
    "CA_realistic_001:0,CA_realistic_001:1,CA_realistic_001:3,CA_realistic_001:4",
  turns.map((t) => t.turnRef).join(","),
);
check(
  "turns: refs are unique (idempotency key)",
  new Set(turns.map((t) => t.turnRef)).size === turns.length,
);
check("turns: first role customer/agent mapped", turns[0].role === "agent" && turns[1].role === "customer");

// --- detectHumanHandoff ---
check("handoff: detects transfer_to_number", detectHumanHandoff(payload.data!.transcript) === true);
check(
  "handoff: none when no transfer",
  detectHumanHandoff([{ role: "user", message: "where is my order" }]) === false,
);

// --- signature round-trip ---
{
  const secret = "whsec_test";
  const body = JSON.stringify(payload);
  const t = "1739537297";
  const v0 = await hmacSha256Hex(secret, `${t}.${body}`);
  const header = `t=${t},v0=${v0}`;

  const parsed = parseSignatureHeader(header);
  check("sig: header parses t/v0", parsed.t === t && parsed.v0 === v0);

  const ok = await verifySignature({ secret, header, rawBody: body, nowSecs: Number(t) });
  check("sig: valid signature verifies", ok.valid === true);

  const tampered = await verifySignature({
    secret,
    header,
    rawBody: body + " ",
    nowSecs: Number(t),
  });
  check("sig: tampered body rejected", tampered.valid === false);

  const wrongSecret = await verifySignature({
    secret: "whsec_wrong",
    header,
    rawBody: body,
    nowSecs: Number(t),
  });
  check("sig: wrong secret rejected", wrongSecret.valid === false);

  const stale = await verifySignature({
    secret,
    header,
    rawBody: body,
    nowSecs: Number(t) + 60 * 60,
  });
  check("sig: stale timestamp rejected", stale.valid === false);
}

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll voice-logger helper tests passed.");
}

main();
