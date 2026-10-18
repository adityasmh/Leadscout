// src/shared-lessons.ts
// Order XC1-shared-lessons: cross-customer anonymous lessons.
//
// Builds per (category, channel) verified-contact rates and per
// (category, signal) outcome lifts from WorkspaceObservation inputs
// without ever carrying lead data (workspace ids, names, phones,
// emails, URLs, free text) into the published output. An item is
// published only when at least K_WORKSPACES distinct workspaces and at
// least MIN_OBSERVATIONS observations contribute (k-anonymity);
// percents are rounded to the nearest ROUND_TO_PERCENT and counts are
// published only as floor-to-COUNT_BUCKET_SIZE buckets.
//
// buildLessons(observations, options?) is pure in its output (it depends
// only on its inputs); it also refreshes the module's published snapshot
// that lessonsFor / priorForTrust / priorForSignal read. It never imports
// source-trust.ts or learn-score.ts; those modules (orders ST1 / WS1) only
// consume priorForTrust / priorForSignal.
//
// Node 24 built-ins only; ES modules with .js import suffixes.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore node:sqlite is a Node 24 built-in; ambient types are not available in this environment.
import type { DatabaseSync } from "node:sqlite";

// ------------------------------------------------------------ constants

export const K_WORKSPACES = 5;
export const MIN_OBSERVATIONS = 50;
export const ROUND_TO_PERCENT = 2;
export const COUNT_BUCKET_SIZE = 10;
export const PERCENT_SCALE = 100;
export const SHARED_LESSONS_FILENAME = "shared-lessons.json";
export const ZERO = 0;
export const ONE = 1;
export const JSON_INDENT = 2;
export const COMPARE_LESS = -1;
export const COMPARE_EQUAL = 0;
export const COMPARE_GREATER = 1;

const TMP_SUFFIX = ".tmp";
const OPTOUT_TABLE = "lesson_optout";
const OBSERVATIONS_TABLE = "lesson_observations";
const GROUP_KEY_SEP = "\u0000";

// ---------------------------------------------------------------- types

export type WorkspaceObservation = {
  workspaceId: string;
  category: string;
  channel?: string;
  verifiedContact?: boolean;
  signals?: string[];
  outcome?: "won" | "lost" | "none";
};

export type ChannelLesson = {
  category: string;
  channel: string;
  percent: number;
  count: string;
  customers: string;
};

export type SignalLesson = {
  category: string;
  signal: string;
  percent: number;
  count: string;
  customers: string;
};

export type SharedLesson = ChannelLesson | SignalLesson;

export type LessonsOutput = {
  channels: ChannelLesson[];
  signals: SignalLesson[];
};

export type BuildOptions = {
  optedOut?: readonly string[];
};

export type LoadResult = {
  observations: WorkspaceObservation[];
  note: string;
};

// Minimal structural view of node:sqlite's DatabaseSync. The real object
// is passed in at runtime (duck typing), so this module needs no type
// import for node:sqlite and stays within Node 24 built-ins.
export type LessonStatement = {
  run(...params: Array<string | number | null>): unknown;
  get(...params: Array<string | number | null>): unknown;
  all(...params: Array<string | number | null>): unknown;
};

export type LessonDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): LessonStatement;
  close?: () => void;
};

// ------------------------------------------------------ published cache

let cached: LessonsOutput = { channels: [], signals: [] };

// --------------------------------------------------------------- helpers

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function bucketCount(n: number): string {
  return `${Math.floor(n / COUNT_BUCKET_SIZE) * COUNT_BUCKET_SIZE}+`;
}

function bucketCustomers(n: number): string {
  if (n >= COUNT_BUCKET_SIZE) return bucketCount(n);
  return `${K_WORKSPACES}+`;
}

function lessonName(lesson: SharedLesson): string {
  if ("channel" in lesson) return lesson.channel;
  return lesson.signal;
}

function compareLessons(a: SharedLesson, b: SharedLesson): number {
  if (a.category < b.category) return COMPARE_LESS;
  if (a.category > b.category) return COMPARE_GREATER;
  const an = lessonName(a);
  const bn = lessonName(b);
  if (an < bn) return COMPARE_LESS;
  if (an > bn) return COMPARE_GREATER;
  return COMPARE_EQUAL;
}

function isStringMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  return Object.keys(value).every((key) => typeof key === "string");
}

function isUnknownArray(value: unknown): value is Array<unknown> {
  return Array.isArray(value);
}

// ----------------------------------------------------------------- build

type ChannelAcc = {
  category: string;
  channel: string;
  workspaces: Set<string>;
  total: number;
  verified: number;
};

// CHANNEL RATE (fraction): verified / total over the observations in one
// (category, channel) group. verifiedContact === true counts as verified;
// false or absent counts as not verified.
function buildChannelLessons(usable: WorkspaceObservation[]): ChannelLesson[] {
  const groups = new Map<string, ChannelAcc>();
  for (const obs of usable) {
    const channel = obs.channel ?? "";
    if (channel === "") continue;
    const key = obs.category + GROUP_KEY_SEP + channel;
    let acc = groups.get(key);
    if (acc === undefined) {
      acc = {
        category: obs.category,
        channel,
        workspaces: new Set<string>(),
        total: ZERO,
        verified: ZERO,
      };
      groups.set(key, acc);
    }
    acc.workspaces.add(obs.workspaceId);
    acc.total += ONE;
    if (obs.verifiedContact === true) acc.verified += ONE;
  }
  const out: ChannelLesson[] = [];
  for (const acc of groups.values()) {
    if (acc.workspaces.size < K_WORKSPACES) continue;
    if (acc.total < MIN_OBSERVATIONS) continue;
    const rate = acc.total === ZERO ? ZERO : acc.verified / acc.total;
    // Built field by field: never spread the observation, never copy id/text.
    out.push({
      category: acc.category,
      channel: acc.channel,
      percent: roundToStep(rate * PERCENT_SCALE, ROUND_TO_PERCENT),
      count: bucketCount(acc.total),
      customers: bucketCustomers(acc.workspaces.size),
    });
  }
  out.sort(compareLessons);
  return out;
}

type SignalAcc = {
  category: string;
  signal: string;
  workspaces: Set<string>;
  won: number;
  decisive: number;
};

type BaselineAcc = {
  workspaces: Set<string>;
  won: number;
  decisive: number;
};

// LIFT DEFINITION (kept as a fraction everywhere internally; only the
// rounded percent is published):
//   lift(category, signal)
//     = P(won | category, signal present) - P(won | category, overall)
// where P(won | group) = won / (won + lost) counted over observations with
// a decisive outcome ("won" or "lost"). Observations with outcome "none"
// or absent are excluded from numerator AND denominator, both for the
// signal group and for the category baseline.
function buildSignalLessons(usable: WorkspaceObservation[]): SignalLesson[] {
  const baselines = new Map<string, BaselineAcc>();
  const groups = new Map<string, SignalAcc>();
  for (const obs of usable) {
    if (obs.outcome !== "won" && obs.outcome !== "lost") continue;
    const won = obs.outcome === "won" ? ONE : ZERO;
    let base = baselines.get(obs.category);
    if (base === undefined) {
      base = { workspaces: new Set<string>(), won: ZERO, decisive: ZERO };
      baselines.set(obs.category, base);
    }
    base.workspaces.add(obs.workspaceId);
    base.won += won;
    base.decisive += ONE;
    const seen = new Set<string>();
    for (const signal of obs.signals ?? []) {
      if (signal === "" || seen.has(signal)) continue;
      seen.add(signal);
      const key = obs.category + GROUP_KEY_SEP + signal;
      let acc = groups.get(key);
      if (acc === undefined) {
        acc = {
          category: obs.category,
          signal,
          workspaces: new Set<string>(),
          won: ZERO,
          decisive: ZERO,
        };
        groups.set(key, acc);
      }
      acc.workspaces.add(obs.workspaceId);
      acc.won += won;
      acc.decisive += ONE;
    }
  }
  const out: SignalLesson[] = [];
  for (const acc of groups.values()) {
    if (acc.workspaces.size < K_WORKSPACES) continue;
    if (acc.decisive < MIN_OBSERVATIONS) continue;
    const base = baselines.get(acc.category);
    const baseRate = base === undefined || base.decisive === ZERO ? ZERO : base.won / base.decisive;
    const signalRate = acc.decisive === ZERO ? ZERO : acc.won / acc.decisive;
    const lift = signalRate - baseRate;
    // Built field by field: never spread the observation, never copy id/text.
    out.push({
      category: acc.category,
      signal: acc.signal,
      percent: roundToStep(lift * PERCENT_SCALE, ROUND_TO_PERCENT),
      count: bucketCount(acc.decisive),
      customers: bucketCustomers(acc.workspaces.size),
    });
  }
  out.sort(compareLessons);
  return out;
}

export function buildLessons(
  observations: WorkspaceObservation[],
  options?: BuildOptions,
): LessonsOutput {
  const excluded = new Set<string>(options?.optedOut ?? []);
  const usable: WorkspaceObservation[] = [];
  for (const obs of observations) {
    if (obs.workspaceId === "" || obs.category === "") continue;
    if (excluded.has(obs.workspaceId)) continue;
    usable.push(obs);
  }
  const channels = buildChannelLessons(usable);
  const signals = buildSignalLessons(usable);
  cached = { channels, signals };
  return { channels, signals };
}

// ----------------------------------------------------------------- priors

export function lessonsFor(category: string): SharedLesson[] {
  const out: SharedLesson[] = [];
  for (const item of cached.channels) {
    if (item.category !== category) continue;
    out.push({
      category: item.category,
      channel: item.channel,
      percent: item.percent,
      count: item.count,
      customers: item.customers,
    });
  }
  for (const item of cached.signals) {
    if (item.category !== category) continue;
    out.push({
      category: item.category,
      signal: item.signal,
      percent: item.percent,
      count: item.count,
      customers: item.customers,
    });
  }
  return out;
}

// Fraction 0..1 for source-trust.ts (order ST1); undefined when unpublished.
export function priorForTrust(channel: string, category: string): number | undefined {
  for (const item of cached.channels) {
    if (item.channel === channel && item.category === category) {
      return item.percent / PERCENT_SCALE;
    }
  }
  return undefined;
}

// Fraction 0..1 for learn-score.ts (order WS1); undefined when unpublished.
export function priorForSignal(category: string, signal: string): number | undefined {
  for (const item of cached.signals) {
    if (item.category === category && item.signal === signal) {
      return item.percent / PERCENT_SCALE;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- opt-out

const OPTOUT_CREATE_SQL = `CREATE TABLE IF NOT EXISTS ${OPTOUT_TABLE} (workspace_id TEXT PRIMARY KEY)`;

export function optOut(db: DatabaseSync, workspaceId: string): void {
  db.exec(OPTOUT_CREATE_SQL);
  db.prepare(`INSERT OR REPLACE INTO ${OPTOUT_TABLE} (workspace_id) VALUES (?)`).run(workspaceId);
}

export function isOptedOut(db: DatabaseSync, workspaceId: string): boolean {
  db.exec(OPTOUT_CREATE_SQL);
  const row = db
    .prepare(`SELECT workspace_id FROM ${OPTOUT_TABLE} WHERE workspace_id = ?`)
    .get(workspaceId);
  if (!isStringMap(row)) return false;
  return row["workspace_id"] === workspaceId;
}

function readOptedOut(db: DatabaseSync): Set<string> {
  const out = new Set<string>();
  const flag = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(OPTOUT_TABLE);
  if (!isStringMap(flag) || flag["name"] !== OPTOUT_TABLE) return out;
  const rows = db.prepare(`SELECT workspace_id FROM ${OPTOUT_TABLE}`).all();
  if (!isUnknownArray(rows)) return out;
  for (const row of rows) {
    if (!isStringMap(row)) continue;
    const id = row["workspace_id"];
    if (typeof id === "string" && id !== "") out.add(id);
  }
  return out;
}

// ------------------------------------------------------------------- load

function parseSignalsField(value: unknown): string[] {
  if (typeof value !== "string" || value === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  const source: unknown = parsed === undefined ? value.split(",") : parsed;
  const items: Array<unknown> = isUnknownArray(source) ? source : [];
  const out: string[] = [];
  for (const entry of items) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

function parseObservationRow(row: unknown): WorkspaceObservation | undefined {
  if (!isStringMap(row)) return undefined;
  const workspaceId = row["workspace_id"];
  const category = row["category"];
  if (typeof workspaceId !== "string" || workspaceId === "") return undefined;
  if (typeof category !== "string" || category === "") return undefined;
  const obs: WorkspaceObservation = { workspaceId, category };
  const channel = row["channel"];
  if (typeof channel === "string" && channel !== "") obs.channel = channel;
  const verified = row["verified"];
  if (typeof verified === "number") {
    obs.verifiedContact = verified !== ZERO;
  } else if (typeof verified === "string") {
    obs.verifiedContact = verified === "1" || verified === "true";
  }
  const parsedSignals = parseSignalsField(row["signals"]);
  if (parsedSignals.length > ZERO) obs.signals = parsedSignals;
  const outcome = row["outcome"];
  if (outcome === "won" || outcome === "lost" || outcome === "none") obs.outcome = outcome;
  return obs;
}

// Reads only the lesson_observations table (never any workspace lead data).
// Returns an empty array plus a note when the needed tables do not exist;
// never throws.
export function loadObservations(db: DatabaseSync): LoadResult {
  try {
    const flag = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(OBSERVATIONS_TABLE);
    if (!isStringMap(flag) || flag["name"] !== OBSERVATIONS_TABLE) {
      return {
        observations: [],
        note: `table ${OBSERVATIONS_TABLE} does not exist; no shared observations available`,
      };
    }
    const raw = db
      .prepare(
        `SELECT workspace_id, category, channel, verified, signals, outcome FROM ${OBSERVATIONS_TABLE}`,
      )
      .all();
    if (!isUnknownArray(raw)) {
      return {
        observations: [],
        note: `table ${OBSERVATIONS_TABLE} returned no rows; no shared observations available`,
      };
    }
    const parsed: WorkspaceObservation[] = [];
    let skipped = ZERO;
    for (const row of raw) {
      const obs = parseObservationRow(row);
      if (obs === undefined) {
        skipped += ONE;
        continue;
      }
      parsed.push(obs);
    }
    const optedOut = readOptedOut(db);
    const kept: WorkspaceObservation[] = [];
    let excludedCount = ZERO;
    for (const obs of parsed) {
      if (optedOut.has(obs.workspaceId)) {
        excludedCount += ONE;
        continue;
      }
      kept.push(obs);
    }
    return {
      observations: kept,
      note: `loaded ${kept.length} shared observations (${excludedCount} opted-out excluded, ${skipped} malformed skipped)`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    return {
      observations: [],
      note: `loadObservations failed (${detail}); no shared observations available`,
    };
  }
}

// ------------------------------------------------------------------ write

// Writes data/shared-lessons.json style output atomically (temp file in the
// same folder, then rename). Called only on demand, never automatically.
export function writeLessons(dir: string, observations: WorkspaceObservation[]): string {
  const built = buildLessons(observations);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, SHARED_LESSONS_FILENAME);
  const tmp = join(dir, `${SHARED_LESSONS_FILENAME}${TMP_SUFFIX}`);
  writeFileSync(tmp, JSON.stringify(built, null, JSON_INDENT), "utf8");
  renameSync(tmp, target);
  return target;
}

// -------------------------------------------------------------- describe

export function describeLesson(item: SharedLesson): string {
  if ("channel" in item) {
    return `Based on ${item.customers} customers selling to ${item.category}: ${item.channel} gives verified numbers ${item.percent} percent of the time.`;
  }
  return `Based on ${item.customers} customers selling to ${item.category}: leads with the ${item.signal} signal win ${item.percent} percent more often.`;
}

// Plain-language alias for UI callers expecting `describe`.
export const describe = describeLesson;
