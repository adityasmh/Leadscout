// src/yield-loop.ts
// Order LL2-yield-loop: a closed learning loop over hunt targets.
//
// Every feed run reports what it found for an arm = (source, category, city, area).
// Every call outcome reports how that arm converted. `allocate` then chooses and
// orders the next run's targets with Thompson sampling: reward = gate-passed leads
// per call credit spent, blended with the downstream reward (interested|won per call
// made) once the arm has >= 20 calls. A fixed 15% of the budget always explores arms
// with < 3 runs, and an arm with 5 consecutive empty runs is paused for 14 days.
//
// Node 24 built-ins only, ES modules, .js import suffixes. The table is created
// lazily on the shared database from store.js (no store.ts edit). Every database
// access is wrapped so a corrupt row or a missing table never throws.
//
// Dependency notes (see docs/leadgen/REPORT_LL2-yield-loop.md):
//  - getDb() is imported from the merged ./store.js.
//  - CallOutcome is imported (type only) from the merged ./calls.ts.
//  - source-trust.ts and learn-score.ts are merged but this loop is self-contained:
//    it reuses the same Beta/Poisson-Gamma idea locally instead of importing them.
//  - Lead has no area field (store.ts leads table has no `area` column), so a lead
//    resolves to an empty area and matches every arm with the same source/category/city.

import { getDb } from "./store.js";
import type { CallOutcome } from "./calls.js";

// ----------------------------------------------------------------- constants

const DAY_MS = 24 * 60 * 60 * 1000;
const PAUSE_DAYS = 14;
const EMPTY_RUNS_TO_PAUSE = 5;
const EXPLORE_FRACTION = 0.15;
const MIN_RUNS_FOR_EXPLOIT = 3;
const MIN_CALLS_FOR_BLEND = 20;
const DAY = "\u0000"; // arm key separator

const REACHED_OUTCOMES: ReadonlySet<string> = new Set([
  "not_interested",
  "call_back",
  "interested",
  "meeting_booked",
  "won",
  "do_not_contact",
]);

// ----------------------------------------------------------------- types

export type HuntTarget = { source: string; category: string; city: string; area?: string };

export type Allocation = {
  source: string;
  category: string;
  city: string;
  area: string;
  credits: number;
  reason: string;
};

export type YieldStat = {
  feedId: string;
  source: string;
  category: string;
  city: string;
  area: string;
  runs: number;
  rawFound: number;
  newLeads: number;
  gatePassed: number;
  called: number;
  answered: number;
  interested: number;
  won: number;
  consecutiveEmpty: number;
  pausedUntil: string | null;
  pauseReason: string | null;
  lastRunAt: string | null;
  updatedAt: string;
};

export type RecordRunInput = {
  feedId: string;
  source: string;
  category: string;
  city: string;
  area?: string;
  rawFound?: number;
  newLeads?: number;
  gatePassed?: number;
};

export type RecordCallInput = { leadId: string; outcome: CallOutcome | string };

type Row = Record<string, unknown>;
type Db = ReturnType<typeof getDb>;

// ----------------------------------------------------------------- schema

const SCHEMA = `
CREATE TABLE IF NOT EXISTS yield_stats (
  feedId TEXT NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  city TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '',
  runs INTEGER NOT NULL DEFAULT 0,
  rawFound INTEGER NOT NULL DEFAULT 0,
  newLeads INTEGER NOT NULL DEFAULT 0,
  gatePassed INTEGER NOT NULL DEFAULT 0,
  called INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  interested INTEGER NOT NULL DEFAULT 0,
  won INTEGER NOT NULL DEFAULT 0,
  consecutiveEmpty INTEGER NOT NULL DEFAULT 0,
  pausedUntil TEXT,
  pauseReason TEXT,
  lastRunAt TEXT,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (feedId, source, category, city, area)
);
CREATE INDEX IF NOT EXISTS idx_yield_stats_feed ON yield_stats(feedId);
`;

// ----------------------------------------------------------------- helpers

let ensured = false;

/** Lazily create the table on the shared db. Returns null (never throws) on failure. */
function ensureTable(): Db | null {
  try {
    const db = getDb();
    if (!ensured) {
      db.exec(SCHEMA);
      ensured = true;
    }
    return db;
  } catch {
    return null;
  }
}

function s(value: unknown): string {
  return String(value ?? "").trim();
}

function n(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function optS(value: unknown): string | null {
  const text = s(value);
  return text === "" ? null : text;
}

function keyOf(t: { source: string; category: string; city: string; area?: string }): string {
  return [s(t.source), s(t.category), s(t.city), s(t.area)].join(DAY);
}

function timeMs(value: string | null | undefined): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function toRow(raw: Row): YieldStat {
  return {
    feedId: s(raw.feedId),
    source: s(raw.source),
    category: s(raw.category),
    city: s(raw.city),
    area: s(raw.area),
    runs: n(raw.runs),
    rawFound: n(raw.rawFound),
    newLeads: n(raw.newLeads),
    gatePassed: n(raw.gatePassed),
    called: n(raw.called),
    answered: n(raw.answered),
    interested: n(raw.interested),
    won: n(raw.won),
    consecutiveEmpty: n(raw.consecutiveEmpty),
    pausedUntil: optS(raw.pausedUntil),
    pauseReason: optS(raw.pauseReason),
    lastRunAt: optS(raw.lastRunAt),
    updatedAt: s(raw.updatedAt),
  };
}

function readRow(db: Db, feedId: string, source: string, category: string, city: string, area: string): YieldStat | undefined {
  try {
    const raw = db
      .prepare("SELECT * FROM yield_stats WHERE feedId = ? AND source = ? AND category = ? AND city = ? AND area = ?")
      .get(feedId, source, category, city, area) as Row | undefined;
    return raw ? toRow(raw) : undefined;
  } catch {
    return undefined;
  }
}

function readAllForFeed(feedId: string): YieldStat[] {
  const db = ensureTable();
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT * FROM yield_stats WHERE feedId = ?").all(feedId) as Row[];
    return rows.map(toRow);
  } catch {
    return [];
  }
}

function writeRow(db: Db, row: YieldStat): void {
  db.prepare(
    `INSERT OR REPLACE INTO yield_stats
      (feedId, source, category, city, area, runs, rawFound, newLeads, gatePassed,
       called, answered, interested, won, consecutiveEmpty, pausedUntil, pauseReason, lastRunAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.feedId, row.source, row.category, row.city, row.area,
    row.runs, row.rawFound, row.newLeads, row.gatePassed,
    row.called, row.answered, row.interested, row.won,
    row.consecutiveEmpty, row.pausedUntil, row.pauseReason, row.lastRunAt, row.updatedAt
  );
}

// ---------------------------------------------------------- sampling (pure)

function normal(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Marsaglia-Tsang sample from Gamma(shape = k >= 1, scale = 1). */
function gammaSample(k: number, rand: () => number): number {
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let guard = 0; guard < 1000; guard++) {
    let x: number;
    let v: number;
    do {
      x = normal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return Math.max(0, d); // practically unreachable; keeps the function total
}

/**
 * Thompson sample of one arm's value in [0, 1). The gate-passed count is modelled
 * as a Poisson rate with a Gamma(gatePassed + 1, runs + 1) posterior, then mapped to
 * [0, 1) so the downstream call reward (also [0, 1]) blends cleanly. The call blend
 * only applies once the arm has >= 20 calls.
 */
function sampleValue(row: YieldStat | undefined, rand: () => number): number {
  const runs = row?.runs ?? 0;
  const gatePassed = row?.gatePassed ?? 0;
  const theta = gammaSample(gatePassed + 1, rand) / (runs + 1);
  const yieldScore = theta / (theta + 1);
  const called = row?.called ?? 0;
  if (called >= MIN_CALLS_FOR_BLEND) {
    const callScore = clamp01(((row?.interested ?? 0) + (row?.won ?? 0)) / Math.max(1, called));
    return 0.5 * yieldScore + 0.5 * callScore;
  }
  return yieldScore;
}

// -------------------------------------------------------------- recordRun

/**
 * Upsert one feed run for an arm. Five consecutive empty runs (gatePassed 0) pause
 * the arm for 14 days with a reason; a non-empty run clears the pause. Never throws.
 * `now` is injectable so tests can place pauses on a fixed clock.
 */
export function recordRun(input: RecordRunInput, now: Date = new Date()): YieldStat | undefined {
  const db = ensureTable();
  if (!db) return undefined;
  try {
    const feedId = s(input?.feedId);
    const source = s(input?.source);
    const category = s(input?.category);
    const city = s(input?.city);
    const area = s(input?.area);
    const rawFound = n(input?.rawFound);
    const newLeads = n(input?.newLeads);
    const gatePassed = n(input?.gatePassed);

    const existing = readRow(db, feedId, source, category, city, area);
    const runs = (existing?.runs ?? 0) + 1;
    const consecutiveEmpty = gatePassed <= 0 ? (existing?.consecutiveEmpty ?? 0) + 1 : 0;

    let pausedUntil: string | null = null;
    let pauseReason: string | null = null;
    if (consecutiveEmpty >= EMPTY_RUNS_TO_PAUSE) {
      pausedUntil = new Date(now.getTime() + PAUSE_DAYS * DAY_MS).toISOString();
      pauseReason = `${EMPTY_RUNS_TO_PAUSE} consecutive empty runs`;
    }

    const row: YieldStat = {
      feedId,
      source,
      category,
      city,
      area,
      runs,
      rawFound: (existing?.rawFound ?? 0) + rawFound,
      newLeads: (existing?.newLeads ?? 0) + newLeads,
      gatePassed: (existing?.gatePassed ?? 0) + gatePassed,
      called: existing?.called ?? 0,
      answered: existing?.answered ?? 0,
      interested: existing?.interested ?? 0,
      won: existing?.won ?? 0,
      consecutiveEmpty,
      pausedUntil,
      pauseReason,
      lastRunAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    writeRow(db, row);
    return row;
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------- recordCallOutcome

/**
 * Attribute one call outcome to its arm. The lead is resolved through its stored
 * source fields (source/category/city; a lead has no area, so an empty area matches
 * every arm with the same source/category/city). Increments called for any outcome,
 * answered for a reached outcome, interested for "interested", won for "won".
 * An unknown lead or an unknown outcome is a safe no-op (returns false).
 */
export function recordCallOutcome(input: RecordCallInput): boolean {
  const db = ensureTable();
  if (!db) return false;
  try {
    const leadId = s(input?.leadId);
    const outcome = s(input?.outcome);
    if (!leadId || !outcome) return false;

    const lead = db.prepare("SELECT source, category, city FROM leads WHERE id = ?").get(leadId) as Row | undefined;
    if (!lead) return false;

    const source = s(lead.source);
    const category = s(lead.category);
    const city = s(lead.city);
    const answered = REACHED_OUTCOMES.has(outcome) ? 1 : 0;
    const interested = outcome === "interested" ? 1 : 0;
    const won = outcome === "won" ? 1 : 0;
    const nowIso = new Date().toISOString();

    const result = db
      .prepare(
        `UPDATE yield_stats
         SET called = called + 1,
             answered = answered + ?,
             interested = interested + ?,
             won = won + ?,
             updatedAt = ?
         WHERE source = ? AND category = ? AND city = ?`
      )
      .run(answered, interested, won, nowIso, source, category, city);

    return Number(result.changes) > 0;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- allocate

function distributeCold(list: HuntTarget[], budget: number): Allocation[] {
  const base = list.length > 0 ? Math.floor(budget / list.length) : 0;
  const rem = list.length > 0 ? budget % list.length : 0;
  return list.map((t, i) => ({
    source: s(t.source),
    category: s(t.category),
    city: s(t.city),
    area: s(t.area),
    credits: base + (i < rem ? 1 : 0),
    reason: "no history yet",
  }));
}

/**
 * Choose and order hunt targets for the next run. Returns every target (the chosen
 * ones first, paused ones last with their reason). Deterministic for an injected
 * `rand`. With no history at all it returns the targets in the order given.
 */
export function allocate(
  feedId: string,
  targets: HuntTarget[],
  budget: number,
  rand: () => number = Math.random,
  now: Date = new Date()
): Allocation[] {
  const list: HuntTarget[] = (Array.isArray(targets) ? targets : []).map((t) => ({
    source: s(t?.source),
    category: s(t?.category),
    city: s(t?.city),
    area: s(t?.area),
  }));
  if (list.length === 0) return [];

  const b = Math.max(0, Math.floor(n(budget)));
  const rows = readAllForFeed(s(feedId));
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  if (!list.some((t) => byKey.has(keyOf(t)))) return distributeCold(list, b);

  const nowMs = now.getTime();
  const eligible: { t: HuntTarget; row: YieldStat | undefined }[] = [];
  const paused: Allocation[] = [];
  for (const t of list) {
    const row = byKey.get(keyOf(t));
    if (row && row.pausedUntil && Date.parse(row.pausedUntil) > nowMs) {
      paused.push({
        source: t.source,
        category: t.category,
        city: t.city,
        area: t.area ?? "",
        credits: 0,
        reason: `paused: ${row.pauseReason ?? "empty runs"} until ${row.pausedUntil}`,
      });
    } else {
      eligible.push({ t, row });
    }
  }

  const credits = new Map<string, number>();
  for (const e of eligible) credits.set(keyOf(e.t), 0);

  if (b > 0 && eligible.length > 0) {
    const exploreArms = eligible
      .filter((e) => (e.row?.runs ?? 0) < MIN_RUNS_FOR_EXPLOIT)
      .sort((a, c) => timeMs(a.row?.lastRunAt) - timeMs(c.row?.lastRunAt));

    const exploreBudget = exploreArms.length > 0
      ? Math.min(b, Math.max(1, Math.round(b * EXPLORE_FRACTION)))
      : 0;

    for (let i = 0; i < exploreBudget; i++) {
      const arm = exploreArms[i % exploreArms.length];
      const k = keyOf(arm.t);
      credits.set(k, (credits.get(k) ?? 0) + 1);
    }

    for (let i = 0; i < b - exploreBudget; i++) {
      let bestKey = "";
      let bestVal = -Infinity;
      for (const e of eligible) {
        const val = sampleValue(e.row, rand);
        if (val > bestVal) {
          bestVal = val;
          bestKey = keyOf(e.t);
        }
      }
      if (bestKey) credits.set(bestKey, (credits.get(bestKey) ?? 0) + 1);
    }
  }

  const ordered = eligible
    .map((e, idx) => ({
      source: e.t.source,
      category: e.t.category,
      city: e.t.city,
      area: e.t.area ?? "",
      credits: credits.get(keyOf(e.t)) ?? 0,
      reason: e.row ? ((e.row.called >= MIN_CALLS_FOR_BLEND) ? "yield + call outcomes" : "yield") : "no data",
      idx,
    }))
    .sort((a, c) => c.credits - a.credits || a.idx - c.idx)
    .map(({ idx: _idx, ...rest }) => rest);

  return [...ordered, ...paused];
}

// ----------------------------------------------------------------- explain

function label(t: { source: string; category: string; city: string; area?: string }): string {
  const area = s(t.area);
  return `${s(t.source)} / ${s(t.category)} / ${s(t.city)}${area ? ` / ${area}` : ""}`;
}

function fmtRate(x: number): string {
  return (Math.round(x * 100) / 100).toString();
}

/**
 * Plain-language explanation for the dashboard: best five arms, paused arms and why,
 * what the loop would do next, and a one-line learning summary. Never throws.
 */
export function explain(feedId: string, now: Date = new Date()): string {
  try {
    const rows = readAllForFeed(s(feedId));
    if (rows.length === 0) {
      return "No yield history yet: the loop has nothing to rank. The next run will hunt the targets in the order given.";
    }
    const nowMs = now.getTime();
    const rate = (r: YieldStat): number => (r.runs > 0 ? r.gatePassed / r.runs : 0);
    const ranked = [...rows].sort((a, c) => rate(c) - rate(a) || c.runs - a.runs);

    const lines: string[] = [];
    lines.push(`Yield loop for feed ${s(feedId)}`);
    lines.push("Best arms:");
    for (const r of ranked.slice(0, 5)) {
      lines.push(`  - ${label(r)}: ${fmtRate(rate(r))} gate-passed leads per credit over ${r.runs} runs (${r.gatePassed} gate-passed, ${r.called} calls).`);
    }

    const paused = rows.filter((r) => r.pausedUntil && Date.parse(r.pausedUntil) > nowMs);
    if (paused.length > 0) {
      lines.push("Paused arms:");
      for (const r of paused) {
        lines.push(`  - ${label(r)}: paused until ${r.pausedUntil} (${r.pauseReason ?? "no reason recorded"}).`);
      }
    } else {
      lines.push("Paused arms: none.");
    }

    const top = ranked[0];
    lines.push(`Next: spend the next budget mainly on ${label(top)}, keeping 15% for arms with fewer than 3 runs.`);

    const totalRuns = rows.reduce((sum, r) => sum + r.runs, 0);
    const totalGate = rows.reduce((sum, r) => sum + r.gatePassed, 0);
    const current = totalRuns > 0 ? totalGate / totalRuns : 0;
    const first = rows
      .filter((r) => r.lastRunAt)
      .sort((a, c) => timeMs(a.lastRunAt) - timeMs(c.lastRunAt))[0];
    const baseline = first && first.runs > 0 ? first.gatePassed / first.runs : current;
    const delta = Math.round((current - baseline) * 100) / 100;
    lines.push(`run ${totalRuns}: ${delta} more callable leads per credit than run 1`);

    return lines.join("\n");
  } catch {
    return "Yield loop: no data available (the table could not be read).";
  }
}
