// src/timing-check.ts
// Proof for dated timing flags (timing.ts). Offline, fixtures only: every
// lead, observation and calendar entry below is fake fixture data under
// .example. Run: npx tsx src/timing-check.ts

import { join } from "node:path";
import { tmpdir } from "node:os";
import { FLAG_WEIGHT, loadSeasonCalendar, reachOutNow, timingSignals } from "./timing.js";
import type {
  SeasonCalendarEntry,
  TimingFlag,
  TimingLead,
  TimingObservation,
} from "./timing.js";

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

function hasFlag(flags: TimingFlag[], name: string): boolean {
  return flags.some((flag) => flag.flag === name);
}

function lead(category: string, country?: string): TimingLead {
  return country === undefined ? { category } : { category, country };
}

function obs(
  kind: TimingObservation["kind"],
  url: string,
  date: string,
  extra?: { count?: number; previousCount?: number; previousDate?: string },
): TimingObservation {
  return { kind, url, date, ...extra };
}

// Fixture lead intentionally uses "Dental Clinic" (capital + space) while the
// fixture calendar entries use "dental-clinic", so every season fire below
// also proves the lower-case spaces-to-hyphens normalisation.
const LEAD_IN = lead("Dental Clinic", "India");
const NOW = "2026-09-30T00:00:00.000Z";

// ------------------------------------------------------------------ 1. new-listing

{
  const inside = timingSignals(
    LEAD_IN,
    [obs("first-seen", "https://listing-fix.example/1", "2026-08-20T00:00:00.000Z")],
    NOW,
  );
  check("new-listing fires inside window", hasFlag(inside, "new-listing"), JSON.stringify(inside));
  const outside = timingSignals(
    LEAD_IN,
    [obs("first-seen", "https://listing-fix.example/1", "2026-06-01T00:00:00.000Z")],
    NOW,
  );
  check("new-listing silent outside window", !hasFlag(outside, "new-listing"), JSON.stringify(outside));
}

// ------------------------------------------------------------------ 2. hiring-spree

{
  const inside = timingSignals(
    LEAD_IN,
    [
      obs("job-posting", "https://jobs-fix.example/a", "2026-09-10T00:00:00.000Z"),
      obs("job-posting", "https://jobs-fix.example/b", "2026-09-15T00:00:00.000Z"),
      obs("job-posting", "https://jobs-fix.example/c", "2026-09-20T00:00:00.000Z"),
    ],
    NOW,
  );
  check("hiring-spree fires with 3 distinct roles", hasFlag(inside, "hiring-spree"), JSON.stringify(inside));
  const outside = timingSignals(
    LEAD_IN,
    [
      obs("job-posting", "https://jobs-fix.example/a", "2026-09-10T00:00:00.000Z"),
      obs("job-posting", "https://jobs-fix.example/b", "2026-09-15T00:00:00.000Z"),
      obs("job-posting", "https://jobs-fix.example/c", "2026-07-01T00:00:00.000Z"),
    ],
    NOW,
  );
  check(
    "hiring-spree silent with only 2 roles in window",
    !hasFlag(outside, "hiring-spree"),
    JSON.stringify(outside),
  );
}

// ------------------------------------------------------------------ 3. new-ad-campaign

{
  const inside = timingSignals(
    LEAD_IN,
    [obs("ad-start", "https://ads-fix.example/x", "2026-09-15T00:00:00.000Z")],
    NOW,
  );
  check("new-ad-campaign fires inside window", hasFlag(inside, "new-ad-campaign"), JSON.stringify(inside));
  const outside = timingSignals(
    LEAD_IN,
    [obs("ad-start", "https://ads-fix.example/x", "2026-07-15T00:00:00.000Z")],
    NOW,
  );
  check(
    "new-ad-campaign silent outside window",
    !hasFlag(outside, "new-ad-campaign"),
    JSON.stringify(outside),
  );
}

// ------------------------------------------------------------------ 4. reviews-momentum

{
  const inside = timingSignals(
    LEAD_IN,
    [
      obs("review-count", "https://reviews-fix.example/asha", "2026-09-01T00:00:00.000Z", {
        count: 130,
        previousCount: 100,
        previousDate: "2026-06-01T00:00:00.000Z",
      }),
    ],
    NOW,
  );
  check("reviews-momentum fires past both thresholds", hasFlag(inside, "reviews-momentum"), JSON.stringify(inside));
  const belowMin = timingSignals(
    LEAD_IN,
    [
      obs("review-count", "https://reviews-fix.example/asha", "2026-09-01T00:00:00.000Z", {
        count: 105,
        previousCount: 100,
        previousDate: "2026-06-01T00:00:00.000Z",
      }),
    ],
    NOW,
  );
  check(
    "reviews-momentum silent below the count minimum",
    !hasFlag(belowMin, "reviews-momentum"),
    JSON.stringify(belowMin),
  );
  const belowRatio = timingSignals(
    LEAD_IN,
    [
      obs("review-count", "https://reviews-fix.example/asha", "2026-09-01T00:00:00.000Z", {
        count: 112,
        previousCount: 100,
        previousDate: "2026-06-01T00:00:00.000Z",
      }),
    ],
    NOW,
  );
  check(
    "reviews-momentum silent below the ratio threshold",
    !hasFlag(belowRatio, "reviews-momentum"),
    JSON.stringify(belowRatio),
  );
}

// ------------------------------------------------------------------ 5. season-window both sides

const CAL_OCT: SeasonCalendarEntry[] = [
  {
    category: "dental-clinic",
    country: "India",
    peakMonths: [10],
    note: "Fixture October peak note.",
    basis: "fixture basis",
  },
];

{
  // 2026-10-01 starts one day after NOW, inside the 45-day lookahead.
  const inside = timingSignals(LEAD_IN, [], NOW, CAL_OCT);
  check("season-window fires inside lookahead", hasFlag(inside, "season-window"), JSON.stringify(inside));
  const season = inside.find((flag) => flag.flag === "season-window");
  check(
    "season-window copies note and basis exactly",
    season !== undefined && season.sentence === "Fixture October peak note." && season.basis === "fixture basis",
    JSON.stringify(season),
  );
  check(
    "season-window url is season-calendar.json",
    season !== undefined && season.url === "season-calendar.json",
    JSON.stringify(season),
  );
  // 2026-10-01 starts 108 days after mid-June, outside the lookahead.
  const outside = timingSignals(LEAD_IN, [], "2026-06-15T00:00:00.000Z", CAL_OCT);
  check("season-window silent outside lookahead", !hasFlag(outside, "season-window"), JSON.stringify(outside));
}

// ------------------------------------------------------------------ 6. year-wrap + country rule

const CAL_WRAP: SeasonCalendarEntry[] = [
  {
    category: "dental-clinic",
    country: "India",
    peakMonths: [12, 1],
    note: "Fixture year-end peak note.",
    basis: "fixture basis",
  },
];

{
  // December starts ~16 days after mid-November: fires across the year wrap.
  const november = timingSignals(LEAD_IN, [], "2026-11-15T00:00:00.000Z", CAL_WRAP);
  check("season year-wrap fires in November", hasFlag(november, "season-window"), JSON.stringify(november));
  // December starts ~169 days after mid-June: no flag with the same months.
  const june = timingSignals(LEAD_IN, [], "2026-06-15T00:00:00.000Z", CAL_WRAP);
  check("season year-wrap silent in June", !hasFlag(june, "season-window"), JSON.stringify(june));
  const wrongCountry = timingSignals(lead("Dental Clinic", "GB"), [], NOW, CAL_OCT);
  check(
    "season-window silent on country mismatch",
    !hasFlag(wrongCountry, "season-window"),
    JSON.stringify(wrongCountry),
  );
  const noCountry = timingSignals(lead("Dental Clinic"), [], NOW, CAL_OCT);
  check(
    "season-window fires when the lead has no country",
    hasFlag(noCountry, "season-window"),
    JSON.stringify(noCountry),
  );
}

// ------------------------------------------------------------------ 7. reachOutNow

{
  const empty = reachOutNow(LEAD_IN, []);
  check(
    "reachOutNow false with no flags",
    empty.now === false && empty.why.length === 0 && empty.score === 0,
    JSON.stringify(empty),
  );
  const one: TimingFlag[] = [
    {
      flag: "new-listing",
      url: "https://listing-fix.example/1",
      dates: ["2026-08-20T00:00:00.000Z"],
      sentence: "Fixture sentence one.",
    },
  ];
  const single = reachOutNow(LEAD_IN, one);
  check(
    "reachOutNow true with one flag",
    single.now === true &&
      JSON.stringify(single.why) === JSON.stringify(["Fixture sentence one."]) &&
      single.score === FLAG_WEIGHT,
    JSON.stringify(single),
  );
  const five: TimingFlag[] = [
    { flag: "new-listing", url: "https://listing-fix.example/1", dates: ["2026-08-20"], sentence: "S1." },
    { flag: "hiring-spree", url: "https://jobs-fix.example/a", dates: ["2026-09-10"], sentence: "S2." },
    { flag: "new-ad-campaign", url: "https://ads-fix.example/x", dates: ["2026-09-15"], sentence: "S3." },
    { flag: "reviews-momentum", url: "https://reviews-fix.example/asha", dates: ["2026-09-01"], sentence: "S4." },
    { flag: "season-window", url: "season-calendar.json", dates: ["2026-10-01"], sentence: "S5." },
  ];
  const capped = reachOutNow(LEAD_IN, five);
  check("reachOutNow score caps at 40", capped.score === 40, JSON.stringify(capped));
}

// ------------------------------------------------------------------ 8. every flag has url + dates

{
  const combined = timingSignals(
    LEAD_IN,
    [
      obs("first-seen", "https://listing-fix.example/1", "2026-08-20T00:00:00.000Z"),
      obs("job-posting", "https://jobs-fix.example/a", "2026-09-10T00:00:00.000Z"),
      obs("job-posting", "https://jobs-fix.example/b", "2026-09-15T00:00:00.000Z"),
      obs("job-posting", "https://jobs-fix.example/c", "2026-09-20T00:00:00.000Z"),
      obs("ad-start", "https://ads-fix.example/x", "2026-09-15T00:00:00.000Z"),
      obs("review-count", "https://reviews-fix.example/asha", "2026-09-01T00:00:00.000Z", {
        count: 130,
        previousCount: 100,
        previousDate: "2026-06-01T00:00:00.000Z",
      }),
    ],
    NOW,
    CAL_OCT,
  );
  check("combined run yields flags", combined.length >= 5, JSON.stringify(combined.map((f) => f.flag)));
  check(
    "every flag has a non-empty url, dates and sentence",
    combined.every((f) => f.url.length > 0 && f.dates.length > 0 && f.sentence.length > 0),
    JSON.stringify(combined),
  );
}

// ------------------------------------------------------------------ 9. malformed skipped, never thrown

{
  let threw = false;
  let malformed: TimingFlag[] = [];
  try {
    malformed = timingSignals(
      LEAD_IN,
      [
        { kind: "first-seen", url: "", date: "not-a-date" },
        { kind: "ad-start", url: "https://ads-fix.example/x", date: "also-not-a-date" },
        { kind: "job-posting", url: "", date: "2026-09-10T00:00:00.000Z" },
      ],
      NOW,
    );
  } catch {
    threw = true;
  }
  check("malformed observations never throw", threw === false);
  check("malformed observations yield no flags", malformed.length === 0, JSON.stringify(malformed));
  const mixed = timingSignals(
    LEAD_IN,
    [
      { kind: "first-seen", url: "", date: "not-a-date" },
      obs("first-seen", "https://listing-fix.example/1", "2026-08-20T00:00:00.000Z"),
    ],
    NOW,
  );
  check(
    "valid observation still fires next to malformed",
    hasFlag(mixed, "new-listing"),
    JSON.stringify(mixed),
  );
}

// ------------------------------------------------------------------ 10. missing calendar

{
  const missing = loadSeasonCalendar(join(tmpdir(), "leadscout-no-such-calendar-fixture.json"));
  check(
    "missing calendar file loads as []",
    Array.isArray(missing) && missing.length === 0,
    JSON.stringify(missing),
  );
  const noSeason = timingSignals(LEAD_IN, [], "2026-11-15T00:00:00.000Z", missing);
  check("missing calendar gives no season flag", !hasFlag(noSeason, "season-window"), JSON.stringify(noSeason));
  let defaultThrew = false;
  let defaultCalendar: SeasonCalendarEntry[] = [];
  try {
    defaultCalendar = loadSeasonCalendar();
  } catch {
    defaultThrew = true;
  }
  check(
    "default calendar loads without throwing",
    defaultThrew === false && Array.isArray(defaultCalendar),
    String(defaultCalendar.length),
  );
}

// ---------------------------------------------------------------- summary

console.log("");
console.log(`Timing: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed checks: ${failures.join("; ")}`);
  process.exitCode = 1;
}
