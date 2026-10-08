// =============================================================================
// seo-detail-suggestions.ts — the dashboard's half of module 30: labels for
// suggested location details, and folding the ticked ones into what a person
// saves on /seo → Map & locations → About this location. The suggestions
// themselves come from supabase/functions/seo-detail-suggestions.
// =============================================================================

import { type ListField } from "@/supabase/functions/seo-content/details";

export type DetailSuggestion = {
  id: string;
  field: string;
  value: string;
  quote: string;
  source_url: string;
  method: "pattern" | "structured" | "model";
};

export const SUGGESTION_FIELD_LABELS: Record<string, string> = {
  service_areas: "Area you serve",
  landmarks: "Nearby landmark",
  services: "Service",
  certifications: "Certification",
  awards: "Award",
  year_founded: "Year founded",
  licensed: "Licensed",
  insured: "Insured",
  bonded: "Bonded",
  family_owned: "Family-owned",
  locally_owned: "Locally owned",
  free_estimates: "Free estimates",
  guarantee: "Guarantee",
};

const LISTS: ListField[] = ["service_areas", "landmarks", "services", "certifications", "awards"];
const FLAGS = ["licensed", "insured", "bonded", "family_owned", "locally_owned", "free_estimates"] as const;

/** What a suggestion reads as in the form: "Service: Pre-rolls", "Licensed". */
export function suggestionLabel(s: Pick<DetailSuggestion, "field" | "value">): string {
  const label = SUGGESTION_FIELD_LABELS[s.field] ?? s.field;
  return (FLAGS as readonly string[]).includes(s.field) ? label : `${label}: ${s.value}`;
}

/** The form as typed: one line per list item, the boxes, the year, the guarantee. */
export type DetailsForm = {
  lists: Record<ListField, string>;
  flags: Record<(typeof FLAGS)[number], boolean>;
  year: string;
  guarantee: string;
};

/**
 * The form with the ticked suggestions folded in: list items appended as new
 * lines (the usual cleaning then de-duplicates and caps them), boxes ticked, a
 * year or guarantee filled only where the person left it blank. What they
 * typed always wins.
 */
export function applyAccepted(form: DetailsForm, accepted: Pick<DetailSuggestion, "field" | "value">[]): DetailsForm {
  const out: DetailsForm = { lists: { ...form.lists }, flags: { ...form.flags }, year: form.year, guarantee: form.guarantee };
  for (const s of accepted) {
    if ((LISTS as string[]).includes(s.field)) {
      const f = s.field as ListField;
      out.lists[f] = out.lists[f].trim() ? `${out.lists[f]}\n${s.value}` : s.value;
    } else if ((FLAGS as readonly string[]).includes(s.field)) {
      out.flags[s.field as (typeof FLAGS)[number]] = true;
    } else if (s.field === "year_founded" && !out.year.trim()) {
      out.year = s.value;
    } else if (s.field === "guarantee" && !out.guarantee.trim()) {
      out.guarantee = s.value;
    }
  }
  return out;
}

export const DETAIL_FLAGS = FLAGS;
export const DETAIL_LISTS = LISTS;
