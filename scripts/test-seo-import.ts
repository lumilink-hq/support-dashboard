// =============================================================================
// test-seo-import.ts — unit tests for module 27's export parser
// (lib/seo-import.ts): Semrush and Ahrefs keyword and competitor exports,
// encodings, delimiters and the default selection.
//
//   npx tsx scripts/test-seo-import.ts
//
// No network, no database.
// =============================================================================

import { cleanDomain, cleanKeyword } from "../lib/seo-portal";
import { decodeExport, defaultSelection, detectDelimiter, parseDelimited, parseExport, parseNumber } from "../lib/seo-import";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${got === undefined ? "" : `  (got: ${JSON.stringify(got)})`}`);
  }
}

const utf16le = (s: string, bom = true) => {
  const body = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    body[i * 2] = s.charCodeAt(i) & 0xff;
    body[i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  return bom ? new Uint8Array([0xff, 0xfe, ...body]) : body;
};

// Semrush Organic Research > Positions export (UTF-8 CSV).
const SEMRUSH_POSITIONS = [
  "Keyword,Position,Previous position,Search Volume,Keyword Difficulty,CPC,URL,Traffic,Traffic (%),Traffic Cost,Competition,Number of Results,Trends,Timestamp,SERP Features by Keyword,Keyword Intents,Position Type",
  'emergency plumber springfield,4,6,880,34,21.37,https://acme.com/emergency,52,10.5,1111,0.41,1200000,"[0.6,0.7,1.0]",2026-09-30,"Local pack, Reviews",transactional,Organic',
  'water heater repair,12,15,"1,300",52,9.10,https://acme.com/heaters,8,1.6,73,0.3,900000,"[0.4]",2026-09-30,,commercial,Organic',
  "Emergency  Plumber Springfield,5,4,880,34,21.37,https://acme.com/,1,0.1,21,0.4,1,,2026-09-30,,,Organic",
  ",3,3,10,1,1,https://acme.com/x,0,0,0,0,0,,2026-09-30,,,Organic",
].join("\n");

// Semrush Position Tracking export: report lines above the table, positions
// in a "<domain>_<date>" column.
const SEMRUSH_TRACKING = [
  "Position Tracking - acme.com",
  "Database: US",
  "",
  "Keyword,Tags,acme.com_20260930,acme.com_20260901,Search Volume,CPC",
  "drain cleaning,,7,9,1600,8.5",
  "plumber near me,,-,-,45000,15",
].join("\n");

const SEMRUSH_COMPETITORS = [
  "Domain,Competitor Relevance,Common Keywords,Organic Keywords,Organic Traffic,Organic Cost,Adwords Keywords",
  "rotorooter.com,0.42,180,52000,410000,3200000,1200",
  "www.mrrooter.com,0.31,120,31000,200000,1500000,800",
].join("\n");

// Ahrefs Site Explorer > Organic keywords, "Excel" export: UTF-16 LE, tabs.
const AHREFS_KEYWORDS = [
  "Keyword\tCountry\tLocation\tEntities\tSERP features\tVolume\tKD\tCPC\tOrganic traffic\tCurrent position\tCurrent URL",
  "sump pump repair\tUS\t\t\tLocal pack\t2.1K\t28\t6.4\t40\t9\thttps://acme.com/sump",
  "tankless water heater cost\tUS\t\t\t\t1300\t45\t3.1\t12\t14\thttps://acme.com/tankless",
].join("\r\n");

const AHREFS_COMPETITORS_CSV = ["Competitor,Common keywords,Share,Competitor's keywords,Keywords,Traffic", "rival.com,320,12%,5000,4800,9000"].join("\n");

console.log("\ndecoding");
{
  ok("UTF-16 LE with BOM", decodeExport(utf16le("Keyword\tVolume")) === "Keyword\tVolume");
  ok("UTF-16 LE without BOM (Ahrefs Excel)", decodeExport(utf16le("Keyword\tVolume\nabc\t1", false)) === "Keyword\tVolume\nabc\t1");
  ok("UTF-8 BOM stripped", decodeExport(new Uint8Array([0xef, 0xbb, 0xbf, 0x4b, 0x65, 0x79])) === "Key");
  ok("plain UTF-8, accents kept", decodeExport(new TextEncoder().encode("Keyword\ncafé near me")) === "Keyword\ncafé near me");
}

console.log("\ndelimiters and quoting");
{
  ok("comma", detectDelimiter(SEMRUSH_POSITIONS) === ",");
  ok("tab", detectDelimiter(AHREFS_KEYWORDS) === "\t");
  ok("semicolon", detectDelimiter("Keyword;Volume\na;1\nb;2") === ";");
  const rows = parseDelimited('a,"b, c","say ""hi""","multi\nline",e', ",");
  ok("quoted commas, escaped quotes and a cell over two lines", rows.length === 1 && rows[0][1] === "b, c" && rows[0][2] === 'say "hi"' && rows[0][3] === "multi\nline", rows);
}

console.log("\nnumbers");
{
  ok("plain, thousands, K, M", parseNumber("880") === 880 && parseNumber("1,300") === 1300 && parseNumber("2.1K") === 2100 && parseNumber("1.5M") === 1_500_000);
  ok("percent, comparisons, dashes, blanks", parseNumber("12%") === 12 && parseNumber("> 100") === 100 && parseNumber("-") === null && parseNumber("") === null && parseNumber(undefined) === null);
  ok("text is null", parseNumber("Local pack") === null);
}

console.log("\nSemrush");
{
  const p = parseExport(SEMRUSH_POSITIONS);
  ok("positions export read as keywords from Semrush", p.ok && p.kind === "keywords" && p.source === "semrush", p);
  if (p.ok) {
    ok("duplicates (case/spacing) and blank keywords skipped", p.rows.length === 2 && p.skipped === 2, p.rows.map((r) => r.value));
    ok("volume, position and difficulty read by column name", p.rows[0].volume === 880 && p.rows[0].position === 4 && p.rows[0].difficulty === 34 && p.rows[1].volume === 1300);
    ok("a quoted multi-value cell doesn't shift columns", p.rows[1].difficulty === 52);
  }
  const t = parseExport(SEMRUSH_TRACKING);
  ok("position tracking: header found below report lines", t.ok && t.kind === "keywords" && t.rows.length === 2, t);
  if (t.ok) ok("position read from the <domain>_<date> column; '-' is no position", t.rows[0].position === 7 && t.rows[1].position === null && t.rows[1].volume === 45000, t.rows);
  const c = parseExport(SEMRUSH_COMPETITORS);
  ok("competitors export read as competitors", c.ok && c.kind === "competitors" && c.source === "semrush" && c.ok && c.rows[1].value === "www.mrrooter.com", c);
}

console.log("\nAhrefs");
{
  const k = parseExport(decodeExport(utf16le(AHREFS_KEYWORDS)));
  ok("UTF-16 tab export read as keywords from Ahrefs", k.ok && k.kind === "keywords" && k.source === "ahrefs", k);
  if (k.ok) ok("Volume (2.1K), KD and Current position", k.rows[0].volume === 2100 && k.rows[0].difficulty === 28 && k.rows[0].position === 9, k.rows[0]);
  const c = parseExport(AHREFS_COMPETITORS_CSV);
  ok("competitors CSV with a 'Competitor' column", c.ok && c.kind === "competitors" && c.ok && c.rows[0].value === "rival.com", c);
}

console.log("\nbad files");
{
  const e = parseExport("");
  ok("empty", !e.ok && /empty/.test(e.reason));
  const n = parseExport("Name,Email\nA,a@b.c");
  ok("no keyword or domain column", !n.ok && /Keyword or Domain/.test(n.reason));
  const h = parseExport("Keyword,Volume\n");
  ok("header only", !h.ok && /no rows/.test(h.reason));
}

console.log("\ndefaultSelection");
{
  const p = parseExport(["Keyword,Volume", "a b,10", "already tracked,9999", "c d,500", "e f,", "x,100000"].join("\n"));
  if (p.ok) {
    const sel = defaultSelection(p.rows, new Set(["already tracked"]), 2, (s) => {
      const c = cleanKeyword(s);
      return c.length >= 2 && c.length <= 80 ? c : null;
    });
    ok("skips tracked and invalid, highest volume first, up to the room left", JSON.stringify(sel.map((i) => p.rows[i].value)) === '["c d","a b"]', sel.map((i) => p.rows[i].value));
    ok("no room → nothing", defaultSelection(p.rows, new Set(), 0, (s) => s).length === 0);
  }
  const c = parseExport(SEMRUSH_COMPETITORS);
  if (c.ok) {
    const sel = defaultSelection(c.rows, new Set(["rotorooter.com"]), 5, cleanDomain);
    ok("competitors: www.mrrooter.com cleans to mrrooter.com; tracked one skipped", sel.length === 1 && cleanDomain(c.rows[sel[0]].value) === "mrrooter.com");
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
