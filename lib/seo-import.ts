// =============================================================================
// seo-import.ts — module 27 (plan.md, Phase 6c): read a Semrush or Ahrefs
// export in the browser and turn it into keywords or competitor domains to
// track. Pure: no DOM, no network, unit-tested in scripts/test-seo-import.ts.
//
// The file never leaves the browser. Only the phrases or domains the person
// ticks are sent to the server action, which cleans and caps them again
// (lib/seo-portal.ts cleanKeyword / cleanDomain, the per-location caps).
//
// FORMATS (from the tools' export layouts; column names vary a little by
// report and version, so columns are matched by name, not position):
//   Semrush  — comma CSV, UTF-8, sometimes with report lines above the header
//              (Position Tracking). Organic Research "Positions": Keyword,
//              Position, Search Volume, Keyword Difficulty, CPC, URL, ...
//              Organic Research "Competitors": Domain, Competitor Relevance,
//              Common Keywords, ...
//   Ahrefs   — "Excel" exports are UTF-16 LE, tab-separated; "CSV" exports
//              are UTF-8 commas. Organic keywords: Keyword, Volume, KD, CPC,
//              Current position, Current URL, ... Organic competitors:
//              Domain (or Competitor), Common keywords, ...
// Anything else with a recognisable keyword or domain column also works.
// =============================================================================

export type ImportKind = "keywords" | "competitors";
export type ImportSource = "semrush" | "ahrefs" | "unknown";

export type ImportRow = {
  value: string; // the keyword or domain as written in the file
  volume: number | null;
  position: number | null;
  difficulty: number | null;
};

export type ParsedImport =
  | { ok: true; kind: ImportKind; source: ImportSource; rows: ImportRow[]; skipped: number }
  | { ok: false; reason: string };

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 5000;

/** Bytes to text: UTF-16 LE/BE (with BOM, or without one when every other
 * byte is zero, as Ahrefs' Excel exports are), else UTF-8, BOM stripped. */
export function decodeExport(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const sample = bytes.subarray(0, Math.min(bytes.length, 200));
  let zeroOdd = 0;
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeroOdd++;
  if (sample.length >= 4 && zeroOdd >= sample.length / 2 - 1) return new TextDecoder("utf-16le").decode(bytes);
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The delimiter that splits the most lines into the same number of cells. */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  let best = ",";
  let bestScore = -1;
  for (const d of [",", "\t", ";"]) {
    const counts = lines.map((l) => splitLine(l, d).length);
    const common = mode(counts);
    const score = common > 1 ? counts.filter((c) => c === common).length * common : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function mode(xs: number[]): number {
  const m = new Map<number, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  let best = 0;
  let n = -1;
  for (const [k, v] of m) if (v > n || (v === n && k > best)) [best, n] = [k, v];
  return best;
}

/** One line, quotes honoured ("a, b" stays one cell; "" is a quote). */
function splitLine(line: string, d: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Whole text to rows. A quoted cell may span lines. */
export function parseDelimited(text: string, d: string): string[][] {
  const rows: string[][] = [];
  let buf = "";
  let quotes = 0;
  for (const line of text.split(/\r?\n/)) {
    buf = buf ? `${buf}\n${line}` : line;
    quotes += (line.match(/"/g) ?? []).length;
    if (quotes % 2 === 0) {
      if (buf.trim()) rows.push(splitLine(buf, d));
      buf = "";
      quotes = 0;
    }
  }
  if (buf.trim()) rows.push(splitLine(buf, d));
  return rows;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Not "keywords": in competitor reports that column is a count, not a phrase.
const KEYWORD_COLS = ["keyword", "query", "search term"];
const DOMAIN_COLS = ["domain", "competitor", "competitor domain", "competitors", "target", "website"];
const VOLUME_COLS = ["search volume", "volume", "avg monthly searches", "sv"];
const POSITION_COLS = ["position", "current position", "pos", "rank", "ranking"];
const DIFFICULTY_COLS = ["keyword difficulty", "kd", "kd %", "difficulty"];

function findCol(headers: string[], names: string[]): number {
  const h = headers.map(norm);
  for (const n of names) {
    const i = h.indexOf(norm(n));
    if (i >= 0) return i;
  }
  return -1;
}

/** "1,300" / "1.3K" / "2.1M" / "12%" / "> 100" / "-" → a number or null. */
export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.replace(/[\s%]/g, "").replace(/^[<>]=?/, "");
  if (!s || s === "-" || s.toLowerCase() === "n/a") return null;
  const m = /^(-?\d+(?:[.,]\d+)*)([kKmM])?$/.exec(s);
  if (!m) return null;
  let n = Number(m[2] ? m[1].replace(",", ".") : m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (m[2]) n *= /k/i.test(m[2]) ? 1_000 : 1_000_000;
  return Math.round(n);
}

function guessSource(headers: string[]): ImportSource {
  const h = new Set(headers.map(norm));
  if (h.has("kd") || h.has("current position") || h.has("current url") || (h.has("organic traffic") && h.has("volume"))) return "ahrefs";
  if (h.has("search volume") || h.has("keyword difficulty") || h.has("competitor relevance") || h.has("previous position")) return "semrush";
  return "unknown";
}

/**
 * Text of an export → the keywords or competitor domains in it. The header
 * is the first line (within the first 15) that has a keyword or domain
 * column; report lines above it are skipped. A file with both columns is a
 * keyword export (the domain column is then the ranking URL's site). Rows
 * without a value are counted as skipped; duplicates (case and spacing
 * ignored) keep the first.
 */
export function parseExport(text: string): ParsedImport {
  if (!text.trim()) return { ok: false, reason: "The file is empty." };
  const d = detectDelimiter(text);
  const rows = parseDelimited(text, d).slice(0, MAX_ROWS + 15);
  let headerIdx = -1;
  let kind: ImportKind | null = null;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    if (findCol(rows[i], KEYWORD_COLS) >= 0) {
      headerIdx = i;
      kind = "keywords";
      break;
    }
    if (findCol(rows[i], DOMAIN_COLS) >= 0) {
      headerIdx = i;
      kind = "competitors";
      break;
    }
  }
  if (headerIdx < 0 || !kind) {
    return { ok: false, reason: "Couldn't find a Keyword or Domain column. Export keywords or competitors from Semrush or Ahrefs as CSV and try again." };
  }
  const headers = rows[headerIdx];
  const valueCol = kind === "keywords" ? findCol(headers, KEYWORD_COLS) : findCol(headers, DOMAIN_COLS);
  const volCol = findCol(headers, VOLUME_COLS);
  let posCol = findCol(headers, POSITION_COLS);
  if (posCol < 0 && kind === "keywords") posCol = headers.findIndex((h) => /_\d{8}$/.test(h.trim())); // Semrush Position Tracking
  const kdCol = findCol(headers, DIFFICULTY_COLS);

  const out: ImportRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const r of rows.slice(headerIdx + 1)) {
    if (out.length >= MAX_ROWS) break;
    const value = (r[valueCol] ?? "").replace(/\s+/g, " ").trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    out.push({
      value,
      volume: volCol >= 0 ? parseNumber(r[volCol]) : null,
      position: posCol >= 0 ? parseNumber(r[posCol]) : null,
      difficulty: kdCol >= 0 ? parseNumber(r[kdCol]) : null,
    });
  }
  if (out.length === 0) return { ok: false, reason: "The file has the right columns but no rows." };
  return { ok: true, kind, source: guessSource(headers), rows: out, skipped };
}

/**
 * Which rows to tick by default: not already tracked (`tracked` holds
 * cleaned values), highest volume first (file order when there's no volume),
 * up to the room left under the cap. Returns their indexes in `rows`.
 */
export function defaultSelection(rows: ImportRow[], tracked: Set<string>, room: number, clean: (s: string) => string | null): number[] {
  if (room <= 0) return [];
  return rows
    .map((r, i) => ({ i, c: clean(r.value), v: r.volume ?? -1 }))
    .filter((x) => x.c !== null && !tracked.has(x.c))
    .sort((a, b) => b.v - a.v || a.i - b.i)
    .slice(0, room)
    .map((x) => x.i);
}
