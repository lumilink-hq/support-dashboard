// =============================================================================
// test-scheduling-slots.ts — unit tests for the tz-aware slot logic (no Supabase
// / Deno). Run: npx tsx scripts/test-scheduling-slots.ts
// =============================================================================

import {
  formatLabel,
  generateSlots,
  isSlotFree,
  tzOffsetMs,
  weekdayKey,
  zonedWallClockToUtc,
  type WeeklyHours,
} from "../supabase/functions/scheduling/lib.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const TZ = "America/Los_Angeles";
const HOURS: WeeklyHours = {
  mon: ["08:00", "18:00"],
  tue: ["08:00", "18:00"],
  wed: ["08:00", "18:00"],
  thu: ["08:00", "18:00"],
  fri: ["08:00", "18:00"],
  sat: ["09:00", "14:00"],
  sun: [],
};

function main() {
  // --- tz offset (PDT = -7h in August) ---
  const aug = new Date("2026-08-03T18:00:00Z"); // 11:00 PDT
  check("tzOffset: LA summer is -7h", tzOffsetMs(aug, TZ) === -7 * 3600_000, String(tzOffsetMs(aug, TZ)));

  // --- wall clock -> UTC ---
  const utc = zonedWallClockToUtc(2026, 8, 3, 14, 0, TZ); // 2 PM PDT
  check("wallToUtc: 2pm PDT -> 21:00Z", utc.toISOString() === "2026-08-03T21:00:00.000Z", utc.toISOString());

  // --- DST correctness: Jan is PST (-8h) ---
  const jan = zonedWallClockToUtc(2026, 1, 15, 9, 0, TZ);
  check("wallToUtc: 9am PST -> 17:00Z", jan.toISOString() === "2026-01-15T17:00:00.000Z", jan.toISOString());

  // --- weekday ---
  check("weekday: 2026-08-03 is mon", weekdayKey(new Date("2026-08-03T18:00:00Z"), TZ) === "mon");

  // --- generateSlots: Monday, 60-min service, 30-min grid, from 8am, no busy ---
  // now = Mon 2026-08-03 07:00 PDT (14:00Z); min notice 120 -> earliest 09:00 PDT.
  const nowMs = Date.parse("2026-08-03T14:00:00Z");
  const slots = generateSlots({
    hours: HOURS,
    timeZone: TZ,
    durationMin: 60,
    granularityMin: 30,
    minNoticeMin: 120,
    nowMs,
    busy: [],
    days: 1,
    limit: 100,
    fromMs: nowMs,
  });
  // earliest slot start should be 09:00 PDT (16:00Z); last slot start 17:00 PDT (fits by 18:00 close)
  check("slots: first is 09:00 PDT", slots[0]?.start === "2026-08-03T16:00:00.000Z", slots[0]?.start);
  check("slots: last start is 17:00 PDT", slots[slots.length - 1]?.start === "2026-08-04T00:00:00.000Z", slots[slots.length - 1]?.start);
  // 09:00..17:00 inclusive at 30-min grid = 17 slots
  check("slots: correct count (17)", slots.length === 17, String(slots.length));

  // --- busy range removes overlapping slots ---
  const busy = [{ start: Date.parse("2026-08-03T17:00:00Z"), end: Date.parse("2026-08-03T18:30:00Z") }]; // 10:00-11:30 PDT
  const slots2 = generateSlots({
    hours: HOURS, timeZone: TZ, durationMin: 60, granularityMin: 30,
    minNoticeMin: 120, nowMs, busy, days: 1, limit: 100, fromMs: nowMs,
  });
  const starts2 = new Set(slots2.map((s) => s.start));
  check("busy: 10:00 slot removed", !starts2.has("2026-08-03T17:00:00.000Z"));
  check("busy: 10:30 slot removed", !starts2.has("2026-08-03T17:30:00.000Z"));
  check("busy: 09:00 slot kept", starts2.has("2026-08-03T16:00:00.000Z"));
  check("busy: 11:30 slot kept (starts at end of busy)", starts2.has("2026-08-03T18:30:00.000Z"));

  // --- closed Sunday yields nothing that day ---
  const sunNow = Date.parse("2026-08-09T15:00:00Z"); // Sunday
  const sunSlots = generateSlots({
    hours: HOURS, timeZone: TZ, durationMin: 60, granularityMin: 30,
    minNoticeMin: 0, nowMs: sunNow, busy: [], days: 1, limit: 100, fromMs: sunNow,
  });
  check("closed: Sunday returns 0 slots", sunSlots.length === 0, String(sunSlots.length));

  // --- isSlotFree ---
  check("isSlotFree: free when no busy", isSlotFree(nowMs, 60, []));
  check("isSlotFree: not free when overlapping", !isSlotFree(Date.parse("2026-08-03T17:15:00Z"), 60, busy));

  // --- label is human/local ---
  const label = formatLabel("2026-08-03T21:00:00.000Z", TZ);
  check("label: mentions 2:00 PM", /2:00\s?PM/.test(label), label);

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll scheduling slot tests passed.");
}

main();
