"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentClientId } from "@/lib/entitlements";
import { getSeoAccess } from "@/lib/seo-access";
import {
  cleanDomain,
  cleanKeyword,
  cleanQuery,
  KEYWORD_MAX,
  KEYWORD_MIN,
  MAX_COMPETITORS_PER_LOCATION,
  MAX_GEO_GRID_KEYWORDS_PER_LOCATION,
  MAX_KEYWORDS_PER_LOCATION,
  QUERY_MAX,
  QUERY_MIN,
} from "@/lib/seo-portal";
import { createClient } from "@/lib/supabase/server";
import { isOnlineOnlyRow, parseLocationForm, type LocationRow } from "@/lib/seo-location-form";
import { JOB_INFO, RUN_NOW_RESULT } from "@/lib/seo-jobs";
import { LINK_RESULT } from "@/lib/seo-gbp";
import { cleanItem, cleanList, cleanYear, DETAIL_LIMITS, type ListField } from "@/supabase/functions/seo-content/details";
import { applyAccepted, DETAIL_FLAGS, DETAIL_LISTS, type DetailsForm } from "@/lib/seo-detail-suggestions";
// The weekly AI-visibility job only ever checks this many active queries; more
// would be accepted here and silently never checked, so the form stops at the cap.
import { MAX_QUERIES_PER_CLIENT } from "@/supabase/functions/seo-ai-visibility/lib";

function backTo(location: string, error?: string) {
  const qs = new URLSearchParams();
  if (location) qs.set("location", location);
  qs.set("tab", "ai");
  if (error) qs.set("error", error);
  const s = qs.toString();
  return `/seo${s ? `?${s}` : ""}#ai`;
}

/**
 * Add (or turn back on) a priority AI question. The tenant policy on
 * seo_ai_queries (0053) already confines this to the caller's own client, so
 * this only checks the session, the input and the cap.
 *
 * The question is stored and later sent to the AI-visibility vendor as a search
 * term. It is never placed in a prompt to our own model (rule 5).
 */
export async function addAiQuery(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const query = cleanQuery(String(formData.get("query") ?? ""));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(backTo(location, "Local SEO isn't active on your plan."));
  if (query.length < QUERY_MIN || query.length > QUERY_MAX) {
    redirect(backTo(location, `A question must be between ${QUERY_MIN} and ${QUERY_MAX} characters.`));
  }

  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login");

  const supabase = await createClient();
  const { count, error: countErr } = await supabase
    .from("seo_ai_queries")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);
  if (countErr) redirect(backTo(location, countErr.message));

  // Re-adding one that is already on is a no-op, not a cap error.
  const { data: existing } = await supabase
    .from("seo_ai_queries")
    .select("id, is_active")
    .eq("client_id", clientId)
    .eq("query", query)
    .maybeSingle();
  if (existing?.is_active) redirect(backTo(location));
  if ((count ?? 0) >= MAX_QUERIES_PER_CLIENT) {
    redirect(backTo(location, `You can track up to ${MAX_QUERIES_PER_CLIENT} questions. Stop tracking one to add another.`));
  }

  const { error } = existing
    ? await supabase.from("seo_ai_queries").update({ is_active: true }).eq("id", existing.id)
    : await supabase.from("seo_ai_queries").insert({ client_id: clientId, query });
  if (error) redirect(backTo(location, error.message));

  revalidatePath("/seo");
  redirect(backTo(location));
}

/** Stop tracking a question. Kept (inactive) rather than deleted so its past checks stay in the history. */
export async function removeAiQuery(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(backTo(location, "Missing question id."));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(backTo(location, "Local SEO isn't active on your plan."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS turns "not yours" into a zero-row update, so the count is the proof.
  const { data, error } = await supabase.from("seo_ai_queries").update({ is_active: false }).eq("id", id).select("id");
  if (error) redirect(backTo(location, error.message));
  if (!data || data.length === 0) redirect(backTo(location, "That question no longer exists."));

  revalidatePath("/seo");
  redirect(backTo(location));
}

/**
 * Track a competitor's domain for one location. The tenant policy on
 * seo_competitors (0042) confines the row to the caller's client, but not the
 * location_id it points at, so the location is looked up under RLS first.
 * Removing one turns it off rather than deleting it, so its ranking history stays.
 */
export async function addCompetitor(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const domain = cleanDomain(String(formData.get("domain") ?? ""));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(competitorBack(location, "Local SEO isn't active on your plan."));
  if (!domain) redirect(competitorBack(location, "That doesn't look like a website address, e.g. rival.com."));

  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login");
  const supabase = await createClient();

  const { data: loc } = await supabase.from("seo_locations").select("id").eq("id", location).maybeSingle();
  if (!loc) redirect(competitorBack(location, "That location no longer exists."));

  const { data: existing } = await supabase
    .from("seo_competitors")
    .select("id, is_active")
    .eq("location_id", location)
    .eq("domain", domain)
    .maybeSingle();
  if (existing?.is_active) redirect(competitorBack(location));

  const { count } = await supabase
    .from("seo_competitors")
    .select("id", { count: "exact", head: true })
    .eq("location_id", location)
    .eq("is_active", true);
  if ((count ?? 0) >= MAX_COMPETITORS_PER_LOCATION) {
    redirect(competitorBack(location, `You can track up to ${MAX_COMPETITORS_PER_LOCATION} competitors per location.`));
  }

  const { error } = existing
    ? await supabase.from("seo_competitors").update({ is_active: true }).eq("id", existing.id)
    : await supabase.from("seo_competitors").insert({ client_id: clientId, location_id: location, domain });
  if (error) redirect(competitorBack(location, error.message));

  revalidatePath("/seo");
  redirect(competitorBack(location));
}

export async function removeCompetitor(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(competitorBack(location, "Missing competitor id."));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(competitorBack(location, "Local SEO isn't active on your plan."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase.from("seo_competitors").update({ is_active: false }).eq("id", id).select("id");
  if (error) redirect(competitorBack(location, error.message));
  if (!data || data.length === 0) redirect(competitorBack(location, "That competitor no longer exists."));

  revalidatePath("/seo");
  redirect(competitorBack(location));
}

/**
 * Track a keyword for one location. Same shape as competitors: the tenant
 * policy on seo_keywords (0042) confines the row to the caller's client but
 * not the location_id it points at, so the location is looked up under RLS
 * first. Re-adding a keyword that was stopped turns it back on (0060), so its
 * ranking history carries on rather than starting over.
 */
export async function addKeyword(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const keyword = cleanKeyword(String(formData.get("keyword") ?? ""));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(keywordBack(location, "Local SEO isn't active on your plan."));
  if (keyword.length < KEYWORD_MIN || keyword.length > KEYWORD_MAX) {
    redirect(keywordBack(location, `A keyword must be between ${KEYWORD_MIN} and ${KEYWORD_MAX} characters.`));
  }

  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login");
  const supabase = await createClient();

  const { data: loc } = await supabase.from("seo_locations").select("id").eq("id", location).maybeSingle();
  if (!loc) redirect(keywordBack(location, "That location no longer exists."));

  const { data: existing } = await supabase
    .from("seo_keywords")
    .select("id, is_active")
    .eq("location_id", location)
    .eq("keyword", keyword)
    .maybeSingle();
  if (existing?.is_active) redirect(keywordBack(location));

  const { count } = await supabase
    .from("seo_keywords")
    .select("id", { count: "exact", head: true })
    .eq("location_id", location)
    .eq("is_active", true);
  if ((count ?? 0) >= MAX_KEYWORDS_PER_LOCATION) {
    redirect(keywordBack(location, `You can track up to ${MAX_KEYWORDS_PER_LOCATION} keywords per location. Stop tracking one to add another.`));
  }

  // A keyword coming back does NOT get its map grid back: the grid must be
  // switched on by a person each time (0042's rule), and the cap re-checked.
  const { error } = existing
    ? await supabase.from("seo_keywords").update({ is_active: true, is_geo_grid_enabled: false, enabled_by: null, enabled_at: null }).eq("id", existing.id)
    : await supabase.from("seo_keywords").insert({ client_id: clientId, location_id: location, keyword });
  if (error) redirect(keywordBack(location, error.message));

  revalidatePath("/seo");
  redirect(keywordBack(location));
}

/** Stop tracking a keyword. Kept (inactive) so its rankings stay in the history. */
export async function removeKeyword(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(keywordBack(location, "Missing keyword id."));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(keywordBack(location, "Local SEO isn't active on your plan."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS turns "not yours" into a zero-row update, so the count is the proof.
  const { data, error } = await supabase
    .from("seo_keywords")
    .update({ is_active: false, is_geo_grid_enabled: false, enabled_by: null, enabled_at: null })
    .eq("id", id)
    .select("id");
  if (error) redirect(keywordBack(location, error.message));
  if (!data || data.length === 0) redirect(keywordBack(location, "That keyword no longer exists."));

  revalidatePath("/seo");
  redirect(keywordBack(location));
}

/**
 * Switch the 5x5 map grid on or off for one keyword. 0042's rule: the grid is
 * turned on by a person, and enabled_by/enabled_at record who. It costs 25
 * extra checks a week, hence the per-location cap.
 */
export async function setKeywordGeoGrid(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const id = String(formData.get("id") ?? "");
  const on = String(formData.get("on") ?? "") === "true";
  if (!id) redirect(keywordBack(location, "Missing keyword id."));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(keywordBack(location, "Local SEO isn't active on your plan."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The cap is counted on the keyword's OWN location (read under RLS), not
  // the one the form claims.
  const { data: kw } = await supabase.from("seo_keywords").select("location_id, is_geo_grid_enabled").eq("id", id).eq("is_active", true).maybeSingle();
  if (!kw) redirect(keywordBack(location, "That keyword no longer exists."));
  if (kw.is_geo_grid_enabled === on) redirect(keywordBack(location));

  if (on) {
    const { count } = await supabase
      .from("seo_keywords")
      .select("id", { count: "exact", head: true })
      .eq("location_id", kw.location_id)
      .eq("is_active", true)
      .eq("is_geo_grid_enabled", true);
    if ((count ?? 0) >= MAX_GEO_GRID_KEYWORDS_PER_LOCATION) {
      redirect(keywordBack(location, `The map grid can be on for up to ${MAX_GEO_GRID_KEYWORDS_PER_LOCATION} keywords per location. Turn it off for one first.`));
    }
  }

  const { data, error } = await supabase
    .from("seo_keywords")
    .update(
      on
        ? { is_geo_grid_enabled: true, enabled_by: user.id, enabled_at: new Date().toISOString() }
        : { is_geo_grid_enabled: false, enabled_by: null, enabled_at: null },
    )
    .eq("id", id)
    .eq("is_active", true)
    .select("id");
  if (error) redirect(keywordBack(location, error.message));
  if (!data || data.length === 0) redirect(keywordBack(location, "That keyword no longer exists."));

  revalidatePath("/seo");
  redirect(keywordBack(location));
}

/**
 * Dismiss a keyword suggestion (module 22) so the monthly run doesn't offer it
 * again. The table is read-only to tenants; 0062's definer function checks
 * the suggestion belongs to the caller's client. Tracking a suggestion goes
 * through addKeyword, like any other keyword.
 */
export async function dismissKeywordSuggestion(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(suggestionBack(location, "Missing suggestion id."));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(suggestionBack(location, "Local SEO isn't active on your plan."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase.rpc("dismiss_seo_keyword_suggestion", { p_id: id });
  if (error) redirect(suggestionBack(location, error.message));
  if (!data) redirect(suggestionBack(location, "That suggestion no longer exists."));

  revalidatePath("/seo");
  redirect(suggestionBack(location));
}

/**
 * Dismiss a competitor gap phrase (module 23) for every location of the
 * client: it leaves the gap table and is never picked as an article topic.
 * The gap tables are read-only to tenants; 0063's definer function records it.
 */
export async function dismissCompetitorGap(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const keyword = cleanKeyword(String(formData.get("keyword") ?? ""));
  if (keyword.length < KEYWORD_MIN || keyword.length > KEYWORD_MAX) redirect(gapBack(location, "Missing keyword."));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(gapBack(location, "Local SEO isn't active on your plan."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase.rpc("dismiss_seo_competitor_gap", { p_keyword: keyword });
  if (error) redirect(gapBack(location, error.message));
  if (!data) redirect(gapBack(location, "That keyword couldn't be dismissed."));

  revalidatePath("/seo");
  redirect(gapBack(location));
}

/**
 * Save a location's local-detail intake (module 28): what weekly articles may
 * say about it. Saving is the client confirming the facts are true; 0067's
 * trigger records who and when. Every list is cleaned with the same rules the
 * table enforces (supabase/functions/seo-content/details.ts), and anything
 * dropped is reported back.
 */
export async function saveLocationDetails(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const back = (notice?: string, error?: string) => {
    const qs = new URLSearchParams();
    if (location) qs.set("location", location);
    qs.set("tab", "map");
    if (notice) qs.set("notice", notice);
    if (error) qs.set("error", error);
    return `/seo?${qs.toString()}#location-details`;
  };

  const access = await getSeoAccess();
  if (!access.allowed) redirect(back(undefined, "Local SEO isn't active on your plan."));
  if (formData.get("confirm") !== "yes") redirect(back(undefined, "Tick the box to confirm these details are true before saving."));
  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login");
  const supabase = await createClient();

  const { data: loc } = await supabase.from("seo_locations").select("id").eq("id", location).maybeSingle();
  if (!loc) redirect(back(undefined, "That location no longer exists."));

  // Module 30: suggestions found on the website and left ticked. Read under
  // RLS, so only this client's own open suggestions for this location count.
  const acceptIds = formData.getAll("accept").map(String).filter(Boolean).slice(0, 100);
  const { data: acceptedRows } = acceptIds.length
    ? await supabase.from("seo_detail_suggestions").select("id, field, value").in("id", acceptIds).eq("location_id", location).eq("status", "open")
    : { data: [] };
  const accepted = (acceptedRows ?? []) as { id: string; field: string; value: string }[];
  const form = applyAccepted(
    {
      lists: Object.fromEntries(DETAIL_LISTS.map((f) => [f, String(formData.get(f) ?? "")])) as DetailsForm["lists"],
      flags: Object.fromEntries(DETAIL_FLAGS.map((f) => [f, formData.get(f) === "on"])) as DetailsForm["flags"],
      year: String(formData.get("year_founded") ?? ""),
      guarantee: String(formData.get("guarantee") ?? ""),
    },
    accepted,
  );

  let dropped = 0;
  const list = (field: ListField) => {
    const r = cleanList(form.lists[field], field);
    dropped += r.dropped;
    return r.items;
  };
  const yearRaw = form.year;
  const year = cleanYear(yearRaw);
  if (yearRaw.trim() && year === null) redirect(back(undefined, "The year founded must be a past year, like 2004."));
  const guaranteeRaw = form.guarantee;
  const guarantee = guaranteeRaw.trim() ? cleanItem(guaranteeRaw, DETAIL_LIMITS.guarantee) : null;
  if (guaranteeRaw.trim() && !guarantee) redirect(back(undefined, `Describe the guarantee in one line of up to ${DETAIL_LIMITS.guarantee} characters, without links or phone numbers.`));
  const flag = (name: (typeof DETAIL_FLAGS)[number]) => form.flags[name];

  const row = {
    location_id: location,
    client_id: clientId,
    service_areas: list("service_areas"),
    landmarks: list("landmarks"),
    services: list("services"),
    year_founded: year,
    licensed: flag("licensed"),
    insured: flag("insured"),
    bonded: flag("bonded"),
    certifications: list("certifications"),
    family_owned: flag("family_owned"),
    locally_owned: flag("locally_owned"),
    free_estimates: flag("free_estimates"),
    guarantee,
    awards: list("awards"),
  };
  const { error } = await supabase.from("seo_location_details").upsert(row, { onConflict: "location_id" });
  if (error) redirect(back(undefined, error.message));
  if (accepted.length) {
    await supabase.rpc("decide_seo_detail_suggestions", { p_location_id: location, p_ids: accepted.map((a) => a.id), p_status: "accepted" });
  }

  revalidatePath("/seo");
  redirect(back(`Saved. New articles for this location can now use these details.${accepted.length ? ` ${accepted.length} found on your website ${accepted.length === 1 ? "was" : "were"} added.` : ""}${dropped ? ` ${dropped} line${dropped === 1 ? " was" : "s were"} left out (too long, repeated, over the limit, or containing a link or phone number).` : ""}`));
}

/**
 * "Not right" on a suggested detail (module 30): it's dismissed and never
 * suggested again for this location. Submitted from the details form without
 * its confirm box, so nothing else in the form is saved.
 */
export async function dismissDetailSuggestion(id: string, formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const back = (error?: string) => {
    const qs = new URLSearchParams();
    if (location) qs.set("location", location);
    qs.set("tab", "map");
    if (error) qs.set("error", error);
    return `/seo?${qs.toString()}#location-details`;
  };
  const access = await getSeoAccess();
  if (!access.allowed) redirect(back("Local SEO isn't active on your plan."));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decide_seo_detail_suggestions", { p_location_id: location, p_ids: [id], p_status: "dismissed" });
  if (error) redirect(back(error.message));
  if (!data) redirect(back("That suggestion was already handled."));
  revalidatePath("/seo");
  redirect(back());
}

/**
 * Track keywords or competitors picked from a Semrush or Ahrefs export (module
 * 27). The file is parsed in the browser (lib/seo-import.ts); only the ticked
 * values arrive here, as repeated `item` fields, and each is cleaned and
 * checked again. Same rules as adding one by hand: the location is looked up
 * under RLS, an inactive row comes back (its history intact; a keyword's map
 * grid stays off), and the per-location cap holds.
 */
export async function importFromExport(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const kind = String(formData.get("kind") ?? "");
  const back = (notice?: string, error?: string) => {
    const qs = new URLSearchParams();
    if (location) qs.set("location", location);
    qs.set("tab", "keywords");
    if (notice) qs.set("notice", notice);
    if (error) qs.set("error", error);
    return `/seo?${qs.toString()}#import`;
  };
  if (kind !== "keywords" && kind !== "competitors") redirect(back(undefined, "Unknown import type."));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(back(undefined, "Local SEO isn't active on your plan."));
  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login");
  const supabase = await createClient();

  const { data: loc } = await supabase.from("seo_locations").select("id").eq("id", location).maybeSingle();
  if (!loc) redirect(back(undefined, "That location no longer exists."));

  const isKw = kind === "keywords";
  const table = isKw ? "seo_keywords" : "seo_competitors";
  const field = isKw ? "keyword" : "domain";
  const cap = isKw ? MAX_KEYWORDS_PER_LOCATION : MAX_COMPETITORS_PER_LOCATION;

  const values: string[] = [];
  let invalid = 0;
  for (const raw of formData.getAll("item").slice(0, 200)) {
    const v = isKw ? cleanKeyword(String(raw)) : cleanDomain(String(raw));
    const okValue = isKw ? !!v && v.length >= KEYWORD_MIN && v.length <= KEYWORD_MAX : !!v;
    if (!okValue || !v) invalid++;
    else if (!values.includes(v)) values.push(v);
  }
  if (values.length === 0) redirect(back(undefined, invalid ? "None of the picked rows is a valid keyword or website." : "Nothing was picked."));

  const { data: existingRows, error: readErr } = await supabase.from(table).select(`id, ${field}, is_active`).eq("location_id", location);
  if (readErr) redirect(back(undefined, readErr.message));
  const existing = new Map(((existingRows ?? []) as unknown as Record<string, unknown>[]).map((r) => [String(r[field]), { id: String(r.id), active: r.is_active === true }]));
  let room = cap - [...existing.values()].filter((e) => e.active).length;

  const reactivate: string[] = [];
  const insert: string[] = [];
  let already = 0;
  let overCap = 0;
  for (const v of values) {
    const e = existing.get(v);
    if (e?.active) already++;
    else if (room <= 0) overCap++;
    else {
      if (e) reactivate.push(e.id);
      else insert.push(v);
      room--;
    }
  }

  if (reactivate.length) {
    const patch = isKw ? { is_active: true, is_geo_grid_enabled: false, enabled_by: null, enabled_at: null } : { is_active: true };
    const { error } = await supabase.from(table).update(patch).in("id", reactivate);
    if (error) redirect(back(undefined, error.message));
  }
  if (insert.length) {
    const { error } = await supabase.from(table).insert(insert.map((v) => ({ client_id: clientId, location_id: location, [field]: v })));
    if (error) redirect(back(undefined, error.message));
  }

  const added = reactivate.length + insert.length;
  const noun = isKw ? "keyword" : "competitor";
  const parts = [`Now tracking ${added} more ${noun}${added === 1 ? "" : "s"}`];
  if (already) parts.push(`${already} already tracked`);
  if (overCap) parts.push(`${overCap} left out at the limit of ${cap} per location`);
  if (invalid) parts.push(`${invalid} not valid`);

  revalidatePath("/seo");
  redirect(back(`${parts.join(", ")}.`));
}

/**
 * Dismiss a referring site from the link opportunities (module 26), for every
 * location of the client. The tables are read-only to tenants; 0066's definer
 * function records it.
 */
export async function dismissLinkOpportunity(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const domain = cleanDomain(String(formData.get("domain") ?? ""));
  if (!domain) redirect(linksBack(location, "Missing site."));

  const access = await getSeoAccess();
  if (!access.allowed) redirect(linksBack(location, "Local SEO isn't active on your plan."));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase.rpc("dismiss_seo_link_opportunity", { p_domain: domain });
  if (error) redirect(linksBack(location, error.message));
  if (!data) redirect(linksBack(location, "That site couldn't be dismissed."));

  revalidatePath("/seo");
  redirect(linksBack(location));
}

function linksBack(location: string, error?: string) {
  const qs = new URLSearchParams();
  if (location) qs.set("location", location);
  qs.set("tab", "links");
  if (error) qs.set("error", error);
  const s = qs.toString();
  return `/seo${s ? `?${s}` : ""}#link-opportunities`;
}

function gapBack(location: string, error?: string) {
  const qs = new URLSearchParams();
  if (location) qs.set("location", location);
  qs.set("tab", "keywords");
  if (error) qs.set("error", error);
  const s = qs.toString();
  return `/seo${s ? `?${s}` : ""}#competitor-gaps`;
}

function suggestionBack(location: string, error?: string) {
  const qs = new URLSearchParams();
  if (location) qs.set("location", location);
  qs.set("tab", "keywords");
  if (error) qs.set("error", error);
  const s = qs.toString();
  return `/seo${s ? `?${s}` : ""}#suggested-keywords`;
}

function keywordBack(location: string, error?: string) {
  const qs = new URLSearchParams();
  if (location) qs.set("location", location);
  qs.set("tab", "keywords");
  if (error) qs.set("error", error);
  const s = qs.toString();
  return `/seo${s ? `?${s}` : ""}#keywords`;
}

function competitorBack(location: string, error?: string) {
  const qs = new URLSearchParams();
  if (location) qs.set("location", location);
  qs.set("tab", "keywords");
  if (error) qs.set("error", error);
  const s = qs.toString();
  return `/seo${s ? `?${s}` : ""}#competitors`;
}

/**
 * Edit a location after onboarding (/seo?tab=settings). The tenant policy on
 * seo_locations (0042) confines the update to the caller's own rows; the row
 * is read under RLS first so a forged id gets a message, not a silent no-op.
 * Validation and the "what changed" logic live in lib/seo-location-form.ts.
 */
export async function updateLocationSettings(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const back = (notice?: string, error?: string) => {
    const qs = new URLSearchParams();
    if (location) qs.set("location", location);
    qs.set("tab", "settings");
    if (notice) qs.set("notice", notice);
    if (error) qs.set("error", error);
    return `/seo?${qs.toString()}#location-settings`;
  };

  const access = await getSeoAccess();
  if (!access.allowed) redirect(back(undefined, "Local SEO isn't active on your plan."));
  const supabase = await createClient();

  const { data: current } = await supabase
    .from("seo_locations")
    .select("name, website_url, store_page_url, search_console_site_url, phone_number, address_line1, city, region, postal_code, country_code")
    .eq("id", location)
    .maybeSingle();
  if (!current) redirect(back(undefined, "That location no longer exists."));

  const result = parseLocationForm((k) => String(formData.get(k) ?? ""), current as LocationRow);
  if (!result.ok) redirect(back(undefined, result.error));
  if (result.changed.length === 0) redirect(back("Nothing changed."));

  const { data, error } = await supabase.from("seo_locations").update(result.update).eq("id", location).select("id");
  if (error) redirect(back(undefined, error.message));
  if (!data || data.length === 0) redirect(back(undefined, "That location no longer exists."));

  const notes = ["Saved."];
  if (isOnlineOnlyRow(result.update)) {
    if (!isOnlineOnlyRow(current as LocationRow)) {
      notes.push("This location is now online only: the audit asks for Organization structured data and new articles name no city.");
    }
  } else if ("lat" in result.update) {
    notes.push("The address changed, so the map position will be looked up again within the hour.");
  }
  if (result.changed.includes("website_url")) notes.push("The next weekly site audit will crawl the new website.");
  revalidatePath("/seo");
  redirect(back(notes.join(" ")));
}

/**
 * "Run now" on /seo?tab=settings. request_seo_run_now (0073) checks ownership,
 * the allowlist and the cooldown, and only moves the job's next_run_at: the
 * job's own cron tick does the work, with every existing guard.
 */
export async function runSeoJobNow(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const job = String(formData.get("job") ?? "");
  const back = (notice?: string, error?: string) => {
    const qs = new URLSearchParams();
    if (location) qs.set("location", location);
    qs.set("tab", "settings");
    if (notice) qs.set("notice", notice);
    if (error) qs.set("error", error);
    return `/seo?${qs.toString()}#jobs`;
  };

  const access = await getSeoAccess();
  if (!access.allowed) redirect(back(undefined, "Local SEO isn't active on your plan."));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("request_seo_run_now", { p_location_id: location, p_job_type: job });
  if (error) redirect(back(undefined, error.message));
  const result = RUN_NOW_RESULT[String(data)] ?? { ok: false, text: "Could not do that." };
  const label = JOB_INFO[job]?.label ?? job;
  revalidatePath("/seo");
  const when = data === "ok" ? ` It starts ${JOB_INFO[job]?.soon ?? "within the hour"}.` : "";
  redirect(result.ok ? back(`${label}: ${result.text}${when}`) : back(undefined, `${label}: ${result.text}`));
}

/**
 * "This location's Business Profile" on /seo?tab=settings. link_seo_gbp_location
 * (0076) checks both ids belong to the caller's client, keeps the link
 * one-to-one, and queues the sync. An empty profile unlinks.
 */
export async function linkGbpLocation(formData: FormData) {
  const location = String(formData.get("location") ?? "");
  const profile = String(formData.get("profile") ?? "").trim();
  const previous = String(formData.get("previous") ?? "").trim();
  const back = (notice?: string, error?: string) => {
    const qs = new URLSearchParams();
    if (location) qs.set("location", location);
    qs.set("tab", "settings");
    if (notice) qs.set("notice", notice);
    if (error) qs.set("error", error);
    return `/seo?${qs.toString()}#gbp`;
  };

  const access = await getSeoAccess();
  if (!access.allowed) redirect(back(undefined, "Local SEO isn't active on your plan."));
  if (!profile && !previous) redirect(back(undefined, "Choose a profile."));
  const supabase = await createClient();
  const { data, error } = profile
    ? await supabase.rpc("link_seo_gbp_location", { p_location_name: profile, p_location_id: location })
    : await supabase.rpc("link_seo_gbp_location", { p_location_name: previous, p_location_id: null });
  if (error) redirect(back(undefined, error.message));
  const result = LINK_RESULT[String(data)] ?? { ok: false, text: "Could not do that." };
  revalidatePath("/seo");
  redirect(result.ok ? back(profile ? result.text : "Unlinked.") : back(undefined, result.text));
}
