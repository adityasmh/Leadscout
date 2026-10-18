// src/calls.ts
// Order CALL1: the call log. Every phone call (or whatsapp/visit/email touch) is
// remembered against a lead: what was said, what they said, what to do next and
// when to follow up. The table is created lazily through the existing store
// helper (no edit to store.ts). Node 24 built-ins only, ES modules, .js imports.
//
// Rules obeyed here:
//  - input is validated; text fields are trimmed to 4000 characters;
//  - the workspace API key / suppression module is optional and never required
//    for a call to be stored (a missing module must not lose the call);
//  - functions never throw for ordinary bad input except CallError, which the
//    HTTP layer turns into a 400. Nothing throws its way into the server.

import { randomUUID } from "node:crypto";
import { csvCell, getDb, getLead, listLeads, updateLead } from "./store.js";
import type { Lead, LeadStatus } from "./types.js";

export type CallChannel = "call" | "whatsapp" | "visit" | "email";
export type CallOutcome =
  | "no_answer"
  | "busy"
  | "wrong_number"
  | "not_interested"
  | "call_back"
  | "interested"
  | "meeting_booked"
  | "won"
  | "do_not_contact";

export const CALL_CHANNELS: readonly CallChannel[] = ["call", "whatsapp", "visit", "email"];
export const CALL_OUTCOMES: readonly CallOutcome[] = [
  "no_answer",
  "busy",
  "wrong_number",
  "not_interested",
  "call_back",
  "interested",
  "meeting_booked",
  "won",
  "do_not_contact",
];

export type CallLog = {
  id: string;
  workspaceId: string;
  leadId: string;
  at: string;
  channel: CallChannel;
  outcome: CallOutcome;
  iSaid: string;
  theySaid: string;
  nextAction: string;
  followUpAt: string | null;
  durationSec: number | null;
};

export type CallInput = {
  workspaceId: string;
  leadId: string;
  channel: CallChannel;
  outcome: CallOutcome;
  iSaid?: string;
  theySaid?: string;
  nextAction?: string;
  followUpAt?: string | null;
  durationSec?: number | null;
  at?: string;
};

export type CallEdit = Partial<Omit<CallInput, "workspaceId" | "leadId">>;

export type QueueEntry = {
  lead: Lead;
  kind: "follow_up" | "never_called";
  reason: string;
  followUpAt: string | null;
  hasPhone?: boolean;
};

export type CallStats = {
  calls: number;
  reached: number;
  interested: number;
  booked: number;
  byOutcome: Record<CallOutcome, number>;
};

/** Bad input for a call. The route layer maps this to HTTP 400. */
export class CallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallError";
  }
}

const MAX_TEXT = 4000;

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS call_logs (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  leadId TEXT NOT NULL,
  at TEXT NOT NULL,
  channel TEXT NOT NULL,
  outcome TEXT NOT NULL,
  i_said TEXT NOT NULL DEFAULT '',
  they_said TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  follow_up_at TEXT,
  duration_sec REAL
);
CREATE INDEX IF NOT EXISTS idx_call_logs_ws ON call_logs(workspaceId);
CREATE INDEX IF NOT EXISTS idx_call_logs_lead ON call_logs(workspaceId, leadId);
`;

/** Idempotent: creates the call_logs table on first use, on the store's database. */
function ensureTable(): void {
  getDb().exec(TABLE_SQL);
}

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return String(value ?? "");
}

function toCall(row: Row): CallLog {
  return {
    id: str(row.id),
    workspaceId: str(row.workspaceId),
    leadId: str(row.leadId),
    at: str(row.at),
    channel: str(row.channel) as CallChannel,
    outcome: str(row.outcome) as CallOutcome,
    iSaid: str(row.i_said),
    theySaid: str(row.they_said),
    nextAction: str(row.next_action),
    followUpAt: row.follow_up_at === null || row.follow_up_at === undefined ? null : str(row.follow_up_at),
    durationSec: typeof row.duration_sec === "number" ? row.duration_sec : null,
  };
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, MAX_TEXT);
}

function requireIso(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (text === "" || Number.isNaN(Date.parse(text))) throw new CallError(`${label} must be a valid ISO date`);
  return new Date(text).toISOString();
}

function optionalIso(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === "") return null;
  return requireIso(text, label);
}

function optionalDuration(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) throw new CallError("durationSec must be a non-negative number");
  return num;
}

function requireChannel(value: unknown): CallChannel {
  const text = String(value ?? "").trim() as CallChannel;
  if (!CALL_CHANNELS.includes(text)) throw new CallError(`channel must be one of ${CALL_CHANNELS.join(", ")}`);
  return text;
}

function requireOutcome(value: unknown): CallOutcome {
  const text = String(value ?? "").trim() as CallOutcome;
  if (!CALL_OUTCOMES.includes(text)) throw new CallError(`outcome must be one of ${CALL_OUTCOMES.join(", ")}`);
  return text;
}

/**
 * Which existing lead status an outcome maps to. `no_answer` and `busy` keep the
 * current status. `do_not_contact` / `wrong_number` reject the lead (and the
 * caller also suppresses the phone when the compliance module is present).
 */
function statusFor(outcome: CallOutcome, current: LeadStatus): LeadStatus {
  switch (outcome) {
    case "no_answer":
    case "busy":
      return current;
    case "call_back":
      return "contacted";
    case "interested":
      return "replied";
    case "meeting_booked":
      return "replied";
    case "won":
      return "won";
    case "not_interested":
    case "do_not_contact":
    case "wrong_number":
      return "rejected";
  }
}

/** Phones to consider for suppression: the lead phone plus any listed phone, unique. */
function leadPhones(lead: Lead): string[] {
  const out: string[] = [];
  if (lead.phone) out.push(lead.phone);
  for (const p of lead.phones ?? []) out.push(p);
  return [...new Set(out.map((p) => p.trim()).filter(Boolean))];
}

/**
 * Add the lead's phone to the workspace suppression list through compliance.ts
 * when that module is present. Dynamic import + try/catch so a missing or broken
 * compliance module never loses or blocks a logged call.
 */
async function suppressPhone(workspaceId: string, lead: Lead): Promise<void> {
  const phones = leadPhones(lead);
  if (phones.length === 0) return;
  try {
    const mod = (await import("./compliance.js")) as {
      addOptOut?: (input: { kind?: "domain" | "email" | "phone" | "bizKey"; value: string; scope: string; source: string }) => unknown;
    };
    if (typeof mod.addOptOut !== "function") return;
    for (const phone of phones) {
      mod.addOptOut({ kind: "phone", value: phone, scope: workspaceId, source: "call-log" });
    }
  } catch {
    // The call is already stored; suppression is best-effort by contract.
  }
}

/**
 * Store one call and update the lead status per the mapping above. Returns the
 * stored call. Throws CallError only for invalid input.
 */
export async function logCall(input: CallInput): Promise<CallLog> {
  ensureTable();
  const workspaceId = String(input?.workspaceId ?? "").trim();
  const leadId = String(input?.leadId ?? "").trim();
  if (!workspaceId) throw new CallError("workspaceId is required");
  if (!leadId) throw new CallError("leadId is required");

  const lead = getLead(workspaceId, leadId);
  if (!lead) throw new CallError("lead not found in this workspace");

  const channel = requireChannel(input.channel);
  const outcome = requireOutcome(input.outcome);
  const at = input.at === undefined ? new Date().toISOString() : requireIso(input.at, "at");
  const call: CallLog = {
    id: randomUUID(),
    workspaceId,
    leadId,
    at,
    channel,
    outcome,
    iSaid: cleanText(input.iSaid),
    theySaid: cleanText(input.theySaid),
    nextAction: cleanText(input.nextAction),
    followUpAt: optionalIso(input.followUpAt, "followUpAt"),
    durationSec: optionalDuration(input.durationSec),
  };

  getDb()
    .prepare(
      "INSERT INTO call_logs (id, workspaceId, leadId, at, channel, outcome, i_said, they_said, next_action, follow_up_at, duration_sec) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      call.id,
      call.workspaceId,
      call.leadId,
      call.at,
      call.channel,
      call.outcome,
      call.iSaid,
      call.theySaid,
      call.nextAction,
      call.followUpAt,
      call.durationSec
    );

  const nextStatus = statusFor(outcome, lead.status);
  if (nextStatus !== lead.status) updateLead(workspaceId, leadId, { status: nextStatus });

  if (outcome === "do_not_contact" || outcome === "wrong_number") {
    await suppressPhone(workspaceId, lead);
  }

  return call;
}

/** All calls for one lead, newest first. */
export function callsForLead(workspaceId: string, leadId: string): CallLog[] {
  ensureTable();
  const rows = getDb()
    .prepare("SELECT * FROM call_logs WHERE workspaceId = ? AND leadId = ? ORDER BY at DESC, rowid DESC")
    .all(workspaceId, leadId);
  return (rows as Row[]).map(toCall);
}

/** Edit one stored call entry (PATCH). Only the given fields change. */
export function updateCallLog(workspaceId: string, callId: string, patch: CallEdit): CallLog | undefined {
  ensureTable();
  const row = getDb()
    .prepare("SELECT * FROM call_logs WHERE workspaceId = ? AND id = ?")
    .get(workspaceId, callId) as Row | undefined;
  if (!row) return undefined;
  const current = toCall(row);
  const next: CallLog = { ...current };

  if (patch.channel !== undefined) next.channel = requireChannel(patch.channel);
  if (patch.outcome !== undefined) next.outcome = requireOutcome(patch.outcome);
  if (patch.at !== undefined) next.at = requireIso(patch.at, "at");
  if (patch.iSaid !== undefined) next.iSaid = cleanText(patch.iSaid);
  if (patch.theySaid !== undefined) next.theySaid = cleanText(patch.theySaid);
  if (patch.nextAction !== undefined) next.nextAction = cleanText(patch.nextAction);
  if (patch.followUpAt !== undefined) next.followUpAt = optionalIso(patch.followUpAt, "followUpAt");
  if (patch.durationSec !== undefined) next.durationSec = optionalDuration(patch.durationSec);

  getDb()
    .prepare(
      "UPDATE call_logs SET at = ?, channel = ?, outcome = ?, i_said = ?, they_said = ?, next_action = ?, follow_up_at = ?, duration_sec = ? " +
        "WHERE workspaceId = ? AND id = ?"
    )
    .run(
      next.at,
      next.channel,
      next.outcome,
      next.iSaid,
      next.theySaid,
      next.nextAction,
      next.followUpAt,
      next.durationSec,
      workspaceId,
      callId
    );
  return next;
}

/** End of the local day for `now`, used to decide whether a follow-up is due today. */
function endOfDay(now: Date): number {
  const end = new Date(now.getTime());
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

/** True when the lead has a usable phone: a non-empty `phone` or any non-empty entry in `phones`. */
function leadHasPhone(lead: Lead): boolean {
  if (typeof lead.phone === "string" && lead.phone.trim() !== "") return true;
  const phones = Array.isArray(lead.phones) ? lead.phones : [];
  return phones.some((entry) => typeof entry === "string" && entry.trim() !== "");
}

/** A numeric `rating` carried directly on the lead, when present. */
function leadRating(lead: Lead): number | null {
  const raw = lead as unknown as { rating?: unknown };
  return typeof raw.rating === "number" && Number.isFinite(raw.rating) ? raw.rating : null;
}

/** A numeric `reviewCount` carried directly on the lead, when present; otherwise 0. */
function leadReviewCount(lead: Lead): number {
  const raw = lead as unknown as { reviewCount?: unknown };
  return typeof raw.reviewCount === "number" && Number.isFinite(raw.reviewCount) ? raw.reviewCount : 0;
}

/** The first non-empty address part that is not a street number, lowercased ("MG Road"). */
function localityOf(lead: Lead): string {
  const address = typeof lead.address === "string" ? lead.address : "";
  for (const part of address.split(",")) {
    const value = part.trim();
    if (value === "") continue;
    if (/^\d+[a-z]?$/i.test(value)) continue;
    return value.toLowerCase();
  }
  return "";
}

/** Rating/review facts stored in dossiers for this workspace, keyed by lead id. */
function loadStoredRatings(workspaceId: string): Map<string, { rating: number; reviewCount: number }> {
  const out = new Map<string, { rating: number; reviewCount: number }>();
  const db = getDb();
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dossiers'")
    .get();
  if (!table) return out;
  const rows = db
    .prepare("SELECT leadId, json FROM dossiers WHERE workspaceId = ?")
    .all(workspaceId) as { leadId: string; json: string }[];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.json) as {
        facts?: { rating?: { value?: number }; reviewCount?: { value?: number } };
      };
      const rating = parsed.facts?.rating?.value;
      if (typeof rating !== "number" || !Number.isFinite(rating)) continue;
      const reviews = parsed.facts?.reviewCount?.value;
      out.set(row.leadId, {
        rating,
        reviewCount: typeof reviews === "number" && Number.isFinite(reviews) ? reviews : 0,
      });
    } catch {
      // ignore a malformed dossier row; the lead simply counts as unrated
    }
  }
  return out;
}

/**
 * The day's work: follow-ups due today or overdue first (oldest first), then
 * never-called leads ordered by score (highest first). Every entry carries a
 * plain reason string. Leads already won or rejected are left out.
 */
export function callQueue(workspaceId: string, now: Date = new Date()): QueueEntry[] {
  ensureTable();
  const end = endOfDay(now);
  const rows = getDb()
    .prepare("SELECT * FROM call_logs WHERE workspaceId = ?")
    .all(workspaceId) as Row[];
  const byLead = new Map<string, CallLog[]>();
  for (const row of rows) {
    const call = toCall(row);
    const list = byLead.get(call.leadId) ?? [];
    list.push(call);
    byLead.set(call.leadId, list);
  }

  const followUps: QueueEntry[] = [];
  for (const [leadId, list] of byLead) {
    const due = list
      .filter((call) => call.followUpAt !== null && Date.parse(call.followUpAt) <= end)
      .sort((a, b) => Date.parse(a.followUpAt as string) - Date.parse(b.followUpAt as string));
    if (due.length === 0) continue;
    const lead = getLead(workspaceId, leadId);
    if (!lead || lead.status === "won" || lead.status === "rejected") continue;
    const followUpAt = due[0].followUpAt;
    followUps.push({
      lead,
      kind: "follow_up",
      reason: `follow-up due ${followUpAt}`,
      followUpAt,
    });
  }
  followUps.sort((a, b) => Date.parse(a.followUpAt as string) - Date.parse(b.followUpAt as string));

  const storedRatings = loadStoredRatings(workspaceId);
  const neverCalled = listLeads({ workspaceId, limit: 100000, offset: 0 })
    .leads.filter((lead) => !byLead.has(lead.id) && lead.status !== "won" && lead.status !== "rejected")
    .map((lead) => {
      const hasPhone = leadHasPhone(lead);
      const stored = storedRatings.get(lead.id);
      const rating = stored?.rating ?? leadRating(lead);
      const reviewCount = stored?.reviewCount ?? leadReviewCount(lead);
      const entry: QueueEntry = {
        lead,
        kind: "never_called",
        reason: hasPhone ? `not called yet; score ${lead.score ?? 0}` : "no number yet",
        followUpAt: null,
        hasPhone,
      };
      return {
        entry,
        hasPhone,
        score: lead.score ?? 0,
        rated: rating !== null,
        ratingWeight:
          rating === null ? Number.NEGATIVE_INFINITY : rating * (1 + Math.log(1 + Math.max(0, reviewCount))),
        locality: localityOf(lead),
        name: lead.name ?? "",
      };
    })
    .sort((a, b) => {
      if (a.hasPhone !== b.hasPhone) return a.hasPhone ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      if (a.rated !== b.rated) return a.rated ? -1 : 1;
      if (a.rated && b.rated && a.ratingWeight !== b.ratingWeight) return b.ratingWeight - a.ratingWeight;
      if (a.locality !== b.locality) {
        if (a.locality === "") return 1;
        if (b.locality === "") return -1;
        return a.locality < b.locality ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    })
    .map((rank) => rank.entry);

  return [...followUps, ...neverCalled];
}

const REACHED_OUTCOMES: readonly CallOutcome[] = [
  "not_interested",
  "call_back",
  "interested",
  "meeting_booked",
  "won",
  "do_not_contact",
];

/** Aggregate call numbers for [from, to] (inclusive). Missing/invalid bounds are ignored. */
export function stats(workspaceId: string, from?: string, to?: string): CallStats {
  ensureTable();
  const all = (getDb()
    .prepare("SELECT * FROM call_logs WHERE workspaceId = ?")
    .all(workspaceId) as Row[]).map(toCall);
  const fromMs = from && !Number.isNaN(Date.parse(from)) ? Date.parse(from) : -Infinity;
  const toMs = to && !Number.isNaN(Date.parse(to)) ? Date.parse(to) : Infinity;

  const byOutcome = {} as Record<CallOutcome, number>;
  for (const outcome of CALL_OUTCOMES) byOutcome[outcome] = 0;

  let calls = 0;
  let reached = 0;
  let interested = 0;
  let booked = 0;
  for (const call of all) {
    const ms = Date.parse(call.at);
    if (ms < fromMs || ms > toMs) continue;
    calls += 1;
    byOutcome[call.outcome] = (byOutcome[call.outcome] ?? 0) + 1;
    if (REACHED_OUTCOMES.includes(call.outcome)) reached += 1;
    if (call.outcome === "interested") interested += 1;
    if (call.outcome === "meeting_booked" || call.outcome === "won") booked += 1;
  }

  return { calls, reached, interested, booked, byOutcome };
}

const CSV_HEADER = ["lead_name", "phone", "at", "outcome", "i_said", "they_said", "next_action"];

/** One CSV row per call, every field included, commas and newlines quoted. */
export function exportCsv(workspaceId: string): string {
  ensureTable();
  const calls = (getDb()
    .prepare("SELECT * FROM call_logs WHERE workspaceId = ? ORDER BY at ASC, rowid ASC")
    .all(workspaceId) as Row[]).map(toCall);
  const lines = [CSV_HEADER.join(",")];
  for (const call of calls) {
    const lead = getLead(workspaceId, call.leadId);
    const cells: unknown[] = [
      lead?.name ?? "",
      lead?.phone ?? "",
      call.at,
      call.outcome,
      call.iSaid,
      call.theySaid,
      call.nextAction,
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
