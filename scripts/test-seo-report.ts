// =============================================================================
// test-seo-report.ts — unit tests for the seo-report pure helpers (module 13).
//
//   npx tsx scripts/test-seo-report.ts
//
// No network, no Deno, no database. (pdf.ts needs Deno's npm: import; it is
// exercised end to end by serving the function locally, see plan.md §8B.)
// =============================================================================

import {
  dayAfter,
  describeRadius,
  keywordRanks,
  movement,
  periodFromDate,
  positionText,
  previousMonth,
  profileMetrics,
  queuedItems,
  safeUrl,
  shippedItems,
  summarise,
  trendData,
  type ActionRow,
} from "../supabase/functions/seo-report/lib.ts";

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

console.log("\nperiods");
{
  const p = previousMonth(new Date("2026-09-01T00:30:00Z"));
  ok("the 1st reports the month just ended", p.start === "2026-08-01" && p.end === "2026-08-31" && p.label === "August 2026", p);
  const jan = previousMonth(new Date("2026-01-01T00:00:00Z"));
  ok("January rolls to December of last year", jan.start === "2025-12-01" && jan.end === "2025-12-31", jan);
  ok("leap February", previousMonth(new Date("2028-03-01T00:00:00Z")).end === "2028-02-29");
  ok("periodFromDate finds the month", periodFromDate("2026-08-14")?.start === "2026-08-01");
  ok("periodFromDate rejects junk", periodFromDate("August") === null && periodFromDate("2026-13-01") === null);
  ok("dayAfter crosses a month end", dayAfter("2026-08-31") === "2026-09-01");
}

console.log("\nkeywordRanks");
{
  const period = periodFromDate("2026-08-01")!;
  const kws = [{ id: "k1", keyword: "plumber" }, { id: "k2", keyword: "drain" }];
  const rows = [
    { keyword_id: "k1", rank_type: "organic" as const, position: 9, check_date: "2026-07-27" },
    { keyword_id: "k1", rank_type: "organic" as const, position: 6, check_date: "2026-08-10" },
    { keyword_id: "k1", rank_type: "organic" as const, position: 4, check_date: "2026-08-24" },
    { keyword_id: "k1", rank_type: "organic" as const, position: 1, check_date: "2026-09-02" }, // after the period: ignored
    { keyword_id: "k2", rank_type: "organic" as const, position: null, check_date: "2026-08-10" },
  ];
  const r = keywordRanks(kws, rows, period);
  const plumber = r.find((k) => k.keyword === "plumber")!;
  const drain = r.find((k) => k.keyword === "drain")!;
  ok("now is the latest check inside the month", plumber.organic.now === 4, plumber);
  ok("before is the latest check before the month", plumber.organic.before === 9, plumber);
  ok("a check after the month is ignored", plumber.organic.now !== 1);
  ok("looked-but-not-found is checked with a null position", drain.organic.checked && drain.organic.now === null, drain);
  ok("no local-pack rows means never checked", !plumber.local_pack.checked, plumber.local_pack);
  ok("sorted by keyword", r[0].keyword === "drain");

  const s = summarise(r.map((k) => k.organic));
  ok("summary counts checked/ranked/top3/top10", s.checked === 2 && s.ranked === 1 && s.top3 === 0 && s.top10 === 1, s);
  ok("average ignores not-found", s.avg_position === 4, s);
  ok("empty summary has a null average, not 0", summarise([]).avg_position === null);
}

console.log("\nmovement and text");
{
  ok("up", movement(2, 5) === "up 3");
  ok("down", movement(8, 3) === "down 5");
  ok("no change", movement(3, 3) === "no change");
  ok("new (no earlier check)", movement(3, null) === "new");
  ok("dropped out", movement(null, 3) === "dropped out");
  ok("nothing to say when neither exists", movement(null, null) === "");
  ok("positionText distinguishes not found from not checked",
    positionText({ now: null, checked: true }) === "not found" && positionText({ now: null, checked: false }) === "not checked");
}

console.log("\ndescribeRadius");
{
  const at = { lat: 40.1, lng: -75.2 };
  const noCoords = describeRadius({ lat: null, lng: null }, 3, null);
  ok("no coordinates says so plainly", noCoords.state === "no_coordinates" && noCoords.km === null && /coordinates/.test(noCoords.statement), noCoords);
  ok("no geo keyword says so plainly", describeRadius(at, 0, null).state === "no_geo_keywords");
  ok("no sweep yet says so plainly", describeRadius(at, 2, null).state === "not_swept_yet");
  const row = (km: number | null) => ({ keywords_checked: 3, last_check_date: "2026-08-24", winnable_radius_km: km, grid_spacing_km: 2 });
  const two = describeRadius(at, 3, row(2));
  ok("measured 2 km", two.state === "measured" && two.km === 2 && /within about 2 km/.test(two.statement), two);
  ok("the whole grid is called out", /whole area/.test(describeRadius(at, 3, row(4)).statement));
  ok("0 km wins at the address only", /own address but not beyond/.test(describeRadius(at, 3, row(0)).statement));
  const none = describeRadius(at, 3, row(null));
  ok("null radius is 'not even at the address', not zero", none.km === null && /isn't reliably/.test(none.statement), none);
  ok("states its basis", /3 keywords/.test(two.statement) && /2026-08-24/.test(two.statement));
}

console.log("\nshipped and queued");
{
  const period = periodFromDate("2026-08-01")!;
  const base: ActionRow = {
    id: "a", action_type: "onpage_fix", target_field: "title_tag", target_url: "https://x.com/a", status: "published",
    apply_mode: "api", publish_result: { verified: true }, proposed_value: null, published_at: "2026-08-15T10:00:00Z", created_at: "2026-08-10T00:00:00Z",
  };
  const rows: ActionRow[] = [
    base,
    { ...base, id: "b", apply_mode: "manual", publish_result: { verified: false } },
    { ...base, id: "c", published_at: "2026-09-01T00:00:00Z" },
    { ...base, id: "d", published_at: "2026-07-31T23:59:59Z" },
    { ...base, id: "e", status: "rolled_back" },
    { ...base, id: "f", target_url: "javascript:alert(1)", action_type: "content_publish", target_field: "article", proposed_value: { title: "Post" }, published_at: "2026-08-31T23:00:00Z" },
  ];
  const s = shippedItems(rows, period);
  ok("only published items inside the month", s.length === 3, s.map((x) => x.published_at));
  ok("API-applied and confirmed is verified", s[0].verified === true, s[0]);
  ok("a manual apply is only a claim", s[1].verified === false, s[1]);
  ok("an unsafe URL is dropped", s[2].url === null, s[2]);
  ok("an article carries its title", s[2].detail === "Post" && s[2].label === "Blog article", s[2]);
  ok("the last day of the month is inside", s.some((x) => x.published_at.startsWith("2026-08-31")));
  ok("safeUrl", safeUrl("https://a.com") === "https://a.com" && safeUrl("ftp://a") === null && safeUrl(null) === null);

  const q = queuedItems([
    { ...base, id: "q1", status: "pending_approval", created_at: "2026-08-02T00:00:00Z" },
    { ...base, id: "q2", status: "manual_required", created_at: "2026-08-01T00:00:00Z" },
    { ...base, id: "q3", status: "approved" },
  ]);
  ok("queued = pending approval + manual, oldest first", q.length === 2 && q[0].needs === "you_to_apply" && q[1].needs === "approval", q);
}

console.log("\nprofileMetrics");
{
  const none = profileMetrics([]);
  ok("no rows is 'not available', never zeros", !none.available, none);
  const m = profileMetrics([{ metrics: { calls: 2, views_maps: 10 } }, { metrics: { calls: 3, junk: "x" } }]);
  ok("sums numeric metrics across days", m.available && m.totals.calls === 5 && m.totals.views_maps === 10 && !("junk" in m.totals), m);
}

console.log("\ntrendData");
{
  const t = trendData([
    { rank_type: "organic", check_date: "2026-08-10", avg_position: "6.5" },
    { rank_type: "organic", check_date: "2026-08-03", avg_position: 9 },
    { rank_type: "local_pack", check_date: "2026-08-03", avg_position: null },
    { rank_type: "geo_grid", check_date: "2026-08-03", avg_position: 3 },
  ]);
  ok("sorted oldest first, numeric strings become numbers", t.organic.length === 2 && t.organic[0].x === "2026-08-03" && t.organic[1].y === 6.5, t.organic);
  ok("null stays null, other rank types are ignored", t.local_pack.length === 1 && t.local_pack[0].y === null, t);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
