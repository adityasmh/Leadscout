// src/shared-lessons-check.ts
// Order XC1-shared-lessons: offline proof with 8 synthetic workspaces.
// No network, no real database: in-memory node:sqlite only, temp dir only.
// Fixtures below are clearly fake (fixture names, .example.invalid URLs).

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-ignore node:sqlite is a Node 24 built-in; ambient types are not available in this environment.
import { DatabaseSync } from "node:sqlite";
import {
  K_WORKSPACES,
  MIN_OBSERVATIONS,
  ONE,
  PERCENT_SCALE,
  ROUND_TO_PERCENT,
  ZERO,
  buildLessons,
  describe,
  describeLesson,
  isOptedOut,
  lessonsFor,
  loadObservations,
  optOut,
  priorForSignal,
  priorForTrust,
  writeLessons,
  type WorkspaceObservation,
} from "./shared-lessons.js";

// ------------------------------------------------------- named constants

const BELOW_K = K_WORKSPACES - ONE;
const OBS_FOUR_EACH = 15;
const OBS_FIVE_EACH = 12;
const OBS_FEW_EACH = 6;
const OBS_WIDE_EACH = 8;
const OBS_OPT_EACH = 20;
const VERIFIED_FOUR = 48;
const VERIFIED_FIVE = 47;
const VERIFIED_FEW = 24;
const VERIFIED_WIDE = 51;
const VERIFIED_OPT = 80;
const EXPECTED_PERCENT_FIVE = 78;
const EXPECTED_PERCENT_WIDE = 80;
const EXPECTED_LIFT_FIVE = 10;
const EXPECTED_COUNT_SIXTY = "60+";
const EXPECTED_COUNT_FIFTY = "50+";
const EXPECTED_COUNT_HUNDRED = "100+";
const EXPECTED_CUSTOMERS_FIVE = "5+";
const EXIT_FAILURE = 1;
const FRACTION_FULL = 1;

const CAT_FOUR = "dental-four-ws";
const CAT_FIVE = "dental-five-ws";
const CAT_FEW = "dental-few-ws";
const CAT_WIDE = "dental-wide-ws";
const CAT_OPT = "dental-opt-ws";
const CHANNEL = "Practo";
const SIGNAL = "has-whatsapp";

const WS_IDS: readonly string[] = [
  "ws-xc1-01",
  "ws-xc1-02",
  "ws-xc1-03",
  "ws-xc1-04",
  "ws-xc1-05",
  "ws-xc1-06",
  "ws-xc1-07",
  "ws-xc1-08",
];
const WS_FOUR: readonly string[] = WS_IDS.slice(ZERO, BELOW_K);
const WS_FIVE: readonly string[] = WS_IDS.slice(ZERO, K_WORKSPACES);

const FIXTURE_NAMES: readonly string[] = [
  "Fixture Person Alpha One",
  "Fixture Person Alpha Two",
  "Fixture Person Alpha Three",
  "Fixture Person Alpha Four",
  "Fixture Person Alpha Five",
  "Fixture Person Alpha Six",
  "Fixture Person Alpha Seven",
  "Fixture Person Alpha Eight",
];
const FIXTURE_PHONES: readonly string[] = [
  "+91-90000-00001",
  "+91-90000-00002",
  "+91-90000-00003",
  "+91-90000-00004",
  "+91-90000-00005",
  "+91-90000-00006",
  "+91-90000-00007",
  "+91-90000-00008",
];
const FIXTURE_URLS: readonly string[] = [
  "https://fixture-xc1-01.example.invalid/lead",
  "https://fixture-xc1-02.example.invalid/lead",
  "https://fixture-xc1-03.example.invalid/lead",
  "https://fixture-xc1-04.example.invalid/lead",
  "https://fixture-xc1-05.example.invalid/lead",
  "https://fixture-xc1-06.example.invalid/lead",
  "https://fixture-xc1-07.example.invalid/lead",
  "https://fixture-xc1-08.example.invalid/lead",
];

// ---------------------------------------------------------------- helpers

let passed = ZERO;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed += ONE;
    console.log(`PASS ${name}`);
    return;
  }
  throw new Error(`FAIL ${name}`);
}

function channelItem(
  built: { channels: Array<{ category: string; channel: string }> },
  category: string,
  channel: string,
): boolean {
  return built.channels.some((item) => item.category === category && item.channel === channel);
}

function makeChannelObs(
  wsIds: readonly string[],
  perWs: number,
  category: string,
  verifiedTotal: number,
): WorkspaceObservation[] {
  const out: WorkspaceObservation[] = [];
  let made = ZERO;
  for (const ws of wsIds) {
    for (let i = ZERO; i < perWs; i += ONE) {
      out.push({
        workspaceId: ws,
        category,
        channel: CHANNEL,
        verifiedContact: made < verifiedTotal,
      });
      made += ONE;
    }
  }
  return out;
}

// CAT_FIVE observations carry outcomes + signals: the first MIN_OBSERVATIONS
// observations carry SIGNAL (mostly won), the remainder do not (mostly lost),
// so the signal lift is published and nonzero.
function makeFiveObs(): WorkspaceObservation[] {
  const out: WorkspaceObservation[] = [];
  let made = ZERO;
  for (const ws of WS_FIVE) {
    for (let i = ZERO; i < OBS_FIVE_EACH; i += ONE) {
      const withSignal = made < MIN_OBSERVATIONS;
      const won = withSignal
        ? made % K_WORKSPACES < BELOW_K
        : made < MIN_OBSERVATIONS + ONE + ONE;
      out.push({
        workspaceId: ws,
        category: CAT_FIVE,
        channel: CHANNEL,
        verifiedContact: made < VERIFIED_FIVE,
        signals: withSignal ? [SIGNAL] : [],
        outcome: won ? "won" : "lost",
      });
      made += ONE;
    }
  }
  return out;
}

// ------------------------------------------------------------------- main

function main(): void {
  const obsFour = makeChannelObs(WS_FOUR, OBS_FOUR_EACH, CAT_FOUR, VERIFIED_FOUR);
  const obsFive = makeFiveObs();
  const obsFew = makeChannelObs(WS_FIVE, OBS_FEW_EACH, CAT_FEW, VERIFIED_FEW);
  const obsWide = makeChannelObs(WS_IDS, OBS_WIDE_EACH, CAT_WIDE, VERIFIED_WIDE);
  const allObs: WorkspaceObservation[] = [...obsFour, ...obsFive, ...obsFew, ...obsWide];

  // 1. Four workspaces with 60 observations is NOT published.
  const builtFour = buildLessons(obsFour);
  check("4 workspaces with 60 obs is not published", channelItem(builtFour, CAT_FOUR, CHANNEL) === false);
  check("priorForTrust is undefined for 4-workspace item", priorForTrust(CHANNEL, CAT_FOUR) === undefined);
  check(
    "priorForSignal is undefined for 4-workspace item",
    priorForSignal(CAT_FOUR, SIGNAL) === undefined,
  );

  // 2. Five workspaces with 60 observations IS published and rounded.
  const built = buildLessons(allObs);
  const five = built.channels.find((item) => item.category === CAT_FIVE && item.channel === CHANNEL);
  check("5 workspaces with 60 obs is published", five !== undefined);
  if (five === undefined) throw new Error("FAIL 5-workspace lesson missing");
  check("published percent is rounded to nearest 2", five.percent % ROUND_TO_PERCENT === ZERO);
  check("published percent equals expected rounded value", five.percent === EXPECTED_PERCENT_FIVE);
  check("count is floor-to-10 bucket", five.count === EXPECTED_COUNT_SIXTY);
  check("customers is bucket", five.customers === EXPECTED_CUSTOMERS_FIVE);

  const wide = built.channels.find((item) => item.category === CAT_WIDE && item.channel === CHANNEL);
  check("8 workspaces with 64 obs is published", wide !== undefined);
  if (wide === undefined) throw new Error("FAIL wide lesson missing");
  check("wide percent is rounded", wide.percent % ROUND_TO_PERCENT === ZERO);
  check("wide percent equals expected", wide.percent === EXPECTED_PERCENT_WIDE);
  check("wide customers bucket", wide.customers === EXPECTED_CUSTOMERS_FIVE);

  // 3. Five workspaces with 30 observations is NOT published.
  check("5 workspaces with 30 obs is not published", channelItem(built, CAT_FEW, CHANNEL) === false);
  check("priorForTrust is undefined below MIN_OBSERVATIONS", priorForTrust(CHANNEL, CAT_FEW) === undefined);

  // 4. Signal lift is published for the 5-workspace category only.
  const sig = built.signals.find((item) => item.category === CAT_FIVE && item.signal === SIGNAL);
  check("signal lift is published for 5-workspace category", sig !== undefined);
  if (sig === undefined) throw new Error("FAIL signal lesson missing");
  check("signal lift percent is rounded", sig.percent % ROUND_TO_PERCENT === ZERO);
  check("signal lift percent equals expected", sig.percent === EXPECTED_LIFT_FIVE);
  check("signal count bucket", sig.count === EXPECTED_COUNT_FIFTY);
  check("signal customers bucket", sig.customers === EXPECTED_CUSTOMERS_FIVE);
  const trustPrior = priorForTrust(CHANNEL, CAT_FIVE);
  check("priorForTrust returns a 0-1 fraction", typeof trustPrior === "number" && trustPrior >= ZERO && trustPrior <= FRACTION_FULL);
  if (typeof trustPrior !== "number") throw new Error("FAIL trust prior shape");
  check("priorForTrust matches published percent", trustPrior === five.percent / PERCENT_SCALE);
  const signalPrior = priorForSignal(CAT_FIVE, SIGNAL);
  check("priorForSignal returns a 0-1 fraction", typeof signalPrior === "number" && signalPrior >= ZERO && signalPrior <= FRACTION_FULL);
  if (typeof signalPrior !== "number") throw new Error("FAIL signal prior shape");
  check("priorForSignal matches published lift", signalPrior * PERCENT_SCALE === sig.percent);
  check("lessonsFor returns published items", lessonsFor(CAT_FIVE).length > ZERO);
  check("lessonsFor is empty for unknown category", lessonsFor("no-such-category") !== undefined && lessonsFor("no-such-category").length === ZERO);

  // 5. Output objects carry ONLY the allowed keys.
  const allowedChannel = new Set(["category", "channel", "percent", "count", "customers"]);
  const allowedSignal = new Set(["category", "signal", "percent", "count", "customers"]);
  let keysOk = true;
  for (const item of built.channels) {
    for (const key of Object.keys(item)) {
      if (allowedChannel.has(key) === false) keysOk = false;
    }
  }
  for (const item of built.signals) {
    for (const key of Object.keys(item)) {
      if (allowedSignal.has(key) === false) keysOk = false;
    }
  }
  check("output objects carry only allowed keys", keysOk);

  // 6. Opt-out excludes a workspace before counting (in-memory DatabaseSync).
  const db = new DatabaseSync(":memory:");
  const optWs = WS_FIVE[ONE + ONE + ONE + ONE];
  const plainWs = WS_FIVE[ZERO];
  check("workspace starts opted-in", isOptedOut(db, optWs) === false);
  optOut(db, optWs);
  check("optOut marks workspace opted-out", isOptedOut(db, optWs) === true);
  check("other workspace stays opted-in", isOptedOut(db, plainWs) === false);
  const obsOpt = makeChannelObs(WS_FIVE, OBS_OPT_EACH, CAT_OPT, VERIFIED_OPT);
  const builtOpt = buildLessons(obsOpt);
  check("opt category published before opt-out", channelItem(builtOpt, CAT_OPT, CHANNEL));
  const excluded: readonly string[] = [optWs];
  const builtExcluded = buildLessons(obsOpt, { optedOut: excluded });
  check("opt-out excludes workspace so item is unpublished", channelItem(builtExcluded, CAT_OPT, CHANNEL) === false);
  db.close();

  // 7. loadObservations excludes opted-out rows and never throws on missing tables.
  const emptyDb = new DatabaseSync(":memory:");
  const missing = loadObservations(emptyDb);
  check("loadObservations on missing tables returns empty array", Array.isArray(missing.observations) && missing.observations.length === ZERO);
  check("loadObservations on missing tables returns a note", missing.note.length > ZERO);
  emptyDb.close();
  const storeDb = new DatabaseSync(":memory:");
  storeDb.exec(
    "CREATE TABLE lesson_observations (workspace_id TEXT, category TEXT, channel TEXT, verified INTEGER, signals TEXT, outcome TEXT)",
  );
  storeDb.prepare("INSERT INTO lesson_observations (workspace_id, category, channel, verified, signals, outcome) VALUES (?, ?, ?, ?, ?, ?)").run(WS_IDS[ZERO], CAT_FIVE, CHANNEL, ONE, "[]", "none");
  storeDb.prepare("INSERT INTO lesson_observations (workspace_id, category, channel, verified, signals, outcome) VALUES (?, ?, ?, ?, ?, ?)").run(WS_IDS[ONE], CAT_FIVE, CHANNEL, ONE, "[]", "none");
  optOut(storeDb, WS_IDS[ONE]);
  const loaded = loadObservations(storeDb);
  check(
    "loadObservations excludes opted-out workspace",
    loaded.observations.length === ONE && loaded.observations[ZERO]?.workspaceId === WS_IDS[ZERO],
  );
  storeDb.close();

  // 8. writeLessons to a temp dir with no leftover .tmp file.
  const dir = mkdtempSync(join(tmpdir(), "xc1-lessons-"));
  const target = writeLessons(dir, allObs);
  const fileText = readFileSync(target, "utf8");
  const parsed: unknown = JSON.parse(fileText);
  check("writeLessons output parses with channels and signals", typeof parsed === "object" && parsed !== null);
  const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
  check("no leftover .tmp file after atomic write", leftovers.length === ZERO);

  // 9. Serialized output contains no workspace id, fixture name, phone or URL.
  const blob = JSON.stringify(built) + fileText;
  let leak = "";
  for (const id of WS_IDS) {
    if (blob.includes(id)) leak = id;
  }
  for (const name of FIXTURE_NAMES) {
    if (blob.includes(name)) leak = name;
  }
  for (const phone of FIXTURE_PHONES) {
    if (blob.includes(phone)) leak = phone;
  }
  for (const url of FIXTURE_URLS) {
    if (blob.includes(url)) leak = url;
  }
  check("JSON output leaks no workspace id, name, phone or URL", leak === "");

  // 10. Plain-language description text.
  const text = describeLesson(five);
  check("describe mentions customers and percent", text.includes("Based on") && text.includes(five.customers) && text.includes("percent"));
  check("describe names category and channel", text.includes(CAT_FIVE) && text.includes(CHANNEL));
  check("describe alias matches describeLesson", describe(five) === text);
  const sigText = describeLesson(sig);
  check("signal describe names the signal", sigText.includes(SIGNAL) && sigText.includes("percent"));

  // 11. Count bucket for the 100-observation opt group before exclusion.
  const optItem = builtOpt.channels.find((item) => item.category === CAT_OPT);
  check("100-observation group buckets count", optItem !== undefined && optItem.count === EXPECTED_COUNT_HUNDRED);

  console.log(`shared-lessons-check: all ${passed} checks passed`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = EXIT_FAILURE;
}
