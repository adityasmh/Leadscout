// src/source-trust.ts
// Order ST1-source-trust: per-business-category source trust scoring.
//
// Learns which channels yield correct contacts, per business category.
// A channel's trust is a Beta posterior in [0, 1] with a confidence:
//   - prior seeded from data/source-trust-seed.json, weight = 4 pseudo-observations;
//   - exponential time decay, half life 30 days;
//   - small category samples shrink toward the channel average.
// Outcomes come from verify.ts (website alive, phone valid, email has MX) and an
// operator flag. Persisted as compact JSON with atomic writes. Node 24 built-ins
// only; imports use the .js suffix. Every outside integration is off unless a
// named env var switches it on; this module makes NO network calls.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedTrustPrior } from "./trust-shared-prior.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE_PATH = join(HERE, "..", "data", "source-trust.json");
const SEED_PATH = join(HERE, "..", "data", "source-trust-seed.json");

const DEFAULT_PSEUDO_OBSERVATIONS = 4;
const DEFAULT_HALF_LIFE_DAYS = 30;
const EXPLAIN_WINDOW_DAYS = 30;
/** Weight of the published cross-customer lesson in the category prior mean;
 * the rest stays on the seed prior, so an absent lesson changes nothing. */
const SHARED_PRIOR_WEIGHT = 0.5;

// -------------------------------------------------------------------- types

export type Outcome = {
  channel: string;
  category: string;
  field: string; // "phone" | "email" | "website" | ...
  ok: boolean;
  at: string; // ISO time the outcome was observed
};

export type Beta = { alpha: number; beta: number };

export type TrustScore = {
  channel: string;
  category: string;
  score: number; // 0..1, the Beta posterior mean after decay + shrinkage
  confidence: number; // 0..1, grows with the decayed category sample size
  checks: number; // raw recorded outcomes for this channel + category
  observations: number; // decayed effective category sample size
  hasData: boolean; // true when any outcome was recorded for this channel + category
};

export type Seed = {
  version: number;
  pseudoObservations: number;
  halfLifeDays: number;
  defaultPrior: number;
  names: Record<string, string>;
  channels: Record<string, { prior: number; categories?: Record<string, number> }>;
};

type Store = { version: number; updatedAt: string; outcomes: Outcome[] };

// ------------------------------------------------------------------ seed load

let cachedSeed: Seed | null = null;

function seed(): Seed {
  if (cachedSeed) return cachedSeed;
  let parsed: Partial<Seed> = {};
  try {
    parsed = JSON.parse(readFileSync(SEED_PATH, "utf8")) as Partial<Seed>;
  } catch {
    parsed = {};
  }
  cachedSeed = {
    version: Number(parsed.version ?? 1),
    pseudoObservations: Number(parsed.pseudoObservations ?? DEFAULT_PSEUDO_OBSERVATIONS),
    halfLifeDays: Number(parsed.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS),
    defaultPrior: Number(parsed.defaultPrior ?? 0.5),
    names: parsed.names ?? {},
    channels: parsed.channels ?? {},
  };
  return cachedSeed;
}

export function pseudoObservations(): number {
  return seed().pseudoObservations;
}

export function halfLifeDays(): number {
  return seed().halfLifeDays;
}

/** Prior mean for a channel, category: a per-category override, else the channel
 * prior, else the seed default. */
function priorMean(channel: string, category: string): number {
  const ch = seed().channels[channel];
  const override = ch?.categories?.[category];
  if (typeof override === "number") return clamp01(override);
  if (ch && typeof ch.prior === "number") return clamp01(ch.prior);
  return clamp01(seed().defaultPrior);
}

/** Prior mean for a channel across categories (channel average prior). */
function channelPriorMean(channel: string): number {
  const ch = seed().channels[channel];
  if (ch && typeof ch.prior === "number") return clamp01(ch.prior);
  return clamp01(seed().defaultPrior);
}

function priorBeta(mean: number, weight: number): Beta {
  const alpha = weight * mean;
  const beta = weight * (1 - mean);
  return { alpha, beta };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function displayName(channel: string): string {
  return seed().names[channel] ?? channel;
}

// ---------------------------------------------------------- pure math helpers

/** Exponential decay weight for an outcome at time `at`, observed at `now`.
 * Weight is 1 at age 0 and 0.5 after one half life. Future times clamp to 1. */
export function decayWeight(at: string, now: Date, halfLife = halfLifeDays()): number {
  const ms = now.getTime() - new Date(at).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  const ageDays = ms / (24 * 60 * 60 * 1000);
  if (halfLife <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLife);
}

/** Exact Beta update: posterior = prior counts + observed (decayed) counts. */
export function betaPosterior(prior: Beta, decayedOk: number, decayedFail: number): Beta {
  return { alpha: prior.alpha + decayedOk, beta: prior.beta + decayedFail };
}

export function betaMean(b: Beta): number {
  const total = b.alpha + b.beta;
  if (total <= 0) return 0;
  return b.alpha / total;
}

// ------------------------------------------------------------------- storage

let cachedOutcomes: Outcome[] | null = null;

function storePath(): string {
  return process.env.LEADSCOUT_SOURCE_TRUST_PATH || DEFAULT_STORE_PATH;
}

function normalizeOutcome(o: Outcome): Outcome {
  return {
    channel: String(o.channel ?? "").trim(),
    category: String(o.category ?? "").trim().toLowerCase(),
    field: String(o.field ?? "").trim().toLowerCase(),
    ok: Boolean(o.ok),
    at: String(o.at ?? "").trim() || new Date().toISOString(),
  };
}

function loadOutcomes(): Outcome[] {
  if (cachedOutcomes) return cachedOutcomes;
  let parsed: Partial<Store> = {};
  try {
    parsed = JSON.parse(readFileSync(storePath(), "utf8")) as Partial<Store>;
  } catch {
    parsed = {};
  }
  cachedOutcomes = Array.isArray(parsed.outcomes) ? parsed.outcomes.map(normalizeOutcome) : [];
  return cachedOutcomes;
}

function saveOutcomes(): void {
  const data: Store = {
    version: 1,
    updatedAt: new Date().toISOString(),
    outcomes: cachedOutcomes ?? [],
  };
  atomicWriteJsonSync(storePath(), data);
}

/** Reset the in-memory caches (tests only). Does not delete the file. */
export function resetSourceTrust(): void {
  cachedSeed = null;
  cachedOutcomes = null;
}

export type AtomicWriteDeps = {
  writeFileFn?: (path: string, data: string, encoding: BufferEncoding) => void;
  renameFn?: (from: string, to: string) => void;
  unlinkFn?: (path: string) => void;
  mkdirFn?: (path: string, opts: { recursive: boolean }) => void;
};

/** Write compact JSON: temp file in the target directory, then rename over the
 * target. An injected write/rename that throws simulates a crash and must leave
 * the target untouched with no leftover temp file. */
export function atomicWriteJsonSync(path: string, data: unknown, deps: AtomicWriteDeps = {}): void {
  const writeFileFn = deps.writeFileFn ?? ((p: string, d: string, e: BufferEncoding) => writeFileSync(p, d, e));
  const renameFn = deps.renameFn ?? ((from: string, to: string) => renameSync(from, to));
  const unlinkFn = deps.unlinkFn ?? ((p: string) => unlinkSync(p));
  const mkdirFn = deps.mkdirFn ?? ((p: string, o: { recursive: boolean }) => mkdirSync(p, o));
  const dir = dirname(path);
  mkdirFn(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    writeFileFn(tmp, JSON.stringify(data), "utf8");
    renameFn(tmp, path);
  } catch (err) {
    try {
      unlinkFn(tmp);
    } catch {
      /* best effort: temp may not exist */
    }
    throw err;
  }
}

// ------------------------------------------------------------------ outcomes

/** Record one outcome (upsert-free: every outcome is a real observation). */
export function recordOutcome(o: Outcome): Outcome {
  const normalized = normalizeOutcome(o);
  const list = loadOutcomes();
  list.push(normalized);
  saveOutcomes();
  return normalized;
}

/** Operator flag: the UI can call this when a human finds a wrong contact.
 * `leadId` is for the caller's audit trail; the category is passed in `opts`
 * (the UI has the lead). Without a category it is recorded under "any". */
export function flagWrongContact(
  leadId: string,
  channel: string,
  field: string,
  opts: { category?: string; at?: string } = {}
): Outcome {
  void leadId;
  return recordOutcome({
    channel,
    category: opts.category ?? "any",
    field,
    ok: false,
    at: opts.at ?? new Date().toISOString(),
  });
}

/** Minimal shapes accepted by outcomesFromVerification: a verification result
 * carried on the lead (or on the evidence) plus the evidence source channel. */
export type VerificationLike = {
  website?: "alive" | "dead" | "none" | "not-checked";
  emails?: { value: string; result: string }[];
  phones?: { value: string; result: string }[];
};

export type LeadLike = { category?: string; verification?: VerificationLike };
export type EvidenceLike = { channel?: string; category?: string; verification?: VerificationLike; duplicatePhones?: string[] };

/** Turn one verification result plus the evidence source channel into outcome
 * records. Returns [] when there is no verification or no channel. This is the
 * adapter the pipeline would call; exported for the caller (see report). */
export function outcomesFromVerification(
  lead: LeadLike,
  evidence: EvidenceLike,
  opts: { at?: string } = {}
): Outcome[] {
  const v = lead?.verification ?? evidence?.verification;
  const channel = String(evidence?.channel ?? "").trim();
  if (!v || !channel) return [];
  const category = String(lead?.category ?? evidence?.category ?? "any").trim().toLowerCase();
  const at = opts.at ?? new Date().toISOString();
  const duplicates = new Set((evidence?.duplicatePhones ?? []).map((p) => String(p).trim()));
  const out: Outcome[] = [];

  if (v.website === "alive" || v.website === "dead") {
    out.push({ channel, category, field: "website", ok: v.website === "alive", at });
  }
  for (const email of v.emails ?? []) {
    out.push({ channel, category, field: "email", ok: email.result === "ok", at });
  }
  for (const phone of v.phones ?? []) {
    const valid = phone.result === "mobile" || phone.result === "landline";
    const duplicate = duplicates.has(String(phone.value).trim());
    out.push({ channel, category, field: "phone", ok: valid && !duplicate, at });
  }
  return out;
}

// ---------------------------------------------------------------- trust score

/** Trust for one channel in one category. Decayed Beta posterior with the
 * category sample shrunk toward the channel average. */
export function trust(
  channel: string,
  category: string,
  opts: {
    now?: Date;
    sharedPrior?: (channel: string, category: string) => number | undefined;
  } = {}
): TrustScore {
  const ch = String(channel ?? "").trim();
  const cat = String(category ?? "").trim().toLowerCase();
  const now = opts.now ?? new Date();
  const all = loadOutcomes();
  const weight = pseudoObservations();

  let nCat = 0;
  let sCat = 0;
  let checks = 0;
  for (const o of all) {
    if (o.channel !== ch || o.category !== cat) continue;
    checks += 1;
    const w = decayWeight(o.at, now);
    nCat += w;
    if (o.ok) sCat += w;
  }
  let nAll = 0;
  let sAll = 0;
  for (const o of all) {
    if (o.channel !== ch) continue;
    const w = decayWeight(o.at, now);
    nAll += w;
    if (o.ok) sAll += w;
  }

  const seed = priorMean(ch, cat);
  const shared = (opts.sharedPrior ?? sharedTrustPrior)(ch, cat);
  const priorMeanBlended = shared === undefined
    ? seed
    : SHARED_PRIOR_WEIGHT * shared + (1 - SHARED_PRIOR_WEIGHT) * seed;
  const catPrior = priorBeta(priorMeanBlended, weight);
  const chanPrior = priorBeta(channelPriorMean(ch), weight);
  const catMean = betaMean(betaPosterior(catPrior, sCat, nCat - sCat));
  const channelMean = betaMean(betaPosterior(chanPrior, sAll, nAll - sAll));

  // Shrink the small category sample toward the channel average with weight
  // equal to the prior weight (4 pseudo-observations).
  const alpha = catPrior.alpha + sCat + weight * channelMean;
  const beta = catPrior.beta + (nCat - sCat) + weight * (1 - channelMean);
  const score = clamp01(betaMean({ alpha, beta }));
  const confidence = clamp01(nCat / (nCat + weight));

  return {
    channel: ch,
    category: cat,
    score,
    confidence,
    checks,
    observations: nCat,
    hasData: checks > 0,
  };
}

// ------------------------------------------------------------------- ranking

export type Rankable = { id: string };
export type RankResult<T extends Rankable> = { order: T[]; changed: boolean; reason: string };

/** Rank adapters for a category: trust multiplied by the existing registry
 * rank (position weight, higher = earlier). Returns undefined when no adapter
 * in the list has recorded data, so the caller keeps the existing order. */
export function rankAdapters<T extends Rankable>(
  list: T[],
  category: string,
  opts: { now?: Date } = {}
): RankResult<T> | undefined {
  if (!Array.isArray(list) || list.length <= 1) return undefined;
  const now = opts.now ?? new Date();
  const total = list.length;
  const withData = list
    .map((a, i) => ({ a, i, t: trust(a.id, category, { now }) }))
    .filter((x) => x.t.hasData);
  if (withData.length === 0) return undefined;

  const scored = list.map((a, i) => {
    const t = trust(a.id, category, { now });
    const rankWeight = total - i; // existing registry rank as a positive weight
    const factor = t.hasData ? t.score : 1; // no data -> neutral, keeps position
    return { a, i, combined: factor * rankWeight };
  });
  scored.sort((x, y) => y.combined - x.combined || x.i - y.i);
  const order = scored.map((s) => s.a);
  const changed = order.some((a, i) => a.id !== list[i].id);
  const reason = changed ? order.map((a) => a.id).join(" > ") : "unchanged";
  return { order, changed, reason };
}

// ------------------------------------------------------------------- explain

const FIELD_LABELS: Record<string, string> = {
  phone: "phone numbers",
  email: "email addresses",
  website: "websites",
};

function pluralizeCategory(category: string): string {
  if (!category) return "businesses";
  return /s$/i.test(category) ? category : `${category}s`;
}

/** Plain sentence for the UI, e.g.
 * "JustDial: 72 percent of phone numbers verified for dentists (41 checks, last 30 days)". */
export function explain(channel: string, category: string, opts: { now?: Date } = {}): string {
  const ch = String(channel ?? "").trim();
  const cat = String(category ?? "").trim().toLowerCase();
  const now = opts.now ?? new Date();
  const name = displayName(ch);

  // The field with the most recorded outcomes for this channel + category.
  const counts = new Map<string, { total: number; ok: number; decayed: number; decayedOk: number }>();
  for (const o of loadOutcomes()) {
    if (o.channel !== ch || o.category !== cat) continue;
    const w = decayWeight(o.at, now);
    const c = counts.get(o.field) ?? { total: 0, ok: 0, decayed: 0, decayedOk: 0 };
    c.total += 1;
    if (o.ok) c.ok += 1;
    c.decayed += w;
    if (o.ok) c.decayedOk += w;
    counts.set(o.field, c);
  }
  const catLabel = pluralizeCategory(cat);
  if (counts.size === 0) {
    return `${name}: no checks recorded for ${catLabel} yet.`;
  }
  let bestField = "";
  let best = { total: 0, ok: 0, decayed: 0, decayedOk: 0 };
  for (const [field, c] of counts) {
    if (c.total > best.total || (c.total === best.total && field < bestField)) {
      bestField = field;
      best = c;
    }
  }
  const label = FIELD_LABELS[bestField] ?? `${bestField}s`;
  const pct = Math.round((best.decayedOk / best.decayed) * 100);
  return `${name}: ${pct} percent of ${label} verified for ${catLabel} (${best.total} checks, last ${EXPLAIN_WINDOW_DAYS} days)`;
}
