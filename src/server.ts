// HTTP API + static file server for leadscout. node:http only, no dependencies.
// Port: env LEADSCOUT_PORT (default 8790).
// Wave 2 (PLAN_V2 4.2): dossier, price book, branding, API keys, usage/limits, export
// formats, share/report and optout routes, plus Bearer-key auth when
// LEADSCOUT_REQUIRE_KEYS=1. Route modules are loaded through dynamic imports with
// variable specifiers, so a missing module answers 501 instead of crashing.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEAD_STATUSES, type Icp, type Lead, type LeadFilter, type LeadStatus, type Offer, type RawLead } from "./types.js";
import type {
  Branding,
  CategoryExplainer,
  Dossier,
  LeadScore,
  Limits,
  LlmFn,
  PriceBook,
  PriceItem,
  Verification,
} from "./types-v2.js";
import type { DossierInput } from "./dossier.js";
import type { PipelineDeps } from "./pipeline.js";
import type { LedgerEntry } from "./cost.js";
import {
  createJob, createWorkspace, getLead, getWorkspace, leadsToCsv, listJobs, listLeads,
  listWorkspaces, updateJob, updateLead, updateProfile, upsertLead,
} from "./store.js";
import { recordStatusChange } from "./learn-score.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");
const MAX_BODY = 1_000_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const NOT_BUILT_PAGE = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8"><title>leadscout</title></head>',
  "<body><h1>leadscout</h1><p>The UI is not built yet. The API is available under /api/.</p></body></html>",
].join("\n");

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "body must be valid JSON");
  }
}

async function readTextBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(body: unknown, label: string): Record<string, unknown> {
  if (!isRecord(body)) throw new HttpError(400, `${label} must be a JSON object`);
  return body;
}

function parseOffer(value: unknown): Offer {
  if (!isRecord(value)) throw new HttpError(400, "offer must be {services: string[], description: string}");
  const services = value.services;
  if (!Array.isArray(services) || services.some((s: unknown) => typeof s !== "string")) {
    throw new HttpError(400, "offer.services must be a string array");
  }
  const description = value.description;
  if (typeof description !== "string") throw new HttpError(400, "offer.description must be a string");
  return { services: [...services], description };
}

function parseIcp(value: unknown): Icp {
  if (!isRecord(value)) throw new HttpError(400, "icp must be {categories: string[], cities: string[], countries: string[]}");
  const out: Icp = { categories: [], cities: [], countries: [] };
  for (const key of ["categories", "cities", "countries"] as const) {
    const arr = value[key];
    if (!Array.isArray(arr) || arr.some((s: unknown) => typeof s !== "string")) {
      throw new HttpError(400, `icp.${key} must be a string array`);
    }
    out[key] = [...arr];
  }
  return out;
}

function parseWorkspaceInput(body: unknown): { name: string; offer: Offer; icp: Icp } {
  const obj = asObject(body, "body");
  const name = obj.name;
  if (typeof name !== "string" || name.trim() === "") throw new HttpError(400, "name is required");
  return { name: name.trim(), offer: parseOffer(obj.offer), icp: parseIcp(obj.icp) };
}

const DISCOVER_SOURCES = ["osm", "google-places", "csv"] as const;

function parseDiscoverBody(body: unknown): { category: string; city?: string; country?: string; limit?: number; source: string; requireWebsite?: boolean } {
  const obj = asObject(body, "body");
  const category = obj.category;
  if (typeof category !== "string" || category.trim() === "") throw new HttpError(400, "category is required");
  const out: { category: string; city?: string; country?: string; limit?: number; source: string; requireWebsite?: boolean } = { category: category.trim(), source: "osm" };
  if (obj.source !== undefined) {
    if (typeof obj.source !== "string" || !(DISCOVER_SOURCES as readonly string[]).includes(obj.source)) {
      throw new HttpError(400, `source must be one of ${DISCOVER_SOURCES.join(", ")}`);
    }
    out.source = obj.source;
  }
  if (obj.city !== undefined) {
    if (typeof obj.city !== "string") throw new HttpError(400, "city must be a string");
    if (obj.city.trim() !== "") out.city = obj.city.trim();
  }
  if (obj.country !== undefined) {
    if (typeof obj.country !== "string") throw new HttpError(400, "country must be a string");
    if (obj.country.trim() !== "") out.country = obj.country.trim();
  }
  if (obj.limit !== undefined) {
    const limit = Number(obj.limit);
    if (!Number.isFinite(limit) || limit <= 0) throw new HttpError(400, "limit must be a positive number");
    out.limit = Math.min(Math.floor(limit), 200);
  }
  if (obj.requireWebsite !== undefined) {
    if (typeof obj.requireWebsite !== "boolean") throw new HttpError(400, "requireWebsite must be a boolean");
    out.requireWebsite = obj.requireWebsite;
  }
  return out;
}

function numberParam(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function filterFromParams(workspaceId: string, params: URLSearchParams): LeadFilter {
  const rawSort = params.get("sort");
  return {
    workspaceId,
    status: params.get("status") ?? undefined,
    minScore: numberParam(params, "minScore"),
    city: params.get("city") ?? undefined,
    category: params.get("category") ?? undefined,
    signal: params.get("signal") ?? undefined,
    q: params.get("q") ?? undefined,
    sort: rawSort === "score" || rawSort === "createdAt" ? rawSort : undefined,
    includeHidden: params.get("includeHidden") === "1" ? true : undefined,
    limit: numberParam(params, "limit"),
    offset: numberParam(params, "offset"),
  };
}

// ------------------------------------------------------------- wave 2 module loading

type AccessModule = typeof import("./access.js");
type ComplianceModule = typeof import("./compliance.js");
type CostModule = typeof import("./cost.js");
type DossierModule = typeof import("./dossier.js");
type EvidenceModule = typeof import("./evidence.js");
type ExplainerModule = typeof import("./explainer.js");
type ExportModule = typeof import("./export.js");
type LlmModule = typeof import("./llm.js");
type ScoreModule = typeof import("./score.js");
type TenantModule = {
  getPriceBook(workspaceId: string): PriceBook;
  setPriceBook(workspaceId: string, items: PriceItem[]): PriceBook;
  getBranding(workspaceId: string): Branding;
  setBranding(workspaceId: string, branding: Branding): Branding;
};
type VerifyModule = typeof import("./verify.js");
type BillingModule = typeof import("./billing.js");
type OutreachModule = typeof import("./outreach.js");
type SourcesExtraModule = typeof import("./sources-extra.js");
type BillingInvoice = ReturnType<BillingModule["buildInvoice"]>;
// ORDER L30-wiring-3: leadgen intake -> brief -> discovery wiring. These modules are
// loaded through importModule so a missing one answers 501 with its name.
type IntakeModule = typeof import("./intake.js");
type LookalikeModule = typeof import("./lookalike.js");
type ReachModule = typeof import("./reach.js");
type BriefRunOptions = { exclusions?: { terms?: string[] }; scoringWeights?: Record<string, number>; lookalike?: unknown };

/**
 * Dynamic import with a variable specifier, wrapped so a missing or broken module
 * answers 501 with a plain message instead of crashing the process. Module
 * function errors themselves are thrown untouched and surface as 500.
 */
async function importModule<T extends object>(specifier: string): Promise<T> {
  // Test hook: a specifier can be pointed at a missing module to exercise the 501 path offline.
  const target = testHooks.moduleOverrides?.[specifier] ?? specifier;
  try {
    return (await import(target)) as T;
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    throw new HttpError(501, `module ${specifier} is not available yet (${message})`);
  }
}

/**
 * Test hooks: `llm` replaces the default model function and `fetchFn` feeds the
 * background pipeline (no real network in checks), `now` fixes the clock for the
 * optout rate limiter. Passing nothing resets to defaults.
 */
type TestHooks = {
  llm?: LlmFn;
  now?: () => Date;
  fetchFn?: typeof fetch;
  transport?: (draft: { to: string }) => Promise<unknown>;
  moduleOverrides?: Record<string, string>;
  // Fixture hook for the e2e check: a partial PipelineDeps (fake discover/enrich/verify/
  // match/score/evidence/dossier functions) used only when LEADSCOUT_TEST_FIXTURES=1.
  pipelineDeps?: Partial<PipelineDeps>;
};
const testHooks: TestHooks = {};
export function setTestHooks(h?: TestHooks): void {
  if (h) Object.assign(testHooks, h);
  else {
    delete testHooks.llm;
    delete testHooks.now;
    delete testHooks.fetchFn;
    delete testHooks.transport;
    delete testHooks.moduleOverrides;
    delete testHooks.pipelineDeps;
  }
}

/**
 * The injected pipeline fixtures (ORDER_I1), enabled only by LEADSCOUT_TEST_FIXTURES=1 so
 * a normal server run never uses them. `fetchFn`/`llm` stay usable on their own for the
 * older checks; the pipeline fixtures require the env switch.
 */
function fixtureDeps(): Partial<PipelineDeps> {
  if (process.env.LEADSCOUT_TEST_FIXTURES !== "1") return {};
  return testHooks.pipelineDeps ?? {};
}

/** Resolved deps for a background pipeline run: fixtures (env-gated) + the fetch/model hooks. */
function pipelineDepsForRun(): Partial<PipelineDeps> {
  const base = fixtureDeps();
  return {
    ...base,
    fetchFn: testHooks.fetchFn ?? base.fetchFn,
    llm: testHooks.llm ?? base.llm,
  };
}

let defaultLlmFn: LlmFn | undefined;

async function currentLlm(): Promise<LlmFn> {
  if (testHooks.llm) return testHooks.llm;
  if (!defaultLlmFn) defaultLlmFn = (await importModule<LlmModule>("./llm.js")).defaultLlm;
  return defaultLlmFn;
}

function currentNow(): Date {
  return (testHooks.now ?? (() => new Date()))();
}

/**
 * Built invoices are kept in memory for this process (billing.ts builds them but has no
 * persistence table). Keyed by the workspace-scoped invoice number.
 */
const invoices = new Map<string, BillingInvoice>();

/**
 * Names of the optional outside integrations that are switched on, decided only by the
 * env vars named in the order/contract. Names only; env values are never returned.
 */
function enabledIntegrations(): string[] {
  const env = process.env;
  const names: string[] = [];
  if (env.LEADSCOUT_LLM_URL && env.LEADSCOUT_LLM_OFF !== "1") names.push("llm");
  if (env.GOOGLE_PLACES_API_KEY) names.push("google-places");
  if (env.LEADSCOUT_SMTP_URL && env.LEADSCOUT_SEND_ENABLED === "1") names.push("email-sending");
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) names.push("razorpay");
  if (env.STRIPE_SECRET_KEY) names.push("stripe");
  if (env.LEADSCOUT_REACH && env.LEADSCOUT_REACH !== "0") names.push("reach");
  return names;
}

/** Money periods default to the current UTC calendar month when the request omits them. */
function defaultInvoicePeriod(): { from: string; to: string } {
  const now = currentNow();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month, 1)).toISOString(),
    to: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
  };
}

// ------------------------------------------------------------------- auth + metering

/**
 * Key auth for /api/workspaces/:ws/* routes, read from env at request time.
 * When LEADSCOUT_REQUIRE_KEYS=1 the bearer must be a valid key of exactly this
 * workspace (write scope for non-GET); each authenticated request meters apiCalls.
 * When the flag is off, behaviour is unchanged (open, as wave 1).
 */
async function authWorkspaceRequest(req: IncomingMessage, workspaceId: string): Promise<void> {
  const requireKeys = process.env.LEADSCOUT_REQUIRE_KEYS === "1";
  const presented = req.headers.authorization !== undefined;
  if (!requireKeys && !presented) return;
  const access = await importModule<AccessModule>("./access.js");
  const key = access.parseBearer(req.headers.authorization);
  if (!key) {
    throw new HttpError(401, "authorization required: send Authorization: Bearer <key> for this workspace");
  }
  const verified = access.verifyApiKey(key);
  if (!verified) throw new HttpError(401, "invalid or revoked API key");
  if (verified.workspaceId !== workspaceId) {
    throw new HttpError(403, "this key belongs to a different workspace");
  }
  if ((req.method ?? "GET") !== "GET" && !verified.scopes.includes("write")) {
    throw new HttpError(403, "this key is read-only; a write-scoped key is needed for this request");
  }
  access.meter(workspaceId, "apiCalls", 1);
}

function sameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ------------------------------------------------------------------ optout rate limit

const OPTOUT_WINDOW_MS = 60 * 60 * 1000;
const OPTOUT_MAX_PER_WINDOW = 10;
const optoutHits = new Map<string, number[]>();

/** Sliding 10-requests-per-IP-per-hour window, in memory, keyed on socket address. */
function allowOptoutRequest(ip: string): boolean {
  const nowMs = currentNow().getTime();
  for (const [addr, hits] of optoutHits) {
    const fresh = hits.filter((t) => nowMs - t < OPTOUT_WINDOW_MS);
    if (fresh.length === 0) optoutHits.delete(addr);
    else optoutHits.set(addr, fresh);
  }
  const hits = (optoutHits.get(ip) ?? []).filter((t) => nowMs - t < OPTOUT_WINDOW_MS);
  if (hits.length >= OPTOUT_MAX_PER_WINDOW) {
    optoutHits.set(ip, hits);
    return false;
  }
  hits.push(nowMs);
  optoutHits.set(ip, hits);
  return true;
}

// ------------------------------------------------------------------ dossier helpers

const CALL_STATUSES = [
  "not-called", "queued", "called", "no-answer", "call-back", "not-interested", "meeting-set",
] as const;

type DossierBundle = {
  dossier: Dossier | null;
  explainer: CategoryExplainer | null;
  score: LeadScore | null;
  verification: Verification | null;
  branding: Branding;
};

/** Reads the wave 2 tables around a lead for the GET/POST dossier shapes. */
async function loadDossierContext(lead: Lead, stored: Dossier | null): Promise<DossierBundle> {
  const workspaceId = lead.workspaceId;
  const [tenantMod, scoreMod, verifyMod, evidenceMod, explainerMod] = await Promise.all([
    importModule<TenantModule>("./tenant.js"),
    importModule<ScoreModule>("./score.js"),
    importModule<VerifyModule>("./verify.js"),
    importModule<EvidenceModule>("./evidence.js"),
    importModule<ExplainerModule>("./explainer.js"),
  ]);
  const key = evidenceMod.bizKey(lead);
  let explainer: CategoryExplainer | null = null;
  if (stored?.explainerId) {
    explainer = explainerMod.listExplainers().find((e) => e.id === stored.explainerId) ?? null;
  }
  // Cache only (allowGenerate false), so no model call and no token spend here.
  if (!explainer) {
    explainer = await explainerMod.getExplainer(lead.category, lead.country ?? "", {
      llm: testHooks.llm,
      allowGenerate: false,
      language: lead.language,
    });
  }
  return {
    dossier: stored,
    explainer: explainer ?? null,
    score: scoreMod.resolveScore(lead, scoreMod.getScore(workspaceId, lead.id)),
    verification: verifyMod.loadVerification(key) ?? null,
    branding: tenantMod.getBranding(workspaceId),
  };
}

/** Returns the stored dossier, or builds and stores a level 0 template dossier when none exists. */
async function ensureTemplateDossier(workspaceId: string, lead: Lead): Promise<Dossier> {
  const [dossierMod, evidenceMod, scoreMod, verifyMod, tenantMod, explainerMod] = await Promise.all([
    importModule<DossierModule>("./dossier.js"),
    importModule<EvidenceModule>("./evidence.js"),
    importModule<ScoreModule>("./score.js"),
    importModule<VerifyModule>("./verify.js"),
    importModule<TenantModule>("./tenant.js"),
    importModule<ExplainerModule>("./explainer.js"),
  ]);
  const stored = dossierMod.getDossier(workspaceId, lead.id);
  if (stored) return stored;
  const workspaceHere = getWorkspace(workspaceId);
  const offer = workspaceHere?.offer ?? { services: [], description: "" };
  const workspaceName = workspaceHere?.name ?? "";
  const key = evidenceMod.bizKey(lead);
  const verification = verifyMod.loadVerification(key) ?? undefined;
  const snapshot = evidenceMod.loadEvidence(key);
  const evidence = snapshot?.evidence ?? evidenceMod.buildEvidence(lead, lead, [], verification);
  const explainer = await explainerMod.getExplainer(lead.category, lead.country ?? "", {
    llm: testHooks.llm,
    allowGenerate: false,
    language: lead.language,
  });
  const input: DossierInput = {
    lead,
    evidence,
    facts: evidenceMod.extractFacts(evidence, lead) as Dossier["facts"],
    score: scoreMod.resolveScore(lead, scoreMod.getScore(workspaceId, lead.id)),
    priceBook: tenantMod.getPriceBook(workspaceId),
    explainer: explainer ?? null,
    workspaceName,
    offer,
    senderName: tenantMod.getBranding(workspaceId).senderName,
  };
  const built = dossierMod.buildTemplateDossier(input);
  dossierMod.saveDossier(built);
  return built;
}

/** Background discover: pipeline.ts is wave 2 and optional; the catch handles a missing/broken module. */
async function runDiscover(workspaceId: string, jobId: string): Promise<void> {
  try {
    // Use a variable specifier so this module stays compilable when pipeline.ts (wave 2) is present
    // but has type issues we cannot edit here; the expected interface is asserted below.
    const pipelinePath = "./pipeline.js";
    const mod = (await import(pipelinePath)) as { runJob?: (workspaceId: string, jobId: string, deps?: { fetchFn?: typeof fetch }) => Promise<unknown> };
    if (typeof mod.runJob !== "function") throw new Error("pipeline.js does not export runJob");
    updateJob(workspaceId, jobId, { status: "running" });
    await mod.runJob(workspaceId, jobId, pipelineDepsForRun());
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    const missing = /cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(message);
    updateJob(workspaceId, jobId, { status: "failed", error: missing ? "pipeline not installed" : message });
  }
}

/**
 * Background process run (ORDER_I1): the same pipeline.ts stage runner as discovery,
 * but over leads that already exist (one lead, or every new/score-0 lead of a
 * workspace). Reports through the jobs list exactly like discovery.
 */
async function runProcess(workspaceId: string, jobId: string, leads: RawLead[]): Promise<void> {
  try {
    const pipelinePath = "./pipeline.js";
    const mod = (await import(pipelinePath)) as {
      runJob?: (
        workspaceId: string,
        jobId: string,
        deps?: Partial<PipelineDeps>,
        options?: { leads?: RawLead[] }
      ) => Promise<unknown>;
    };
    if (typeof mod.runJob !== "function") throw new Error("pipeline.js does not export runJob");
    updateJob(workspaceId, jobId, { status: "running" });
    await mod.runJob(workspaceId, jobId, pipelineDepsForRun(), { leads });
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    const missing = /cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(message);
    updateJob(workspaceId, jobId, { status: "failed", error: missing ? "pipeline not installed" : message });
  }
}

// -------------------------------------------------------------- L30 intake/brief helpers

/**
 * In-memory intake answers per workspace. intake.ts persists only the compiled brief, so the
 * answer state (needed for adaptive next-questions) is kept here for the process.
 */
const intakeAnswers = new Map<string, { answers: Record<string, string | number | string[]>; industry?: string }>();

function intakeStateFor(workspaceId: string): { workspaceId: string; answers: Record<string, string | number | string[]>; industry?: string } {
  const stored = intakeAnswers.get(workspaceId);
  return { workspaceId, answers: stored?.answers ?? {}, industry: stored?.industry };
}

/**
 * Reach availability, name only. The module is imported to prove it is installed; the env
 * switch can turn it off. No channel, install command or error values are returned.
 */
async function reachAvailability(): Promise<{ name: string; available: boolean }> {
  try {
    await importModule<ReachModule>("./reach.js");
  } catch {
    return { name: "reach", available: false };
  }
  return { name: "reach", available: process.env.LEADSCOUT_REACH !== "0" };
}

/** Background brief run: runs one job per compiled query with the brief's exclusions/weights. */
async function runBrief(workspaceId: string, jobId: string, brief: BriefRunOptions): Promise<void> {
  try {
    const pipelinePath = "./pipeline.js";
    const mod = (await import(pipelinePath)) as {
      runJob?: (workspaceId: string, jobId: string, deps?: Partial<PipelineDeps>, options?: { leads?: RawLead[]; brief?: BriefRunOptions }) => Promise<unknown>;
    };
    if (typeof mod.runJob !== "function") throw new Error("pipeline.js does not export runJob");
    updateJob(workspaceId, jobId, { status: "running" });
    await mod.runJob(workspaceId, jobId, pipelineDepsForRun(), { brief });
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    const missing = /cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(message);
    updateJob(workspaceId, jobId, { status: "failed", error: missing ? "pipeline not installed" : message });
  }
}

/** A stored lead stripped back to the RawLead shape the pipeline stages expect. */
function leadToRaw(lead: Lead): RawLead {
  const raw: RawLead = {
    name: lead.name,
    category: lead.category,
    source: lead.source,
    sourceUrl: lead.sourceUrl,
  };
  if (lead.address !== undefined) raw.address = lead.address;
  if (lead.city !== undefined) raw.city = lead.city;
  if (lead.country !== undefined) raw.country = lead.country;
  if (lead.lat !== undefined) raw.lat = lead.lat;
  if (lead.lon !== undefined) raw.lon = lead.lon;
  if (lead.phone !== undefined) raw.phone = lead.phone;
  if (lead.email !== undefined) raw.email = lead.email;
  if (lead.website !== undefined) raw.website = lead.website;
  return raw;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
  const dirReady = existsSync(PUBLIC_DIR) && statSync(PUBLIC_DIR).isDirectory();
  const files = dirReady ? readdirSync(PUBLIC_DIR) : [];
  if (!dirReady || files.length === 0) {
    return void sendText(res, 200, NOT_BUILT_PAGE, "text/html; charset=utf-8");
  }

  let rel = pathname === "" ? "/" : pathname;
  if (rel === "/") rel = "/index.html";
  const safe = normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, "");
  const full = join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) throw new HttpError(403, "forbidden");

  let target = full;
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html");
  if (decodeURIComponent(rel) === "/index.html" && !existsSync(target)) {
    return void sendText(res, 200, NOT_BUILT_PAGE, "text/html; charset=utf-8");
  }
  if (!existsSync(target) || !statSync(target).isFile()) throw new HttpError(404, "not found");

  const data = readFileSync(target);
  res.writeHead(200, {
    "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
    "content-length": data.length,
  });
  res.end(req.method === "HEAD" ? undefined : data);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });

  const method = req.method ?? "GET";

  if (parts.length === 1 && parts[0] === "optout") {
    // Public GET /optout: the opt-out form page. 404 (not a crash) when missing.
    if ((req.method ?? "GET") !== "GET" && (req.method ?? "GET") !== "HEAD") throw new HttpError(405, "method not allowed");
    const page = join(PUBLIC_DIR, "optout.html");
    if (!existsSync(page) || !statSync(page).isFile()) throw new HttpError(404, "optout page not found");
    const data = readFileSync(page);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": data.length });
    res.end(method === "HEAD" ? undefined : data);
    return;
  }

  if (parts[0] !== "api") return serveStatic(req, res, url.pathname);

  if (parts.length === 2 && parts[1] === "health") {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    // L30: report whether the optional `reach` module is available, by name only.
    // L54B: channels counts (best-effort; a missing channels module leaves 0/0).
    let channels = { enabled: 0, total: 0 };
    try {
      await import("./channels/index.js");
      const { channelAdapters } = await import("./channels/registry.js");
      const { channelStatusReport } = await import("./channel-status.js");
      const report = channelStatusReport(channelAdapters());
      channels = { enabled: report.enabledCount, total: report.totalCount };
    } catch { channels = { enabled: 0, total: 0 }; }
    return sendJson(res, 200, { ok: true, integrations: enabledIntegrations(), reach: await reachAvailability(), channels });
  }

  // GET /api/channels/adapters (L54B adapter report; the intake view stays at /api/channels/status)
  if (parts.length === 3 && parts[1] === "channels" && parts[2] === "adapters") {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    await import("./channels/index.js");
    const { channelAdapters } = await import("./channels/registry.js");
    const { channelStatusReport } = await import("./channel-status.js");
    let browserStatus: import("./channels/types.js").BrowserStatus | undefined;
    try {
      const { BrowserReader } = await import("./channels/browser.js");
      browserStatus = new BrowserReader().status();
    } catch { browserStatus = undefined; }
    return sendJson(res, 200, channelStatusReport(channelAdapters(), browserStatus));
  }

  if (parts.length === 2 && parts[1] === "optout") {
    // Public opt-out: rate limited per IP, validated, stored as a global suppression.
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    const ip = req.socket.remoteAddress ?? "unknown";
    if (!allowOptoutRequest(ip)) {
      throw new HttpError(429, "too many opt-out requests from this address; try again later");
    }
    const compliance = await importModule<ComplianceModule>("./compliance.js");
    const validated = compliance.validateOptOutInput(await readJsonBody(req));
    if (!validated.ok) throw new HttpError(400, validated.errors.join("; "));
    const saved = compliance.addOptOut({
      kind: validated.kind as "domain" | "email" | "phone" | "bizKey" | undefined,
      value: validated.value,
      scope: "global",
      source: "public-form",
      note: validated.note,
    });
    return sendJson(res, 200, { ok: true, id: saved.id, kind: saved.kind, value: saved.value });
  }

  if (parts.length === 3 && parts[1] === "report") {
    // Public, read-only client report behind a share token.
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    const access = await importModule<AccessModule>("./access.js");
    const resolved = access.resolveShareToken(parts[2]);
    if (!resolved) throw new HttpError(404, "report not found or expired");
    const workspace = getWorkspace(resolved.workspaceId);
    if (!workspace) throw new HttpError(404, "workspace not found");
    const dossierMod = await importModule<DossierModule>("./dossier.js");
    const tenantMod = await importModule<TenantModule>("./tenant.js");
    const complianceMod = await importModule<ComplianceModule>("./compliance.js");
    const explainerMod = await importModule<ExplainerModule>("./explainer.js");
    const ws = resolved.workspaceId;
    const scope = (resolved.scope ?? {}) as { leadIds?: string[]; filter?: Partial<LeadFilter> };
    let leads: Lead[] = [];
    if (Array.isArray(scope.leadIds)) {
      leads = scope.leadIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => getLead(ws, id))
        .filter((lead): lead is Lead => Boolean(lead));
    } else if (isRecord(scope.filter)) {
      leads = listLeads({ ...(scope.filter as LeadFilter), workspaceId: ws }).leads;
    }
    leads = leads.filter(
      (lead) => !complianceMod.isSuppressed({ website: lead.website, email: lead.email, phone: lead.phone, emails: lead.emails, phones: lead.phones }, ws).suppressed
    );
    const dossiers: Dossier[] = [];
    const explainers: CategoryExplainer[] = [];
    const seenExplainers = new Set<string>();
    for (const lead of leads) {
      const dossier = dossierMod.getDossier(ws, lead.id);
      if (dossier) dossiers.push(dossier);
      if (dossier?.explainerId && !seenExplainers.has(dossier.explainerId)) {
        seenExplainers.add(dossier.explainerId);
        const found = explainerMod.listExplainers().find((e) => e.id === dossier.explainerId);
        if (found) explainers.push(found);
      }
    }
    return sendJson(res, 200, { branding: tenantMod.getBranding(ws), dossiers, explainers });
  }

  if (parts.length === 2 && parts[1] === "workspaces") {
    if (method === "GET") return sendJson(res, 200, listWorkspaces());
    if (method === "POST") {
      const input = parseWorkspaceInput(await readJsonBody(req));
      return sendJson(res, 201, createWorkspace(input));
    }
    throw new HttpError(405, "method not allowed");
  }

  // ---- call-log routes (routes-calls.ts), order CALL1: ONE dynamic hook ----
  // A missing or broken module must never break the API: the catch falls through.
  try {
    const callRoutes = await import("./routes-calls.js");
    if (await callRoutes.handleCallRequest(req, res, url)) return;
  } catch { /* call-log routes unavailable */ }

  // ---- voice-note routes (routes-callnotes.ts), order CALL3: ONE dynamic hook ----
  try {
    const noteRoutes = await import("./routes-callnotes.js");
    if (await noteRoutes.handleCallNoteRequest(req, res, url)) return;
  } catch { /* voice-note routes unavailable */ }

  // ---- intake/brief/lookalike/channels routes (routes-intake.ts), order L30: ONE dynamic hook ----
  // L30-wiring-3 owns the workspace-scoped paths below inline; the optional hook is skipped
  // for those exact paths so the server.ts implementation wins, but still serves its others
  // (GET /intake, /api/channels/status).
  const INTAKE_INLINE_PATHS = /^\/api\/workspaces\/[^/]+\/(?:intake\/(?:next|answer|refine)|brief(?:\/run)?|lookalike\/profile)$/;
  try {
    const intakeRoutes = await import("./routes-intake.js");
    if (!INTAKE_INLINE_PATHS.test(url.pathname) && await intakeRoutes.handleIntakeRequest(req, res, url)) return;
  } catch { /* intake routes unavailable */ }

  // ---- opportunity map routes (routes-opportunity.ts), order OM1: ONE dynamic hook ----
  try {
    const oppRoutes = await import("./routes-opportunity.js");
    if (await oppRoutes.handleOpportunityRequest(req, res, url)) return;
  } catch { /* opportunity routes unavailable */ }

  // ---- showcase overview routes (routes-showcase.ts), order DEMO2: ONE dynamic hook ----
  try {
    const showcaseRoutes = await import("./routes-showcase.js");
    if (await showcaseRoutes.handleShowcaseRequest(req, res, url, {})) return;
  } catch { /* showcase routes unavailable */ }

  // ---- lead-feed routes (routes-feeds.ts), order LG1: ONE dynamic hook ----
  try {
    const feedRoutes = await import("./routes-feeds.js");
    if (await feedRoutes.handleFeedRequest(req, res, url)) return;
  } catch { /* feed routes unavailable */ }

  // ---- niche-pack routes (routes-packs.ts), order NP1: ONE dynamic hook ----
  try {
    const packRoutes = await import("./routes-packs.js");
    if (await packRoutes.handlePackRequest(req, res, url)) return;
  } catch { /* niche-pack routes unavailable */ }

  // ---- call-sheet routes (routes-delivery.ts), order LG3: ONE dynamic hook ----
  try {
    const deliveryRoutes = await import("./routes-delivery.js");
    if (await deliveryRoutes.handleDeliveryRequest(req, res, url)) return;
  } catch { /* delivery routes unavailable */ }

  if (parts.length >= 3 && parts[1] === "workspaces") {
    const workspaceId = parts[2];
    const workspace = getWorkspace(workspaceId);
    if (!workspace) throw new HttpError(404, "workspace not found");

    // PUT limits: admin token only (checked before key auth; the admin token is not an API key).
    if (parts.length === 4 && parts[3] === "limits" && method === "PUT") {
      const access = await importModule<AccessModule>("./access.js");
      const token = access.parseBearer(req.headers.authorization);
      const admin = process.env.LEADSCOUT_ADMIN_TOKEN;
      if (!admin) throw new HttpError(403, "admin token required: LEADSCOUT_ADMIN_TOKEN is not configured");
      if (!token || !sameSecret(token, admin)) {
        throw new HttpError(403, "admin token required: send Authorization: Bearer <admin token>");
      }
      const body = asObject(await readJsonBody(req), "body");
      const patch: Partial<Limits> = {};
      for (const field of ["leadsPerMonth", "dossiersPerMonth", "tokensPerMonth", "exportsPerMonth", "apiCallsPerMonth"] as const) {
        const value = body[field];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          throw new HttpError(400, `${field} must be a non-negative integer`);
        }
        patch[field] = value;
      }
      access.setLimits(workspaceId, patch);
      return sendJson(res, 200, { ok: true, limits: access.getLimits(workspaceId) });
    }

    // Key auth for every workspace route (no-op unless LEADSCOUT_REQUIRE_KEYS=1);
    // also meters apiCalls for requests carrying a valid key.
    await authWorkspaceRequest(req, workspaceId);

    // ---- L30-wiring-3: intake -> brief -> discovery (leadgen) ----

    if (parts.length === 5 && parts[3] === "intake" && parts[4] === "next") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const intakeMod = await importModule<IntakeModule>("./intake.js");
      return sendJson(res, 200, {
        questions: intakeMod.nextQuestions(intakeStateFor(workspaceId)),
        brief: intakeMod.loadBrief(workspaceId) ?? null,
      });
    }

    if (parts.length === 5 && parts[3] === "intake" && parts[4] === "answer") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const intakeMod = await importModule<IntakeModule>("./intake.js");
      const body = asObject(await readJsonBody(req), "body");
      const answers = isRecord(body.answers) ? (body.answers as Record<string, string | number | string[]>) : {};
      const industry = typeof body.industry === "string" ? body.industry : undefined;
      const state = { workspaceId, answers, industry };
      // Save answers and produce + persist the brief, so an end-to-end intake run leaves a
      // brief that GET /brief and POST /brief/run can use immediately.
      intakeAnswers.set(workspaceId, { answers, industry });
      const brief = intakeMod.compileBrief(state);
      intakeMod.saveBrief(workspaceId, brief);
      return sendJson(res, 200, { ok: true, brief, next: intakeMod.nextQuestions(state) });
    }

    if (parts.length === 5 && parts[3] === "intake" && parts[4] === "refine") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const intakeMod = await importModule<IntakeModule>("./intake.js");
      const state = intakeStateFor(workspaceId);
      let model = testHooks.llm;
      if (!model) {
        const llmMod = await importModule<LlmModule>("./llm.js");
        model = llmMod.makeDefaultLlm(testHooks.fetchFn ?? fetch);
        // The default adapter posts to the local router; prove it is reachable, else 501.
        try {
          await model({ system: "ping", prompt: "ping", taskHint: "intake refine" });
        } catch {
          throw new HttpError(501, "intake refine is unavailable: the model router is not reachable");
        }
      }
      const questions = await intakeMod.refineWithModel(state, async (req) => ({ text: (await model!(req)).text }));
      return sendJson(res, 200, { ok: true, questions });
    }

    if (parts.length === 4 && parts[3] === "brief") {
      const intakeMod = await importModule<IntakeModule>("./intake.js");
      if (method === "GET") return sendJson(res, 200, { brief: intakeMod.loadBrief(workspaceId) ?? null });
      if (method === "PUT") {
        const raw = await readJsonBody(req);
        const candidate = isRecord(raw) && "brief" in raw ? (raw as Record<string, unknown>).brief : raw;
        if (!isRecord(candidate) || !Array.isArray((candidate as Record<string, unknown>).sections)) {
          throw new HttpError(400, "brief must be a TargetBrief with a sections array");
        }
        const brief = candidate as Parameters<IntakeModule["saveBrief"]>[1];
        intakeMod.saveBrief(workspaceId, brief);
        return sendJson(res, 200, { ok: true, brief });
      }
      throw new HttpError(405, "method not allowed");
    }

    if (parts.length === 5 && parts[3] === "brief" && parts[4] === "run") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const intakeMod = await importModule<IntakeModule>("./intake.js");
      const brief = intakeMod.loadBrief(workspaceId);
      if (!brief) throw new HttpError(404, "no brief saved for this workspace yet");
      const raw = await readJsonBody(req);
      const body = isRecord(raw) ? raw : {};
      const lookalike = isRecord(body.lookalike) ? body.lookalike : undefined;
      const compiled = intakeMod.briefToQueries(brief);
      const access = await importModule<AccessModule>("./access.js");
      const briefRun: BriefRunOptions = { exclusions: compiled.exclusions, scoringWeights: compiled.scoringWeights, lookalike };
      const jobIds: string[] = [];
      for (const query of compiled.queries) {
        const limit = access.checkLimit(workspaceId, "discovered", Math.max(1, Math.floor(query.limit ?? 50)));
        if (!limit.ok) throw new HttpError(429, limit.message);
        const job = createJob(workspaceId, query);
        void runBrief(workspaceId, job.id, briefRun);
        jobIds.push(job.id);
      }
      return sendJson(res, 202, {
        ok: true,
        jobIds,
        count: jobIds.length,
        queries: compiled.queries,
        exclusions: compiled.exclusions,
        scoringWeights: compiled.scoringWeights,
        dossierTone: compiled.dossierTone,
      });
    }

    if (parts.length === 5 && parts[3] === "lookalike" && parts[4] === "profile") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const lookMod = await importModule<LookalikeModule>("./lookalike.js");
      const body = asObject(await readJsonBody(req), "body");
      if (!Array.isArray(body.examples)) throw new HttpError(400, "examples must be an array of {name, website, category}");
      const examples = body.examples as Parameters<LookalikeModule["buildProfile"]>[0];
      const profile = await lookMod.buildProfile(examples, { fetchFn: testHooks.fetchFn });
      return sendJson(res, 200, { ok: true, profile, explanation: lookMod.explainProfile(profile) });
    }

    if (parts.length === 3) {
      if (method === "GET") return sendJson(res, 200, workspace);
      if (method === "PUT") {
        const body = asObject(await readJsonBody(req), "body");
        const patch: { name?: string; offer?: Offer; icp?: Icp } = {};
        if (body.name !== undefined) {
          if (typeof body.name !== "string" || body.name.trim() === "") throw new HttpError(400, "name must be a non-empty string");
          patch.name = body.name.trim();
        }
        if (body.offer !== undefined) patch.offer = parseOffer(body.offer);
        if (body.icp !== undefined) patch.icp = parseIcp(body.icp);
        const updated = updateProfile(workspaceId, patch);
        return sendJson(res, 200, updated);
      }
      throw new HttpError(405, "method not allowed");
    }

    if (parts.length === 4 && parts[3] === "discover") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const query = parseDiscoverBody(await readJsonBody(req));
      // Monthly lead limit: refuse a new job with 429 before any work starts.
      // Metering for discovered/enriched/dossiers/tokens happens inside pipeline.ts.
      const access = await importModule<AccessModule>("./access.js");
      const leads = access.checkLimit(workspaceId, "discovered", Math.max(1, Math.floor(query.limit ?? 50)));
      if (!leads.ok) throw new HttpError(429, leads.message);
      const job = createJob(workspaceId, query);
      void runDiscover(workspaceId, job.id);
      return sendJson(res, 202, { jobId: job.id });
    }

    // ORDER_I1: process every lead of this workspace with status "new" and score 0,
    // in the background, through the same stage runner as discovery.
    if (parts.length === 4 && parts[3] === "process") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const candidates = listLeads({ workspaceId, status: "new", includeHidden: true, limit: 100000, offset: 0 })
        .leads.filter((lead) => Number(lead.score ?? 0) === 0);
      const raws = candidates.map(leadToRaw);
      const job = createJob(workspaceId, { category: "process", limit: Math.max(1, raws.length) });
      void runProcess(workspaceId, job.id, raws);
      return sendJson(res, 202, { jobId: job.id, leads: raws.length });
    }

    if (parts.length === 4 && parts[3] === "jobs") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return sendJson(res, 200, listJobs(workspaceId));
    }

    if (parts.length === 4 && parts[3] === "usage") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const access = await importModule<AccessModule>("./access.js");
      return sendJson(res, 200, { usage: access.getUsage(workspaceId), limits: access.getLimits(workspaceId) });
    }

    if (parts.length === 4 && parts[3] === "keys") {
      if (method === "POST") {
        const body = asObject(await readJsonBody(req), "body");
        const scopes = body.scopes;
        if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((s: unknown) => typeof s !== "string")) {
          throw new HttpError(400, "scopes must be a non-empty string array of 'read' or 'write'");
        }
        for (const scope of scopes as string[]) {
          if (scope !== "read" && scope !== "write") throw new HttpError(400, `invalid scope: ${scope}`);
        }
        const access = await importModule<AccessModule>("./access.js");
        return sendJson(res, 201, access.createApiKey(workspaceId, scopes as string[]));
      }
      if (method === "GET") {
        const access = await importModule<AccessModule>("./access.js");
        return sendJson(res, 200, access.listApiKeys(workspaceId));
      }
      throw new HttpError(405, "method not allowed");
    }

    if (parts.length === 5 && parts[3] === "keys") {
      if (method !== "DELETE") throw new HttpError(405, "method not allowed");
      const access = await importModule<AccessModule>("./access.js");
      if (!access.revokeApiKey(workspaceId, parts[4])) throw new HttpError(404, "key not found");
      return sendJson(res, 200, { ok: true });
    }

    if (parts.length === 4 && parts[3] === "pricebook") {
      if (method === "GET") {
        const tenantMod = await importModule<TenantModule>("./tenant.js");
        return sendJson(res, 200, tenantMod.getPriceBook(workspaceId));
      }
      if (method === "PUT") {
        const body = asObject(await readJsonBody(req), "body");
        if (!Array.isArray(body.items)) throw new HttpError(400, "items must be an array of price book items");
        const tenantMod = await importModule<TenantModule>("./tenant.js");
        const saved = tenantMod.setPriceBook(workspaceId, body.items as PriceItem[]);
        return sendJson(res, 200, saved);
      }
      throw new HttpError(405, "method not allowed");
    }

    if (parts.length === 4 && parts[3] === "branding") {
      if (method === "GET") {
        const tenantMod = await importModule<TenantModule>("./tenant.js");
        return sendJson(res, 200, tenantMod.getBranding(workspaceId));
      }
      if (method === "PUT") {
        const body = asObject(await readJsonBody(req), "body");
        if (typeof body.displayName !== "string" || body.displayName.trim() === "") {
          throw new HttpError(400, "displayName must be a non-empty string");
        }
        const tenantMod = await importModule<TenantModule>("./tenant.js");
        return sendJson(res, 200, tenantMod.setBranding(workspaceId, body as Branding));
      }
      throw new HttpError(405, "method not allowed");
    }

    if (parts.length === 4 && parts[3] === "export") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const formatRaw = url.searchParams.get("format") ?? "generic";
      const formats = ["generic", "hubspot", "zoho", "twenty", "jsonl"];
      if (!formats.includes(formatRaw)) {
        throw new HttpError(400, `format must be one of ${formats.join(", ")}`);
      }
      const access = await importModule<AccessModule>("./access.js");
      const limit = access.checkLimit(workspaceId, "exports", 1);
      if (!limit.ok) throw new HttpError(429, limit.message);
      // Hidden and suppressed leads are never exported. includeHidden loads all rows,
      // then the gate/suppression filters below decide what actually leaves.
      const filter: LeadFilter = {
        ...filterFromParams(workspaceId, url.searchParams),
        includeHidden: true,
        limit: 100000,
        offset: 0,
      };
      const loaded = listLeads(filter).leads.filter((lead) => lead.gate !== "hidden");
      const complianceMod = await importModule<ComplianceModule>("./compliance.js");
      const leads = loaded.filter(
        (lead) => !complianceMod.isSuppressed({ website: lead.website, email: lead.email, phone: lead.phone, emails: lead.emails, phones: lead.phones }, workspaceId).suppressed
      );
      const extras = new Map<string, { dossier?: Dossier; score?: LeadScore }>();
      const dossierMod = await importModule<DossierModule>("./dossier.js");
      const scoreMod = await importModule<ScoreModule>("./score.js");
      for (const lead of leads) {
        extras.set(lead.id, {
          dossier: dossierMod.getDossier(workspaceId, lead.id),
          score: scoreMod.getScore(workspaceId, lead.id),
        });
      }
      const exportMod = await importModule<ExportModule>("./export.js");
      const out = exportMod.exportRows(leads, extras, formatRaw as "generic" | "hubspot" | "zoho" | "twenty" | "jsonl");
      access.meter(workspaceId, "exports", 1);
      const extension = formatRaw === "jsonl" ? "jsonl" : "csv";
      res.writeHead(200, {
        "content-type": out.contentType,
        "content-disposition": `attachment; filename="leadscout-leads.${extension}"`,
        "content-length": Buffer.byteLength(out.body),
      });
      return void res.end(out.body);
    }

    if (parts.length === 4 && parts[3] === "share") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const body = asObject(await readJsonBody(req), "body");
      if (body.leadIds !== undefined && (!Array.isArray(body.leadIds) || (body.leadIds as unknown[]).some((v) => typeof v !== "string"))) {
        throw new HttpError(400, "leadIds must be an array of lead ids");
      }
      if (body.filter !== undefined && !isRecord(body.filter)) throw new HttpError(400, "filter must be an object");
      let days = 30;
      if (body.days !== undefined) {
        const value = Number(body.days);
        if (!Number.isInteger(value) || value < 0) throw new HttpError(400, "days must be a non-negative integer");
        days = value;
      }
      const scope: { leadIds?: string[]; filter?: Record<string, unknown> } = {};
      if (body.leadIds !== undefined) scope.leadIds = [...(body.leadIds as string[])];
      if (body.filter !== undefined) scope.filter = body.filter as Record<string, unknown>;
      const access = await importModule<AccessModule>("./access.js");
      const token = access.createShareToken(workspaceId, scope, days);
      return sendJson(res, 200, { token, url: `/dossier.html?report=${token}` });
    }

    if (parts.length === 4 && parts[3] === "export.csv") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const filter: LeadFilter = { ...filterFromParams(workspaceId, url.searchParams), limit: 100000, offset: 0 };
      const { leads } = listLeads(filter);
      const csv = leadsToCsv(leads);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="leadscout-leads.csv"',
        "content-length": Buffer.byteLength(csv),
      });
      return void res.end(csv);
    }

    if (parts.length === 4 && parts[3] === "leads") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const result = listLeads(filterFromParams(workspaceId, url.searchParams));
      return sendJson(res, 200, result);
    }

    if (parts.length === 5 && parts[3] === "leads") {
      const leadId = parts[4];
      if (method === "GET") {
        const lead = getLead(workspaceId, leadId);
        if (!lead) throw new HttpError(404, "lead not found");
        return sendJson(res, 200, lead);
      }
      if (method === "PATCH") {
        const body = asObject(await readJsonBody(req), "body");
        const patch: { status?: (typeof LEAD_STATUSES)[number]; notes?: string } = {};
        if (body.status !== undefined) {
          if (typeof body.status !== "string" || !LEAD_STATUSES.includes(body.status as LeadStatus)) {
            throw new HttpError(400, `status must be one of ${LEAD_STATUSES.join(", ")}`);
          }
          patch.status = body.status as LeadStatus;
        }
        if (body.notes !== undefined) {
          if (typeof body.notes !== "string") throw new HttpError(400, "notes must be a string");
          patch.notes = body.notes;
        }
        const lead = updateLead(workspaceId, leadId, patch);
        if (!lead) throw new HttpError(404, "lead not found");
        if (patch.status) {
          // L30 learning hook: record the outcome event (won/replied/rejected carry a label).
          try { recordStatusChange(workspaceId, lead); } catch { /* learning is best-effort */ }
        }
        return sendJson(res, 200, lead);
      }
      throw new HttpError(405, "method not allowed");
    }

    // ORDER_I1: process one existing lead (CSV import or discovered earlier) through the
    // same stage runner as discovery, in the background; report via the jobs list.
    if (parts.length === 6 && parts[3] === "leads" && parts[5] === "process") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const lead = getLead(workspaceId, parts[4]);
      if (!lead) throw new HttpError(404, "lead not found");
      const job = createJob(workspaceId, { category: lead.category, limit: 1 });
      void runProcess(workspaceId, job.id, [leadToRaw(lead)]);
      return sendJson(res, 202, { jobId: job.id, leadId: lead.id });
    }

    if (parts.length === 6 && parts[3] === "leads" && parts[5] === "dossier") {
      const leadId = parts[4];
      const lead = getLead(workspaceId, leadId);
      if (!lead) throw new HttpError(404, "lead not found");
      if (method === "GET") {
        const dossierMod = await importModule<DossierModule>("./dossier.js");
        const stored = dossierMod.getDossier(workspaceId, leadId) ?? null;
        const bundle = await loadDossierContext(lead, stored);
        // ORDER_I1: when no dossier exists yet, say so plainly instead of a bare null.
        if (!stored) {
          return sendJson(res, 200, {
            ...bundle,
            ready: false,
            reason: "no dossier built for this lead yet; POST to this URL to build one",
          });
        }
        return sendJson(res, 200, { ...bundle, ready: true });
      }

      if (method === "PATCH") {
        const body = asObject(await readJsonBody(req), "body");
        if (body.callStatus === undefined) throw new HttpError(400, "callStatus is required");
        if (typeof body.callStatus !== "string" || !(CALL_STATUSES as readonly string[]).includes(body.callStatus)) {
          throw new HttpError(400, `callStatus must be one of ${(CALL_STATUSES as readonly string[]).join(", ")}`);
        }
        const dossierMod = await importModule<DossierModule>("./dossier.js");
        const updated = dossierMod.setCallStatus(workspaceId, leadId, body.callStatus as Dossier["callStatus"]);
        if (!updated) throw new HttpError(404, "dossier not found; POST to build it first");
        return sendJson(res, 200, updated);
      }

      if (method === "POST") {
        // On-demand dossier (PLAN_V2 1.2/4.2): level 0 always built/refreshed,
        // then at most ONE level 1 polish attempt.
        const [dossierMod, evidenceMod, scoreMod, verifyMod, tenantMod, explainerMod, access, costMod] = await Promise.all([
          importModule<DossierModule>("./dossier.js"),
          importModule<EvidenceModule>("./evidence.js"),
          importModule<ScoreModule>("./score.js"),
          importModule<VerifyModule>("./verify.js"),
          importModule<TenantModule>("./tenant.js"),
          importModule<ExplainerModule>("./explainer.js"),
          importModule<AccessModule>("./access.js"),
          importModule<CostModule>("./cost.js"),
        ]);
        const workspaceHere = getWorkspace(workspaceId);
        const offer = workspaceHere?.offer ?? { services: [], description: "" };
        const workspaceName = workspaceHere?.name ?? "";
        const key = evidenceMod.bizKey(lead);
        const verification = verifyMod.loadVerification(key) ?? undefined;
        const snapshot = evidenceMod.loadEvidence(key);
        const evidence = snapshot?.evidence ?? evidenceMod.buildEvidence(lead, lead, [], verification);
        const priceBook = tenantMod.getPriceBook(workspaceId);
        const branding = tenantMod.getBranding(workspaceId);
        // Explainer from cache only (allowGenerate false): no model call, no token spend.
        const explainer = await explainerMod.getExplainer(lead.category, lead.country ?? "", {
          llm: testHooks.llm,
          allowGenerate: false,
          language: lead.language,
        });

        const input: DossierInput = {
          lead,
          evidence,
          facts: evidenceMod.extractFacts(evidence, lead) as Dossier["facts"],
          score: scoreMod.resolveScore(lead, scoreMod.getScore(workspaceId, leadId)),
          priceBook,
          explainer: explainer ?? null,
          workspaceName,
          offer,
          senderName: branding.senderName,
        };

        const hash = dossierMod.inputHashOf(input);
        const stored = dossierMod.getDossier(workspaceId, leadId) ?? null;
        const needsRebuild = !stored || stored.inputHash !== hash;
        let finalDossier: Dossier | null = stored;
        if (needsRebuild) {
          finalDossier = dossierMod.buildTemplateDossier(input);
          dossierMod.saveDossier(finalDossier);
        }

        let note: string;
        if (process.env.LEADSCOUT_LLM_OFF === "1") {
          note = `level 0 kept: model calls are switched off (LEADSCOUT_LLM_OFF=1); level 0 dossier ${needsRebuild ? "rebuilt" : "already stored"}.`;
        } else if (!needsRebuild) {
          note = "kept the stored dossier: the inputs have not changed, so nothing needed rebuilding.";
        } else {
          const limit = access.checkLimit(workspaceId, "dossiers", 1);
          if (!limit.ok) {
            note = `level 0 kept: this month's dossier limit was reached (${limit.message}).`;
          } else {
            // At most one polish attempt. A failure keeps level 0 and is reported, not thrown.
            try {
              const polished = await dossierMod.polishDossier(input, finalDossier as Dossier, { llm: await currentLlm() });
              dossierMod.saveDossier(polished);
              finalDossier = polished;
              access.meter(workspaceId, "dossiers", 1);
              access.meter(workspaceId, "tokensIn", polished.tokensIn);
              access.meter(workspaceId, "tokensOut", polished.tokensOut);
              const entry: LedgerEntry = {
                workspaceId,
                leadId,
                inputHash: hash,
                purpose: "dossier",
                model: polished.model,
                tokensIn: polished.tokensIn,
                tokensOut: polished.tokensOut,
              };
              costMod.record(entry);
              note = polished.level === 1
                ? `polished to level 1 with the model (tokens in ${polished.tokensIn}, out ${polished.tokensOut}).`
                : "kept level 0: the model polish did not produce a better, fully cited rewrite, so the template dossier stays.";
            } catch (err) {
              const message = err instanceof Error && err.message ? err.message : String(err);
              note = `kept level 0: the model polish attempt failed (${message}).`;
            }
          }
        }

        const bundle = await loadDossierContext(lead, finalDossier);
        return sendJson(res, 200, { ...bundle, note });
      }

      throw new HttpError(405, "method not allowed");
    }

    // ---- outreach drafts and safe email sending (outreach.ts) ----

    if (parts.length === 6 && parts[3] === "leads" && parts[5] === "outreach") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const lead = getLead(workspaceId, parts[4]);
      if (!lead) throw new HttpError(404, "lead not found");
      const body = asObject(await readJsonBody(req), "body");
      const channel = body.channel;
      if (channel !== "email" && channel !== "whatsapp" && channel !== "call") {
        throw new HttpError(400, "channel must be one of email, whatsapp, call");
      }
      const [outreachMod, tenantMod] = await Promise.all([
        importModule<OutreachModule>("./outreach.js"),
        importModule<TenantModule>("./tenant.js"),
      ]);
      const dossier = await ensureTemplateDossier(workspaceId, lead);
      const options: { emailTo?: string; phone?: string; waNumber?: string } = {};
      if (typeof body.emailTo === "string") options.emailTo = body.emailTo;
      if (typeof body.phone === "string") options.phone = body.phone;
      if (typeof body.waNumber === "string") options.waNumber = body.waNumber;
      const drafts = outreachMod.buildDrafts(dossier, lead, tenantMod.getBranding(workspaceId), options);
      return sendJson(res, 200, { channel, draft: drafts[channel] });
    }

    if (parts.length === 7 && parts[3] === "leads" && parts[5] === "outreach" && parts[6] === "send") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const lead = getLead(workspaceId, parts[4]);
      if (!lead) throw new HttpError(404, "lead not found");
      const rawBody = await readJsonBody(req);
      const body = isRecord(rawBody) ? rawBody : {};
      const [outreachMod, tenantMod] = await Promise.all([
        importModule<OutreachModule>("./outreach.js"),
        importModule<TenantModule>("./tenant.js"),
      ]);
      const dossier = await ensureTemplateDossier(workspaceId, lead);
      const options: { emailTo?: string } = {};
      if (typeof body.emailTo === "string") options.emailTo = body.emailTo;
      const draft = outreachMod.buildDrafts(dossier, lead, tenantMod.getBranding(workspaceId), options).email;
      // Sending stays OFF unless the env switch named in the order is set. The injected
      // transport (test hook) is only used when sending is enabled, so a real send always
      // needs LEADSCOUT_SEND_ENABLED=1; otherwise this stays a dry run even with a transport.
      const sendEnabled = process.env.LEADSCOUT_SEND_ENABLED === "1";
      const sendDeps = sendEnabled && testHooks.transport ? { transport: testHooks.transport } : {};
      const result = await outreachMod.sendEmail(draft, sendDeps);
      return sendJson(res, 200, { ...result, channel: "email" });
    }

    // ---- billing: usage invoices, printable HTML and payment links (billing.ts) ----

    if (parts.length === 4 && parts[3] === "invoices") {
      const billingMod = await importModule<BillingModule>("./billing.js");
      if (method === "GET") {
        const list = [...invoices.values()].filter((invoice) => invoice.workspaceId === workspaceId);
        return sendJson(res, 200, { invoices: list });
      }
      if (method === "POST") {
        const raw = await readJsonBody(req);
        const body = isRecord(raw) ? raw : {};
        let from: string | undefined;
        let to: string | undefined;
        if (isRecord(body.period)) {
          if (typeof body.period.from === "string") from = body.period.from;
          if (typeof body.period.to === "string") to = body.period.to;
        } else {
          if (typeof body.from === "string") from = body.from;
          if (typeof body.to === "string") to = body.to;
        }
        const fallback = defaultInvoicePeriod();
        const periodFrom = from ?? fallback.from;
        const periodTo = to ?? fallback.to;
        if (Number.isNaN(Date.parse(periodFrom)) || Number.isNaN(Date.parse(periodTo))) {
          throw new HttpError(400, "period from/to must be valid ISO date strings");
        }
        let invoice: BillingInvoice;
        try {
          invoice = billingMod.buildInvoice(workspaceId, { from: periodFrom, to: periodTo });
        } catch (err) {
          if (err instanceof billingMod.BillingError) throw new HttpError(400, err.message);
          throw err;
        }
        invoices.set(invoice.invoiceNumber, invoice);
        return sendJson(res, 201, invoice);
      }
      throw new HttpError(405, "method not allowed");
    }

    if (parts.length === 5 && parts[3] === "invoices" && parts[4].endsWith(".html")) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const invoiceId = parts[4].slice(0, -".html".length);
      const invoice = invoices.get(invoiceId);
      if (!invoice || invoice.workspaceId !== workspaceId) throw new HttpError(404, "invoice not found");
      const billingMod = await importModule<BillingModule>("./billing.js");
      return sendText(res, 200, billingMod.renderInvoiceHtml(invoice), "text/html; charset=utf-8");
    }

    if (parts.length === 6 && parts[3] === "invoices" && parts[5] === "pay-link") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const invoice = invoices.get(parts[4]);
      if (!invoice || invoice.workspaceId !== workspaceId) throw new HttpError(404, "invoice not found");
      const raw = await readJsonBody(req);
      const body = isRecord(raw) ? raw : {};
      const provider = typeof body.provider === "string" ? body.provider : "razorpay";
      const billingMod = await importModule<BillingModule>("./billing.js");
      // Payment adapters read their own env keys and take the injected fetch; with no keys they
      // return {enabled:false} before any request, so this route is offline by default.
      const fetchFn = testHooks.fetchFn ?? fetch;
      let result: Awaited<ReturnType<BillingModule["createPaymentLink"]>>;
      try {
        result = await billingMod.createPaymentLink(invoice, provider, { fetchFn });
      } catch (err) {
        if (err instanceof billingMod.BillingError) throw new HttpError(400, err.message);
        throw err;
      }
      return sendJson(res, 200, result);
    }

    // ---- CSV lead import (sources-extra.ts) ----

    if (parts.length === 4 && parts[3] === "import-csv") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const csvText = await readTextBody(req);
      if (csvText.trim() === "") throw new HttpError(400, "CSV body is required");
      const sourcesMod = await importModule<SourcesExtraModule>("./sources-extra.js");
      const result = sourcesMod.importScraperCsv(csvText);
      const saved = result.leads.map((raw) => upsertLead({ ...raw, workspaceId }));
      return sendJson(res, 200, { imported: saved.length, leads: saved, facts: result.facts, notice: result.notice });
    }

    throw new HttpError(404, "not found");
  }

  throw new HttpError(404, "not found");
}

export function createServer(): Server {
  return createHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) return void sendJson(res, err.status, { error: err.message });
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    });
  });
}

export function startServer(port?: number): Server {
  const server = createServer();
  const fromEnv = Number(process.env.LEADSCOUT_PORT ?? 8790);
  const chosen = port ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 8790);
  // Loopback by default: Leadscout holds lead data and has no login. Set LEADSCOUT_HOST=0.0.0.0 only
  // behind a reverse proxy / firewall you control (the Docker image does this and publishes to 127.0.0.1).
  const host = String(process.env.LEADSCOUT_HOST ?? "").trim() || "127.0.0.1";
  server.listen(chosen, host, () => {
    const address = server.address();
    const shown = typeof address === "object" && address ? address.port : chosen;
    console.log(`leadscout listening on http://${host === "127.0.0.1" ? "localhost" : host}:${shown}`);
  });
  return server;
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isMain) startServer();
