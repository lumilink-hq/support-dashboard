// =============================================================================
// outbound-source/lib.ts — pure helpers for outbound-source: turn a profile's
// audience into a DataForSEO business listings request, and a listing item
// into an outbound_leads row. No network, no Deno APIs, so
// scripts/test-outbound-source.ts can run them under Node.
// =============================================================================

/**
 * outbound_profiles.audience. Every field is optional; an empty audience is
 * rejected because it would page through every listing in DataForSEO.
 *
 *   categories          DataForSEO category ids, up to 10, e.g. "cannabis_store"
 *   location_coordinate "lat,lng,radius_km", e.g. "42.3314,-83.0458,50"
 *   min_rating          keep listings rated at least this (out of 5)
 *   min_reviews         keep listings with at least this many reviews
 *   require_website     default true: no website, no email to find
 *   filters             extra raw DataForSEO filter conditions, e.g.
 *                       [["address_info.region", "=", "MI"]]
 */
export type Audience = {
  categories?: string[];
  location_coordinate?: string;
  min_rating?: number;
  min_reviews?: number;
  require_website?: boolean;
  filters?: unknown[];
};

export type ListingsRequest = {
  categories?: string[];
  location_coordinate?: string;
  filters?: unknown[];
  order_by: string[];
  limit: number;
  offset_token?: string;
};

export class AudienceError extends Error {}

const MAX_CATEGORIES = 10;
const MAX_FILTER_CONDITIONS = 8; // DataForSEO's documented maximum
const COORDINATE = /^-?\d{1,2}(\.\d{1,7})?,-?\d{1,3}(\.\d{1,7})?,\d{1,6}(\.\d+)?$/;

/** Listings bought per run: four per lead the profile pushes a day, because
 * many businesses have no website or no findable email. 100 to 1,000 (the
 * API's page maximum). */
export function pageLimit(dailyLeadTarget: number): number {
  const target = Number.isFinite(dailyLeadTarget) ? Math.max(0, Math.floor(dailyLeadTarget)) : 0;
  return Math.min(1000, Math.max(100, target * 4));
}

function isCondition(c: unknown): boolean {
  return Array.isArray(c) && c.length === 3 && typeof c[0] === "string" && typeof c[1] === "string";
}

/** Validates the audience and builds the request body, minus offset_token. */
export function buildListingsRequest(audience: unknown, limit: number): ListingsRequest {
  if (!audience || typeof audience !== "object" || Array.isArray(audience)) {
    throw new AudienceError("audience must be an object");
  }
  const a = audience as Audience;
  const body: ListingsRequest = { order_by: ["rating.votes_count,desc"], limit };

  if (a.categories !== undefined) {
    if (!Array.isArray(a.categories) || !a.categories.every((c) => typeof c === "string" && c.trim() !== "")) {
      throw new AudienceError("audience.categories must be a list of category ids");
    }
    if (a.categories.length > MAX_CATEGORIES) {
      throw new AudienceError(`audience.categories allows at most ${MAX_CATEGORIES}`);
    }
    if (a.categories.length > 0) body.categories = a.categories.map((c) => c.trim());
  }

  if (a.location_coordinate !== undefined) {
    const coord = String(a.location_coordinate).replace(/\s+/g, "");
    if (!COORDINATE.test(coord)) {
      throw new AudienceError('audience.location_coordinate must be "lat,lng,radius_km"');
    }
    body.location_coordinate = coord;
  }

  if (!body.categories && !body.location_coordinate) {
    throw new AudienceError("audience needs categories or a location_coordinate");
  }

  const conditions: unknown[] = [];
  if (a.min_rating !== undefined) {
    if (typeof a.min_rating !== "number" || a.min_rating < 0 || a.min_rating > 5) {
      throw new AudienceError("audience.min_rating must be between 0 and 5");
    }
    conditions.push(["rating.value", ">=", a.min_rating]);
  }
  if (a.min_reviews !== undefined) {
    if (!Number.isInteger(a.min_reviews) || a.min_reviews < 0) {
      throw new AudienceError("audience.min_reviews must be a whole number");
    }
    conditions.push(["rating.votes_count", ">=", a.min_reviews]);
  }
  if (a.filters !== undefined) {
    if (!Array.isArray(a.filters) || !a.filters.every(isCondition)) {
      throw new AudienceError('audience.filters must be conditions like ["field", "op", value]');
    }
    conditions.push(...a.filters);
  }
  if (conditions.length > MAX_FILTER_CONDITIONS) {
    throw new AudienceError(`at most ${MAX_FILTER_CONDITIONS} filter conditions`);
  }
  if (conditions.length > 0) {
    // DataForSEO joins conditions with explicit "and" between them.
    body.filters = conditions.flatMap((c, i) => (i === 0 ? [c] : ["and", c]));
  }

  return body;
}

/** Identifies a request for cursor purposes: an offset_token is only valid
 * for the identical request. Key order is fixed by buildListingsRequest. */
export function cursorKey(body: ListingsRequest): string {
  const { offset_token: _ignored, ...rest } = body;
  return JSON.stringify(rest);
}

export type LeadRow = {
  source_ref: string;
  business_name: string;
  category: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  phone: string | null;
  website_url: string | null;
  rating: number | null;
  review_count: number | null;
  raw: Record<string, unknown>;
};

export type SkipReason = "no_id" | "no_name" | "closed" | "no_website";

// Large, unused parts of a listing; dropped from `raw` to keep rows small.
const RAW_DROP = ["popular_times", "people_also_search", "place_topics", "rating_distribution", "attributes"];

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** One listing item to a lead row, or the reason it's skipped. */
export function parseListing(
  item: unknown,
  requireWebsite = true,
): { row: LeadRow } | { skip: SkipReason } {
  if (!item || typeof item !== "object") return { skip: "no_id" };
  const it = item as Record<string, any>;

  const sourceRef = str(it.cid) ?? str(it.place_id);
  if (!sourceRef) return { skip: "no_id" };
  const name = str(it.title);
  if (!name) return { skip: "no_name" };

  const status = it.work_time?.work_hours?.current_status;
  if (status === "closed_forever" || status === "temporarily_closed") return { skip: "closed" };

  const website = str(it.url) ?? (str(it.domain) ? `https://${str(it.domain)}` : null);
  if (requireWebsite && !website) return { skip: "no_website" };

  // Only a 5-point rating maps onto outbound_leads.rating.
  const r = it.rating ?? {};
  const rating = r.rating_type === "Max5" || r.rating_max === 5 ? num(r.value) : null;
  const votes = num(r.votes_count);

  const raw: Record<string, unknown> = { ...it };
  for (const k of RAW_DROP) delete raw[k];

  const info = it.address_info ?? {};
  return {
    row: {
      source_ref: sourceRef,
      business_name: name,
      category: str(it.category),
      address: str(it.address),
      city: str(info.city),
      region: str(info.region),
      postal_code: str(info.zip),
      country_code: str(info.country_code),
      phone: str(it.phone),
      website_url: website,
      rating: rating !== null && rating >= 0 && rating <= 5 ? rating : null,
      review_count: votes !== null && votes >= 0 ? Math.floor(votes) : null,
      raw,
    },
  };
}

export type Page = {
  items: unknown[];
  total: number | null;
  nextToken: string | null;
  exhausted: boolean;
};

/** Reads tasks[0].result[0] of a listings response. A page shorter than the
 * limit, or one without a token, means there's nothing further to fetch. */
export function readPage(result: unknown, limit: number): Page {
  const first = Array.isArray(result) ? (result[0] as Record<string, any> | undefined) : undefined;
  const items: unknown[] = Array.isArray(first?.items) ? first!.items : [];
  const nextToken = str(first?.offset_token);
  const total = num(first?.total_count);
  return { items, total, nextToken, exhausted: items.length < limit || !nextToken };
}
