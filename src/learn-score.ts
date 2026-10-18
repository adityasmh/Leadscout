// src/learn-score.ts
// L30-wiring-3: per-workspace, win-trained scoring.
//
// Records lead outcome events in a lazily-created `lead_events` table (via getDb() from
// store.ts, which is NOT edited), trains a per-workspace online logistic model over signal
// ids and service fits predicting won/replied (1) versus rejected (0), and blends the learned
// score toward the rule score by the number of labelled outcomes:
//   < 30           -> rule score, unchanged (source "rules")
//   30..200        -> linear ramp up to 70% learned (source "blend")
//   > 200          -> 70% learned (source "learned")
// Strict workspace isolation: every query is scoped by workspaceId.
//
// Node 24 built-ins only; ES modules with .js import suffixes.

// @ts-ignore node:sqlite is a Node 24 built-in; ambient types may be absent.
import { DatabaseSync } from "node:sqlite";
import { getDb } from "./store.js";
import type { FitService, Lead } from "./types.js";

export type LearnedSource = "rules" | "blend" | "learned";

export type LearnedScore = {
  score: number;
  source: LearnedSource;
  topReasons: string[];
  outcomes: number; // labelled outcomes in this workspace
  weight: number;   // fraction of the final score that came from the learned model
};

export type CalibrationBucket = {
  bucket: string;        // "0-20" ... "80-100"
  n: number;
  meanPredicted: number; // 0-100
  actualRate: number;    // 0-1, fraction won/replied
};

export type ModelSnapshot = {
  outcomes: number;
  bias: number;
  weights: Record<string, number>; // keys: "sig:<id>" / "svc:<service>"
};

// Blending thresholds and model hyper-parameters. L2 is deliberately strong so a handful of
// outcomes cannot move the score far.
const MIN_OUTCOMES = 30;
const FULL_OUTCOMES = 200;
const MAX_WEIGHT = 0.7;
const L2 = 0.1;
const LR = 0.2;
const EPOCHS = 4;

const SIGNAL_PHRASES: Record<string, string> = {
  "no-website": "not having a website",
  "no-https": "having no HTTPS",
  "not-mobile-friendly": "not being mobile friendly",
  "no-contact-form": "having no contact form",
  "no-chat-widget": "having no chat widget",
  "no-online-booking": "no booking widget",
  "no-analytics": "having no analytics",
  "outdated-copyright": "an outdated copyright year",
  wordpress: "running WordPress",
  wix: "running Wix",
  shopify: "running Shopify",
  "custom-cms": "running a custom CMS",
  "has-whatsapp": "having a WhatsApp link",
  "has-email": "having an email address",
  "has-phone": "having a phone number",
  "social-active-links": "active social links",
  "slow-response": "a slow site",
  "site-unreachable": "an unreachable site",
  ecommerce: "being an e-commerce business",
  "appointment-based": "being appointment based",
  "high-volume-enquiry-type": "being a high-volume enquiry type",
};

type EventRow = { signals: string | null; fit: string | null; status: string };

function ensureEventsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leadId TEXT NOT NULL,
      workspaceId TEXT NOT NULL,
      status TEXT NOT NULL,
      at TEXT NOT NULL,
      signals TEXT NOT NULL DEFAULT '[]',
      fit TEXT NOT NULL DEFAULT '[]'
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_lead_events_ws ON lead_events(workspaceId);");
}

function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** won/replied = 1, rejected = 0, anything else is not a label. */
function labelOf(status: string | undefined): 0 | 1 | null {
  if (status === "won" || status === "replied") return 1;
  if (status === "rejected") return 0;
  return null;
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Binary features for each present signal id, value fit/100 for each service fit. */
function featuresOf(signals: unknown, fit: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (Array.isArray(signals)) {
    for (const s of signals) {
      if (typeof s === "string" && s !== "") out["sig:" + s] = 1;
    }
  }
  if (Array.isArray(fit)) {
    for (const f of fit) {
      const svc = (f as FitService)?.service;
      if (typeof svc !== "string" || svc === "") continue;
      const raw = Number((f as FitService)?.score);
      const value = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw / 100)) : 0;
      if (value > 0) out["svc:" + svc] = value;
    }
  }
  return out;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function zOf(model: { bias: number; weights: Record<string, number> }, x: Record<string, number>): number {
  let z = model.bias;
  for (const k of Object.keys(x)) z += (model.weights[k] ?? 0) * x[k];
  return z;
}

/** One online SGD pass sequence over the events, repeated for a stable fit. */
function trainModel(events: EventRow[]): { bias: number; weights: Record<string, number> } {
  const weights: Record<string, number> = {};
  let bias = 0;
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    for (const ev of events) {
      const x = featuresOf(parseJsonArray(ev.signals), parseJsonArray(ev.fit));
      const keys = Object.keys(x);
      if (keys.length === 0) {
        bias += LR * ((labelOf(ev.status) ?? 0) - sigmoid(bias));
        continue;
      }
      const p = sigmoid(zOf({ bias, weights }, x));
      const g = (labelOf(ev.status) ?? 0) - p;
      bias += LR * g;
      for (const k of keys) {
        const w0 = weights[k] ?? 0;
        weights[k] = w0 + LR * (g * x[k] - L2 * w0);
      }
    }
  }
  return { bias, weights };
}

function labelledEvents(workspaceId: string): EventRow[] {
  const db = getDb();
  ensureEventsTable(db);
  const rows = db.prepare(
    `SELECT signals, fit, status FROM lead_events
      WHERE workspaceId = ? AND status IN ('won', 'replied', 'rejected')
      ORDER BY id ASC`
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    signals: typeof r.signals === "string" ? r.signals : null,
    fit: typeof r.fit === "string" ? r.fit : null,
    status: String(r.status ?? ""),
  }));
}

function phraseFor(key: string): string {
  if (key.startsWith("sig:")) {
    const id = key.slice(4);
    return SIGNAL_PHRASES[id] ?? id.replace(/-/g, " ");
  }
  if (key.startsWith("svc:")) return `service "${key.slice(4)}"`;
  return key;
}

function blendWeight(n: number): number {
  if (n < MIN_OUTCOMES) return 0;
  if (n > FULL_OUTCOMES) return MAX_WEIGHT;
  return (MAX_WEIGHT * (n - MIN_OUTCOMES)) / (FULL_OUTCOMES - MIN_OUTCOMES);
}

function topReasons(model: { bias: number; weights: Record<string, number> }, x: Record<string, number>, weight: number): string[] {
  const z = zOf(model, x);
  const full = sigmoid(z);
  const items: { pts: number; reason: string }[] = [];
  for (const k of Object.keys(x)) {
    const w = model.weights[k] ?? 0;
    if (Math.abs(w) < 1e-9) continue;
    const without = sigmoid(z - w * x[k]);
    const pts = (full - without) * 100 * weight;
    if (Math.abs(pts) < 1) continue;
    const dir = pts > 0 ? "raised" : "lowered";
    items.push({
      pts,
      reason: `${phraseFor(k)} ${dir} the chance by ${Math.abs(Math.round(pts))} points for this workspace`,
    });
  }
  items.sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts));
  return items.slice(0, 3).map((i) => i.reason);
}

// ------------------------------------------------------------------ public API

/**
 * Record a status change for a lead, capturing the signals and service fits at that time.
 * Only won/replied and rejected are labels; every other status is stored but not trained on.
 * Repeated identical statuses for the same lead are ignored (no duplicate noise).
 */
export function recordStatusChange(
  workspaceId: string,
  lead: { id?: string; status?: Lead["status"]; signals?: string[]; fit?: FitService[] },
  status?: Lead["status"]
): { recorded: boolean; label: 0 | 1 | null } {
  const resolved = status ?? lead?.status;
  const leadId = lead?.id;
  const label = labelOf(resolved);
  if (!workspaceId || !leadId || !resolved) return { recorded: false, label: null };
  const db = getDb();
  ensureEventsTable(db);
  const last = db.prepare(
    "SELECT status FROM lead_events WHERE workspaceId = ? AND leadId = ? ORDER BY id DESC LIMIT 1"
  ).get(workspaceId, leadId) as { status?: unknown } | undefined;
  if (last && String(last.status) === resolved) return { recorded: false, label };
  db.prepare(
    `INSERT INTO lead_events (leadId, workspaceId, status, at, signals, fit) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    leadId,
    workspaceId,
    resolved,
    new Date().toISOString(),
    JSON.stringify(Array.isArray(lead?.signals) ? lead.signals : []),
    JSON.stringify(Array.isArray(lead?.fit) ? lead.fit : [])
  );
  return { recorded: true, label };
}

/**
 * The learned score for one lead. `source` says which of rules/blend/learned produced it.
 * `topReasons` name the signals that moved the score (only when the model is active).
 */
export function learnedScore(
  workspaceId: string,
  lead: Pick<Lead, "signals" | "fit" | "score">,
  ruleScore?: number
): LearnedScore {
  const rule = typeof ruleScore === "number" && Number.isFinite(ruleScore)
    ? clamp100(ruleScore)
    : clamp100(Number.isFinite(lead?.score) ? Number(lead?.score) : 0);

  const events = labelledEvents(workspaceId);
  const n = events.length;
  const weight = blendWeight(n);
  if (weight <= 0) {
    return { score: rule, source: "rules", topReasons: [], outcomes: n, weight: 0 };
  }
  const model = trainModel(events);
  const x = featuresOf(lead?.signals, lead?.fit);
  const learned = Math.round(sigmoid(zOf(model, x)) * 100);
  const score = clamp100(Math.round((1 - weight) * rule + weight * learned));
  const source: LearnedSource = n > FULL_OUTCOMES ? "learned" : "blend";
  return { score, source, topReasons: topReasons(model, x, weight), outcomes: n, weight };
}

/** Predicted win probability (0-1) for a lead under the workspace's current model. */
export function predictProbability(workspaceId: string, lead: Pick<Lead, "signals" | "fit">): number {
  const events = labelledEvents(workspaceId);
  if (events.length === 0) return 0.5;
  const model = trainModel(events);
  return sigmoid(zOf(model, featuresOf(lead?.signals, lead?.fit)));
}

/** The learned weights for a workspace (for inspection/tests). */
export function learnedWeights(workspaceId: string): ModelSnapshot {
  const events = labelledEvents(workspaceId);
  const model = trainModel(events);
  return { outcomes: events.length, bias: model.bias, weights: model.weights };
}

/** Bucket predicted scores and compare each bucket's mean prediction with the actual win rate. */
export function calibration(workspaceId: string): CalibrationBucket[] {
  const events = labelledEvents(workspaceId);
  if (events.length === 0) return [];
  const model = trainModel(events);
  const bins = [
    { n: 0, sum: 0, wins: 0 },
    { n: 0, sum: 0, wins: 0 },
    { n: 0, sum: 0, wins: 0 },
    { n: 0, sum: 0, wins: 0 },
    { n: 0, sum: 0, wins: 0 },
  ];
  for (const ev of events) {
    const p = sigmoid(zOf(model, featuresOf(parseJsonArray(ev.signals), parseJsonArray(ev.fit))));
    const idx = Math.min(4, Math.max(0, Math.floor(p * 5)));
    bins[idx].n += 1;
    bins[idx].sum += p;
    if ((labelOf(ev.status) ?? 0) === 1) bins[idx].wins += 1;
  }
  const lo = [0, 20, 40, 60, 80];
  const hi = [20, 40, 60, 80, 100];
  const out: CalibrationBucket[] = [];
  for (let i = 0; i < 5; i++) {
    if (bins[i].n === 0) continue;
    out.push({
      bucket: `${lo[i]}-${hi[i]}`,
      n: bins[i].n,
      meanPredicted: Math.round((bins[i].sum / bins[i].n) * 1000) / 10,
      actualRate: Math.round((bins[i].wins / bins[i].n) * 1000) / 1000,
    });
  }
  return out;
}

/**
 * One-line hook for score.ts: returns the blended total and its reasons, or undefined when
 * there is nothing to add (no workspace, under 30 outcomes, or the blend did not move the score).
 */
export function blendLearnedScore(
  workspaceId: string | undefined,
  lead: Lead,
  ruleTotal: number
): { total: number; reasons: string[] } | undefined {
  if (!workspaceId) return undefined;
  let r: LearnedScore;
  try {
    r = learnedScore(workspaceId, lead, ruleTotal);
  } catch {
    return undefined; // learning is best-effort; never break rule scoring
  }
  if (r.source === "rules" || r.weight <= 0 || r.score === ruleTotal) return undefined;
  const reasons = [
    `learned: score ${r.score} from ${r.outcomes} workspace outcomes (${r.source})`,
    ...r.topReasons,
  ];
  return { total: r.score, reasons };
}
