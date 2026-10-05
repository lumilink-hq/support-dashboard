import { formatPlacedOn } from "../supabase/functions/voice-order-lookup/lib.ts";
let f = 0;
const ok = (l: string, c: boolean, d?: unknown) => {
  if (c) console.log(`  ok   ${l}`);
  else { f++; console.error(`  FAIL ${l}${d === undefined ? "" : ` — ${JSON.stringify(d)}`}`); }
};

console.log("\nformatPlacedOn — the Jul 31 / Aug 1 bug");
// The reported case: placed 18:00 Jul 31 in LA == 01:00 Aug 1 UTC.
const NOW = new Date("2026-07-31T22:00:00Z");        // 15:00 Jul 31 in LA
const evening = "2026-08-01T01:00:00Z";              // 18:00 Jul 31 in LA
ok('evening LA order reads "today", not August 1',
   formatPlacedOn(evening, "America/Los_Angeles", new Date("2026-08-01T02:00:00Z")) === "today",
   formatPlacedOn(evening, "America/Los_Angeles", new Date("2026-08-01T02:00:00Z")));
ok("the raw UTC date would have said August",
   new Date(evening).toISOString().startsWith("2026-08-01"));

ok('same instant is "today" for a caller mid-afternoon',
   formatPlacedOn("2026-07-31T20:00:00Z", "America/Los_Angeles", NOW) === "today");
ok('previous calendar day is "yesterday"',
   formatPlacedOn("2026-07-30T20:00:00Z", "America/Los_Angeles", NOW) === "yesterday");

// 23:50 last night is 40 minutes old but a different DAY.
ok("late-night order is yesterday, not today",
   formatPlacedOn("2026-07-31T06:50:00Z", "America/Los_Angeles",
                  new Date("2026-07-31T07:30:00Z")) === "yesterday",
   formatPlacedOn("2026-07-31T06:50:00Z", "America/Los_Angeles", new Date("2026-07-31T07:30:00Z")));

const older = formatPlacedOn("2026-07-25T20:00:00Z", "America/Los_Angeles", NOW);
ok("older orders get a spoken weekday + date", older === "Saturday, July 25", older);

console.log("\ntimezone handling");
// Compared on an OLDER order on purpose. For a recent one both zones return
// "today" and the difference is invisible — which is correct behaviour, and why
// the first version of this assertion failed.
ok("same instant is a different calendar day in another zone",
   formatPlacedOn("2026-07-25T20:00:00Z", "America/Los_Angeles", NOW) ===
     "Saturday, July 25" &&
   formatPlacedOn("2026-07-25T20:00:00Z", "Pacific/Auckland", NOW) ===
     "Sunday, July 26",
   [formatPlacedOn("2026-07-25T20:00:00Z", "America/Los_Angeles", NOW),
    formatPlacedOn("2026-07-25T20:00:00Z", "Pacific/Auckland", NOW)]);
ok("invalid timezone falls back to UTC instead of throwing",
   formatPlacedOn("2026-07-25T20:00:00Z", "Not/AZone", NOW) !== null);
ok("null timezone falls back to UTC",
   formatPlacedOn("2026-07-25T20:00:00Z", null, NOW) !== null);

console.log("\nbad input");
ok("null timestamp -> null", formatPlacedOn(null, "UTC", NOW) === null);
ok("empty timestamp -> null", formatPlacedOn("", "UTC", NOW) === null);
ok("garbage timestamp -> null", formatPlacedOn("not a date", "UTC", NOW) === null);

console.log(f === 0 ? "\nAll timezone tests passed.\n" : `\n${f} FAILED\n`);
process.exit(f === 0 ? 0 : 1);
