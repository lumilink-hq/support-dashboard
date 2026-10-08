// =============================================================================
// details.ts — module 28 (plan.md, Phase 6c): the local-detail intake that
// module 16's articles draw on. Pure (no Deno, no DOM, no database): the
// dashboard uses it to clean what a client types, seo-content uses it to
// build the prompt and to decide which otherwise-blocked claims a draft may
// make. Unit-tested in scripts/test-seo-location-details.ts.
//
// WHY STRUCTURED. module 16's validator refuses invented specifics
// (RISKY_CLAIMS): "licensed and insured", "since 1998", "family-owned", "free
// estimates", "guaranteed". With an intake those can be true, but only the
// specific ones the client vouched for. So the facts are fields (a year, yes /
// no boxes, short lists), not a free-text box: the validator can then allow
// "since 2004" only when year_founded is 2004, "insured" only when insured is
// ticked, and nothing else. Percentages, superlatives and price claims stay
// blocked whatever the intake says.
//
// The prompt payload and the claim allowances that use this type live in
// lib.ts (the dashboard type-checks lib.ts, and can only take a type import
// with a .ts extension from it).
//
// RULE 5. These are the client's words and they reach the model, the same way
// the business name and city already do: as data in the JSON user turn, under
// a fixed system prompt that calls every value data. Items are short, one
// line, and anything URL- or phone-shaped is dropped; the draft is validated
// and a person approves it.
// =============================================================================

export type LocationDetails = {
  service_areas: string[];
  landmarks: string[];
  services: string[];
  year_founded: number | null;
  licensed: boolean;
  insured: boolean;
  bonded: boolean;
  certifications: string[];
  family_owned: boolean;
  locally_owned: boolean;
  free_estimates: boolean;
  guarantee: string | null;
  awards: string[];
};

export type ListField = "service_areas" | "landmarks" | "services" | "certifications" | "awards";

/** Mirrors 0067's checks. */
export const DETAIL_LIMITS: Record<ListField, { items: number; len: number }> & { guarantee: number } = {
  service_areas: { items: 20, len: 60 },
  landmarks: { items: 10, len: 80 },
  services: { items: 30, len: 80 },
  certifications: { items: 10, len: 80 },
  awards: { items: 10, len: 100 },
  guarantee: 120,
};

export const YEAR_MIN = 1800;

export function emptyDetails(): LocationDetails {
  return {
    service_areas: [],
    landmarks: [],
    services: [],
    year_founded: null,
    licensed: false,
    insured: false,
    bonded: false,
    certifications: [],
    family_owned: false,
    locally_owned: false,
    free_estimates: false,
    guarantee: null,
    awards: [],
  };
}

const URLISH = /https?:\/\/|www\.|\.(com|net|org|io|co|biz|us)\b/i;

/**
 * A California Department of Cannabis Control licence number, e.g.
 * C10-0000123-LIC (C9 delivery, C10 retail, C11 distribution, C12
 * microbusiness, C13 distribution transport; -LIC annual, -TMP temporary).
 * California requires it on a licensee's website, so module 30 reads it from
 * each store page. Its digits aren't a phone number.
 */
export const DCC_LICENCE = /\bC(?:9|1[0-3])-\d{7}-(?:LIC|TMP)\b/gi;

/** One short, single-line, plain item, or null when it can't be one. */
export function cleanItem(raw: string, maxLen: number): string | null {
  let s = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    s += code < 32 || code === 127 ? " " : ch;
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > maxLen) return null;
  if (URLISH.test(s) || /[<>{}]/.test(s)) return null;
  // Phone-number shaped, not counting a cannabis licence number's digits.
  if ((s.replace(DCC_LICENCE, "").match(/\d/g) ?? []).length >= 7) return null;
  return s;
}

/** A textarea (one item per line) to a clean, de-duplicated, capped list. */
export function cleanList(raw: string, field: ListField): { items: string[]; dropped: number } {
  const lim = DETAIL_LIMITS[field];
  const items: string[] = [];
  let dropped = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = cleanItem(line, lim.len);
    if (!c || items.some((x) => x.toLowerCase() === c.toLowerCase())) {
      dropped++;
      continue;
    }
    if (items.length >= lim.items) {
      dropped++;
      continue;
    }
    items.push(c);
  }
  return { items, dropped };
}

export function cleanYear(raw: string, now = new Date()): number | null {
  const n = Number(raw.trim());
  if (!raw.trim() || !Number.isInteger(n)) return null;
  return n >= YEAR_MIN && n <= now.getUTCFullYear() ? n : null;
}

/** Intake items an article actually used (case-insensitive), for the reviewer. */
export function detailsUsed(d: LocationDetails | null | undefined, text: string): string[] {
  if (!d) return [];
  const t = text.toLowerCase();
  return [...d.service_areas, ...d.landmarks, ...d.services].filter((x) => t.includes(x.toLowerCase()));
}
