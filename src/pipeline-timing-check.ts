// src/pipeline-timing-check.ts
// Offline proof for pipeline-timing.ts. Fixtures only: fake category, fake
// calendar entries, fake observation urls under .example, no network, no
// database. Run: npx tsx src/pipeline-timing-check.ts

import { mergeSignals, timingForLead } from "./pipeline-timing.js";
import type { PipelineTiming } from "./pipeline-timing.js";
import type { SeasonCalendar, SeasonCalendarEntry, TimingObservation } from "./timing.js";
import { SEASON_LOOKAHEAD_DAYS } from "./timing.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`FAIL  ${name}${detail.length > 0 ? `  :: ${detail}` : ""}`);
  }
}

const NOW = new Date(Date.UTC(2026, 8, 30, 0, 0, 0));
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MONTHS_PER_YEAR = 12;
const FIRST_SEEN_DAYS_AGO = 10;

const SEASON_SIGNAL = "timing:season-window";
const NEW_LISTING_SIGNAL = "timing:new-listing";

const LEAD_WITH_CALENDAR_ENTRY = { category: "Dental Clinic", country: "India" };
const LEAD_WITHOUT_CALENDAR_ENTRY = { category: "fixture-plumbing" };
const CALENDAR_BASIS = "https://fixture.example/season-basis";
const CALENDAR_NOTE = "Fixture dental season opens soon.";
const CALENDAR_NOTE_SECOND = "Fixture dental season closes late.";

function nextPeakMonth(now: Date): number {
  return (now.getUTCMonth() + 1) % MONTHS_PER_YEAR + 1;
}

// Month whose first day sits well outside the season lookahead window.
function monthDaysFromNow(days: number): number {
  return new Date(NOW.getTime() + days * MS_PER_DAY).getUTCMonth() + 1;
}

const FIRST_PEAK_MONTH = nextPeakMonth(NOW);
const SECOND_PEAK_MONTH = (FIRST_PEAK_MONTH % MONTHS_PER_YEAR) + 1;
const BEYOND_WINDOW_PEAK_MONTH = monthDaysFromNow(SEASON_LOOKAHEAD_DAYS + 35);

// Two entries for the same fixture category: the first day of each peak month
// falls inside SEASON_LOOKAHEAD_DAYS of NOW, so both fire the same
// season-window flag and the checks below can prove the wrapper de-duplicates
// signal ids.
const FIXTURE_CALENDAR: SeasonCalendarEntry[] = [
  {
    category: "dental-clinic",
    country: "India",
    peakMonths: [FIRST_PEAK_MONTH],
    note: CALENDAR_NOTE,
    basis: CALENDAR_BASIS,
  },
  {
    category: "dental-clinic",
    country: "India",
    peakMonths: [SECOND_PEAK_MONTH],
    note: CALENDAR_NOTE_SECOND,
    basis: CALENDAR_BASIS,
  },
];

const THROWING_CALENDAR: SeasonCalendar = {
  version: 1,
  note: "fixture calendar whose entries cannot be read",
  get entries(): SeasonCalendarEntry[] {
    throw new Error("fixture calendar entries unreadable");
  },
};

function firstSeenObservation(daysAgo: number): TimingObservation[] {
  const date = new Date(NOW.getTime() - daysAgo * MS_PER_DAY);
  return [{ kind: "first-seen", url: "https://listing-fixture.example/dental-clinic-1", date: date.toISOString() }];
}

// ------------------------------------------------------- 1. season window

{
  const result = timingForLead(LEAD_WITH_CALENDAR_ENTRY, [], NOW, FIXTURE_CALENDAR);
  check(
    "season window: calendar entry in lookahead gives timing:season-window",
    result.signals.includes(SEASON_SIGNAL),
    JSON.stringify(result.signals),
  );
  check(
    "season window: reachOutNow is true",
    result.reachOutNow === true,
    JSON.stringify(result.reachOutNow),
  );
  check(
    "season window: duplicate flags collapse to one signal",
    result.flags.length === 2 && result.signals.length === 1,
    `flags=${result.flags.length} signals=${JSON.stringify(result.signals)}`,
  );
  const peakIso = result.flags.length > 0 ? result.flags[0].dates[0] : "";
  const daysToPeak = (Date.parse(`${peakIso}T00:00:00Z`) - NOW.getTime()) / MS_PER_DAY;
  check(
    "season window: fixture peak starts inside SEASON_LOOKAHEAD_DAYS",
    peakIso.length > 0 && daysToPeak >= 0 && daysToPeak <= SEASON_LOOKAHEAD_DAYS,
    `peak=${peakIso} daysToPeak=${String(daysToPeak)} lookahead=${String(SEASON_LOOKAHEAD_DAYS)}`,
  );
}

// --------------------------------------------- 2. category with no entry

{
  const result = timingForLead(LEAD_WITHOUT_CALENDAR_ENTRY, [], NOW, FIXTURE_CALENDAR);
  check(
    "no calendar entry: no signals",
    result.signals.length === 0,
    JSON.stringify(result.signals),
  );
  check(
    "no calendar entry: reachOutNow is false",
    result.reachOutNow === false,
    JSON.stringify(result.reachOutNow),
  );
}

// ------------------------------------------------- 2b. no category at all

{
  const result = timingForLead({ country: "India" }, [], NOW, FIXTURE_CALENDAR);
  check(
    "missing category: no flags and no signals",
    result.flags.length === 0 && result.signals.length === 0,
    JSON.stringify(result.signals),
  );
  check(
    "missing category: reachOutNow is false",
    result.reachOutNow === false,
    JSON.stringify(result.reachOutNow),
  );
}

// ------------------------------------- 2c. negative control: peak too far out

{
  const result = timingForLead(LEAD_WITH_CALENDAR_ENTRY, [], NOW, [
    {
      category: "dental-clinic",
      country: "India",
      peakMonths: [BEYOND_WINDOW_PEAK_MONTH],
      note: CALENDAR_NOTE,
      basis: CALENDAR_BASIS,
    },
  ]);
  check(
    "negative control: peak beyond the lookahead gives no season-window",
    result.flags.length === 0 && result.signals.length === 0 && result.reachOutNow === false,
    JSON.stringify(result.signals),
  );
}

// ------------------------------------------------------- 3. new listing

{
  const result = timingForLead(
    LEAD_WITH_CALENDAR_ENTRY,
    firstSeenObservation(FIRST_SEEN_DAYS_AGO),
    NOW,
    FIXTURE_CALENDAR,
  );
  check(
    "new listing: first-seen 10 days before now adds timing:new-listing",
    result.signals.includes(NEW_LISTING_SIGNAL),
    JSON.stringify(result.signals),
  );
  check(
    "new listing: season signal still present next to it",
    result.signals.includes(SEASON_SIGNAL),
    JSON.stringify(result.signals),
  );
}

// ---------------------------------------------------- 4. throwing calendar

{
  let threw = false;
  let result: PipelineTiming | undefined;
  try {
    result = timingForLead(LEAD_WITH_CALENDAR_ENTRY, [], NOW, THROWING_CALENDAR);
  } catch {
    threw = true;
  }
  check("throwing calendar: timingForLead does not throw", threw === false);
  check(
    "throwing calendar: empty signals",
    result !== undefined && result.signals.length === 0,
    JSON.stringify(result?.signals),
  );
  check(
    "throwing calendar: empty flags and reachOutNow false",
    result !== undefined && result.flags.length === 0 && result.reachOutNow === false,
    JSON.stringify(result),
  );
  check(
    "throwing calendar: why records the cause",
    result !== undefined &&
      result.why.length > 0 &&
      result.why.join(" ").includes("fixture calendar entries unreadable"),
    JSON.stringify(result?.why),
  );
}

// ------------------------------------------------------- 5. no duplicates

{
  const season = timingForLead(LEAD_WITH_CALENDAR_ENTRY, [], NOW, FIXTURE_CALENDAR);
  const combined = timingForLead(
    LEAD_WITH_CALENDAR_ENTRY,
    firstSeenObservation(FIRST_SEEN_DAYS_AGO),
    NOW,
    FIXTURE_CALENDAR,
  );
  const absent = timingForLead(LEAD_WITHOUT_CALENDAR_ENTRY, [], NOW, FIXTURE_CALENDAR);
  const cases: [string, PipelineTiming][] = [
    ["season only", season],
    ["season plus new listing", combined],
    ["no calendar entry", absent],
  ];
  for (const [label, result] of cases) {
    check(
      `signal list has no duplicates: ${label}`,
      new Set(result.signals).size === result.signals.length,
      JSON.stringify(result.signals),
    );
  }
}

// --------------------------------------------------------- 6. mergeSignals

{
  const existing = [SEASON_SIGNAL, "signal:fixture-website"];
  const extra = [NEW_LISTING_SIGNAL, SEASON_SIGNAL, "signal:fixture-website"];
  const existingBefore = JSON.stringify(existing);
  const extraBefore = JSON.stringify(extra);

  const merged = mergeSignals(existing, extra);
  const expected = [SEASON_SIGNAL, "signal:fixture-website", NEW_LISTING_SIGNAL];
  check(
    "mergeSignals: existing order first, duplicates removed",
    JSON.stringify(merged) === JSON.stringify(expected),
    JSON.stringify(merged),
  );
  check(
    "mergeSignals: existing input unchanged",
    JSON.stringify(existing) === existingBefore,
    JSON.stringify(existing),
  );
  check(
    "mergeSignals: extra input unchanged",
    JSON.stringify(extra) === extraBefore,
    JSON.stringify(extra),
  );
  check(
    "mergeSignals: undefined existing yields unique extra ids in order",
    JSON.stringify(mergeSignals(undefined, extra)) ===
      JSON.stringify([NEW_LISTING_SIGNAL, SEASON_SIGNAL, "signal:fixture-website"]),
    JSON.stringify(mergeSignals(undefined, extra)),
  );
  check(
    "mergeSignals: empty extra returns a copy of existing",
    JSON.stringify(mergeSignals(existing, [])) === JSON.stringify(existing),
    JSON.stringify(mergeSignals(existing, [])),
  );
}

// ---------------------------------------------------------------- summary

console.log("");
console.log(`Pipeline timing: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed checks: ${failures.join("; ")}`);
  process.exitCode = 1;
}
