// src/match.ts
// L5-match: score a lead against what the seller offers.
//
// A transparent rule engine. No model calls, no network. The rules live in
// data/service-rules.json: each service lists the enrichment
// signals that raise its score and by how much, the business categories that are
// naturally high-need for it, and a one-line reason naming the signal that fired.
//
// Shape of the result (docs/leadgen/CONTRACT.md):
//   Match = { score: 0-100, fit: {service, score, reason}[], angle: string }
// The same lead scored against a different offer gives a different ranking,
// because only services in offer.services are scored and each service weighs the
// lead's signals differently.
//
// Node 24 built-ins only, ES module, .js import suffix.

import { readFileSync } from "node:fs";
import type { Enrichment, FitService, Match, Offer, RawLead } from "./types.js";

export type SignalKind = "gap" | "positive" | "platform" | "context";

export type SignalInfo = {
  kind: SignalKind;
  /** Plain-English line naming this signal, used as a fallback reason. */
  phrase: string;
};

export type ServiceRule = {
  id: string;
  label: string;
  /** Plain clause used when a service has none of its own signals present. */
  pitch: string;
  /** Points added when the lead's category is naturally high-need for this service. */
  categoryBonus?: number;
  categories?: string[];
  /** Signal id -> points added when that signal is present. */
  signals: Record<string, number>;
  /** Signal id -> one-line reason naming that signal. Optional per signal. */
  reasons?: Record<string, string>;
};

export type ScoringConfig = {
  max: number;
  /** The best service score is multiplied by this before reachability is added. */
  overallWeight: number;
  reach: { email: number; phone: number; whatsapp: number };
  /** Points removed when the listed site is dead (site-unreachable). */
  deadRoutePenalty: number;
  /** Overall score cap when the lead has no contact route at all. */
  unreachableCap: number;
};

export type ServiceRules = {
  version: number;
  note?: string;
  scoring: ScoringConfig;
  signals: Record<string, SignalInfo>;
  /** Fallback order used to name a signal when a service has none of its own. */
  searchOrder: string[];
  services: ServiceRule[];
};

export const DEFAULT_RULES_PATH = new URL("../data/service-rules.json", import.meta.url);

let cachedRules: ServiceRules | null = null;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateRules(raw: unknown): ServiceRules {
  const fail = (message: string): never => {
    throw new Error(`match: invalid service-rules.json: ${message}`);
  };
  if (!raw || typeof raw !== "object") fail("root is not an object");
  const obj = raw as ServiceRules;

  const scoring = obj.scoring;
  if (!scoring || typeof scoring !== "object") fail("missing scoring");
  if (!isFiniteNumber(scoring.max) || scoring.max <= 0) fail("scoring.max must be a positive number");
  if (!isFiniteNumber(scoring.overallWeight)) fail("scoring.overallWeight must be a number");
  if (!scoring.reach || typeof scoring.reach !== "object") fail("missing scoring.reach");
  for (const key of ["email", "phone", "whatsapp"] as const) {
    if (!isFiniteNumber(scoring.reach[key])) fail(`scoring.reach.${key} must be a number`);
  }
  if (!isFiniteNumber(scoring.deadRoutePenalty)) fail("scoring.deadRoutePenalty must be a number");
  if (!isFiniteNumber(scoring.unreachableCap)) fail("scoring.unreachableCap must be a number");

  if (!obj.signals || typeof obj.signals !== "object") fail("missing signals");
  for (const [id, info] of Object.entries(obj.signals)) {
    if (!info || typeof info !== "object" || typeof (info as SignalInfo).phrase !== "string") {
      fail(`signals.${id} needs a phrase`);
    }
  }
  if (!Array.isArray(obj.searchOrder)) fail("searchOrder must be an array");
  if (!Array.isArray(obj.services) || obj.services.length === 0) fail("services must be a non-empty array");

  const seen = new Set<string>();
  for (const service of obj.services) {
    if (!service || typeof service !== "object") fail("a service entry is not an object");
    if (typeof service.id !== "string" || !service.id) fail("a service entry has no id");
    if (seen.has(service.id)) fail(`duplicate service id "${service.id}"`);
    seen.add(service.id);
    if (typeof service.label !== "string") fail(`service "${service.id}" has no label`);
    if (typeof service.pitch !== "string") fail(`service "${service.id}" has no pitch`);
    if (!service.signals || typeof service.signals !== "object") fail(`service "${service.id}" has no signals`);
    for (const [signal, points] of Object.entries(service.signals)) {
      if (!isFiniteNumber(points)) fail(`service "${service.id}" signal "${signal}" is not a number`);
      if (!obj.signals[signal]) fail(`service "${service.id}" uses unknown signal "${signal}"`);
    }
    for (const signal of Object.keys(service.reasons ?? {})) {
      if (!service.signals[signal]) fail(`service "${service.id}" has a reason for unused signal "${signal}"`);
    }
  }
  return obj as ServiceRules;
}

/** Load and validate the rule table. Cached for the default path. */
export function loadRules(fileUrl: URL | string = DEFAULT_RULES_PATH): ServiceRules {
  if (fileUrl === DEFAULT_RULES_PATH && cachedRules) return cachedRules;
  let text: string;
  try {
    text = readFileSync(fileUrl, "utf8");
  } catch (err) {
    throw new Error(`match: could not read service-rules.json: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`match: service-rules.json is not valid JSON: ${(err as Error).message}`);
  }
  const rules = validateRules(parsed);
  if (fileUrl === DEFAULT_RULES_PATH) cachedRules = rules;
  return rules;
}

// ------------------------------------------------------------------ contacts

export function hasEmail(lead: RawLead, e: Enrichment): boolean {
  return (e.emails?.length ?? 0) > 0 || Boolean(lead.email);
}

export function hasPhone(lead: RawLead, e: Enrichment): boolean {
  return (e.phones?.length ?? 0) > 0 || Boolean(lead.phone);
}

export function hasWhatsapp(e: Enrichment): boolean {
  return Boolean(e.socials?.whatsapp);
}

/** A lead is reachable only if at least one contact route exists. */
export function canReach(lead: RawLead, e: Enrichment): boolean {
  return hasEmail(lead, e) || hasPhone(lead, e) || hasWhatsapp(e);
}

function hasWebsite(lead: RawLead, e: Enrichment): boolean {
  return Boolean(lead.website) || Boolean(e.fetchedUrl);
}

/**
 * Signals from the enrichment, plus the few that can be read straight off the
 * lead's own contact fields. Derived signals are facts present in the inputs:
 * has-email/has-phone/has-whatsapp when a route exists, no-website when neither
 * the lead nor the enrichment shows a site.
 */
export function effectiveSignals(lead: RawLead, e: Enrichment): string[] {
  const out = new Set<string>((e.signals ?? []).filter((s): s is string => typeof s === "string" && s.length > 0));
  if (hasEmail(lead, e)) out.add("has-email");
  if (hasPhone(lead, e)) out.add("has-phone");
  if (hasWhatsapp(e)) out.add("has-whatsapp");
  if (!hasWebsite(lead, e)) out.add("no-website");
  return [...out];
}

/** Canonical category id: "Dental Clinic" -> "dental-clinic". */
export function normaliseCategory(category: string | undefined): string {
  return (category ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function clampScore(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

function stripPeriod(text: string): string {
  return text.trim().replace(/[.!?]+$/, "");
}

/** The first sentence of a summary, so a built angle stays one sentence. */
export function firstSentence(text: string | undefined): string {
  const clean = (text ?? "").trim();
  if (!clean) return "";
  const match = clean.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (match ? match[0] : clean).trim();
}

// ------------------------------------------------------------------ scoring

function reasonFor(rule: ServiceRule, firing: string[], present: Set<string>, rules: ServiceRules): string {
  // 1. Prefer a signal this service actually weighs, heaviest first.
  const byWeight = [...firing].sort((a, b) => (rule.signals[b] ?? 0) - (rule.signals[a] ?? 0));
  for (const signal of byWeight) {
    const text = rule.reasons?.[signal] ?? rules.signals[signal]?.phrase;
    if (text) return text;
  }
  // 2. No service signal fired: name the first present signal in the global order.
  for (const signal of rules.searchOrder) {
    if (!present.has(signal)) continue;
    const phrase = rules.signals[signal]?.phrase;
    if (phrase) return `${phrase}, so ${rule.pitch}`;
  }
  // 3. Any present signal at all.
  for (const signal of present) {
    const phrase = rules.signals[signal]?.phrase;
    if (phrase) return `${phrase}, so ${rule.pitch}`;
  }
  // 4. Nothing to name. Only possible for a lead with no signals and no contacts.
  return `nothing in the fetched data points to ${rule.label.toLowerCase()}, so no signal could be named`;
}

function scoreService(rule: ServiceRule, lead: RawLead, present: Set<string>, rules: ServiceRules): FitService {
  let score = 0;
  const firing = Object.keys(rule.signals).filter((signal) => present.has(signal));
  for (const signal of firing) score += rule.signals[signal];
  if (normaliseCategory(lead.category) && (rule.categories ?? []).includes(normaliseCategory(lead.category))) {
    score += rule.categoryBonus ?? 0;
  }
  return { service: rule.id, score: clampScore(score, rules.scoring.max), reason: reasonFor(rule, firing, present, rules) };
}

function overallScore(fit: FitService[], lead: RawLead, e: Enrichment, present: Set<string>, rules: ServiceRules): number {
  const { scoring } = rules;
  if (fit.length === 0) return 0; // nothing offered to score, so no relevance
  const best = Math.max(...fit.map((f) => f.score));
  let score = Math.round(best * scoring.overallWeight);
  if (hasEmail(lead, e)) score += scoring.reach.email;
  if (hasPhone(lead, e)) score += scoring.reach.phone;
  if (hasWhatsapp(e)) score += scoring.reach.whatsapp;
  if (present.has("site-unreachable")) score -= scoring.deadRoutePenalty;
  score = clampScore(score, scoring.max);
  if (!canReach(lead, e)) score = Math.min(score, scoring.unreachableCap);
  return score;
}

function buildAngle(lead: RawLead, e: Enrichment, fit: FitService[]): string {
  const reason = stripPeriod(fit[0]?.reason ?? `no service in this offer fits ${lead.name}`);
  const base = stripPeriod(firstSentence(e.summary));
  if (base) return `${base} - ${reason}.`;
  const leadLine = [lead.name, lead.city].filter(Boolean).join(" in ");
  const opening = leadLine ? `${leadLine} - ${reason}` : reason;
  return `${opening.charAt(0).toUpperCase()}${opening.slice(1)}.`;
}

/**
 * Score one lead against one offer. Only services in offer.services that exist in
 * the rule table are scored; each becomes a FitService with a signal-based reason.
 * fit is sorted best first (ties keep the offer's order). angle is one sentence
 * built from the lead's summary and the top reason, with no invented facts.
 */
export function match(lead: RawLead, e: Enrichment, offer: Offer): Match {
  const rules = loadRules();
  const present = new Set(effectiveSignals(lead, e));
  const byId = new Map(rules.services.map((service) => [service.id, service]));
  const fit: FitService[] = [];
  for (const id of offer?.services ?? []) {
    const rule = byId.get(id);
    if (!rule) continue; // unknown service ids are ignored, never invented
    fit.push(scoreService(rule, lead, present, rules));
  }
  fit.sort((a, b) => b.score - a.score); // stable: equal scores keep the offer order
  const score = overallScore(fit, lead, e, present, rules);
  const angle = buildAngle(lead, e, fit);
  return { score, fit, angle };
}
