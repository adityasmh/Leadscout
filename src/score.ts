// src/score.ts
// L10-verify-score: lead scoring per docs/leadgen/PLAN_V2.md section 3.1.
//
// total = round(0.5 x fit + 0.3 x reach + 0.2 x timing)
// fit  = best service score from match (already offer-aware, stored on lead.fit).
// reach = points from verification (mobile/WhatsApp 40, ok email 30, alive site 20, contact form 10).
// timing = default 50, +25 peak within 60 days, +15 site-unreachable/no-https, +10 new branch/opening/hiring.

// @ts-ignore node:sqlite is a Node 24 built-in; ambient types may be absent.
import { DatabaseSync } from "node:sqlite";
import { getDb } from "./store.js";
import { bizKey } from "./evidence.js";
import { loadVerification } from "./verify.js";
import { blendLearnedScore } from "./learn-score.js";
import type { Lead } from "./types.js";
import type { LeadScore, Verification } from "./types-v2.js";

export type SeasonCalendar = {
  version: number;
  note: string;
  entries: {
    category: string;
    country: string;
    peakMonths: number[];
    note: string;
    basis: string;
  }[];
};

export type ScoreOpts = {
  month?: number; // 1-12
  calendar?: SeasonCalendar;
  optedOut?: boolean;
};

const GATE_CUTOFF = 35;

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function bestFitScore(lead: Lead): number {
  if (!lead.fit || lead.fit.length === 0) return 0;
  return Math.max(...lead.fit.map((f) => f.score));
}

function normaliseCategory(category: string): string {
  return (category ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function monthDiffForward(from: number, to: number): number {
  // Months ahead from `from` to `to`, wrapping around the year.
  return (to - from + 12) % 12;
}

function peakWithin60Days(category: string, country: string | undefined, runMonth: number, calendar?: SeasonCalendar): boolean {
  if (!calendar) return false;
  const cat = normaliseCategory(category);
  const ctry = (country ?? "").trim().toLowerCase();
  for (const entry of calendar.entries) {
    if (normaliseCategory(entry.category) !== cat) continue;
    const entryCountry = (entry.country ?? "").trim().toLowerCase();
    if (entryCountry && entryCountry !== ctry) continue;
    for (const peak of entry.peakMonths) {
      const diff = monthDiffForward(runMonth, peak);
      if (diff >= 0 && diff <= 2) return true;
    }
  }
  return false;
}

function mentionsTimingTrigger(summary: string): boolean {
  const lower = (summary ?? "").toLowerCase();
  const triggers = ["new branch", "opening", "hiring", "we are hiring", "now hiring", "grand opening", "launched"];
  return triggers.some((t) => lower.includes(t));
}

/**
 * Score a lead. `lead.fit` is expected to be populated by `match`.
 * `v` is the verification result from `verify`.
 */
export function scoreLead(lead: Lead, v: Verification, opts: ScoreOpts = {}): LeadScore {
  const now = new Date();
  const runMonth = typeof opts.month === "number" && opts.month >= 1 && opts.month <= 12
    ? opts.month
    : now.getMonth() + 1;

  const reasons: string[] = [];

  // Fit
  const fit = bestFitScore(lead);
  reasons.push(`fit: best service score ${fit}`);

  // Reach
  let reach = 0;
  const mobile = v.phones.find((p) => p.result === "mobile");
  if (mobile) {
    reach += 40;
    reasons.push(`reach: valid mobile ${mobile.e164 ?? mobile.value} +40`);
  }
  if (v.whatsapp) {
    reach += 40;
    reasons.push("reach: WhatsApp link +40");
  }
  const okEmail = v.emails.find((e) => e.result === "ok");
  if (okEmail) {
    reach += 30;
    reasons.push(`reach: ok email ${okEmail.value} +30`);
  } else {
    // RS1-reach-honesty: an email counts toward reach unless verification says
    // its domain cannot receive mail (no-mx) or the address is invalid. An
    // address with no verification entry still counts, as before.
    const UNRECEIVABLE_EMAIL_RESULTS: ReadonlySet<string> = new Set(["no-mx", "invalid"]);
    const leadEmails = [
      ...(typeof lead.email === "string" ? [lead.email] : []),
      ...((lead.emails ?? []).filter((s): s is string => typeof s === "string")),
    ].map((s) => s.trim()).filter((s) => s.length > 0);
    const emailResultByAddress = new Map(
      (v.emails ?? []).map((e) => [String(e.value ?? "").trim().toLowerCase(), e.result]),
    );
    const usableEmail = leadEmails.find((addr) => {
      const result = emailResultByAddress.get(addr.toLowerCase());
      return result === undefined || !UNRECEIVABLE_EMAIL_RESULTS.has(result);
    });
    if (usableEmail !== undefined) {
      reach += 30;
      if (emailResultByAddress.get(usableEmail.toLowerCase()) === undefined) {
        reasons.push(`reach: unverified email ${usableEmail} +30`);
      } else {
        reasons.push(`reach: email ${usableEmail} +30`);
      }
    } else if (leadEmails.length > 0) {
      reasons.push("reach: email domain cannot receive mail [email]");
    }
  }
  if (v.website === "alive") {
    reach += 20;
    reasons.push("reach: website alive +20");
  }
  const signals = new Set((lead.signals ?? []).filter((s): s is string => typeof s === "string"));
  if (v.website === "alive" && !signals.has("no-contact-form")) {
    reach += 10;
    reasons.push("reach: contact form present +10");
  }
  reach = clamp100(reach);

  // Timing
  let timing = 50;
  reasons.push("timing: default 50");
  if (peakWithin60Days(lead.category, lead.country, runMonth, opts.calendar)) {
    timing += 25;
    reasons.push(`timing: ${normaliseCategory(lead.category)} peak window starts within 60 days +25`);
  }
  if (signals.has("site-unreachable") || signals.has("no-https")) {
    timing += 15;
    reasons.push(`timing: ${signals.has("site-unreachable") ? "site-unreachable" : "no-https"} +15`);
  }
  if (mentionsTimingTrigger(lead.summary)) {
    timing += 10;
    reasons.push("timing: summary mentions new branch/opening/hiring +10");
  }
  timing = clamp100(timing);

  const ruleTotal = clamp100(Math.round(0.5 * fit + 0.3 * reach + 0.2 * timing));
  // L30 learning hook: blend this workspace's win-trained score when it is available.
  const blended = blendLearnedScore(lead.workspaceId, lead, ruleTotal);
  const total = blended ? blended.total : ruleTotal;
  if (blended) reasons.push(...blended.reasons);

  let gate: LeadScore["gate"] = "template";
  if (opts.optedOut) {
    gate = "hidden";
    reasons.push("gate: opted out -> hidden");
  } else if (!v.contactable) {
    gate = "hidden";
    reasons.push("gate: not contactable -> hidden");
  } else if (total < GATE_CUTOFF) {
    gate = "hidden";
    reasons.push(`gate: total ${total} below cut-off ${GATE_CUTOFF} -> hidden`);
  }

  return { total, fit, reach, timing, gate, reasons };
}

// ------------------------------------------------------------------ persistence

function ensureScoreTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_scores (
      workspaceId TEXT NOT NULL,
      leadId TEXT NOT NULL,
      total INTEGER NOT NULL,
      fit INTEGER NOT NULL,
      reach INTEGER NOT NULL,
      timing INTEGER NOT NULL,
      gate TEXT NOT NULL,
      reasons TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL,
      PRIMARY KEY (workspaceId, leadId)
    );
  `);
}

export function saveScore(workspaceId: string, leadId: string, s: LeadScore): LeadScore {
  const db = getDb();
  ensureScoreTable(db);
  db.prepare(
    `INSERT OR REPLACE INTO lead_scores
      (workspaceId, leadId, total, fit, reach, timing, gate, reasons, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    workspaceId,
    leadId,
    s.total,
    s.fit,
    s.reach,
    s.timing,
    s.gate,
    JSON.stringify(s.reasons),
    new Date().toISOString()
  );
  return s;
}

export function getScore(workspaceId: string, leadId: string): LeadScore | undefined {
  const db = getDb();
  ensureScoreTable(db);
  const row = db.prepare("SELECT * FROM lead_scores WHERE workspaceId = ? AND leadId = ?").get(workspaceId, leadId) as any;
  if (!row) return undefined;
  return {
    total: row.total,
    fit: row.fit,
    reach: row.reach,
    timing: row.timing,
    gate: row.gate,
    reasons: JSON.parse(row.reasons ?? "[]"),
  };
}

// --------------------------------------------------------------- recompute (ORDER_SC1)
// `scoreLead` needs the live Verification object, which is not stored on the lead, so
// leads processed before the parts were persisted only carry the total. These helpers
// rebuild the dossier breakdown from what IS stored on the lead (signals + fields),
// purely and with no network, and never touch the stored total. The scorer rule is
// total = round(0.5 x fit + 0.3 x reach + 0.2 x timing).

export type ScoreBreakdown = { fit: number; reach: number; timing: number; reasons: string[] };

/** True when the verification lists emails but none of them can receive mail. */
function emailsBlockEmailPoints(verification: Verification | undefined): boolean {
  if (!verification) return false;
  const emails = verification.emails ?? [];
  if (emails.length === 0) return false;
  return emails.every((entry) => {
    const result: string = entry.result;
    return result === "no-mx" || result === "invalid";
  });
}

/** Plain-words fit/reach/timing derived only from the stored lead (no network). */
export function breakdownFromLead(lead: Lead, verification?: Verification): ScoreBreakdown {
  const signals = new Set((lead.signals ?? []).filter((s): s is string => typeof s === "string"));
  const reasons: string[] = [];

  const hasFit = Array.isArray(lead.fit) && lead.fit.length > 0;
  const hasPhone = signals.has("has-phone");
  const hasEmail = signals.has("has-email");
  const hasWhatsapp = signals.has("has-whatsapp");
  const siteReachable = !!lead.website && !signals.has("no-website") && !signals.has("site-unreachable");

  // Nothing on the lead to reason about: be honest and return zeros.
  if (!hasFit && signals.size === 0 && !siteReachable) {
    return { fit: 0, reach: 0, timing: 0, reasons: [] };
  }

  // Fit: the best stored match service score.
  let fit = 0;
  if (hasFit) {
    const best = lead.fit.reduce((a, b) => (b.score > a.score ? b : a));
    fit = clamp100(best.score);
    reasons.push(`fit: best service "${best.service}" found by the match [fit]`);
  }

  // Reach: points for a real route, read from the stored signals/fields.
  let reach = 0;
  if (hasPhone) { reach += 40; reasons.push("reach: has a phone number [has-phone]"); }
  if (hasWhatsapp) { reach += 40; reasons.push("reach: has a WhatsApp link [has-whatsapp]"); }
  if (hasEmail) {
    if (emailsBlockEmailPoints(verification)) {
      reasons.push("reach: email domain cannot receive mail [email]");
    } else {
      reach += 30; reasons.push("reach: has an email address [has-email]");
    }
  }
  if (siteReachable) { reach += 20; reasons.push("reach: website looks reachable [website]"); }
  if (siteReachable && !signals.has("no-contact-form")) {
    reach += 10;
    reasons.push("reach: website has a contact form or booking page [website]");
  }
  reach = clamp100(reach);

  // Timing: default 50, +15 for a broken/insecure site, +10 for a growth trigger.
  let timing = 50;
  reasons.push(`timing: baseline timing for "${lead.category}" [category]`);
  if (signals.has("site-unreachable")) {
    timing += 15;
    reasons.push("timing: listed site is unreachable [site-unreachable]");
  } else if (signals.has("no-https")) {
    timing += 15;
    reasons.push("timing: site has no HTTPS [no-https]");
  }
  if (mentionsTimingTrigger(lead.summary)) {
    timing += 10;
    reasons.push("timing: summary mentions a new branch, opening or hiring [summary]");
  }
  timing = clamp100(timing);

  return { fit, reach, timing, reasons };
}

/** Same business key derivation the dossier response uses to load verification. */
function businessKeyForLead(lead: Lead): string | undefined {
  try {
    const key = bizKey(lead);
    return typeof key === "string" && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Stored verification for the lead; missing table or row means "no verification". */
function loadStoredVerification(lead: Lead): Verification | undefined {
  try {
    const key = businessKeyForLead(lead);
    if (!key) return undefined;
    return loadVerification(key);
  } catch {
    return undefined;
  }
}
function weightedTotal(fit: number, reach: number, timing: number): number {
  return clamp100(Math.round(0.5 * fit + 0.3 * reach + 0.2 * timing));
}

/** Nudges the parts by whole points so the scorer rule lands exactly on `total`. */
function reconcileParts(parts: ScoreBreakdown, total: number): ScoreBreakdown {
  if (weightedTotal(parts.fit, parts.reach, parts.timing) === total) return parts;
  for (let d = 1; d <= 300; d++) {
    for (let df = -d; df <= d; df++) {
      for (let dr = -d + Math.abs(df); dr <= d - Math.abs(df); dr++) {
        const rem = d - Math.abs(df) - Math.abs(dr);
        for (const dt of rem === 0 ? [0] : [rem, -rem]) {
          const fit = parts.fit + df;
          const reach = parts.reach + dr;
          const timing = parts.timing + dt;
          if (fit < 0 || fit > 100 || reach < 0 || reach > 100 || timing < 0 || timing > 100) continue;
          if (weightedTotal(fit, reach, timing) === total) return { fit, reach, timing, reasons: parts.reasons };
        }
      }
    }
  }
  return parts;
}

/**
 * The dossier response score. Keeps a stored score only when its parts already add up to
 * its total and it has reasons; otherwise rebuilds the parts from the stored lead and
 * reconciles them to the stored total. The stored total is never changed.
 */
export function resolveScore(lead: Lead, stored?: LeadScore): LeadScore {
  const total = stored && Number.isFinite(stored.total) ? stored.total : (Number.isFinite(lead.score) ? lead.score : 0);
  const storedUsable = !!stored
    && Array.isArray(stored.reasons) && stored.reasons.length > 0
    && (stored.fit > 0 || stored.reach > 0 || stored.timing > 0)
    && weightedTotal(stored.fit, stored.reach, stored.timing) === total;
  if (storedUsable) return stored as LeadScore;

  const raw = breakdownFromLead(lead, loadStoredVerification(lead));
  const parts = reconcileParts(raw, total);
  return {
    total,
    fit: parts.fit,
    reach: parts.reach,
    timing: parts.timing,
    gate: stored?.gate ?? lead.gate ?? "template",
    reasons: raw.reasons,
  };
}
