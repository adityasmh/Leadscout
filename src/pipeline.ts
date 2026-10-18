// src/pipeline.ts
// Wave 2 pipeline driver: stages S0–S7 with cost gate, page cache and stop conditions.

import {
  listJobs,
  updateJob,
  upsertLead,
  updateLead,
  getWorkspace,
  type LeadInput,
} from "./store.js";
import type { RawLead, Enrichment, Match, Offer, Lead, Workspace, JobQuery, Job } from "./types.js";
import type {
  Evidence,
  Verification,
  LeadScore,
  Dossier,
  CategoryExplainer,
  PriceBook,
  LlmFn,
  UsageField,
} from "./types-v2.js";
import { cachedFetch } from "./page-cache.js";
import { DEFAULT_BUDGET, record, spentForJob, callsFor, selectForLlm } from "./cost.js";
import { planBudget, startBudget, summarize } from "./research-budget.js";
import { normalizePhone } from "./enrich.js";
import {
  defaultReachApi,
  researchBusiness,
  resolveReachMode,
    type ReachApi,
  type ReachMode,
  type ResearchEvidence,
} from "./research.js";
import { timingForLead, mergeSignals } from "./pipeline-timing.js";
import type { TimingObservation } from "./timing.js";
// ORDER_L42: resolveContacts and its deps/outcome types live in ./resolve.js (owned by
// the L42 resolver coder). The type is imported here only; the value is loaded through
// the same optional-module loader used for every other module, so pipeline.ts still
// runs before ./resolve.js exists (contactless leads then stay 'unreachable').
// resolve.js owns the reach.ts fallback (its live gate is LEADSCOUT_RESOLVE_LIVE=1) and
// honours an injected deps.search/deps.fetchPage, so the pipeline injects neither.
import type { ResolveContactsFn } from "./resolve.js";
import type { ChannelDeps } from "./channels/types.js";
import { channelDepsForJob } from "./pipeline-channels.js";

// The three counts ORDER_L42 adds to a job result. They are returned from runJob
// because the store's Job type (owned by L2) is outside this order's file list.
// L33 adds the optional `research` summary (mode used, degraded flag, calls used) to
// the returned object; the store Job type has no column for it and must not be edited.
export type JobCounts = {
  found: number;
  resolved: number;
  unreachable: number;
  research?: { mode: ReachMode; degraded: boolean; callsUsed: number; budget?: { savedCalls: number; stepsSkipped: number } };
  timing?: { flagged: number; reachOutNow: number };
};

// Score cap for a lead with no contact route after resolution. Same value match.ts
// applies from data/service-rules.json (scoring.unreachableCap).
const UNREACHABLE_SCORE_CAP = 30;

export type PipelineDeps = {
  discover?: (q: JobQuery & { limit?: number }, deps?: { fetchFn?: typeof fetch }) => Promise<RawLead[]>;
  enrich?: (lead: RawLead, deps?: { fetchFn?: typeof fetch }) => Promise<Enrichment>;
  match?: (lead: RawLead, e: Enrichment, offer: Offer) => Match;
  verify?: (raw: RawLead, e: Enrichment, deps?: { fetchFn?: typeof fetch }) => Promise<Verification>;
  scoreLead?: (
    lead: Lead,
    v: Verification,
    opts?: { month?: number; calendar?: unknown; optedOut?: boolean }
  ) => LeadScore;
  buildEvidence?: (
    raw: RawLead,
    e: Enrichment,
    pages: { url: string; body: string; fetchedAt: string }[],
    v?: Verification
  ) => Evidence[];
  extractFacts?: (evidence: Evidence[], raw: RawLead) => Dossier["facts"];
  bizKey?: (raw: RawLead, phonesE164?: string[]) => string;
  saveEvidence?: (bizKey: string, hash: string, evidence: Evidence[]) => void;
  getExplainer?: (
    category: string,
    country: string,
    deps?: { llm?: LlmFn; allowGenerate?: boolean; language?: string }
  ) => Promise<CategoryExplainer | null>;
  buildTemplateDossier?: (input: DossierInput) => Dossier;
  polishDossier?: (input: DossierInput, draft: Dossier, deps: { llm: LlmFn }) => Promise<Dossier>;
  inputHashOf?: (input: DossierInput) => string;
  saveDossier?: (d: Dossier) => void;
  getDossier?: (workspaceId: string, leadId: string) => Dossier | undefined;
  isSuppressed?: (
    lead: { website?: string; emails?: string[]; phones?: string[]; email?: string; phone?: string },
    ws: string,
    bizKey?: string
  ) => { suppressed: boolean; reason?: string };
  getPriceBook?: (ws: string) => PriceBook;
  checkLimit?: (ws: string, field: UsageField, n: number) => { ok: boolean; remaining: number; message?: string };
  meter?: (ws: string, field: UsageField, n: number) => void;
  llm?: LlmFn;
  resolveContacts?: ResolveContactsFn;
  reach?: ReachApi | null;
  researchMode?: ReachMode;
  channelDeps?: ChannelDeps | null;
  fetchFn?: typeof fetch;
  now?: () => Date;
  timingObservations?: (raw: RawLead) => TimingObservation[];
};

type DossierInput = {
  lead: Lead;
  evidence: Evidence[];
  facts: Dossier["facts"];
  score: LeadScore;
  priceBook: PriceBook;
  explainer?: CategoryExplainer | null;
  workspaceName: string;
  offer: Offer;
  senderName?: string;
};

const CONCURRENCY = 4;
const DEFAULT_PAGE_TIMEOUT_MS = 8000;
const NOMINATIM_HOST = "nominatim.openstreetmap.org";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function isRateLimitOrServerError(err: unknown): boolean {
  const text = String((err as Error)?.message ?? err);
  return /\b429\b/.test(text) || /\b5\d{2}\b/.test(text);
}

function noopMeter(): void {}
function okLimit(): { ok: boolean; remaining: number; message?: string } {
  return { ok: true, remaining: Infinity };
}

async function loadDefault<T>(path: string): Promise<T | undefined> {
  try {
    const mod = await import(path);
    return mod as T;
  } catch {
    return undefined;
  }
}

async function resolveDeps(provided: Partial<PipelineDeps>): Promise<PipelineDeps> {
  const [
    discoverMod,
    enrichMod,
    matchMod,
    verifyMod,
    scoreMod,
    evidenceMod,
    explainerMod,
    dossierMod,
    complianceMod,
    tenantMod,
    accessMod,
    llmMod,
    resolveMod,
  ] = await Promise.all([
    loadDefault<{ discover: PipelineDeps["discover"] }>("./discover.js"),
    loadDefault<{ enrich: PipelineDeps["enrich"] }>("./enrich.js"),
    loadDefault<{ match: PipelineDeps["match"] }>("./match.js"),
    loadDefault<{ verify: PipelineDeps["verify"] }>("./verify.js"),
    loadDefault<{ scoreLead: PipelineDeps["scoreLead"] }>("./score.js"),
    loadDefault<{
      buildEvidence: PipelineDeps["buildEvidence"];
      extractFacts: PipelineDeps["extractFacts"];
      bizKey: PipelineDeps["bizKey"];
      saveEvidence: PipelineDeps["saveEvidence"];
    }>("./evidence.js"),
    loadDefault<{ getExplainer: PipelineDeps["getExplainer"] }>("./explainer.js"),
    loadDefault<{
      buildTemplateDossier: PipelineDeps["buildTemplateDossier"];
      polishDossier: PipelineDeps["polishDossier"];
      inputHashOf: PipelineDeps["inputHashOf"];
      saveDossier: PipelineDeps["saveDossier"];
      getDossier: PipelineDeps["getDossier"];
    }>("./dossier.js"),
    loadDefault<{ isSuppressed: PipelineDeps["isSuppressed"] }>("./compliance.js"),
    loadDefault<{ getPriceBook: PipelineDeps["getPriceBook"] }>("./tenant.js"),
    loadDefault<{ checkLimit: PipelineDeps["checkLimit"]; meter: PipelineDeps["meter"] }>("./access.js"),
    loadDefault<{ defaultLlm: LlmFn }>("./llm.js"),
    loadDefault<{ resolveContacts: PipelineDeps["resolveContacts"] }>("./resolve.js"),
  ]);

  return {
    discover: provided.discover ?? discoverMod?.discover,
    enrich: provided.enrich ?? enrichMod?.enrich,
    match: provided.match ?? matchMod?.match,
    verify: provided.verify ?? verifyMod?.verify,
    scoreLead: provided.scoreLead ?? scoreMod?.scoreLead,
    buildEvidence: provided.buildEvidence ?? evidenceMod?.buildEvidence,
    extractFacts: provided.extractFacts ?? evidenceMod?.extractFacts,
    bizKey: provided.bizKey ?? evidenceMod?.bizKey,
    saveEvidence: provided.saveEvidence ?? evidenceMod?.saveEvidence,
    getExplainer: provided.getExplainer ?? explainerMod?.getExplainer,
    buildTemplateDossier: provided.buildTemplateDossier ?? dossierMod?.buildTemplateDossier,
    polishDossier: provided.polishDossier ?? dossierMod?.polishDossier,
    inputHashOf: provided.inputHashOf ?? dossierMod?.inputHashOf,
    saveDossier: provided.saveDossier ?? dossierMod?.saveDossier,
    getDossier: provided.getDossier ?? dossierMod?.getDossier,
    isSuppressed: provided.isSuppressed ?? complianceMod?.isSuppressed,
    getPriceBook: provided.getPriceBook ?? tenantMod?.getPriceBook,
    checkLimit: provided.checkLimit ?? accessMod?.checkLimit,
    meter: provided.meter ?? accessMod?.meter,
    llm: provided.llm ?? llmMod?.defaultLlm,
    resolveContacts: provided.resolveContacts ?? resolveMod?.resolveContacts,
    reach: provided.reach,
    researchMode: provided.researchMode,
    channelDeps: provided.channelDeps,
    fetchFn: provided.fetchFn ?? fetch,
    now: provided.now ?? (() => new Date()),
    timingObservations: provided.timingObservations,
  };
}

function buildLead(raw: RawLead, enrichment: Enrichment, match: Match, workspaceId: string, now: Date): Lead {
  return {
    ...raw,
    ...enrichment,
    ...match,
    id: "",
    workspaceId,
    status: "new",
    notes: "",
    createdAt: now.toISOString(),
  };
}

/**
 * Merge web-resolved contacts (ORDER_L42) back onto the raw lead before enrich, so
 * the existing S2–S4 stages see the same fields an OSM contact tag would have set.
 * Only the first contact of each kind is used, and an existing field is never
 * overwritten. `kind: "social"` is deliberately ignored: a social profile is not a
 * reachable route (phone/email/website), so a social-only lead stays 'unreachable'.
 */
function mergeResolvedContacts(raw: RawLead, contacts: Array<{ kind: string; value: string }>): void {
  for (const contact of contacts) {
    if (!contact || typeof contact.value !== "string" || contact.value.trim() === "") continue;
    if (contact.kind === "phone" && !raw.phone) {
      raw.phone = normalizePhone(contact.value) ?? contact.value;
    } else if (contact.kind === "email" && !raw.email) {
      raw.email = contact.value;
    } else if (contact.kind === "website" && !raw.website) {
      raw.website = contact.value;
    }
  }
}

/**
 * L33: append research evidence (reach page/search/feed/social items) to the evidence
 * the builder produced, without changing buildEvidence's signature. Ids are re-prefixed
 * ("R1", "R2", ...) so they never collide with the builder's "E" ids; the channel and
 * untrusted:true fields ride along on each item, so dossier prompts still see reach text
 * only as quoted untrusted evidence.
 */
function mergeResearchEvidence(base: Evidence[], research: ResearchEvidence[] | undefined): Evidence[] {
  if (!research || research.length === 0) return base;
  const used = new Set(base.map((e) => e.id));
  const out: Evidence[] = [...base];
  let n = base.length;
  for (const item of research) {
    let id: string;
    do {
      n += 1;
      id = `R${n}`;
    } while (used.has(id));
    used.add(id);
    const merged: ResearchEvidence = { ...item, id };
    out.push(merged);
  }
  return out;
}

function addTimeout(init: RequestInit | undefined, ms: number): RequestInit {
  const next = { ...(init ?? {}) };
  next.signal = AbortSignal.timeout(ms);
  return next;
}

export async function runJob(
  workspaceId: string,
  jobId: string,
  deps: Partial<PipelineDeps> = {},
  // ORDER L30-wiring-3: the optional `brief` carries the compiled Target Brief from the
  // server's brief/run route. Only `exclusions` is enforced here (S1 filter below); the
  // scoring weights and lookalike profile are forwarded for the runner to apply.
  options: {
    leads?: RawLead[];
    brief?: { exclusions?: { terms?: string[] }; scoringWeights?: Record<string, number>; lookalike?: unknown };
  } = {}
): Promise<JobCounts> {
  const d = await resolveDeps(deps);
  const zeroCounts: JobCounts = { found: 0, resolved: 0, unreachable: 0 };

  if ((!options.leads && !d.discover) || !d.enrich || !d.match) {
    const missing = (options.leads ? ["enrich", "match"] : ["discover", "enrich", "match"])
      .filter((n) => !(d as Record<string, unknown>)[n])
      .join(", ");
    updateJob(workspaceId, jobId, { status: "failed", error: `missing required wave-1 module: ${missing}` });
    return zeroCounts;
  }

  const job = getJob(workspaceId, jobId);
  if (!job) return zeroCounts;

  updateJob(workspaceId, jobId, { status: "running" });

  const workspace = getWorkspace(workspaceId);
  const offer = workspace?.offer ?? { services: [], description: "" };
  const now = d.now!();
  const errors: string[] = [];

  const maxMinutes = Number(process.env.LEADSCOUT_JOB_MAX_MINUTES ?? 30);
  const wallLimit = now.getTime() + maxMinutes * 60 * 1000;
  const limit = Math.max(1, Math.floor(job.query.limit ?? 50));
  const pageCap = 4 * limit;
  let pagesFetched = 0;
  const badHosts = new Set<string>();
  const meter = d.meter ?? noopMeter;
  const checkLimit = d.checkLimit ?? okLimit;

  // L33-reach-wiring: the Agent Reach api is built ONCE per job and shared by every
  // researchBusiness call. `off` builds nothing (zero reach interaction). An injected
  // PipelineDeps.reach (including null) is an offline test override; otherwise the
  // module default is used. The degraded warning is emitted once per job via the
  // wrapper below even though researchBusiness warns once per lead.
  const researchMode: ReachMode = d.researchMode ?? resolveReachMode();
  const reachApi: ReachApi | null =
    d.reach !== undefined ? d.reach : researchMode === "off" ? null : defaultReachApi();
  // L54G: channel deps resolved ONCE per job; absent by default so behavior is unchanged.
  const channel = await channelDepsForJob(d.channelDeps);
  if (channel.note) console.warn(channel.note);
  let researchWarned = false;
  let researchCalls = 0;
  let timingFlagged = 0;
  let timingReachOutNow = 0;
  let budgetSavedCalls = 0;
  let budgetStepsSkipped = 0;
  let researchDegraded = false;
  const researchWarn = (message: string): void => {
    if (researchWarned) return;
    researchWarned = true;
    console.warn(message);
  };

  function outOfTime(): boolean {
    return d.now!().getTime() >= wallLimit;
  }

  function overPageCap(): boolean {
    return pagesFetched >= pageCap;
  }

  function overTokenBudget(): boolean {
    return spentForJob(jobId) >= DEFAULT_BUDGET.maxTokensPerJob;
  }

  function addError(stage: string, msg: string): void {
    errors.push(`stage ${stage}: ${msg}`);
  }

  function failJob(error: string): void {
    updateJob(workspaceId, jobId, { status: "failed", error });
  }

  // Wrapped fetch: counts network GETs toward the page cap and tracks per-host failures.
  const countingFetch: typeof fetch = async (input, init) => {
    if (outOfTime()) throw new Error("wall time limit reached");
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const host = hostOf(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (host && badHosts.has(host)) {
      throw new Error(`host ${host} skipped after earlier failure`);
    }
    if (method === "GET" && overPageCap()) {
      throw new Error("page cap reached");
    }
    try {
      const res = await (d.fetchFn! as typeof fetch)(input, addTimeout(init, DEFAULT_PAGE_TIMEOUT_MS));
      if (method === "GET") pagesFetched++;
      return res;
    } catch (err) {
      if (host) badHosts.add(host);
      throw err;
    }
  };

  let fetchFn = cachedFetch({
    fetchFn: countingFetch,
    ttlDaysByHost: { [NOMINATIM_HOST]: 365 },
    now: d.now,
  });

  // ORDER_FC1: optional Firecrawl fallback for JS-heavy or blocked home pages.
  try {
    const { withFirecrawl } = await import("./fc-reader.js");
    fetchFn = withFirecrawl(fetchFn);
  } catch {
    // Firecrawl reader unavailable; keep the plain page fetch.
  }

  // ----------------------------------------------------------------------- S0 Discover
  // ORDER_I1: when the caller supplies the leads (process an existing lead or a CSV
  // import), discovery is skipped and the same stage runner runs over them, so the
  // process routes share every S1-S7 line with the discovery job. Only a real
  // discovery job meters "discovered".
  let rawLeads: RawLead[] = [];
  if (options.leads) {
    rawLeads = options.leads;
  } else {
    try {
      if (outOfTime()) {
        addError("S0", "stopped: wall time limit");
      } else {
        rawLeads = await d.discover!(job.query, { fetchFn });
        meter(workspaceId, "discovered", rawLeads.length);
      }
    } catch (err) {
      if (isRateLimitOrServerError(err)) {
        failJob((err as Error).message);
        return zeroCounts;
      }
      addError("S0", (err as Error).message);
    }
  }

  // ----------------------------------------------------------------------- S1 Listing pre-score
  // ORDER_L42: keep every named business that has a location, regardless of OSM
  // contact tags. Contactless leads are resolved from the web in S1.5 below and, if
  // still unreachable, persisted with status 'unreachable' instead of dropped.
  let preScored: RawLead[] = rawLeads;
  if (!outOfTime()) {
    const icpCats = new Set(workspace?.icp?.categories ?? []);
    // ORDER L30-wiring-3: brief exclusions drop a discovered lead before any scoring,
    // contact resolution or persistence, so an excluded business never becomes a lead.
    const briefExclusions = (options.brief?.exclusions?.terms ?? [])
      .map((term) => String(term).toLowerCase())
      .filter((term) => term.length >= 2);
    preScored = rawLeads.filter((r) => {
      if (!r.name || !r.name.trim()) return false;
      const located =
        Boolean(r.city && r.city.trim()) ||
        Boolean(r.address && r.address.trim()) ||
        (typeof r.lat === "number" && typeof r.lon === "number");
      if (!located) return false;
      if (icpCats.size > 0 && !icpCats.has(r.category)) return false;
      if (briefExclusions.length > 0) {
        const haystack = `${r.name} ${r.category ?? ""}`.toLowerCase();
        if (briefExclusions.some((term) => haystack.includes(term))) return false;
      }
      return true;
    });
    preScored = preScored.slice(0, limit);
  } else {
    addError("S1", "stopped: wall time limit");
  }

  // A contact route is exactly the original S1 keep-rule: phone, email or website.
  // Social-only contacts are NOT a reachable route (ORDER_L42 policy decision).
  const hasContactRoute = (r: RawLead): boolean => Boolean(r.phone || r.email || r.website);

  // ------------------------------------------------------------- S1.5 Contact resolution
  let resolvedCount = 0;
  let unreachableCount = 0;
  const needResolution = preScored.filter((r) => !hasContactRoute(r));
  // External integration OFF by default: an injected resolveContacts (offline tests)
  // always runs because it performs no real I/O; the default ./resolve.js runs only
  // when its live gate LEADSCOUT_RESOLVE_LIVE=1 is set, so a plain run keeps
  // contactless leads and persists them 'unreachable' without any network call.
  const resolveLive = Boolean(deps.resolveContacts) || process.env.LEADSCOUT_RESOLVE_LIVE === "1";
  if (d.resolveContacts && resolveLive && needResolution.length > 0 && !outOfTime()) {
    // Reuse the existing job primitives: remaining wall time and remaining page cap.
    const resolveBudget = {
      calls: Math.max(0, pageCap - pagesFetched),
      deadlineMs: Math.max(0, wallLimit - d.now!().getTime()),
    };
    for (const batch of chunks(needResolution, CONCURRENCY)) {
      if (outOfTime()) {
        addError("S1.5", "stopped: wall time limit");
        break;
      }
      await Promise.all(
        batch.map(async (raw) => {
          try {
            // No search/fetchPage here: ./resolve.js defaults them to its own
            // reach.ts transport (live-gated) and accepts injected fakes in tests.
            const outcome = await d.resolveContacts!(raw, {
              budget: resolveBudget,
              now: d.now,
              fetchFn,
              ...(channel.deps ? { channelDeps: channel.deps } : {}),
            });
            mergeResolvedContacts(raw, outcome?.contacts ?? []);
            // ORDER_L42 honest reporting: a lead that stayed unreachable must name the
            // layer state, and if a search call failed, exactly which call and error.
            if (outcome && outcome.state !== "resolved") {
              const failure = outcome.rejected.find((r) => r.reason === "search-failed");
              addError(
                "S1.5",
                failure
                  ? `resolve "${raw.name}" (${outcome.queries.length} queries): ${failure.error ?? failure.url}`
                  : `resolve "${raw.name}": ${outcome.state} (${outcome.rejected.length} candidates rejected)`
              );
            }
          } catch (err) {
            addError("S1.5", `resolve failed for ${raw.name}: ${(err as Error).message}`);
          }
        })
      );
    }
  }

  // ----------------------------------------------------------------------- S2 Enrich
  const enriched: Array<{ raw: RawLead; enrichment: Enrichment; research: ResearchEvidence[] }> = [];
  if (!d.checkLimit || !d.meter) {
    // The pipeline still runs; missing access module is treated like any other optional module.
    if (!d.checkLimit) addError("S2", "checkLimit skipped: module not installed");
  }
  const enrichLimit = checkLimit(workspaceId, "enriched", preScored.length);
  if (!enrichLimit.ok) {
    addError("S2", enrichLimit.message ?? "enriched limit reached");
  } else if (outOfTime()) {
    addError("S2", "stopped: wall time limit");
  } else {
    for (const batch of chunks(preScored, CONCURRENCY)) {
      if (outOfTime()) {
        addError("S2", "stopped: wall time limit");
        break;
      }
      const batchResults = await Promise.all(
        batch.map(async (raw) => {
          try {
            // L33: every research step goes through the single entry point; `enrich`
            // stays step 1 inside it. The mode, reach api and warn wrapper are per job.
            const plan = process.env.LEADSCOUT_RESEARCH_BUDGET !== "0"
              ? planBudget({ category: String(raw.category ?? ""), website: raw.website, phone: raw.phone, email: raw.email }, {}, {})
              : null;
            const budget = plan ? startBudget(plan) : null;
            const research = await researchBusiness(raw, budget ? { maxCalls: plan!.maxCalls, maxSeconds: plan!.maxSeconds } : {}, {
              enrich: d.enrich!,
              fetchFn,
              reach: reachApi,
              mode: researchMode,
              warn: researchWarn,
              now: d.now,
              ...(channel.deps ? { channelDeps: channel.deps } : {}),
              ...(budget ? { budget } : {}),
            });
            let enrichment = research.enrichment;
            if (process.env.LEADSCOUT_TIMING !== "0") {
              const timing = timingForLead({ category: raw.category, country: raw.country }, d.timingObservations?.(raw) ?? [], d.now?.() ?? new Date());
              enrichment = { ...research.enrichment, signals: mergeSignals(research.enrichment.signals, timing.signals) };
              if (timing.signals.length > 0) timingFlagged++;
              if (timing.reachOutNow) timingReachOutNow++;
            }
            researchCalls += research.callsUsed;
            if (budget) {
              const s = summarize(budget);
              budgetSavedCalls += s.savedCalls;
              budgetStepsSkipped += s.stepsSkipped;
            }
            if (research.degraded) researchDegraded = true;
            return { raw, enrichment, research: research.evidence, ok: true };
          } catch (err) {
            return {
              raw,
              enrichment: {
                summary: `enrichment failed: ${(err as Error).message}`,
                emails: [],
                phones: [],
                socials: {},
                signals: ["site-unreachable"],
              } as Enrichment,
              research: [] as ResearchEvidence[],
              ok: false,
            };
          }
        })
      );
      for (const r of batchResults) {
        if (r.ok) enriched.push({ raw: r.raw, enrichment: r.enrichment, research: r.research });
      }
    }
    meter(workspaceId, "enriched", enriched.length);
  }

  // ----------------------------------------------------------------------- S3 Verify
  const verifications = new Map<string, Verification>();
  if (!d.verify) {
    addError("S3", "verify skipped: module not installed");
  } else {
    for (const batch of chunks(enriched, CONCURRENCY)) {
      if (outOfTime()) {
        addError("S3", "stopped: wall time limit");
        break;
      }
      const results = await Promise.all(
        batch.map(async (item) => {
          try {
            const v = await d.verify!(item.raw, item.enrichment, { fetchFn });
            return { key: item.raw.sourceUrl ?? item.raw.name, v, ok: true };
          } catch (err) {
            return { key: item.raw.sourceUrl ?? item.raw.name, v: null as unknown as Verification, ok: false };
          }
        })
      );
      for (const r of results) {
        if (r.ok) verifications.set(r.key, r.v);
      }
    }
  }

  // ----------------------------------------------------------------------- S4 Match + score
  const scored: Array<{
    raw: RawLead;
    enrichment: Enrichment;
    verification: Verification;
    match: Match;
    score: LeadScore;
    lead: Lead;
    research: ResearchEvidence[];
  }> = [];
  for (const item of enriched) {
    if (outOfTime()) {
      addError("S4", "stopped: wall time limit");
      break;
    }
    const match = d.match!(item.raw, item.enrichment, offer);
    const v = verifications.get(item.raw.sourceUrl ?? item.raw.name) ?? ({
      bizKey: "",
      checkedAt: now.toISOString(),
      website: "not-checked",
      emails: [],
      phones: [],
      whatsapp: false,
      contactable: true,
      reasons: [],
    } as Verification);
    const tmpLead = buildLead(item.raw, item.enrichment, match, workspaceId, now);
    const score = d.scoreLead ? d.scoreLead(tmpLead, v) : defaultScore(match.score, v);
    if (!v.contactable || score.total < 35) score.gate = "hidden";

    // ORDER_L42 post-resolution reachability rule: a lead still without any contact
    // route is kept in the store (never dropped) as 'unreachable' with the score
    // capped, and is therefore hidden from gate-filtered listings and dossiers.
    const routeless = !hasContactRoute(item.raw);
    if (routeless) {
      score.total = Math.min(score.total, UNREACHABLE_SCORE_CAP);
      score.gate = "hidden";
      score.reasons.push(
        `reachability: no contact route after resolution -> 'unreachable', score capped at ${UNREACHABLE_SCORE_CAP}`
      );
    }

    const lead = buildLead(item.raw, item.enrichment, match, workspaceId, now);
    const input = { ...(lead as LeadInput), score: score.total };
    if (routeless) {
      // Lead["status"] is a union that does not include "unreachable" and types.ts is
      // outside this order's file list, so the status is widened here at the call site
      // only (store.ts persists status as free text).
      (input as { status: string }).status = "unreachable";
    }
    const saved = upsertLead(input);
    // Store status is free text at runtime; compare widened so the type union difference
    // (types.ts owns the narrow union) does not hide the real persisted value.
    if (routeless && String(saved.status) !== "unreachable") {
      // The store preserves an existing status on merge; force it for this run.
      updateLead(workspaceId, saved.id, { status: "unreachable" } as unknown as Partial<Lead>);
    }
    lead.id = saved.id;

    scored.push({ raw: item.raw, enrichment: item.enrichment, verification: v, match, score, lead, research: item.research });
  }

  updateJob(workspaceId, jobId, { found: preScored.length, enriched: enriched.length });

  // ----------------------------------------------------------------------- S5 Evidence
  let evidenceBuilt = false;
  if (!d.buildEvidence) {
    addError("S5", "buildEvidence skipped: module not installed");
  } else {
    evidenceBuilt = true;
    for (const s of scored) {
      if (outOfTime()) {
        addError("S5", "stopped: wall time limit");
        break;
      }
      if (s.score.gate === "hidden") continue;
      const pages: { url: string; body: string; fetchedAt: string }[] = []; // L15 saves pages itself
      d.buildEvidence!(s.raw, s.enrichment, pages, s.verification);
    }
  }

  // ----------------------------------------------------------------------- S6 + S7 Dossiers
  const priceBook = d.getPriceBook
    ? d.getPriceBook(workspaceId)
    : ({ workspaceId, version: 1, items: [], updatedAt: now.toISOString() } as PriceBook);
  let explainer: CategoryExplainer | null = null;
  if (d.getExplainer) {
    try {
      explainer = await d.getExplainer(job.query.category ?? "", job.query.country ?? "", {
        llm: d.llm,
        allowGenerate: false,
      });
    } catch (err) {
      addError("S6", `getExplainer failed: ${(err as Error).message}`);
    }
  }

  const shown = scored.filter((s) => s.score.gate !== "hidden");
  const dossierInputs = new Map<string, DossierInput>();
  const templateDossiers = new Map<string, Dossier>();

  if (!d.buildTemplateDossier) {
    addError("S6", "buildTemplateDossier skipped: module not installed");
  } else {
    for (const s of shown) {
      if (outOfTime()) {
        addError("S6", "stopped: wall time limit");
        break;
      }
      const facts = d.extractFacts ? d.extractFacts([], s.raw) : {};
      const input: DossierInput = {
        lead: s.lead,
        evidence: [],
        facts,
        score: s.score,
        priceBook,
        explainer,
        workspaceName: workspace?.name ?? "",
        offer,
      };
      if (evidenceBuilt && d.buildEvidence) {
        // L33: hand the builder output plus the untrusted reach evidence items to the
        // dossier path. buildEvidence's signature is unchanged; research items get new
        // non-colliding ids and keep url / channel / fetchedAt / untrusted.
        const built = d.buildEvidence(s.raw, s.enrichment, [], s.verification);
        input.evidence = mergeResearchEvidence(built, s.research);
        // DR1: optional doctor direct-contact evidence; never touches lead.phone.
        try { const dc = await import("./doctor-contact.js"); const f = dc.findDecisionMaker(s.raw, (s.research ?? []).map((r) => ({ url: r.url, body: String(r.quote ?? "") }))); if (f.found) input.evidence = mergeResearchEvidence(input.evidence, dc.toEvidence(f)); } catch { /* skip when unavailable */ }
      }
      dossierInputs.set(s.lead.id, input);
      const draft = d.buildTemplateDossier!(input);
      templateDossiers.set(s.lead.id, draft);
      if (d.saveDossier) d.saveDossier(draft);
      meter(workspaceId, "dossiers", 1);
    }
  }

  // ----------------------------------------------------------------------- S7 Model polish
  const llmOff = process.env.LEADSCOUT_LLM_OFF === "1";
  if (llmOff) {
    // skipped globally
  } else if (!d.polishDossier || !d.inputHashOf) {
    if (!d.polishDossier) addError("S7", "polishDossier skipped: module not installed");
    if (!d.inputHashOf) addError("S7", "inputHashOf skipped: module not installed");
  } else if (!d.llm) {
    addError("S7", "llm skipped: module not installed");
  } else {
    const polishLimit = checkLimit(workspaceId, "dossiers", shown.length);
    if (!polishLimit.ok) {
      addError("S7", polishLimit.message ?? "dossier limit reached");
    } else if (overTokenBudget()) {
      addError("S7", "stopped: token budget reached");
    } else {
      const candidates = shown.map((s) => ({
        leadId: s.lead.id,
        total: s.score.total,
        gate: s.score.gate,
        richEvidence: 0, // filled below if evidence module is present
      }));
      for (const c of candidates) {
        const input = dossierInputs.get(c.leadId);
        if (input) c.richEvidence = input.evidence.filter((e) => e.kind === "page-text" || e.kind === "structured-data").length;
      }
      const selectedIds = selectForLlm(candidates, DEFAULT_BUDGET, spentForJob(jobId));
      const selected = shown.filter((s) => selectedIds.includes(s.lead.id));

      for (const s of selected) {
        if (outOfTime()) {
          addError("S7", "stopped: wall time limit");
          break;
        }
        if (overTokenBudget()) {
          addError("S7", "stopped: token budget reached");
          break;
        }
        const input = dossierInputs.get(s.lead.id);
        if (!input) continue;
        const inputHash = d.inputHashOf!(input);

        if (d.getDossier) {
          const existing = d.getDossier(workspaceId, s.lead.id);
          if (existing && existing.inputHash === inputHash) continue;
        }
        if (callsFor(s.lead.id, inputHash) >= 2) continue;

        const draft = templateDossiers.get(s.lead.id);
        if (!draft) continue;

        try {
          const polished = await d.polishDossier!(input, draft, { llm: d.llm });
          if (d.saveDossier) d.saveDossier(polished);
          record({
            workspaceId,
            jobId,
            leadId: s.lead.id,
            inputHash,
            purpose: "dossier",
            model: polished.model,
            tokensIn: polished.tokensIn,
            tokensOut: polished.tokensOut,
          });
          meter(workspaceId, "tokensIn", polished.tokensIn);
          meter(workspaceId, "tokensOut", polished.tokensOut);
          // Raise gate for selected leads.
          s.score.gate = "llm";
        } catch (err) {
          addError("S7", `polish failed for ${s.lead.id}: ${(err as Error).message}`);
        }
      }
    }
  }

  // ORDER_L42 counts: found = every named+located business S1 kept; resolved = has a
  // contact route after resolution; unreachable = the rest (persisted, never dropped).
  resolvedCount = scored.filter((s) => hasContactRoute(s.raw)).length;
  unreachableCount = scored.length - resolvedCount;

  const errorText = errors.join("; ");
  updateJob(workspaceId, jobId, {
    status: "done",
    error: errorText || undefined,
    found: preScored.length,
    enriched: enriched.length,
  });
  return {
    found: preScored.length,
    resolved: resolvedCount,
    unreachable: unreachableCount,
    // L33: job result carries the research mode used, whether reach was degraded and
    // how many research calls the job spent. The store Job type has no field for this,
    // so it lives on the returned object (see REPORT_L33).
    research: { mode: researchMode, degraded: researchDegraded, callsUsed: researchCalls, ...(process.env.LEADSCOUT_RESEARCH_BUDGET !== "0" ? { budget: { savedCalls: budgetSavedCalls, stepsSkipped: budgetStepsSkipped } } : {}) },
    ...(process.env.LEADSCOUT_TIMING !== "0" ? { timing: { flagged: timingFlagged, reachOutNow: timingReachOutNow } } : {}),
  };
}

function getJob(workspaceId: string, jobId: string): Job | undefined {
  return listJobs(workspaceId).find((j) => j.id === jobId);
}

function defaultScore(matchScore: number, v: Verification): LeadScore {
  return {
    total: matchScore,
    fit: 0,
    reach: v.contactable ? 50 : 0,
    timing: 0,
    gate: matchScore >= 35 && v.contactable ? "template" : "hidden",
    reasons: [],
  };
}
