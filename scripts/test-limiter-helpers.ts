// =============================================================================
// test-limiter-helpers.ts — unit tests for the pure halves of the usage-limiter
// wiring. No Supabase / Deno / network. Run with tsx:
//   npx tsx scripts/test-limiter-helpers.ts
//
// Layer 1 (pre-call deflect) lives in voice-personalization/lib.ts.
// Layer 4 (post-call meter) lives in voice-call-logger/lib.ts.
// Layer 3 (mid-call wrap_up) is wired directly in voice-order-lookup/index.ts.
// =============================================================================

import {
  buildDeflectResponse,
  shouldDeflect,
  type ClientConfig,
} from "../supabase/functions/voice-personalization/lib.ts";
import {
  extractDurationSecs,
  usageKeyFor,
  type CallFields,
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

const baseCfg: ClientConfig = {
  name: "Tsunami",
  slug: "shopify-store",
  persona: "Lumi",
  brandVoice: "friendly, concise, helpful",
  timezone: "America/New_York",
  serviceArea: null,
  hoursHuman: "Mon-Fri 09:00-17:00",
  transferNumber: null,
  extraInstructions: "",
  isDemo: false,
};

// -----------------------------------------------------------------------------
console.log("\nshouldDeflect — FAILS OPEN on anything unexpected");
// -----------------------------------------------------------------------------
check("allowed:false -> deflect", shouldDeflect({ allowed: false }) === true);
check("allowed:true -> allow", shouldDeflect({ allowed: true }) === false);
check("null (rpc errored) -> ALLOW", shouldDeflect(null) === false);
check("undefined -> ALLOW", shouldDeflect(undefined) === false);
check("empty object -> ALLOW", shouldDeflect({}) === false);
check("string payload -> ALLOW", shouldDeflect("nope") === false);
check("missing allowed key -> ALLOW", shouldDeflect({ reason: "ok" }) === false);
// A truthy-but-not-true value must not be read as permission to block.
check("allowed:'false' (string) -> ALLOW", shouldDeflect({ allowed: "false" }) === false);

// -----------------------------------------------------------------------------
console.log("\nbuildDeflectResponse — no transfer line (Tsunami today)");
// -----------------------------------------------------------------------------
const deflect = buildDeflectResponse(baseCfg, [], { supportEmail: "hey@tsunami.store" });
check(
  "discriminator present (ElevenLabs silently drops the body without it)",
  deflect.type === "conversation_initiation_client_data",
);
check("names the store", deflect.conversation_config_override.agent.first_message.includes("Tsunami"));
check(
  "gives the caller somewhere to go",
  deflect.conversation_config_override.agent.first_message.includes("hey@tsunami.store"),
);
check(
  "instructs end_call",
  deflect.conversation_config_override.agent.prompt.prompt.includes("end_call"),
);
check(
  "forbids doing any lookup",
  /do not look anything up/i.test(deflect.conversation_config_override.agent.prompt.prompt),
);
check(
  "does NOT promise a callback (we can't honor it at the cap)",
  !/callback/i.test(deflect.conversation_config_override.agent.first_message),
);
check("flags the call as over cap", deflect.dynamic_variables.over_cap === "true");
check("keeps the standard variables", deflect.dynamic_variables.store_name === "Tsunami");
check("keeps client_slug for tool routing", deflect.dynamic_variables.client_slug === "shopify-store");

console.log("\nbuildDeflectResponse — no support email configured");
const noEmail = buildDeflectResponse(baseCfg, [], {});
check(
  "no dangling 'email us at' with nothing after it",
  !/email us at\s*[.,]?\s*$/i.test(noEmail.conversation_config_override.agent.first_message),
);
check(
  "still tells them support is unavailable",
  /isn't available/i.test(noEmail.conversation_config_override.agent.first_message),
);
check(
  "still ends the call",
  noEmail.conversation_config_override.agent.prompt.prompt.includes("end_call"),
);

console.log("\nbuildDeflectResponse — WITH a transfer line (once Tsunami has one)");
const withLine = buildDeflectResponse(
  { ...baseCfg, transferNumber: "+12125551234" },
  [],
  { supportEmail: "hey@tsunami.store" },
);
check(
  "prefers a human over a deflection",
  withLine.conversation_config_override.agent.prompt.prompt.includes("transfer_to_number"),
);
check(
  "passes the actual number",
  withLine.conversation_config_override.agent.prompt.prompt.includes("+12125551234"),
);
check(
  "greeting says it's connecting them",
  /put you through|connect/i.test(withLine.conversation_config_override.agent.first_message),
);
check(
  "still has an end_call fallback if the transfer fails",
  withLine.conversation_config_override.agent.prompt.prompt.includes("end_call"),
);
check(
  "blank transfer number is treated as none",
  !buildDeflectResponse({ ...baseCfg, transferNumber: "   " }, [], {})
    .conversation_config_override.agent.prompt.prompt.includes("transfer_to_number"),
);

// -----------------------------------------------------------------------------
console.log("\nextractDurationSecs — a zero here means the cap never trips");
// -----------------------------------------------------------------------------
const p = (data: any): PostCallPayload => ({ type: "post_call_transcription", data });

check("metadata.call_duration_secs", extractDurationSecs(p({ metadata: { call_duration_secs: 137 } })) === 137);
check("call_duration_seconds spelling", extractDurationSecs(p({ metadata: { call_duration_seconds: 42 } })) === 42);
check("call_duration spelling", extractDurationSecs(p({ metadata: { call_duration: 60 } })) === 60);
check("duration_secs spelling", extractDurationSecs(p({ metadata: { duration_secs: 15 } })) === 15);
check(
  "phone_call block",
  extractDurationSecs(p({ metadata: { phone_call: { call_duration_secs: 91 } } })) === 91,
);
check("string numbers coerced", extractDurationSecs(p({ metadata: { call_duration_secs: "88" } })) === 88);
check("fractional rounded", extractDurationSecs(p({ metadata: { call_duration_secs: 12.6 } })) === 13);
check("explicit zero is honored", extractDurationSecs(p({ metadata: { call_duration_secs: 0 } })) === 0);
check(
  "negative garbage skipped, falls through",
  extractDurationSecs(p({ metadata: { call_duration_secs: -5 }, transcript: [{ time_in_call_secs: 30 }] })) === 30,
);
check(
  "falls back to the furthest transcript turn",
  extractDurationSecs(p({
    transcript: [
      { time_in_call_secs: 3 },
      { time_in_call_secs: 47 },
      { time_in_call_secs: 22 },
    ],
  })) === 47,
);
check("no metadata, no transcript -> 0", extractDurationSecs(p({})) === 0);
check("empty payload doesn't throw", extractDurationSecs({} as PostCallPayload) === 0);
check("null payload doesn't throw", extractDurationSecs(null as any) === 0);
check(
  "transcript without timings -> 0",
  extractDurationSecs(p({ transcript: [{ message: "hi" }, { message: "there" }] })) === 0,
);

// -----------------------------------------------------------------------------
console.log("\nusageKeyFor — a web call has no Twilio SID");
// -----------------------------------------------------------------------------
const cf = (o: Partial<CallFields>): CallFields => ({
  callSid: null, calledNumber: null, callerId: null,
  elevenConversationId: null, clientSlug: null, status: null, ...o,
});
check("phone: uses the call SID", usageKeyFor(cf({ callSid: "CA_1", elevenConversationId: "conv_1" })) === "CA_1");
check("web: falls back to conversation id", usageKeyFor(cf({ elevenConversationId: "conv_1" })) === "conv_1");
check("neither -> null (caller must skip metering)", usageKeyFor(cf({})) === null);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
