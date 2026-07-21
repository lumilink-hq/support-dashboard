// =============================================================================
// lib.ts — pure, dependency-free availability logic for the scheduling function.
// Timezone math uses the built-in Intl API (works in Deno and Node), so no
// luxon/date-fns dependency. Unit-tested in scripts/test-scheduling-slots.ts.
// =============================================================================

export type WeeklyHours = Record<string, string[]>; // { mon: ["08:00","18:00"], sun: [] }
export type BusyRange = { start: number; end: number }; // epoch ms
export type Slot = { start: string; end: string; label: string }; // ISO + speakable

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function parseHM(hm: string): [number, number] {
  const [h, m] = hm.split(":").map((x) => parseInt(x, 10));
  return [h || 0, m || 0];
}

// Offset (localWallClock - UTC) in ms for a given instant in a time zone.
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const asUTC = Date.UTC(
    +map.year,
    +map.month - 1,
    +map.day,
    +map.hour,
    +map.minute,
    +map.second,
  );
  return asUTC - instant.getTime();
}

// The UTC instant whose wall-clock time in `timeZone` is the given local Y/M/D H:M.
export function zonedWallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMs(new Date(guess), timeZone);
  let utc = guess - off1;
  const off2 = tzOffsetMs(new Date(utc), timeZone); // DST-boundary correction
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

export function localParts(
  instant: Date,
  timeZone: string,
): { y: number; mo: number; d: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return { y: +map.year, mo: +map.month, d: +map.day };
}

export function weekdayKey(instant: Date, timeZone: string): string {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })
    .format(instant)
    .toLowerCase();
  return wd.slice(0, 3);
}

// Speakable local label, e.g. "Tuesday, Sep 9 at 2:00 PM".
export function formatLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function overlaps(s: number, e: number, busy: BusyRange[]): boolean {
  return busy.some((b) => s < b.end && e > b.start);
}

export type SlotParams = {
  hours: WeeklyHours;
  timeZone: string;
  durationMin: number;
  granularityMin: number;
  minNoticeMin: number;
  nowMs: number;
  busy: BusyRange[];
  days?: number; // how many calendar days forward to scan
  limit?: number; // max slots to return
  fromMs?: number; // earliest day to start scanning (defaults to now)
};

// Generate the next available slots: within each day's open window, at the
// configured granularity, long enough for the service, after now+minNotice, and
// not overlapping a busy range.
export function generateSlots(p: SlotParams): Slot[] {
  const {
    hours,
    timeZone,
    durationMin,
    granularityMin,
    minNoticeMin,
    nowMs,
    busy,
    days = 14,
    limit = 6,
    fromMs,
  } = p;

  const durationMs = durationMin * 60_000;
  const granMs = granularityMin * 60_000;
  const earliest = nowMs + minNoticeMin * 60_000;
  const startLocal = localParts(new Date(fromMs ?? nowMs), timeZone);
  const out: Slot[] = [];

  for (let dayIdx = 0; dayIdx < days && out.length < limit; dayIdx++) {
    // Noon UTC on the target calendar date — safe to read weekday/date from.
    const dayAnchor = new Date(
      Date.UTC(startLocal.y, startLocal.mo - 1, startLocal.d + dayIdx, 12, 0),
    );
    const win = hours[weekdayKey(dayAnchor, timeZone)];
    if (!win || win.length < 2) continue; // closed that day

    const { y, mo, d } = localParts(dayAnchor, timeZone);
    const [oh, om] = parseHM(win[0]);
    const [ch, cm] = parseHM(win[1]);
    const openMs = zonedWallClockToUtc(y, mo, d, oh, om, timeZone).getTime();
    const closeMs = zonedWallClockToUtc(y, mo, d, ch, cm, timeZone).getTime();

    for (let s = openMs; s + durationMs <= closeMs; s += granMs) {
      if (s < earliest) continue;
      const e = s + durationMs;
      if (overlaps(s, e, busy)) continue;
      const startIso = new Date(s).toISOString();
      out.push({
        start: startIso,
        end: new Date(e).toISOString(),
        label: formatLabel(startIso, timeZone),
      });
      if (out.length >= limit) break;
    }
  }

  return out;
}

// Is a specific requested start free? (used to validate an agent-proposed time)
export function isSlotFree(
  startMs: number,
  durationMin: number,
  busy: BusyRange[],
): boolean {
  return !overlaps(startMs, startMs + durationMin * 60_000, busy);
}

export const _internal = { DAY_KEYS };
