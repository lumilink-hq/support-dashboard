// =============================================================================
// outbound-snapshot/lib.ts — pure helpers for the pre-call SEO snapshot
// (docs/OUTBOUND-PLAN.md, Phase 4): the search to check, the nearby
// competitors worth comparing against, and the plain-language to-do list a
// prospect gets whether they sign up or not. No network, no Deno APIs, so
// scripts/test-outbound-snapshot.ts runs them under Node.
//
// The website checks themselves come from the SEO modules unchanged
// (seo-crawl auditPage, seo-technical-audit analyzers, seo-rank-tracking
// findOwnRanking); this file only turns their findings into sentences a
// business owner understands.
// =============================================================================

export type Severity = "critical" | "warning" | "info";

export type SiteFinding = {
  finding_type: string;
  severity: Severity;
  title: string;
  details: Record<string, unknown>;
};

export type Competitor = {
  name: string;
  rating: number | null;
  reviews: number | null;
  domain: string | null;
  cid: string | null;
};

export type RankResult = {
  keyword: string;
  /** Position in Google's map pack (1-3, sometimes more), or null if absent. */
  local_pack: number | null;
  /** Position among the organic results checked (top 20), or null. */
  organic: number | null;
  /** Businesses in the map pack, in order, for the talk track. */
  local_pack_names: string[];
} | null;

export type TodoItem = {
  area: "maps" | "reviews" | "website" | "search";
  severity: Severity;
  text: string;
};

// -----------------------------------------------------------------------------
// The search
// -----------------------------------------------------------------------------

/** "Cannabis store" in "Detroit" -> "cannabis store detroit". The search a
 * nearby customer would type; null when the listing lacks either part. */
export function keywordFor(category: string | null, city: string | null): string | null {
  const c = category?.trim().toLowerCase();
  const t = city?.trim().toLowerCase();
  if (!c || !t) return null;
  return `${c} ${t}`.replace(/\s+/g, " ");
}

/** Latitude and longitude from the listing DataForSEO returned (outbound_leads.raw). */
export function coordinatesOf(raw: unknown): { lat: number; lng: number } | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const lat = typeof r.latitude === "number" ? r.latitude : null;
  const lng = typeof r.longitude === "number" ? r.longitude : null;
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** The listing's primary DataForSEO category id, for the competitor search. */
export function primaryCategoryId(raw: unknown): string | null {
  const ids = (raw as Record<string, unknown> | null)?.category_ids;
  return Array.isArray(ids) && typeof ids[0] === "string" && ids[0] ? ids[0] : null;
}

// -----------------------------------------------------------------------------
// Competitors
// -----------------------------------------------------------------------------

function bareDomain(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Nearby listings from a business listings search, minus the prospect
 * itself, most-reviewed first. `limit` competitors are kept.
 */
export function competitorsFrom(
  items: unknown[],
  own: { cid: string | null; domain: string | null; name: string | null },
  limit = 5,
): Competitor[] {
  const ownDomain = bareDomain(own.domain);
  const ownName = own.name?.trim().toLowerCase() ?? null;
  const out: Competitor[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, any>;
    const name = typeof it.title === "string" ? it.title.trim() : "";
    if (!name) continue;
    const cid = typeof it.cid === "string" ? it.cid : null;
    const domain = bareDomain(it.url ?? it.domain);
    if ((own.cid && cid === own.cid) || (ownDomain && domain === ownDomain) || (ownName && name.toLowerCase() === ownName)) {
      continue;
    }
    if (it.work_time?.work_hours?.current_status === "closed_forever") continue;
    const r = it.rating ?? {};
    out.push({
      name,
      rating: r.rating_type === "Max5" && typeof r.value === "number" ? r.value : null,
      reviews: typeof r.votes_count === "number" ? r.votes_count : null,
      domain,
      cid,
    });
  }
  return out.sort((a, b) => (b.reviews ?? -1) - (a.reviews ?? -1)).slice(0, limit);
}

export type ListingComparison = {
  own_rating: number | null;
  own_reviews: number | null;
  competitors: number;
  median_reviews: number | null;
  average_rating: number | null;
  /** 1 = most reviews among the prospect plus its competitors. */
  reviews_rank: number | null;
};

function median(ns: number[]): number | null {
  if (ns.length === 0) return null;
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function compareListing(own: { rating: number | null; reviews: number | null }, competitors: Competitor[]): ListingComparison {
  const reviews = competitors.map((c) => c.reviews).filter((n): n is number => typeof n === "number");
  const ratings = competitors.map((c) => c.rating).filter((n): n is number => typeof n === "number");
  const average = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;
  const rank = own.reviews === null ? null : 1 + reviews.filter((n) => n > own.reviews!).length;
  return {
    own_rating: own.rating,
    own_reviews: own.reviews,
    competitors: competitors.length,
    median_reviews: median(reviews),
    average_rating: average,
    reviews_rank: rank,
  };
}

// -----------------------------------------------------------------------------
// To-do list
// -----------------------------------------------------------------------------

/** What each website finding means for the owner, in their words. */
function siteText(f: SiteFinding): string | null {
  const d = f.details ?? {};
  switch (f.finding_type) {
    case "site_unreachable":
      return "Your website didn't load when we checked, so anyone who clicks it from Google hits a dead end.";
    case "server_error":
    case "client_error":
    case "homepage_not_found":
      return `Your homepage returns an error${d.status ? ` (${d.status})` : ""} instead of the page.`;
    case "redirect_loop":
      return "Your homepage redirects in a loop, so browsers and Google give up before it loads.";
    case "redirect_chain_too_long":
      return "Your homepage bounces through several redirects before it loads, which slows it down and dilutes it for Google.";
    case "robots_txt_blocks_everything":
      return "Your site tells Google not to look at any of its pages (robots.txt), so it can't show them in search.";
    case "sitemap_missing":
      return "Your site has no sitemap, so Google has to find your pages on its own.";
    case "missing_title":
      return "Your homepage has no title, the line Google shows as the blue link in search results.";
    case "title_length":
      return `Your homepage title is ${d.length ?? "the wrong"} characters long; Google shows about 60, so it's cut off or too thin.`;
    case "missing_meta_description":
      return "There's no description for Google to show under your link, so it picks random text from the page.";
    case "missing_h1":
      return "Your homepage has no main headline telling visitors and Google what you do.";
    case "multiple_h1":
      return "Your homepage has several competing main headlines, which muddies what the page is about.";
    case "missing_local_business_schema":
      return "Your site doesn't give Google your name, address, phone and hours in the format it reads for local results.";
    case "phone_not_on_page":
      return "The phone number on your Google listing doesn't appear on your homepage, which weakens Google's trust in both.";
    case "thin_content":
      return `Your homepage has very little text${d.word_count ? ` (${d.word_count} words)` : ""}, so Google has little to rank it for.`;
    case "images_missing_alt":
      return "Images on your homepage have no descriptions, which Google uses to understand them.";
    case "not_https":
      return "Your site isn't secure (no https), and browsers warn visitors before they reach it.";
    case "no_mobile_viewport":
      return "Your site isn't set up for phones, where most local searches happen.";
    default:
      return f.title || null;
  }
}

const WEIGHT: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const AREA_ORDER: Record<TodoItem["area"], number> = { maps: 0, reviews: 1, search: 2, website: 3 };

export function buildTodo(input: {
  businessName: string;
  rank: RankResult;
  listing: ListingComparison | null;
  competitors: Competitor[];
  site: SiteFinding[];
}): TodoItem[] {
  const items: TodoItem[] = [];
  const { rank, listing, competitors } = input;

  if (rank) {
    const leaders = rank.local_pack_names.slice(0, 3).join(", ");
    if (rank.local_pack === null) {
      items.push({
        area: "maps",
        severity: "critical",
        text: `You don't appear in Google's map results for "${rank.keyword}"${leaders ? `; ${leaders} do` : ""}.`,
      });
    } else if (rank.local_pack > 3) {
      items.push({
        area: "maps",
        severity: "warning",
        text: `You're #${rank.local_pack} on the map for "${rank.keyword}"; only the top 3 show without scrolling.`,
      });
    }
    if (rank.organic === null) {
      items.push({ area: "search", severity: "warning", text: `Your website isn't in Google's top 20 results for "${rank.keyword}".` });
    } else if (rank.organic > 10) {
      items.push({ area: "search", severity: "info", text: `Your website is on page 2 of Google for "${rank.keyword}" (#${rank.organic}).` });
    }
  }

  if (listing && listing.competitors > 0) {
    const top = competitors[0];
    if (listing.own_reviews !== null && listing.median_reviews !== null && listing.own_reviews < listing.median_reviews) {
      items.push({
        area: "reviews",
        severity: listing.own_reviews < listing.median_reviews / 2 ? "critical" : "warning",
        text: `You have ${listing.own_reviews} Google reviews; nearby competitors have a median of ${listing.median_reviews}` +
          (top?.reviews ? ` and ${top.name} has ${top.reviews}` : "") + ".",
      });
    }
    if (listing.own_rating !== null && listing.average_rating !== null && listing.own_rating + 0.2 < listing.average_rating) {
      items.push({
        area: "reviews",
        severity: "warning",
        text: `Your rating is ${listing.own_rating}★ against a ${listing.average_rating}★ average nearby.`,
      });
    }
  }

  for (const f of input.site) {
    const text = siteText(f);
    if (text) items.push({ area: "website", severity: f.severity, text });
  }

  return items.sort((a, b) => WEIGHT[a.severity] - WEIGHT[b.severity] || AREA_ORDER[a.area] - AREA_ORDER[b.area]);
}

/** Two or three lines for whoever makes the call. */
export function summaryLines(input: {
  businessName: string;
  rank: RankResult;
  listing: ListingComparison | null;
  todo: TodoItem[];
}): string {
  const lines: string[] = [];
  const { rank, listing } = input;
  if (rank) {
    lines.push(
      `"${rank.keyword}": map ${rank.local_pack ? `#${rank.local_pack}` : "not shown"}, ` +
        `organic ${rank.organic ? `#${rank.organic}` : "not in top 20"}.`,
    );
  }
  if (listing && listing.competitors > 0) {
    lines.push(
      `Reviews: ${listing.own_reviews ?? "?"} (${listing.own_rating ?? "?"}★) vs nearby median ` +
        `${listing.median_reviews ?? "?"} (${listing.average_rating ?? "?"}★); ` +
        `#${listing.reviews_rank ?? "?"} of ${listing.competitors + 1} by reviews.`,
    );
  }
  const critical = input.todo.filter((t) => t.severity === "critical").length;
  lines.push(`${input.todo.length} to-do items, ${critical} critical.`);
  return lines.join("\n");
}

/** Simple homepage signals the SEO modules don't check on their own. */
export function extraSiteFindings(finalUrl: string, html: string | null): SiteFinding[] {
  const out: SiteFinding[] = [];
  if (finalUrl.startsWith("http://")) {
    out.push({ finding_type: "not_https", severity: "warning", title: "Site doesn't use https", details: { url: finalUrl } });
  }
  if (html !== null && !/<meta[^>]+name\s*=\s*["']viewport["']/i.test(html)) {
    out.push({ finding_type: "no_mobile_viewport", severity: "warning", title: "No mobile viewport tag", details: {} });
  }
  return out;
}
