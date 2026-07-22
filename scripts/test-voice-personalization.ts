// =============================================================================
// test-voice-personalization.ts — unit tests for the pure helpers in
// supabase/functions/voice-personalization/lib.ts. No Supabase/Deno needed.
//
// Run:  npx tsx scripts/test-voice-personalization.ts
// =============================================================================

import {
  buildDynamicVariables,
  buildFallbackResponse,
  buildFirstMessage,
  buildResponse,
  buildSystemPrompt,
  extractClientRef,
  formatServices,
  formatStructuredHours,
  hmacSha256Hex,
  readClientConfig,
  verifySignature,
  type ServiceRow,
} from "../supabase/functions/voice-personalization/lib.ts";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

// ---- fixtures (mirror seed_hvac_client.sql) --------------------------------
const clientRow = {
  name: "Comfort Air (Demo)",
  slug: "comfort-air-demo",
  brand_tone_config: {
    voice: "warm, professional, efficient",
    persona: "Lumi",
  },
  business_hours: {
    tz: "America/Los_Angeles",
    hours: "Mon-Fri 08:00-18:00, Sat 09:00-14:00",
  },
  settings: {
    is_demo: true,
    transfer_number: "+14155550111",
    scheduling: {
      timezone: "America/Los_Angeles",
      service_area: "Within 25 miles of San Francisco, CA",
      persona: "Lumi",
      hours: {
        mon: ["08:00", "18:00"],
        sat: ["09:00", "14:00"],
        sun: [],
      },
    },
  },
};

const services: ServiceRow[] = [
  { name: "Service Call / Diagnostic", price_type: "quote", price: null, callout_fee: 89, emergency_eligible: true },
  { name: "AC Tune-Up", price_type: "fixed", price: 99, callout_fee: null, emergency_eligible: false },
  { name: "New System Estimate", price_type: "fixed", price: 0, callout_fee: null, emergency_eligible: false },
];

// ---- readClientConfig -------------------------------------------------------
const cfg = readClientConfig(clientRow);
ok("reads client name", cfg.name === "Comfort Air (Demo)");
ok("reads slug", cfg.slug === "comfort-air-demo");
ok("reads persona", cfg.persona === "Lumi");
ok("reads brand voice", cfg.brandVoice === "warm, professional, efficient");
ok("reads timezone", cfg.timezone === "America/Los_Angeles");
ok("reads service area", cfg.serviceArea === "Within 25 miles of San Francisco, CA");
ok("prefers human hours string", cfg.hoursHuman === "Mon-Fri 08:00-18:00, Sat 09:00-14:00");
ok("reads transfer number", cfg.transferNumber === "+14155550111");
ok("reads is_demo", cfg.isDemo === true);

// ---- fallback when config sparse -------------------------------------------
const bare = readClientConfig({ name: "X" });
ok("defaults persona to Lumi", bare.persona === "Lumi");
ok("defaults timezone", bare.timezone === "America/Los_Angeles");
ok("null service area when absent", bare.serviceArea === null);
ok("null transfer when absent", bare.transferNumber === null);

// ---- formatStructuredHours --------------------------------------------------
ok(
  "formats structured hours in day order, skips empty",
  formatStructuredHours({ sat: ["09:00", "14:00"], mon: ["08:00", "18:00"], sun: [] }) ===
    "Mon 08:00-18:00, Sat 09:00-14:00",
);

// ---- formatServices ---------------------------------------------------------
const menu = formatServices(services);
ok("callout-fee service shows service call + quoted", menu.includes("$89 service call, then quoted"));
ok("fixed service shows price", menu.includes("AC Tune-Up: $99"));
ok("zero-price fixed shows free", menu.includes("New System Estimate: free"));
ok("emergency flag surfaced", menu.includes("(available for emergencies)"));
ok("empty services handled", formatServices([]) === "No services are configured yet.");

// ---- buildSystemPrompt ------------------------------------------------------
const prompt = buildSystemPrompt(cfg, services);
ok("prompt names the persona", prompt.includes("You are Lumi"));
ok("prompt names the business", prompt.includes("Comfort Air (Demo)"));
ok("prompt embeds the service menu", prompt.includes("AC Tune-Up: $99"));
ok("prompt embeds hours", prompt.includes("Mon-Fri 08:00-18:00"));
ok("prompt embeds service area", prompt.includes("Within 25 miles"));
ok("prompt references system__time", prompt.includes("{{system__time}}"));
ok("prompt mentions the three tools", prompt.includes("check_availability") && prompt.includes("book") && prompt.includes("capture_lead"));
ok("demo note present when is_demo", prompt.includes("DEMONSTRATION"));
ok("transfer path used when transfer_number set", prompt.includes("warm-transfer"));

const noTransfer = readClientConfig({ ...clientRow, settings: { ...clientRow.settings, transfer_number: null } });
ok("lead-capture path when no transfer_number", buildSystemPrompt(noTransfer, services).includes("capture the caller's details as a lead"));

// ---- greeting + dynamic variables ------------------------------------------
ok("first message greets by name + persona", buildFirstMessage(cfg) === "Thanks for calling Comfort Air (Demo), this is Lumi. How can I help you today?");

const dv = buildDynamicVariables(cfg, services);
const REQUIRED_VARS = ["client_slug", "store_name", "persona", "brand_voice", "timezone", "business_hours", "service_area", "services_summary", "transfer_number", "is_demo"];
ok("all dynamic variables present", REQUIRED_VARS.every((k) => k in dv));
ok("all dynamic variables are strings", Object.values(dv).every((v) => typeof v === "string"));
ok("client_slug carried for web tool routing", dv.client_slug === "comfort-air-demo");
ok("services_summary lists names", dv.services_summary.includes("AC Tune-Up"));

// ---- buildResponse / fallback shape ----------------------------------------
const res = buildResponse(cfg, services);
ok("response has dynamic_variables", typeof res.dynamic_variables === "object");
ok("override carries prompt", res.conversation_config_override.agent.prompt.prompt.length > 0);
ok("override carries first_message", res.conversation_config_override.agent.first_message.length > 0);
ok("override language en", res.conversation_config_override.agent.language === "en");

const fb = buildFallbackResponse();
ok("fallback still valid shape", fb.dynamic_variables.store_name === "our team" && fb.conversation_config_override.agent.first_message.length > 0);
ok("fallback vars match required set", REQUIRED_VARS.every((k) => k in fb.dynamic_variables));

// ---- verifySignature --------------------------------------------------------
await (async () => {
  const secret = "whsec_test";
  const rawBody = JSON.stringify({ called_number: "+14155550123" });
  const t = "1700000000";
  const good = await hmacSha256Hex(secret, `${t}.${rawBody}`);

  const valid = await verifySignature({ secret, header: `t=${t},v0=${good}`, rawBody, nowSecs: Number(t) + 5 });
  ok("valid signature accepted", valid.valid);

  const tampered = await verifySignature({ secret, header: `t=${t},v0=${good}`, rawBody: rawBody + "x", nowSecs: Number(t) + 5 });
  ok("tampered body rejected", !tampered.valid);

  const stale = await verifySignature({ secret, header: `t=${t},v0=${good}`, rawBody, nowSecs: Number(t) + 9999 });
  ok("stale timestamp rejected", !stale.valid);

  const missing = await verifySignature({ secret, header: null, rawBody, nowSecs: Number(t) });
  ok("missing header rejected", !missing.valid);
})();

// ---- extractClientRef (phone vs web body shapes) ---------------------------
{
  const phone = extractClientRef({ called_number: "+14155550123", agent_id: "a", call_sid: "CA1" });
  ok("phone body → called_number", phone.calledNumber === "+14155550123");
  ok("phone body → no client slug", phone.clientSlug === null);

  const webTop = extractClientRef({ client_slug: "comfort-air-demo" });
  ok("web top-level client_slug", webTop.clientSlug === "comfort-air-demo" && webTop.calledNumber === null);

  const webNested = extractClientRef({ dynamic_variables: { client_slug: "acme-hvac" } });
  ok("web nested dynamic_variables.client_slug", webNested.clientSlug === "acme-hvac");

  const webInit = extractClientRef({ conversation_initiation_client_data: { dynamic_variables: { client_slug: "acme-hvac" } } });
  ok("web nested conversation_initiation_client_data", webInit.clientSlug === "acme-hvac");

  const empty = extractClientRef({});
  ok("empty body → both null", empty.calledNumber === null && empty.clientSlug === null);

  const blank = extractClientRef({ called_number: "   ", client_slug: "" });
  ok("blank strings treated as null", blank.calledNumber === null && blank.clientSlug === null);
}

// ---- fallback carries client_slug key --------------------------------------
ok("fallback includes client_slug key", "client_slug" in buildFallbackResponse().dynamic_variables);

// ---- report -----------------------------------------------------------------
console.log(`\nvoice-personalization: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
