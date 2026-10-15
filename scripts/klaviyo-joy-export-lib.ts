// =============================================================================
// klaviyo-joy-export-lib.ts — pure helpers for scripts/klaviyo-joy-export.ts:
// a Klaviyo profile (with Joy's synced properties) to a row, and rows to the
// CSV that scripts/joy-import.ts reads. No network; tested by
// scripts/test-klaviyo-joy-export.ts.
//
// Joy syncs these onto each member's Klaviyo profile (plan §4):
//   "Joy Loyalty Points", "Joy Vip tier", "Birthday" / "dateOfBirth" (MM/DD/YYYY)
// =============================================================================

export const HEADER = ["Email", "First Name", "Last Name", "Joy Loyalty Points", "Joy Vip tier", "Birthday"];

export type Profile = {
  id?: string;
  attributes?: {
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    properties?: Record<string, unknown> | null;
  };
};

export type Row = { email: string; first: string; last: string; points: string; tier: string; birthday: string };

const str = (v: unknown) => (v == null ? "" : String(v).trim());

/** A row, or a reason it can't be one. */
export function rowFromProfile(p: Profile): { row: Row } | { skip: string } {
  const a = p.attributes ?? {};
  const props = a.properties ?? {};
  const email = str(a.email).toLowerCase();
  if (!email) return { skip: "no email" };
  const points = str(props["Joy Loyalty Points"]);
  if (points === "") return { skip: "no Joy Loyalty Points" };
  return {
    row: {
      email,
      first: str(a.first_name),
      last: str(a.last_name),
      points,
      tier: str(props["Joy Vip tier"]),
      birthday: str(props["Birthday"]) || str(props["dateOfBirth"]),
    },
  };
}

function cell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(rows: Row[]): string {
  const lines = [HEADER.join(",")];
  for (const r of rows) lines.push([r.email, r.first, r.last, r.points, r.tier, r.birthday].map(cell).join(","));
  return lines.join("\n") + "\n";
}

/**
 * One row per email. A profile in two tier segments (shouldn't happen) keeps
 * the first seen and is counted, so the summary shows it.
 */
export function dedupe(rows: Row[]): { rows: Row[]; duplicates: number } {
  const seen = new Set<string>();
  const out: Row[] = [];
  let duplicates = 0;
  for (const r of rows) {
    if (seen.has(r.email)) { duplicates++; continue; }
    seen.add(r.email);
    out.push(r);
  }
  return { rows: out, duplicates };
}
