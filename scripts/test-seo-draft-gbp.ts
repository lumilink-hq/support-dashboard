// =============================================================================
// test-seo-draft-gbp.ts — module 4: drafting a Business Profile description
// (seo-draft/gbp.ts) and writing it (seo-publish/gbp.ts, against a fake Google).
//
//   npx tsx scripts/test-seo-draft-gbp.ts
//
// No network, no Deno, no database.
// =============================================================================

import {
  buildGbpPayload,
  GBP_DESCRIPTION,
  GBP_DRAFTABLE,
  GBP_SYSTEM_PROMPT,
  validateGbpDescription,
} from "../supabase/functions/seo-draft/gbp.ts";
import { applyGbpField, GBP_WRITABLE, GbpError, gbpManualInstructions, isWritable, revertGbpField, type GbpCtx } from "../supabase/functions/seo-publish/gbp.ts";
import { emptyDetails } from "../supabase/functions/seo-content/details.ts";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
  }
}
function eq(label: string, got: unknown, want: unknown) {
  ok(label, JSON.stringify(got) === JSON.stringify(want), got);
}

const pad = (s: string, n = GBP_DESCRIPTION.min) => (s + " " + "We serve neighbours across the area with friendly, knowledgeable staff who help each visitor find what they need.".repeat(4)).slice(0, Math.max(n, s.length)).trim();
const good = pad("PACKS Club is a licensed dispensary in Hollywood, serving the neighbourhood around Cahuenga Boulevard.");

async function main() {
  // --- prompt and payload: our facts only --------------------------------------
  ok("prompt: forbids promotions", /promotions/i.test(GBP_SYSTEM_PROMPT));
  ok("prompt: no client text interpolated", !/\$\{/.test(GBP_SYSTEM_PROMPT));
  const details = { ...emptyDetails(), services: ["Same-day delivery"], licensed: true, service_areas: ["Los Feliz"] };
  const payload = JSON.parse(buildGbpPayload({ name: "PACKS Hollywood", city: "Los Angeles", region: "CA" }, details));
  eq("payload: business facts", [payload.business_name, payload.city, payload.min_chars, payload.max_chars], ["PACKS Hollywood", "Los Angeles", 250, 750]);
  eq("payload: vouched facts passed", payload.vouched_facts, { licensed: true });
  ok("payload: no current description field (Google data never sent)", !("current_text" in payload) && !("current_description" in payload));
  eq("draftable findings", GBP_DRAFTABLE, { gbp_missing_description: "gbp_description", gbp_short_description: "gbp_description" });

  // --- validator ---------------------------------------------------------------
  ok("valid: a licensed claim backed by details", validateGbpDescription(good, null, details, "PACKS Hollywood").ok, validateGbpDescription(good, null, details, "PACKS Hollywood"));
  eq("refused: licensed claim without details", validateGbpDescription(good, null, null).ok, false);
  eq("refused: too short", validateGbpDescription("A dispensary in Hollywood.", null, details), { ok: false, reason: "description is 26 characters, needs 250-750" });
  eq("refused: too long", validateGbpDescription(pad("x", 800).padEnd(800, " a"), null, details).ok, false);
  eq("refused: URL", validateGbpDescription(pad("Visit packsclub.com for more."), null, details).reason, "description contains a web address");
  eq("refused: phone", validateGbpDescription(pad("Call (323) 555-0100 today."), null, details).reason, "description contains a phone-number-like string");
  eq("refused: promotion", validateGbpDescription(pad("Ask about our daily deals."), null, details).reason, "description mentions a promotion or price, which Google doesn't allow");
  eq("refused: price", validateGbpDescription(pad("Pre-rolls from $5."), null, details).ok, false);
  eq("refused: medical", validateGbpDescription(pad("Products that relieve anxiety."), null, details).reason, "description makes a health or medical claim");
  ok("allowed: 'sweet treats' is not medical", validateGbpDescription(pad("A bakery making sweet treats and fresh bread in Hollywood every morning."), null, null).ok);
  eq("refused: superlative", validateGbpDescription(pad("The best dispensary in Hollywood."), null, details).ok, false);
  eq("refused: emoji", validateGbpDescription(pad("Welcome to PACKS 🌿 in Hollywood."), null, details).reason, "description contains an emoji");
  eq("refused: hashtag", validateGbpDescription(pad("Visit us #hollywood."), null, details).reason, "description contains a hashtag");
  eq("refused: another brand's caps", validateGbpDescription(good, null, details, "Other Shop").reason, "description contains an ALL-CAPS word");
  eq("refused: percent off", validateGbpDescription(pad("Get 20% off today."), null, details).ok, false);
  eq("refused: shouting", validateGbpDescription(pad("WELCOME to our Hollywood store."), null, details).reason, "description contains an ALL-CAPS word");
  eq("refused: markup", validateGbpDescription(pad("<b>Hello</b> Hollywood."), null, details).reason, "description contains markup");
  eq("refused: model said insufficient facts", validateGbpDescription("INSUFFICIENT_FACTS", null, details).reason, "model reported insufficient facts");
  eq("refused: same as now (whitespace ignored)", validateGbpDescription(good, good.replace(/ /g, "  "), details, "PACKS").reason, "description is identical to the current one");
  const paras = validateGbpDescription(`"${good.slice(0, 150)}\n\n\n\n   ${good.slice(150)}"`, null, details, "PACKS");
  ok("cleaned: quotes stripped, blank lines collapsed", paras.ok && !paras.text.startsWith('"') && !paras.text.includes("\n\n\n"), paras);

  // --- publishing: allowlist ---------------------------------------------------
  eq("allowlist: description only", Object.keys(GBP_WRITABLE), ["gbp_description"]);
  for (const f of ["name", "title", "phone", "address", "primary_category", "storefrontAddress", "phoneNumbers", "categories", "gbp_primary_category"]) {
    ok(`allowlist: ${f} is not writable`, !isWritable(f));
  }
  eq("allowlist: description's updateMask", GBP_WRITABLE.gbp_description.updateMask, "profile.description");

  // --- publishing against a fake Google -----------------------------------------
  type Call = { method: string; url: string; body?: unknown };
  function fakeGoogle(opts: { description: string; holdForReview?: boolean; failFirst?: number; status?: number }) {
    const state = { description: opts.description, calls: [] as Call[], failsLeft: opts.failFirst ?? 0 };
    const doFetch = (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      state.calls.push({ method: String(init.method), url, body });
      if (state.failsLeft > 0) {
        state.failsLeft--;
        return new Response("{}", { status: 503 });
      }
      if (opts.status) return new Response(JSON.stringify({ error: { message: "nope" } }), { status: opts.status });
      if (init.method === "PATCH") {
        if (!opts.holdForReview) state.description = body.profile.description;
        return new Response(JSON.stringify({ name: "locations/1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ profile: { description: state.description }, metadata: opts.holdForReview ? { hasPendingEdits: true } : {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const ctx: GbpCtx = { token: "t", fetch: doFetch, sleep: async () => {}, base: "https://fake" };
    return { state, ctx };
  }

  {
    const g = fakeGoogle({ description: "Old text." });
    let saved: string | null = null;
    const r = await applyGbpField(g.ctx, "locations/1", "gbp_description", good, null, async (p) => { saved = p; });
    eq("apply: prior saved before writing", saved, "Old text.");
    eq("apply: result", r, { prior: "Old text.", noop: false, verified: true, pending: false });
    eq("apply: read, write, read back", g.state.calls.map((c) => c.method), ["GET", "PATCH", "GET"]);
    eq("apply: exact updateMask", g.state.calls[1].url, "https://fake/v1/locations/1?updateMask=profile.description");
    eq("apply: body touches only the description", g.state.calls[1].body, { profile: { description: good } });
  }
  {
    const g = fakeGoogle({ description: "Old text." });
    let threw = false;
    try {
      await applyGbpField(g.ctx, "locations/1", "gbp_description", good, null, async () => { throw new Error("db down"); });
    } catch {
      threw = true;
    }
    ok("apply: nothing written when the prior can't be saved", threw && !g.state.calls.some((c) => c.method === "PATCH"));
  }
  {
    const g = fakeGoogle({ description: good });
    const r = await applyGbpField(g.ctx, "locations/1", "gbp_description", good, "Old text.", async () => {});
    eq("apply: retry uses the saved prior, not a fresh read", r.prior, "Old text.");
  }
  {
    const g = fakeGoogle({ description: "Old text.", holdForReview: true });
    const r = await applyGbpField(g.ctx, "locations/1", "gbp_description", good, null, async () => {});
    eq("apply: held for review is pending, not failed", [r.verified, r.pending], [false, true]);
  }
  {
    const g = fakeGoogle({ description: "Old text.", failFirst: 2 });
    const r = await applyGbpField(g.ctx, "locations/1", "gbp_description", good, null, async () => {});
    ok("apply: backs off and retries 5xx", r.verified && g.state.calls.length === 5, g.state.calls.length);
  }
  for (const [status, kind] of [[401, "auth"], [403, "no_access"], [404, "not_found"], [400, "user"]] as const) {
    const g = fakeGoogle({ description: "x", status });
    let got = "";
    try {
      await applyGbpField(g.ctx, "locations/1", "gbp_description", good, null, async () => {});
    } catch (e) {
      got = e instanceof GbpError ? e.kind : "other";
    }
    eq(`apply: ${status} is ${kind}, not retried`, [got, g.state.calls.length], [kind, 1]);
  }
  {
    const g = fakeGoogle({ description: "x" });
    let got = "";
    try {
      await applyGbpField(g.ctx, "locations/1", "primary_category", "Bank", null, async () => {});
    } catch (e) {
      got = e instanceof GbpError ? e.kind : "other";
    }
    eq("apply: a protected field is refused before any call", [got, g.state.calls.length], ["user", 0]);
  }

  // --- rollback -----------------------------------------------------------------
  {
    const g = fakeGoogle({ description: good });
    eq("revert: restores the prior", await revertGbpField(g.ctx, "locations/1", "gbp_description", good, "Old text."), { noop: false });
    eq("revert: prior is back", g.state.description, "Old text.");
  }
  {
    const g = fakeGoogle({ description: "Someone's own edit." });
    let got = "";
    try {
      await revertGbpField(g.ctx, "locations/1", "gbp_description", good, "Old text.");
    } catch (e) {
      got = e instanceof GbpError ? e.kind : "other";
    }
    eq("revert: refuses to overwrite a later hand edit", [got, g.state.calls.some((c) => c.method === "PATCH")], ["drift", false]);
  }
  {
    const g = fakeGoogle({ description: "Old text." });
    eq("revert: already back (edit never accepted) is a no-op", await revertGbpField(g.ctx, "locations/1", "gbp_description", good, "Old text."), { noop: true });
  }

  const m = gbpManualInstructions("gbp_description", good, "missing_scope");
  ok("manual: steps and the text to paste", m.steps.length === 3 && m.copy.text === good && m.copy.label === "Description");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
