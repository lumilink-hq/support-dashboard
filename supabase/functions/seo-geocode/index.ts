// =============================================================================
// seo-geocode — fills module 7's missing piece (plan.md: "the wizard does not
// collect latitude/longitude and geocoding isn't built, so there is no geo
// grid for a location until its lat/lng is filled in by hand"). US only, via
// the Census Bureau's free public Geocoder — no API key, no vendor account,
// no cost.
//
//   POST /seo-geocode
//   header: x-voice-tool-secret: <VOICE_TOOL_SECRET>
//   body:   { "location_id": "<uuid>" }
//
// Admin endpoint, same posture as the other seo-* functions. MUST be deployed
// with --no-verify-jwt (see this repo's memory on that).
//
// NEVER OVERWRITES. Only ever fills lat/lng when BOTH are still null — a
// location geocoded once, or one a person enters by hand, is never touched
// again. Enforced twice: 0058_seo_geocoding.sql's scheduling view never even
// selects a location that already has coordinates, and the UPDATE below
// repeats the guard in its WHERE so a race between two dispatches can't
// clobber a hand-entered value.
//
// NO MATCH IS NOT AN ERROR. An address that doesn't match yet (a typo, a
// missing unit, a very new build) is recorded as a settled run, not a
// failure: it is re-tried once a day in case the address gets corrected,
// rather than backing off as if the Census service itself were down.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (["default"] = service role),
//      VOICE_TOOL_SECRET.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { censusUrl, isUsAddress, parseCensusMatch, toCensusQuery, type LocationAddress } from "./lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");
const VOICE_TOOL_SECRET = Deno.env.get("VOICE_TOOL_SECRET");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");
const SERVICE_ROLE_SECRET = (JSON.parse(rawSecrets) as Record<string, string>)["default"];
if (!SERVICE_ROLE_SECRET) throw new Error("Missing SUPABASE_SECRET_KEYS['default']");

const BASE_INTERVAL_MINUTES = 24 * 60; // re-check a still-unmatched address daily
const MAX_BACKOFF_MINUTES = 4 * 60; // a genuine vendor/network failure retries the same day

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function settle(clientId: string, locationId: string, success: boolean, error: string | null) {
  const { error: jobError } = await supabase.rpc("complete_job_attempt", {
    p_client_id: clientId,
    p_job_type: "seo_geocode",
    p_success: success,
    p_error: error,
    p_base_interval_minutes: BASE_INTERVAL_MINUTES,
    p_max_backoff_minutes: MAX_BACKOFF_MINUTES,
    p_entity_id: locationId,
  });
  if (jobError) console.error(`seo-geocode ${locationId}: complete_job_attempt failed: ${jobError.message}`);
}

type LocationRow = LocationAddress & { id: string; client_id: string; lat: number | null; lng: number | null };

async function geocodeLocation(loc: LocationRow): Promise<string> {
  if (loc.lat !== null || loc.lng !== null) {
    // Coordinates appeared since this run was dispatched (hand entry, or a
    // previous run). Nothing to do — settle so job_attempts doesn't spin.
    await settle(loc.client_id, loc.id, true, null);
    return "already_set";
  }
  if (!isUsAddress(loc.country_code)) {
    await settle(loc.client_id, loc.id, true, null);
    return "not_us";
  }
  const query = toCensusQuery(loc);
  if (!query) {
    await settle(loc.client_id, loc.id, true, null);
    return "incomplete_address";
  }

  const res = await fetch(censusUrl(query));
  if (!res.ok) throw new Error(`Census geocoder responded ${res.status}`);
  const body = await res.json().catch(() => null);
  const match = parseCensusMatch(body);

  if (!match) {
    await settle(loc.client_id, loc.id, true, null); // not an error — see file header
    return "no_match";
  }

  const { error: upErr } = await supabase
    .from("seo_locations")
    .update({ lat: match.lat, lng: match.lng })
    .eq("id", loc.id)
    .is("lat", null)
    .is("lng", null);
  if (upErr) throw new Error(`writing seo_locations failed: ${upErr.message}`);

  await settle(loc.client_id, loc.id, true, null);
  console.log(`seo-geocode ${loc.id}: matched "${match.matchedAddress}" -> ${match.lat},${match.lng}`);
  return "matched";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!VOICE_TOOL_SECRET) {
    console.error("VOICE_TOOL_SECRET unset — refusing to run");
    return json({ error: "Server not configured" }, 500);
  }
  if (req.headers.get("x-voice-tool-secret") !== VOICE_TOOL_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const locationId = String(body.location_id ?? "").trim();
  if (!locationId) return json({ error: "location_id is required" }, 400);

  const { data: loc, error } = await supabase
    .from("seo_locations")
    .select("id, client_id, address_line1, city, region, postal_code, country_code, lat, lng")
    .eq("id", locationId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!loc) return json({ error: "location not found" }, 404);

  try {
    const status = await geocodeLocation(loc as LocationRow);
    return json({ ok: true, status, location_id: locationId });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "geocoding failed";
    console.error(`seo-geocode ${locationId} failed: ${reason}`);
    await settle(loc.client_id, loc.id, false, reason);
    return json({ ok: false, error: reason }, 500);
  }
});
