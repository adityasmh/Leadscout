// src/feeds.ts
// Order LG1-feed-engine: client lead feeds - a standing order (niche pack, cities,
// leads per run, schedule, workspace) that runs daily or weekly and delivers ONLY
// new leads. Tables are created lazily in the existing database (no store.ts edit).
//
// Node 24 built-ins only, ES module, .js import suffixes. Discovery and the process
// stage runner are injected through `FeedDeps` so a check runs fully offline. The
// real channel runner is OFF unless LEADSCOUT_FEEDS_LIVE=1 (see defaultRunDiscovery);
// the real process runner is only reached through the default `processLeads`.

import { randomUUID } from "node:crypto";
import { getDb } from "./store.js";
import { loadNichePack, nextHuntTargets, type NichePack, type HuntTarget } from "./niche-pack.js";
import type { RawLead } from "./types.js";
import type { ChannelAdapter, ChannelDeps, DiscoverQuery } from "./channels/types.js";
import type { DiscoveryResult } from "./channels/registry.js";
import type { PipelineDeps } from "./pipeline.js";
import { makeLiveDeps as defaultMakeLiveDeps } from "./channels/live-deps.js";

// ---------------------------------------------------------------- types

export type FeedSchedule = { kind: "daily" } | { kind: "weekly"; weekday: number };
export type FeedCursor = { hunted: string[] };

export type Feed = {
  id: string;
  workspaceId: string;
  name: string;
  nichePackId: string;
  categories: string[];
  cities: string[];
  perRunTarget: number;
  schedule: FeedSchedule;
  enabled: boolean;
  createdAt: string;
  cursor: FeedCursor;
};

export type FeedRunStatus = "running" | "done" | "failed";

export type FeedRun = {
  id: string;
  feedId: string;
  startedAt: string;
  finishedAt?: string;
  status: FeedRunStatus;
  found: number;
  newLeads: number;
  delivered: number;
  bySource: Record<string, number>;
  costNote?: string;
  error?: string;
};

/**
 * Injected seams. Everything that leaves the process is a dependency so a check
 * runs offline: `loadPack`, `runDiscovery` + `channelDeps`, and `processLeads`.
 * `bizKeyOf` defaults to the order's stable business key (see feedBizKey).
 */
export type FeedDeps = {
  now?: () => Date;
  loadPack?: (id: string) => NichePack;
  runDiscovery?: (
    q: DiscoverQuery,
    deps: ChannelDeps,
    opts?: { callBudget?: number }
  ) => Promise<DiscoveryResult>;
  channelDeps?: ChannelDeps;
  processLeads?: (feed: Feed, leads: RawLead[]) => Promise<string[]>;
  pipelineDeps?: Partial<PipelineDeps>;
  bizKeyOf?: (raw: RawLead) => string;
  /** Override the live ChannelDeps factory (default: the shared module seam,
   *  replaceable in checks via setLiveDepsFactory). */
  makeLiveDeps?: () => Promise<ChannelDeps>;
  /** Override the adapter list used to skip disabled adapters before any work
   *  (default: the live registry when LEADSCOUT_FEEDS_LIVE=1, else unknown). */
  listAdapters?: () => ChannelAdapter[];
  /** Hard limit per run (default 40). */
  maxTargets?: number;
  /** Hard limit per run (default 200). */
  maxCandidates?: number;
};

export type CreateFeedInput = {
  workspaceId: string;
  name: string;
  nichePackId: string;
  categories?: string[];
  cities?: string[];
  perRunTarget: number;
  schedule: FeedSchedule;
  enabled?: boolean;
};

// ---------------------------------------------------------------- live wiring (LG4)

export type LiveDepsFactory = () => Promise<ChannelDeps>;

let liveDepsFactory: LiveDepsFactory = defaultMakeLiveDeps;

/**
 * Replace the factory runFeed uses to build real ChannelDeps (checks inject a
 * fake here so no network is touched). Pass undefined to restore the default.
 */
export function setLiveDepsFactory(factory: LiveDepsFactory | undefined): void {
  liveDepsFactory = factory ?? defaultMakeLiveDeps;
}

const MAX_DISTINCT_ERRORS = 20;
const MAX_ERROR_CHARS = 2000;
const SKIPPED_LINE_RE = /^skipped \d+ disabled adapters$/;

/** Merge identical messages as "<message> (x<count>)", at most 20 distinct
 *  messages and 2000 characters, so one failing source cannot flood the run. */
function dedupErrorText(errors: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const raw of errors) {
    const message = String(raw ?? "").trim();
    if (message === "") continue;
    counts.set(message, (counts.get(message) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [message, count] of counts) {
    if (parts.length >= MAX_DISTINCT_ERRORS) break;
    parts.push(count > 1 ? `${message} (x${count})` : message);
  }
  if (parts.length === 0) return undefined;
  const joined = parts.join("; ");
  if (joined.length <= MAX_ERROR_CHARS) return joined;
  const cut = joined.slice(0, MAX_ERROR_CHARS);
  const boundary = cut.lastIndexOf("; ");
  return boundary > MAX_ERROR_CHARS / 2 ? cut.slice(0, boundary) : cut;
}

function adapterEnabled(adapter: ChannelAdapter): boolean {
  try {
    return adapter.status().enabled === true;
  } catch {
    return false;
  }
}

function adapterListsCategory(adapter: ChannelAdapter, category: string): boolean {
  const want = category.trim().toLowerCase();
  return adapter.categories.some((listed) => {
    const have = listed.trim().toLowerCase();
    return have === want || have === "any";
  });
}

/** Adapters for the skip decision: the injected list in checks, else the live
 *  registry when live mode is on. Undefined means unknown: keep the legacy
 *  behaviour (call the runner for every target). */
async function resolveAdapters(deps: FeedDeps): Promise<ChannelAdapter[] | undefined> {
  if (deps.listAdapters) return deps.listAdapters();
  if (process.env.LEADSCOUT_FEEDS_LIVE !== "1") return undefined;
  await import("./channels/index.js");
  const registry = await import("./channels/registry.js");
  return registry.channelAdapters();
}

function isDisabledReport(message: string): boolean {
  return /^\s*disabled\b/i.test(message);
}

/** True when the stored error holds a real source failure. The one
 *  "skipped N disabled adapters" bookkeeping line is not a failure. */
function runHasSourceErrors(run: FeedRun): boolean {
  const text = String(run.error ?? "").trim();
  if (text === "") return false;
  const rest = text
    .split("; ")
    .filter((part) => !SKIPPED_LINE_RE.test(part.trim()))
    .join("; ")
    .trim();
  return rest !== "";
}

// ---------------------------------------------------------------- schema

const FEED_SCHEMA = `
CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  nichePackId TEXT NOT NULL,
  categories TEXT NOT NULL DEFAULT '[]',
  cities TEXT NOT NULL DEFAULT '[]',
  perRunTarget INTEGER NOT NULL DEFAULT 0,
  schedule TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '{"hunted":[]}'
);
CREATE TABLE IF NOT EXISTS feed_runs (
  id TEXT PRIMARY KEY,
  feedId TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  finishedAt TEXT,
  status TEXT NOT NULL,
  found INTEGER NOT NULL DEFAULT 0,
  newLeads INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  bySource TEXT NOT NULL DEFAULT '{}',
  costNote TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS delivered_leads (
  feedId TEXT NOT NULL,
  bizKey TEXT NOT NULL,
  leadId TEXT NOT NULL,
  deliveredAt TEXT NOT NULL,
  PRIMARY KEY (feedId, bizKey)
);
`;

// SQLite rows are untyped by design; narrow once on entry.
type SqliteRow = Record<string, unknown>;

function str(value: unknown): string {
  return String(value ?? "");
}
function optStr(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function nullable(value: string | number | undefined | null): string | number | null {
  return value === undefined ? null : value;
}
function json(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value) ?? "null";
}
function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
function clampInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function ensureTables(): void {
  getDb().exec(FEED_SCHEMA);
}

// ---------------------------------------------------------------- bizKey

/**
 * Stable business key (Order LG1): lowercased name + last 10 digits of phone,
 * else lowercased name + area (city, else address). The project also has
 * `evidence.bizKey`, which prioritises website host / OSM id / E.164 phone; the
 * order pins this feed rule, so feeds use it and allow an override via
 * `FeedDeps.bizKeyOf`.
 */
export function feedBizKey(raw: RawLead): string {
  const name = String(raw.name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const digits = String(raw.phone ?? "").replace(/\D/g, "");
  if (digits.length >= 10) return `${name}|${digits.slice(-10)}`;
  const area = String(raw.city ?? raw.address ?? "").trim().toLowerCase();
  return `${name}|${area}`;
}

// ---------------------------------------------------------------- row mapping

function toFeed(row: SqliteRow): Feed {
  const schedule = parseJson<FeedSchedule>(row.schedule, { kind: "daily" });
  return {
    id: str(row.id),
    workspaceId: str(row.workspaceId),
    name: str(row.name),
    nichePackId: str(row.nichePackId),
    categories: parseJson<string[]>(row.categories, []),
    cities: parseJson<string[]>(row.cities, []),
    perRunTarget: num(row.perRunTarget),
    schedule,
    enabled: num(row.enabled) !== 0,
    createdAt: str(row.createdAt),
    cursor: parseJson<FeedCursor>(row.cursor, { hunted: [] }),
  };
}

function toRun(row: SqliteRow): FeedRun {
  return {
    id: str(row.id),
    feedId: str(row.feedId),
    startedAt: str(row.startedAt),
    finishedAt: optStr(row.finishedAt),
    status: str(row.status) as FeedRunStatus,
    found: num(row.found),
    newLeads: num(row.newLeads),
    delivered: num(row.delivered),
    bySource: parseJson<Record<string, number>>(row.bySource, {}),
    costNote: optStr(row.costNote),
    error: optStr(row.error),
  };
}

// ---------------------------------------------------------------- feeds CRUD

export function createFeed(input: CreateFeedInput): Feed {
  ensureTables();
  const schedule: FeedSchedule =
    input.schedule?.kind === "weekly"
      ? { kind: "weekly", weekday: ((Math.floor(input.schedule.weekday) % 7) + 7) % 7 }
      : { kind: "daily" };
  const feed: Feed = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    name: input.name,
    nichePackId: input.nichePackId,
    categories: Array.isArray(input.categories) ? input.categories.map(String) : [],
    cities: Array.isArray(input.cities) ? input.cities.map(String) : [],
    perRunTarget: clampInt(input.perRunTarget, 0),
    schedule,
    enabled: input.enabled === false ? false : true,
    createdAt: new Date().toISOString(),
    cursor: { hunted: [] },
  };
  getDb()
    .prepare(
      "INSERT INTO feeds (id, workspaceId, name, nichePackId, categories, cities, perRunTarget, schedule, enabled, createdAt, cursor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      feed.id,
      feed.workspaceId,
      feed.name,
      feed.nichePackId,
      json(feed.categories),
      json(feed.cities),
      feed.perRunTarget,
      json(feed.schedule),
      feed.enabled ? 1 : 0,
      feed.createdAt,
      json(feed.cursor)
    );
  return feed;
}

export function getFeed(id: string): Feed | undefined {
  ensureTables();
  const row = getDb().prepare("SELECT * FROM feeds WHERE id = ?").get(id);
  return row ? toFeed(row as SqliteRow) : undefined;
}

export function listFeeds(filter: { workspaceId?: string } = {}): Feed[] {
  ensureTables();
  const rows = filter.workspaceId
    ? getDb().prepare("SELECT * FROM feeds WHERE workspaceId = ? ORDER BY createdAt ASC, rowid ASC").all(filter.workspaceId)
    : getDb().prepare("SELECT * FROM feeds ORDER BY createdAt ASC, rowid ASC").all();
  return (rows as SqliteRow[]).map(toFeed);
}

export function setFeedEnabled(id: string, enabled: boolean): Feed | undefined {
  ensureTables();
  const current = getFeed(id);
  if (!current) return undefined;
  getDb().prepare("UPDATE feeds SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  return { ...current, enabled };
}

function updateCursor(id: string, cursor: FeedCursor): void {
  getDb().prepare("UPDATE feeds SET cursor = ? WHERE id = ?").run(json(cursor), id);
}

// ---------------------------------------------------------------- runs

export function listFeedRuns(feedId: string): FeedRun[] {
  ensureTables();
  const rows = getDb()
    .prepare("SELECT * FROM feed_runs WHERE feedId = ? ORDER BY startedAt DESC, rowid DESC")
    .all(feedId);
  return (rows as SqliteRow[]).map(toRun);
}

function getRun(id: string): FeedRun | undefined {
  const row = getDb().prepare("SELECT * FROM feed_runs WHERE id = ?").get(id);
  return row ? toRun(row as SqliteRow) : undefined;
}

function latestRun(feedId: string): FeedRun | undefined {
  const row = getDb()
    .prepare("SELECT * FROM feed_runs WHERE feedId = ? ORDER BY startedAt DESC, rowid DESC LIMIT 1")
    .get(feedId);
  return row ? toRun(row as SqliteRow) : undefined;
}

function findRunOnDay(feedId: string, day: string): FeedRun | undefined {
  const rows = getDb()
    .prepare("SELECT * FROM feed_runs WHERE feedId = ? ORDER BY startedAt DESC, rowid DESC")
    .all(feedId) as SqliteRow[];
  const row = rows.find((r) => str(r.startedAt).slice(0, 10) === day);
  return row ? toRun(row) : undefined;
}

function insertRun(run: FeedRun): void {
  getDb()
    .prepare(
      "INSERT INTO feed_runs (id, feedId, startedAt, finishedAt, status, found, newLeads, delivered, bySource, costNote, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      run.id,
      run.feedId,
      run.startedAt,
      nullable(run.finishedAt),
      run.status,
      run.found,
      run.newLeads,
      run.delivered,
      json(run.bySource),
      nullable(run.costNote),
      nullable(run.error)
    );
}

function updateRun(
  id: string,
  patch: Partial<Pick<FeedRun, "finishedAt" | "status" | "found" | "newLeads" | "delivered" | "bySource" | "costNote" | "error">>
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.finishedAt !== undefined) { fields.push("finishedAt = ?"); values.push(nullable(patch.finishedAt)); }
  if (patch.status !== undefined) { fields.push("status = ?"); values.push(patch.status); }
  if (patch.found !== undefined) { fields.push("found = ?"); values.push(patch.found); }
  if (patch.newLeads !== undefined) { fields.push("newLeads = ?"); values.push(patch.newLeads); }
  if (patch.delivered !== undefined) { fields.push("delivered = ?"); values.push(patch.delivered); }
  if (patch.bySource !== undefined) { fields.push("bySource = ?"); values.push(json(patch.bySource)); }
  if (patch.costNote !== undefined) { fields.push("costNote = ?"); values.push(nullable(patch.costNote)); }
  if (patch.error !== undefined) { fields.push("error = ?"); values.push(nullable(patch.error)); }
  if (fields.length === 0) return;
  values.push(id);
  getDb().prepare(`UPDATE feed_runs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

// ---------------------------------------------------------------- delivered

function listDeliveredKeys(feedId: string): string[] {
  const rows = getDb().prepare("SELECT bizKey FROM delivered_leads WHERE feedId = ?").all(feedId) as SqliteRow[];
  return rows.map((r) => str(r.bizKey));
}

function insertDelivered(feedId: string, bizKey: string, leadId: string, deliveredAt: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO delivered_leads (feedId, bizKey, leadId, deliveredAt) VALUES (?, ?, ?, ?)")
    .run(feedId, bizKey, leadId, deliveredAt);
}

// ---------------------------------------------------------------- targets

function targetHistoryKey(target: HuntTarget): string {
  return `${str(target.category).trim().toLowerCase()}|${str(target.city).trim().toLowerCase()}|${str(target.area ?? "").trim().toLowerCase()}`;
}

function filterTargets(targets: HuntTarget[], categories: string[], cities: string[]): HuntTarget[] {
  const cats = new Set(categories.map((c) => c.trim().toLowerCase()));
  const citySet = new Set(cities.map((c) => c.trim().toLowerCase()));
  return targets.filter((t) => {
    if (cats.size > 0 && !cats.has(t.category.trim().toLowerCase())) return false;
    if (citySet.size > 0 && !citySet.has(t.city.trim().toLowerCase())) return false;
    return true;
  });
}

// ---------------------------------------------------------------- discovery / process defaults

/**
 * Real channel runner, OFF unless LEADSCOUT_FEEDS_LIVE=1. When off, no network
 * call is made: the source is reported as disabled and the run simply finds
 * nothing. When on, it delegates to `channels/registry.runDiscovery`.
 */
async function defaultRunDiscovery(
  q: DiscoverQuery,
  deps: ChannelDeps,
  opts?: { callBudget?: number }
): Promise<DiscoveryResult> {
  if (process.env.LEADSCOUT_FEEDS_LIVE !== "1") {
    return {
      leads: [],
      runs: [{ id: "feed-discovery-off", ok: false, error: "feed discovery is off (set LEADSCOUT_FEEDS_LIVE=1)", leads: 0 }],
      callsUsed: 0,
    };
  }
  const registry = await import("./channels/registry.js");
  return registry.runDiscovery(q, deps, opts ?? {});
}

/** Import the new leads into the workspace, then run the same stage runner as POST /process. */
async function defaultProcessLeads(feed: Feed, leads: RawLead[], pipelineDeps?: Partial<PipelineDeps>): Promise<string[]> {
  const store = await import("./store.js");
  const ids: string[] = [];
  for (const raw of leads) {
    ids.push(store.upsertLead({ ...raw, workspaceId: feed.workspaceId }).id);
  }
  const { runJob } = await import("./pipeline.js");
  const job = store.createJob(feed.workspaceId, { category: "feed", limit: Math.max(1, leads.length) });
  await runJob(feed.workspaceId, job.id, pipelineDeps ?? {}, { leads });
  return ids;
}

// ---------------------------------------------------------------- runFeed

/**
 * Run one feed: hunt fresh (category, city, area) targets from the feed cursor,
 * collect `perRunTarget` candidates not already delivered, import + process them,
 * mark them delivered, rotate the cursor and write the run row. A failing source
 * never fails the run (its error is recorded). Idempotent within a calendar day:
 * a second call the same day returns the earlier run row, unless that run
 * delivered nothing and holds source errors (then a new run starts).
 */
export async function runFeed(feedId: string, deps: FeedDeps = {}): Promise<FeedRun> {
  ensureTables();
  const feed = getFeed(feedId);
  if (!feed) throw new Error(`feed not found: ${feedId}`);

  const now = deps.now ? deps.now() : new Date();
  const today = now.toISOString().slice(0, 10);

  // Idempotent within a calendar day, but a failed or empty run never blocks a
  // retry: only a finished run that delivered leads or has no source errors
  // stands (a leftover "running" row never stands).
  const earlier = findRunOnDay(feedId, today);
  if (
    earlier &&
    earlier.status === "done" &&
    (earlier.newLeads >= 1 || earlier.delivered >= 1 || !runHasSourceErrors(earlier))
  ) {
    return earlier;
  }

  const runId = randomUUID();
  insertRun({
    id: runId,
    feedId,
    startedAt: now.toISOString(),
    status: "running",
    found: 0,
    newLeads: 0,
    delivered: 0,
    bySource: {},
  });

  const maxTargets = clampInt(deps.maxTargets, 40);
  const maxCandidates = clampInt(deps.maxCandidates, 200);
  const loadPack = deps.loadPack ?? loadNichePack;
  const runDisc = deps.runDiscovery ?? defaultRunDiscovery;
  const bizKeyOf = deps.bizKeyOf ?? feedBizKey;
  const processLeads = deps.processLeads;

  const adapters = await resolveAdapters(deps);
  const disabledCount = adapters ? adapters.filter((a) => !adapterEnabled(a)).length : 0;

  const errors: string[] = [];

  // Real ChannelDeps only when nothing was injected and live mode is on;
  // injected deps always win so checks stay offline.
  let channelDeps = deps.channelDeps;
  if (!channelDeps && process.env.LEADSCOUT_FEEDS_LIVE === "1") {
    try {
      channelDeps = await (deps.makeLiveDeps ?? liveDepsFactory)();
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : String(err);
      errors.push(`live deps: ${message}`);
    }
  }

  const bySource: Record<string, number> = {};
  const deliveredSet = new Set(listDeliveredKeys(feedId));
  const candidateKeys = new Set<string>();
  const candidates: RawLead[] = [];
  const hunted: string[] = [];
  let found = 0;
  let rawCount = 0;

  try {
    const pack = loadPack(feed.nichePackId);
    const targets = filterTargets(nextHuntTargets(pack, feed.cursor.hunted ?? []), feed.categories, feed.cities).slice(
      0,
      maxTargets
    );

    for (const target of targets) {
      if (candidates.length >= feed.perRunTarget) break;
      if (rawCount >= maxCandidates) break;
      // Skip before any work when no enabled adapter lists this category.
      if (adapters && !adapters.some((a) => adapterEnabled(a) && adapterListsCategory(a, target.category))) {
        hunted.push(targetHistoryKey(target));
        continue;
      }
      hunted.push(targetHistoryKey(target));
      try {
        const result = await runDisc(
          { category: target.category, city: target.city, area: target.area, limit: feed.perRunTarget - candidates.length },
          channelDeps as ChannelDeps,
          {}
        );
        for (const r of result.runs ?? []) {
          if (r.ok === false && r.error) {
            // Disabled-adapter noise is counted once below, never copied per target.
            if (adapters && isDisabledReport(r.error)) continue;
            errors.push(`source ${r.id}: ${r.error}`);
          }
        }
        for (const raw of result.leads ?? []) {
          if (rawCount >= maxCandidates) break;
          rawCount += 1;
          found += 1;
          const key = bizKeyOf(raw);
          if (deliveredSet.has(key) || candidateKeys.has(key)) continue;
          candidateKeys.add(key);
          candidates.push(raw);
          bySource[raw.source] = (bySource[raw.source] ?? 0) + 1;
          if (candidates.length >= feed.perRunTarget) break;
        }
      } catch (err) {
        const message = err instanceof Error && err.message ? err.message : String(err);
        errors.push(`source ${target.category}/${target.city}/${target.area ?? ""}: ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    errors.push(`feed setup: ${message}`);
  }

  const selected = candidates.slice(0, feed.perRunTarget);
  let delivered = 0;
  if (selected.length > 0) {
    try {
      const ids = processLeads
        ? await processLeads(feed, selected)
        : await defaultProcessLeads(feed, selected, deps.pipelineDeps);
      const deliveredAt = new Date().toISOString();
      selected.forEach((raw, index) => {
        insertDelivered(feedId, bizKeyOf(raw), ids[index] ?? "", deliveredAt);
        delivered += 1;
      });
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : String(err);
      errors.push(`process: ${message}`);
    }
  }

  if (adapters && disabledCount > 0) errors.push(`skipped ${disabledCount} disabled adapters`);

  updateCursor(feedId, { hunted: [...(feed.cursor.hunted ?? []), ...hunted] });
  updateRun(runId, {
    finishedAt: new Date().toISOString(),
    status: "done",
    found,
    newLeads: selected.length,
    delivered,
    bySource,
    error: dedupErrorText(errors),
  });

  return getRun(runId) as FeedRun;
}

// ---------------------------------------------------------------- scheduling

/** Enabled feeds that have not yet run today and whose daily/weekly schedule is due. */
export function dueFeeds(now: Date = new Date()): Feed[] {
  ensureTables();
  const today = now.toISOString().slice(0, 10);
  const weekday = now.getUTCDay();
  const due: Feed[] = [];
  for (const feed of listFeeds()) {
    if (!feed.enabled) continue;
    const last = latestRun(feed.id);
    if (last && last.startedAt.slice(0, 10) === today) continue;
    if (feed.schedule.kind === "daily" || feed.schedule.weekday === weekday) due.push(feed);
  }
  return due;
}
