// src/research.ts
// L33-reach-wiring, part 1: Agent Reach as the PRIMARY research layer for every lead.
// docs/leadgen/ORDER_L33-reach-wiring.md. Single entry point for all research so no other
// module does ad hoc web lookups: researchBusiness(lead, brief, deps).
//
// Policy implemented here:
// - LEADSCOUT_REACH_MODE is read at call time: "primary" (default; Agent Reach first, the
//   plain site fetch only when reach is unavailable or returned nothing for those pages),
//   "fallback" (plain enrich() first, reach only when the result is thin: no verified
//   contact or fewer than 3 citable evidence items), "off" (plain enrich only, zero reach
//   interaction; result.enrichment deep-equals deps.enrich output).
// - Verified contact (the "enough" stop condition, defined from existing exports and kept
//   here in one place): an email that passes verify.isValidEmailSyntax and is not flagged
//   by verify.isDummyEmail, or a phone that enrich.normalizePhone accepts. "Enough" =
//   verified contact AND >= 3 citable evidence items.
// - Every reach call (readPage / searchWeb / readFeed / socialSearch) and every plain
//   deps.enrich call is counted; the brief or DEFAULT_RESEARCH_BUDGET caps calls and wall
//   seconds (via deps.now). reachStatus (the doctor) is metadata and is not counted.
// - Reach text is untrusted data only: it never becomes an instruction in any prompt.
//   Anything quoted from reach carries untrusted: true on its evidence item.
//
// Node 24 built-ins only (base64/exec via dynamic import), ES module, .js import suffixes.

import { enrichFromPages, normalizePhone } from "./enrich.js";
import { isDummyEmail, isValidEmailSyntax } from "./verify.js";
import {
  OPERATOR_NOTICE,
  REACH_DOCTOR_TIMEOUT_MS,
  SOCIAL_CHANNELS,
  channelCommand,
  parseJina,
  reachStatus as reachDoctorStatus,
  readPage as reachReadPage,
  searchWeb as reachSearchWeb,
  readFeed as reachReadFeed,
  sanitizeUntrusted,
  extractSocialLinks,
  type ReachDeps,
  type ReachExecFile,
  type ReachResult,
  type ReachStatus,
} from "./reach.js";
import type { Enrichment, RawLead } from "./types.js";
import type { Evidence } from "./types-v2.js";
import type { ChannelDeps } from "./channels/types.js";
import { shouldContinue as shouldContinueBudget, type BudgetState } from "./research-budget.js";
import { snapshotOf, closeStepWith } from "./research-budget-wiring.js";

export type ReachMode = "primary" | "fallback" | "off";

function modeValue(value: unknown): ReachMode {
  if (value === "fallback" || value === "off" || value === "primary") return value;
  return "primary"; // empty or unknown values use the documented default
}

/** Read LEADSCOUT_REACH_MODE at call time (never at import). Empty/unknown -> "primary". */
export function resolveReachMode(env?: Record<string, string | undefined>): ReachMode {
  return modeValue((env ?? process.env).LEADSCOUT_REACH_MODE);
}

export type ResearchBrief = { ownerRole?: string; maxCalls?: number; maxSeconds?: number };

export const DEFAULT_RESEARCH_BUDGET = { maxCalls: 12, maxSeconds: 60 };

export type ResearchEvidence = Evidence & { channel: string; untrusted: boolean };

export type ReachApi = {
  reachStatus(): Promise<ReachStatus>;
  readPage(url: string): Promise<ReachResult>;
  searchWeb(q: string): Promise<ReachResult>;
  readFeed(url: string): Promise<ReachResult>;
  socialSearch(channel: string, q: string): Promise<ReachResult>;
};

export type ResearchDeps = {
  enrich: (lead: RawLead, d?: { fetchFn?: typeof fetch }) => Promise<Enrichment>;
  fetchFn?: typeof fetch;
  reach?: ReachApi | null;
  channelDeps?: ChannelDeps;
  now?: () => Date;
  warn?: (m: string) => void;
  mode?: ReachMode;
  budget?: BudgetState;
};

export type ResearchResult = {
  enrichment: Enrichment;
  evidence: ResearchEvidence[];
  mode: ReachMode;
  degraded: boolean;
  notes: string[];
  callsUsed: number;
  stoppedBecause?: "enough" | "call-budget" | "time-budget";
};

const DEGRADED_WARN = "reach not installed, using plain fetch";

// --------------------------------------------------------------------------- default ReachApi

async function defaultExecFile(
  file: string,
  args: readonly string[],
  opts: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return (promisify(execFileCb) as ReachExecFile)(file, [...args], opts);
}

/**
 * defaultReachApi: ReachApi over the merged reach.ts adapter. Per order: NEVER pass
 * fetchFn into reach calls - only execFile and the time function are forwarded, so reach
 * always runs through its own exec transport; degraded web reads inside reach never use
 * our plain fetch. socialSearch is built from exported channelCommand + sanitizeUntrusted,
 * gated on reachStatus (with the injected execFile) reporting the channel ok.
 */
export function defaultReachApi(deps: ReachDeps = {}): ReachApi {
  const forward: ReachDeps = {
    execFile: deps.execFile,
    now: deps.now ?? (() => new Date().toISOString()),
  };
  const execFile: ReachExecFile = deps.execFile ?? defaultExecFile;
  const doctor = (): Promise<ReachStatus> => reachDoctorStatus(deps.execFile ? { execFile: deps.execFile } : {});
  const traceOf = (channel: string, target: string): ReachResult["trace"] => [
    { channel, target, time: forward.now?.() ?? new Date().toISOString() },
  ];
  const failed = (channel: string, error: string): ReachResult => ({
    ok: false, channel, text: "", untrusted: true, error, trace: [],
  });
  return {
    reachStatus: doctor,
    readPage: (url) => reachReadPage(url, forward),
    searchWeb: (q) => reachSearchWeb(q, forward),
    readFeed: (url) => reachReadFeed(url, forward),
    socialSearch: async (channel, q) => {
      const status = await doctor();
      if (!status.available || status.channels[channel]?.ok !== true) {
        return failed(channel, `social channel ${channel} not working`);
      }
      const cmd = channelCommand(channel, q);
      try {
        const { stdout, stderr } = await execFile(cmd.file, cmd.args, { timeout: REACH_DOCTOR_TIMEOUT_MS });
        const text = sanitizeUntrusted(String(stdout || stderr || ""));
        return {
          ok: text.length > 0,
          channel,
          text,
          untrusted: true,
          notice: OPERATOR_NOTICE,
          trace: traceOf(channel, q),
        };
      } catch (e) {
        return failed(channel, String((e as { message?: string })?.message ?? e));
      }
    },
  };
}

// --------------------------------------------------------------------------- helpers

function toHomeUrl(website: string): string | undefined {
  const raw = String(website ?? "").trim();
  if (!raw) return undefined;
  let candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    let url = new URL(candidate);
    return url.toString();
  } catch {
    return undefined;
  }
}

/** A reach result counts as something only when it is ok (no degraded flag) and non-empty. */
function reachText(r: ReachResult | undefined): boolean {
  return !!r && r.ok === true && !r.degraded && String(r.text ?? "").trim().length > 0;
}

/* reach page text is data, not instructions; quotes are trimmed for evidence. */
function quoteText(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function mergeInto(base: Enrichment, extra: Enrichment): Enrichment {
  const emailSeen = new Set(base.emails.map((e) => e.toLowerCase()));
  const emails = [...base.emails];
  for (const e of extra.emails) {
    const key = e.toLowerCase();
    if (!emailSeen.has(key)) { emailSeen.add(key); emails.push(e); }
  }
  const phoneSeen = new Set(base.phones.map((p) => normalizePhone(String(p ?? "")) ?? String(p ?? "")));
  const phones = [...base.phones];
  for (const p of extra.phones) {
    const key = normalizePhone(String(p ?? "")) ?? String(p ?? "");
    if (!phoneSeen.has(key)) { phoneSeen.add(key); phones.push(p); }
  }
  const socials: Enrichment["socials"] = { ...extra.socials, ...base.socials };
  const signals = [...new Set([...base.signals, ...extra.signals])];
  return {
    ...extra,
    ...base, // summary/fetchedUrl stay from the base unless missing
    ...(base.fetchedUrl ? {} : { fetchedUrl: extra.fetchedUrl }),
    ...(base.title ? {} : { title: extra.title }),
    ...(base.description ? {} : { description: extra.description }),
    ...(base.language ? {} : { language: extra.language }),
    summary: base.summary || extra.summary,
    emails: emails.slice(0, 10),
    phones: phones.slice(0, 10),
    socials,
    signals,
  };
}

function noWebsiteLike(lead: RawLead): Enrichment {
  const where = [lead.city, lead.country].map((v) => String(v ?? "").trim()).filter(Boolean).join(", ");
  const category = String(lead.category ?? "").trim() || "unknown";
  return {
    summary: where
      ? `No website is on record for this business. Only its category (${category}) and place (${where}) are known.`
      : `No website is on record for this business. Only its category (${category}) is known.`,
    emails: lead.email ? [String(lead.email).trim()].filter(Boolean) : [],
    phones: lead.phone ? [String(lead.phone).trim()].filter(Boolean) : [],
    socials: {},
    signals: ["no-website"],
  };
}

// --------------------------------------------------------------------------- researchBusiness

export async function researchBusiness(
  lead: RawLead,
  brief: ResearchBrief = {},
  deps: ResearchDeps,
): Promise<ResearchResult> {
  const mode: ReachMode = deps.mode ?? resolveReachMode();
  const now = deps.now ?? (() => new Date());
  const maxCalls = Math.max(0, Math.floor(brief.maxCalls ?? DEFAULT_RESEARCH_BUDGET.maxCalls));
  const maxSeconds = Math.max(0, Math.floor(brief.maxSeconds ?? DEFAULT_RESEARCH_BUDGET.maxSeconds));
  const startedAt = now().getTime();
  const notes: string[] = [];
  const evidence: ResearchEvidence[] = [];
  let callsUsed = 0;
  let degraded = false;
  let stopped: ResearchResult["stoppedBecause"];
  let warned = false;

  const warnOnce = (m: string): void => {
    if (!warned) { warned = true; deps.warn?.(m); }
  };
  const timeLeft = (): boolean => now().getTime() - startedAt < maxSeconds * 1000;
  const stopNow = (why: "enough" | "call-budget" | "time-budget"): void => {
    if (stopped) return;
    stopped = why;
    notes.push(
      why === "enough" ? "stopped early: verified contact and 3 citable items reached"
        : why === "call-budget" ? `stopped early: call budget (${maxCalls} calls) reached`
          : `stopped early: time budget (${maxSeconds}s) reached`,
    );
  };
  /** Budget gate before every counted call. Returns true when the call must be skipped. */
  const blocked = (): boolean => {
    if (deps.budget && !shouldContinueBudget(deps.budget).continue) { stopNow("call-budget"); return true; }
    if (!timeLeft()) { stopNow("time-budget"); return true; }
    if (callsUsed >= maxCalls) { stopNow("call-budget"); return true; }
    return false;
  };
  const call = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (blocked()) return undefined;
    callsUsed += 1;
    return await fn();
  };
  const plainEnrich = (): Promise<Enrichment> => deps.enrich(lead, { fetchFn: deps.fetchFn });

  const hasVerifiedContact = (e: Enrichment): boolean => {
    const emailOk = e.emails
      .some((x) => isValidEmailSyntax(String(x ?? "")) && !isDummyEmail(String(x ?? "")).dummy);
    const phoneOk = e.phones.some((p) => normalizePhone(String(p ?? "")) !== undefined);
    return emailOk || phoneOk;
  };
  // "citable items" = evidence entries in this result (each carries an exact quote + url).
  const enough = (e: Enrichment): boolean => hasVerifiedContact(e) && evidence.length >= 3;
  const checkEnough = (): void => { if (enrichment && !stopped && enough(enrichment)) stopNow("enough"); };

  function push(item: {
    kind: Evidence["kind"]; url: string; quote: string; field?: string;
    channel: string; untrusted: boolean;
  }): void {
    const trimmed = quoteText(item.quote);
    if (!trimmed) return;
    evidence.push({
      id: `E${evidence.length + 1}`,
      kind: item.kind,
      url: item.url,
      quote: trimmed,
      ...(item.field ? { field: item.field } : {}),
      channel: item.channel,
      untrusted: item.untrusted,
      fetchedAt: now().toISOString(),
    });
  }

  // ---------------------------------------------------------------- mode off: plain only
  if (mode === "off") {
    const enrichment = await plainEnrich();
    callsUsed += 1;
    notes.push("LEADSCOUT_REACH_MODE=off: reach skipped");
    return { enrichment, evidence: [], mode, degraded: false, notes, callsUsed };
  }

  const api = deps.reach;
  const status = api ? await api.reachStatus() : null;

  // ---------------------------------------------------------------- degraded: reach unusable
  if (!api || !status?.available) {
    degraded = true;
    warnOnce(DEGRADED_WARN);
    notes.push(DEGRADED_WARN);
    const enrichment = await plainEnrich();
    callsUsed += 1;
    return { enrichment, evidence: [], mode, degraded, notes, callsUsed };
  }

  // ---------------------------------------------------------------- reach available
  const q = [lead.name, lead.city].map((v) => String(v ?? "").trim()).filter(Boolean).join(" ").trim();
  const pages: Array<{ url: string; text: string }> = [];
  let reachTitle: string | undefined;
  const reachSocials: Enrichment["socials"] = {};
  let enrichment: Enrichment | undefined;

  const keepPage = (url: string, result: ReachResult, field: string): void => {
    const j = parseJina(result.text);
    pages.push({ url, text: j.body || result.text });
    if (j.title && !reachTitle) reachTitle = j.title;
    push({ kind: "page-text", url, quote: (j.body || result.text), field, channel: result.channel, untrusted: true });
    for (const [k, v] of Object.entries(extractSocialLinks(result.text))) {
      if (!reachSocials[k as keyof Enrichment["socials"]]) reachSocials[k as keyof Enrichment["socials"]] = v;
    }
  };

  // Step 1: readPage for site / contact / about pages (reach first).
  const reachPages = async (): Promise<boolean> => {
    const home = toHomeUrl(String(lead.website ?? "").trim());
    if (!home) return false;
    let gotAny = false;
    const homeResult = await call(() => api.readPage(home));
    if (reachText(homeResult) && homeResult) { keepPage(home, homeResult, "site"); gotAny = true; }
    for (const kind of ["contact", "about"] as const) {
      if (stopped || blocked()) break;
      const url = new URL(`/${kind}`, home).toString();
      const pageResult = await call(() => api.readPage(url));
      if (reachText(pageResult) && pageResult) { keepPage(url, pageResult, kind); gotAny = true; }
    }
    return gotAny;
  };

  // Step 2: searchWeb for the business's own site (none known), public contact pages,
  // and public mentions of the owner/decision-maker role named in the brief.
  const searchOnce = async (query: string, field: string): Promise<boolean> => {
    const result = await call(() => api.searchWeb(query));
    if (!reachText(result) || !result) return false;
    push({
      kind: "page-text",
      url: `search:${encodeURIComponent(query)}`,
      quote: result.text,
      field,
      channel: result.channel,
      untrusted: true,
    });
    for (const [k, v] of Object.entries(extractSocialLinks(result.text))) {
      if (!reachSocials[k as keyof Enrichment["socials"]]) reachSocials[k as keyof Enrichment["socials"]] = v;
    }
    return true;
  };

  // Step 3: readFeed for recent news about the business.
  const feedOnce = async (): Promise<boolean> => {
    const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}`;
    const result = await call(() => api.readFeed(feedUrl));
    if (!reachText(result) || !result) return false;
    push({ kind: "page-text", url: feedUrl, quote: result.text, field: "news", channel: result.channel, untrusted: true });
    return true;
  };

  // socialSearch evidence for one call, or null otherwise.
  const socialOk = async (channel: string, query: string): Promise<void> => {
    const result = await call(() => api.socialSearch(channel, query));
    if (!reachText(result) || !result) return;
    push({
      kind: "page-text",
      url: `social:${channel}:${encodeURIComponent(query)}`,
      quote: result.text,
      field: `social:${channel}`,
      channel: result.channel,
      untrusted: true,
    });
    if (result.text.includes(String(now().getFullYear()))) notes.push(`social ${channel}: recently active in ${now().getFullYear()}`);
    for (const [k, v] of Object.entries(extractSocialLinks(result.text))) {
      if (!reachSocials[k as keyof Enrichment["socials"]]) reachSocials[k as keyof Enrichment["socials"]] = v;
    }
  };

  const finish = async (base: Enrichment | undefined): Promise<Enrichment> => {
    let out = base;
    if (pages.length > 0) {
      const fromPages = enrichFromPages(lead, pages);
      for (const [k, v] of Object.entries(reachSocials)) {
        if (!fromPages.socials[k as keyof Enrichment["socials"]]) {
          fromPages.socials[k as keyof Enrichment["socials"]] = v;
        }
      }
      out = out ? mergeInto(out, fromPages) : fromPages;
      if (reachTitle && !out.title) out.title = reachTitle;
    }
    if (!out) {
      // Safety valve: the pipeline needs an enrichment even when the budget stopped
      // everything. Rank this as the documented last-resort plain fetch.
      out = await plainEnrich();
      callsUsed += 1;
      notes.push("no enrichment after budget stop; ran plain enrich as last resort");
    }
    return out;
  };

  if (mode === "primary") {
    // Step 1 first. Only when reach is unavailable (degraded handled above) or returns
    // nothing for those pages does the plain enrich() path fetch the same pages.
    const before = snapshotOf(enrichment, evidence); const callsBefore = callsUsed; const startedMs = now().getTime();
    const gotPages = await reachPages();
    if (!gotPages) {
      if (lead.website) {
        const plain = await call(plainEnrich);
        if (plain) {
          enrichment = plain;
          notes.push("reach returned nothing for the site pages; used plain fetch");
        } else {
          notes.push("reach returned nothing for the site pages; plain fetch skipped by budget");
        }
      } else {
        // No website on record: plain enrich is a pure local computation (no fetch) that
        // yields the no-website summary; search below looks for the site instead.
        const plain = await call(() => Promise.resolve(noWebsiteLike(lead)));
        enrichment = plain ?? undefined;
        if (enrichment) notes.push("no website on record; search will look for one");
      }
    } else {
      enrichment = await finish(enrichment);
    }
    closeStepWith(deps.budget, before, snapshotOf(enrichment, evidence), callsUsed - callsBefore, (now().getTime() - startedMs) / 1000);
  } else {
    // fallback mode: plain enrich plus our own extractors first (unconditionally: this is
    // the primary layer in this mode), counted as a plain call.
    callsUsed += 1;
    enrichment = await plainEnrich();
  }

  if (enrichment) checkEnough();

  // Step 2: searches (own site only when none is known; contact pages; owner mentions
  // only when the brief names a role). Skipped entirely in fallback mode when the plain
  // run is not thin.
  const thin = !enrichment || !enough(enrichment);
  if (mode === "primary" || (mode === "fallback" && thin)) {
    if (mode === "fallback" && thin) {
      notes.push("plain result thin (no verified contact or fewer than 3 citable items); reach used");
    }
    {
      const before = snapshotOf(enrichment, evidence); const callsBefore = callsUsed; const startedMs = now().getTime();
      if (!lead.website) await searchOnce(`${q} official website`, "website");
      if (!stopped && !blocked()) await searchOnce(`${q} contact page`, "contact");
      if (!stopped && !blocked() && brief.ownerRole) {
        await searchOnce(`${q} ${brief.ownerRole}`, `owner:${brief.ownerRole}`);
      }
      closeStepWith(deps.budget, before, snapshotOf(enrichment, evidence), callsUsed - callsBefore, (now().getTime() - startedMs) / 1000);
    }
    // Step 3: recent news.
    {
      const before = snapshotOf(enrichment, evidence); const callsBefore = callsUsed; const startedMs = now().getTime();
      if (!stopped && !blocked()) await feedOnce();
      closeStepWith(deps.budget, before, snapshotOf(enrichment, evidence), callsUsed - callsBefore, (now().getTime() - startedMs) / 1000);
    }
    // Step 4: social channels, only those reachStatus reports ok.
    {
      const before = snapshotOf(enrichment, evidence); const callsBefore = callsUsed; const startedMs = now().getTime();
      if (!stopped && !blocked()) {
        for (const channel of SOCIAL_CHANNELS) {
          if (stopped || blocked()) break;
          // linkedin's backend takes a username, not a name query: skip it here.
          if (channel === "linkedin") continue;
          if (status?.channels[channel]?.ok !== true) continue;
          await socialOk(channel, q);
        }
      }
      closeStepWith(deps.budget, before, snapshotOf(enrichment, evidence), callsUsed - callsBefore, (now().getTime() - startedMs) / 1000);
    }
    enrichment = await finish(enrichment);
    if (enrichment) checkEnough();
  }

  if (deps.channelDeps) {
    try {
      const { channelEvidenceFor } = await import("./research-channels.js");
      const extra = await channelEvidenceFor(lead, deps.channelDeps);
      evidence.push(...extra.evidence);
      notes.push(...extra.notes);
    } catch (err) {
      notes.push(`channel evidence skipped: ${String((err as Error).message ?? err)}`);
    }
  }

  return {
    enrichment: enrichment as NonNullable<typeof enrichment>,
    evidence,
    mode,
    degraded,
    notes,
    callsUsed,
    ...(stopped ? { stoppedBecause: stopped } : {}),
  };
}
