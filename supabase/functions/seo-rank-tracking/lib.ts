// =============================================================================
// lib.ts — pure, side-effect-free helpers for the seo-rank-tracking worker
// (module 7). Same split as the other SEO edge functions.
// =============================================================================

export type SerpItem = {
  type: string;
  rank_group?: number;
  rank_absolute?: number;
  domain?: string;
  url?: string;
  title?: string;
  phone?: string;
};

export type RankMatch = { position: number; matched_on: "domain" | "phone" | "title" } | null;

/** Normalizes a domain for comparison — strips protocol, www, and any path,
 * so "https://www.acme.com/" and "acme.com" compare equal. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function digitsOnly(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); // drop US country code
}

/**
 * Finds this location's own ranking among a SERP's items, for one item type
 * ('organic' or 'local_pack'). Matches on domain first (most reliable for
 * organic), falling back to phone (most reliable for local_pack, where the
 * domain field is sometimes the business's own site and sometimes absent),
 * falling back to an exact title match as a last resort.
 *
 * Returns the FIRST (best) match — a business can legitimately appear twice
 * in local_pack-adjacent results, and "where do I rank" means the best one.
 */
export function findOwnRanking(
  items: SerpItem[],
  itemType: "organic" | "local_pack",
  own: { domain: string | null; phone: string | null; businessName: string | null },
): RankMatch {
  const ownDomain = normalizeDomain(own.domain);
  const ownPhone = digitsOnly(own.phone);
  const ownTitle = own.businessName?.trim().toLowerCase() || null;

  const candidates = items.filter((i) => i.type === itemType && (i.rank_group ?? i.rank_absolute) !== undefined);

  // THREE FULL PASSES, one per strategy, in priority order — not one combined
  // pass checking all three per item. A single pass would let a spurious
  // title match on an EARLY item win over the true domain match on a LATER
  // one; scanning the whole list per strategy before falling back to the
  // next guarantees domain beats phone beats title regardless of order.
  if (ownDomain) {
    for (const item of candidates) {
      if (normalizeDomain(item.domain ?? item.url) === ownDomain) {
        return { position: (item.rank_group ?? item.rank_absolute)!, matched_on: "domain" };
      }
    }
  }
  if (ownPhone && ownPhone.length >= 7) {
    for (const item of candidates) {
      if (digitsOnly(item.phone) === ownPhone) {
        return { position: (item.rank_group ?? item.rank_absolute)!, matched_on: "phone" };
      }
    }
  }
  if (ownTitle) {
    for (const item of candidates) {
      if (item.title?.trim().toLowerCase() === ownTitle) {
        return { position: (item.rank_group ?? item.rank_absolute)!, matched_on: "title" };
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Geo grid — 5x5 points around a center coordinate. Spacing is in kilometers
// (converted to degrees), which distorts slightly at latitude extremes — an
// accepted approximation for the +/-2 grid-cell radius this covers; nothing
// in local SEO needs geodesic precision at this scale.
// -----------------------------------------------------------------------------

export type GridPoint = { row: number; col: number; lat: number; lng: number };

const KM_PER_DEGREE_LAT = 111.0;

export function buildGeoGrid(centerLat: number, centerLng: number, spacingKm: number): GridPoint[] {
  const points: GridPoint[] = [];
  const latStep = spacingKm / KM_PER_DEGREE_LAT;
  const lngStep = spacingKm / (KM_PER_DEGREE_LAT * Math.cos((centerLat * Math.PI) / 180));

  // Rows/cols 1..5, center cell is (3,3) — matches 0042's seo_rankings CHECK
  // constraint (grid_row/grid_col between 1 and 5).
  for (let row = 1; row <= 5; row++) {
    for (let col = 1; col <= 5; col++) {
      const rowOffset = row - 3; // -2..2
      const colOffset = col - 3;
      points.push({
        row,
        col,
        lat: Number((centerLat + rowOffset * latStep).toFixed(6)),
        lng: Number((centerLng + colOffset * lngStep).toFixed(6)),
      });
    }
  }
  return points;
}

/** DataForSEO's location_coordinate format: "lat,lng,radius_km". */
export function formatLocationCoordinate(lat: number, lng: number, radiusKm = 5): string {
  return `${lat},${lng},${radiusKm}`;
}

// -----------------------------------------------------------------------------
// Competitor matching (module 18) — reads the SERP a standard task already
// returned, so it costs no extra vendor call.
// -----------------------------------------------------------------------------

export type CompetitorRankRow = {
  competitor_id: string;
  rank_type: "organic" | "local_pack";
  position: number | null;
};

/**
 * Where each competitor ranks in one SERP. Domain match only: a competitor is
 * a website the client typed in, so there's no phone or business name to fall
 * back on, and a title guess would risk crediting the wrong business.
 *
 * Organic always gets a row (null position = not in the tracked results).
 * local_pack gets a row only when Google showed a local pack for the query,
 * matching how the location's own ranking is recorded. A competitor whose
 * domain can't be parsed is skipped rather than recorded as "not found".
 */
export function matchCompetitors(
  items: SerpItem[],
  competitors: { id: string; domain: string }[],
): CompetitorRankRow[] {
  const hasLocalPack = items.some((i) => i.type === "local_pack");
  const rows: CompetitorRankRow[] = [];
  for (const c of competitors) {
    if (!normalizeDomain(c.domain)) continue;
    const own = { domain: c.domain, phone: null, businessName: null };
    rows.push({
      competitor_id: c.id,
      rank_type: "organic",
      position: findOwnRanking(items, "organic", own)?.position ?? null,
    });
    if (hasLocalPack) {
      rows.push({
        competitor_id: c.id,
        rank_type: "local_pack",
        position: findOwnRanking(items, "local_pack", own)?.position ?? null,
      });
    }
  }
  return rows;
}
