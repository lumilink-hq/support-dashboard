// =============================================================================
// joy-import-lib.ts — pure parsing for scripts/joy-import.ts (0207): CSV in,
// normalized rows out. No network, no database; scripts/test-joy-import.ts
// tests it.
//
// Joy's export columns aren't documented, so headers are matched by alias
// (case, spaces and punctuation ignored). Required: a points column, and per
// row a Shopify customer id or an email. Anything unmapped is ignored and
// listed, so a surprise column is visible in the dry run.
// =============================================================================

export type JoyRow = {
  row_no: number;
  shopify_customer_id: number | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  points: number;
  tier_name: string | null;
  birthday: string | null; // YYYY-MM-DD
  joined_at: string | null; // ISO
  last_activity_at: string | null; // ISO
};

export type Field = Exclude<keyof JoyRow, "row_no"> | "full_name";

const ALIASES: Record<Field, string[]> = {
  shopify_customer_id: ["shopifycustomerid", "customerid", "shopifyid", "shopifycustomer", "customershopifyid"],
  email: ["email", "emailaddress", "customeremail"],
  first_name: ["firstname", "first"],
  last_name: ["lastname", "last", "surname"],
  full_name: ["name", "fullname", "customername", "customer"],
  points: ["points", "pointbalance", "pointsbalance", "balance", "availablepoints", "currentpoints", "pointsavailable", "totalpoints"],
  tier_name: ["tier", "viptier", "tiername", "vip", "viplevel", "level"],
  birthday: ["birthday", "dateofbirth", "dob", "birthdate"],
  joined_at: ["joinedat", "joined", "joindate", "datejoined", "createdat", "signupdate", "membersince", "enrolledat"],
  last_activity_at: ["lastactivity", "lastactivityat", "lastactive", "lastactivitydate", "pointsupdatedat", "lastearned", "lastearnedat"],
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** RFC 4180-ish: quoted fields, "" escapes, commas and newlines inside quotes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export type Mapping = { columns: Partial<Record<Field, number>>; unmapped: string[] };

export function mapHeaders(header: string[]): Mapping {
  const columns: Partial<Record<Field, number>> = {};
  const unmapped: string[] = [];
  header.forEach((h, i) => {
    const n = norm(h);
    const field = (Object.keys(ALIASES) as Field[]).find((f) => ALIASES[f].includes(n));
    if (field && columns[field] === undefined) columns[field] = i;
    else unmapped.push(h);
  });
  return { columns, unmapped };
}

/** "1,234" -> 1234; null if not a whole number. */
export function parsePoints(v: string | undefined): number | null {
  const s = String(v ?? "").trim().replace(/,/g, "");
  return /^-?\d+$/.test(s) ? Number(s) : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const validYmd = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/**
 * A birthday as YYYY-MM-DD. Accepts YYYY-MM-DD, MM/DD/YYYY and MM/DD (no
 * year -> 1904, a leap year, so Feb 29 survives; only month/day matter for
 * the birthday job).
 */
export function parseBirthday(v: string | undefined): string | null {
  const s = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m && validYmd(+m[1], +m[2], +m[3])) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m && validYmd(+m[3], +m[1], +m[2])) return `${m[3]}-${pad(+m[1])}-${pad(+m[2])}`;
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m && validYmd(1904, +m[1], +m[2])) return `1904-${pad(+m[1])}-${pad(+m[2])}`;
  return null;
}

/** A timestamp as ISO. ISO strings pass through; MM/DD/YYYY [HH:mm] is read as UTC. */
export function parseTimestamp(v: string | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (us) {
    if (!validYmd(+us[3], +us[1], +us[2])) return null;
    return new Date(Date.UTC(+us[3], +us[1] - 1, +us[2], +(us[4] ?? 0), +(us[5] ?? 0), +(us[6] ?? 0))).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export type Problem = { row_no: number; message: string };
export type Parsed = { rows: JoyRow[]; problems: Problem[]; mapping: Mapping; header: string[] };

export function parseJoyExport(text: string): Parsed {
  const table = parseCsv(text);
  if (table.length === 0) throw new Error("the file is empty");
  const header = table[0];
  const mapping = mapHeaders(header);
  const c = mapping.columns;
  if (c.points === undefined) throw new Error(`no points column (headers: ${header.join(", ")})`);
  if (c.shopify_customer_id === undefined && c.email === undefined) {
    throw new Error(`no customer id or email column (headers: ${header.join(", ")})`);
  }

  const rows: JoyRow[] = [];
  const problems: Problem[] = [];
  const seen = new Set<string>();
  table.slice(1).forEach((cells, i) => {
    const row_no = i + 2; // spreadsheet row number (header is row 1)
    const get = (f: Field) => (c[f] === undefined ? undefined : (cells[c[f]!] ?? "").trim());
    const idRaw = get("shopify_customer_id") ?? "";
    const id = idRaw ? Number(idRaw.replace(/^gid:\/\/shopify\/Customer\//, "")) : null;
    const email = (get("email") || "").toLowerCase() || null;
    const points = parsePoints(get("points"));
    if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) return problems.push({ row_no, message: `bad customer id "${idRaw}"` });
    if (id === null && !email) return problems.push({ row_no, message: "no customer id or email" });
    if (points === null) return problems.push({ row_no, message: `points "${get("points")}" isn't a whole number` });
    if (points < 0) return problems.push({ row_no, message: `negative points (${points})` });
    const key = id !== null ? `id:${id}` : `email:${email}`;
    if (seen.has(key)) return problems.push({ row_no, message: `duplicate ${key}` });
    seen.add(key);

    let first = get("first_name") || null;
    let last = get("last_name") || null;
    const full = get("full_name");
    if (!first && !last && full) [first, last] = [full.split(/\s+/)[0] || null, full.split(/\s+/).slice(1).join(" ") || null];
    const bdayRaw = get("birthday");
    const birthday = parseBirthday(bdayRaw);
    if (bdayRaw && !birthday) problems.push({ row_no, message: `birthday "${bdayRaw}" not understood (row kept, birthday skipped)` });

    rows.push({
      row_no,
      shopify_customer_id: id,
      email,
      first_name: first,
      last_name: last,
      points,
      tier_name: get("tier_name") || null,
      birthday,
      joined_at: parseTimestamp(get("joined_at")),
      last_activity_at: parseTimestamp(get("last_activity_at")),
    });
  });
  return { rows, problems, mapping, header };
}

/** For terminal output: a@example.com -> a***@example.com */
export function maskEmail(email: string | null): string {
  if (!email) return "—";
  const [user, domain] = email.split("@");
  return `${user.slice(0, 1)}***@${domain ?? ""}`;
}
