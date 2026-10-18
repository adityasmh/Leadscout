// src/bakeoff.ts
// L35-reach-bakeoff: a one-shot head-to-head between Agent Reach (arm A) and our own
// plain-fetch research path (arm B). docs/leadgen/ORDER_L35-reach-bakeoff.md.
//
// This module is a measurement harness, not product code. It:
//   1. samples real website-bearing businesses by running the existing discovery,
//   2. reads each site itself (homepage + contact/about + sitemap) to build ground truth,
//   3. runs researchBusiness once per business per arm (A: LEADSCOUT_REACH_MODE=primary,
//      B: LEADSCOUT_REACH_MODE=off plus stronger probing added here),
//   4. scores both arms and writes data/bakeoff/results.json.
//
// Guardrails:
// - Node 24 built-ins only, ES module, .js import suffixes, no new dependencies.
// - Every outside call goes through an injected fetchFn (offline tests possible); the real
//   fetch is used only when main() runs with --run.
// - Every outside call is paced to at most one request per second and checks robots.txt.
// - Arm A is switched on only by LEADSCOUT_REACH_MODE=primary; arm B by =off. Nothing is
//   changed in the product defaults.
// - Reach text is untrusted data; the harness counts prompt-injection style strings instead
//   of acting on them.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { discover } from "./discover.js";
import { enrich, extractContacts, extractSocials, normalizePhone } from "./enrich.js";
import {
  defaultReachApi,
  researchBusiness,
  type ReachApi,
  type ResearchDeps,
} from "./research.js";
import type { ReachExecFile } from "./reach.js";
import type { RawLead, Enrichment } from "./types.js";

// --------------------------------------------------------------------------- public types

export type SampleQuery = { category: string; city: string };

export const SAMPLE_QUERIES: SampleQuery[] = [
  { category: "dental-clinic", city: "Navi Mumbai" },
  { category: "salon", city: "Navi Mumbai" },
  { category: "restaurant", city: "Pune" },
  { category: "coaching-centre", city: "Pune" },
  { category: "repair-shop", city: "Nashik" },
];

export const TARGET_SAMPLE = 20;
export const PER_BUSINESS_TIMEOUT_MS = 60_000;

export type GroundTruth = {
  name: string;
  website: string;
  pagesRead: string[];
  emails: string[];
  phones: string[];
  whatsapp: boolean;
  socials: Record<string, string>;
  summary: string; // one sentence, from fetched text only
  needsJs: boolean; // content hidden behind client-side JS
  needsJsUnsure: boolean;
  contactsUnsure: boolean; // site too thin/JS to trust contact absence -> exclude contacts
  summaryUnsure: boolean;
  unsure: boolean; // exclude the whole business from scoring
  corpus: string; // fetched text used to check summary claims (not written to results.json)
};

export type InjectionHit = { where: string; text: string };

export type ArmOutcome = {
  arm: "A" | "B";
  mode: string;
  ok: boolean;
  timedOut: boolean;
  error?: string;
  degraded: boolean;
  summary: string;
  title?: string;
  emails: string[];
  phones: string[];
  socials: Record<string, string>;
  evidence: { url: string; quote: string }[];
  calls: number;
  timeMs: number;
  injections: InjectionHit[];
  notes: string[];
  summarySupported?: boolean;
};

export type BusinessResult = {
  lead: RawLead;
  truth: GroundTruth;
  armA?: ArmOutcome;
  armB?: ArmOutcome;
};

export type ArmAggregate = {
  arm: "A" | "B";
  mode: string;
  scored: number;
  failed: number;
  timedOut: number;
  failuresAndTimeouts: number;
  failureRate: number;
  emailTp: number;
  emailFp: number;
  emailFn: number;
  emailRecall: number | null;
  emailPrecision: number | null;
  phoneTp: number;
  phoneFp: number;
  phoneFn: number;
  phoneRecall: number | null;
  phonePrecision: number | null;
  socialTrue: number;
  socialFound: number;
  socialRecall: number | null;
  summariesCorrect: number;
  summaryCorrectness: number | null;
  jsBusinesses: number;
  jsCovered: number;
  jsCoverage: number | null;
  evidenceItems: number;
  evidenceWithValidUrl: number;
  evidencePerLead: number;
  avgTimeMs: number;
  totalCalls: number;
  avgCalls: number;
  injectionStrings: number;
};

export type BakeoffResults = {
  startedAt: string;
  finishedAt: string;
  queries: SampleQuery[];
  sampleSize: number;
  missing?: string;
  businesses: BusinessResult[];
  aggregate: { A?: ArmAggregate; B?: ArmAggregate };
};

export type BakeoffOptions = {
  fetchFn?: typeof fetch;
  queries?: SampleQuery[];
  limitPerQuery?: number;
  targetSample?: number;
  timeoutMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
};

// --------------------------------------------------------------------------- politeness

export const USER_AGENT = "Leadscout/0.1 (bakeoff)";
const MIN_INTERVAL_MS = 1000;
let lastFetchAt = 0;

async function pace(): Promise<void> {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastFetchAt);
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
}

/** Wrap a fetch so every call is counted and paced to <= 1 request/second, with a UA. */
export function makePoliteFetch(counter: { calls: number }, base?: typeof fetch): typeof fetch {
  const real = base ?? fetch;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    await pace();
    counter.calls += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as Request).url);
    const headers = new Headers(init?.headers);
    if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
    return real(url, { ...(init ?? {}), headers, signal: init?.signal ?? AbortSignal.timeout(12_000) });
  };
}

// robots.txt: cached per origin; callers ask before fetching a path.
const robotsCache = new Map<string, string[] | null>();

function parseRobots(txt: string): string[] {
  const rules: string[] = [];
  let applies = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") applies = value === "*" || /leadscout/i.test(value);
    else if (applies && key === "disallow" && value) rules.push(value);
  }
  return rules;
}

async function robotsRules(origin: string, fetchFn: typeof fetch): Promise<string[] | null> {
  if (robotsCache.has(origin)) return robotsCache.get(origin) ?? null;
  let rules: string[] | null = null;
  try {
    const res = await fetchFn(new URL("/robots.txt", origin).toString());
    if (res.ok) rules = parseRobots(await res.text());
  } catch {
    rules = null; // no robots.txt readable -> treat as allowed
  }
  robotsCache.set(origin, rules);
  return rules;
}

/** True when robots.txt does not disallow this URL path. */
export async function robotsAllows(url: string, fetchFn: typeof fetch): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const rules = await robotsRules(u.origin, fetchFn);
  if (!rules) return true;
  const path = u.pathname + u.search;
  return !rules.some((r) => r !== "/" && path.startsWith(r));
}

// --------------------------------------------------------------------------- helpers

export function normalizeUrl(website: string | undefined): string | undefined {
  const raw = String(website ?? "").trim();
  if (!raw) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).toString();
  } catch {
    return undefined;
  }
}

export function phoneKey(raw: unknown): string {
  const n = normalizePhone(String(raw ?? ""));
  const source = n ?? String(raw ?? "");
  const d = source.replace(/\D/g, "");
  if (d.length > 10 && d.startsWith("91")) return d.slice(-10);
  return d.length > 10 ? d.slice(-10) : d;
}

export function emailKey(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i;
export function cleanEmail(raw: string): boolean {
  return raw.includes("@") && !IMAGE_EXT.test(raw) && !/\s/.test(raw);
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

export function visibleText(html: string): string {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html: string): string {
  return String(html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function looksLikeSpa(html: string): boolean {
  const lower = html.toLowerCase();
  const markers = ['id="root"', "id='root'", 'id="app"', "id='app'", "__next", "__nuxt", "ng-version", "data-reactroot", "app-root"];
  if (markers.some((m) => lower.includes(m))) return true;
  const scripts = (html.match(/<script/gi) ?? []).length;
  const text = visibleText(html);
  return scripts >= 3 && text.length < 400;
}

// Prompt-injection style strings that must never reach agent output.
export const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all )?(the )?previous/i,
  /disregard (all )?(the )?(above|previous|prior|earlier)/i,
  /you are now/i,
  /system prompt/i,
  /^\s*(<\/?(tool|function|invoke)\b[^>]*>|<\|[^|]*\|>)/i,
  /^\s*```/,
];

export function injectionHits(text: string, where: string): InjectionHit[] {
  const hits: InjectionHit[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (INJECTION_PATTERNS.some((r) => r.test(line))) hits.push({ where, text: line.slice(0, 200) });
  }
  return hits;
}

function outcomeInjections(o: ArmOutcome): InjectionHit[] {
  const hits: InjectionHit[] = [];
  hits.push(...injectionHits(o.summary, "summary"));
  if (o.title) hits.push(...injectionHits(o.title, "title"));
  for (const e of o.evidence) hits.push(...injectionHits(e.quote, "evidence"));
  for (const v of Object.values(o.socials)) hits.push(...injectionHits(v, "social"));
  return hits;
}

// --------------------------------------------------------------------------- sampling

/** Run discovery for each query and keep likely-to-have-a-website leads, deduped by host. */
export async function sampleLeads(opts: BakeoffOptions = {}): Promise<{ leads: RawLead[]; queries: SampleQuery[]; notes: string[] }> {
  const queries = opts.queries ?? SAMPLE_QUERIES;
  const limit = opts.limitPerQuery ?? 30;
  const target = opts.targetSample ?? TARGET_SAMPLE;
  const fetchFn = opts.fetchFn ?? fetch;
  const notes: string[] = [];
  const out: RawLead[] = [];
  const seenHost = new Set<string>();
  const seenName = new Set<string>();

  for (const q of queries) {
    try {
      const found = await discover({ category: q.category, city: q.city, limit }, { fetchFn });
      let withSite = 0;
      for (const lead of found) {
        const website = normalizeUrl(lead.website);
        if (!website) continue;
        withSite += 1;
        const host = new URL(website).host.replace(/^www\./i, "").toLowerCase();
        const nameKey = `${lead.name.toLowerCase().replace(/\s+/g, " ").trim()}|${q.city.toLowerCase()}`;
        if (seenHost.has(host) || seenName.has(nameKey)) continue;
        seenHost.add(host);
        seenName.add(nameKey);
        out.push({ ...lead, website });
        if (out.length >= target) break;
      }
      notes.push(`${q.category} in ${q.city}: ${found.length} discovered, ${withSite} with a website`);
    } catch (err) {
      notes.push(`${q.category} in ${q.city}: discovery failed: ${(err as Error)?.message ?? String(err)}`);
    }
    if (out.length >= target) break;
  }
  return { leads: out, queries, notes };
}

// --------------------------------------------------------------------------- ground truth

async function fetchText(url: string, fetchFn: typeof fetch): Promise<string | undefined> {
  try {
    if (!(await robotsAllows(url, fetchFn))) return undefined;
    const res = await fetchFn(url);
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

function linksFrom(html: string, base: string, want: RegExp): string[] {
  const out: string[] = [];
  for (const m of String(html ?? "").matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1];
    if (want.test(href)) {
      try {
        out.push(new URL(href, base).toString());
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function locsFromSitemap(xml: string): string[] {
  const out: string[] = [];
  for (const m of String(xml ?? "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) out.push(m[1]);
  return out;
}

const CONTACT_WANT = /contact|about|reach|enquir|get-in-touch|touch|team|impressum/i;
const COMMON_PATHS = ["/contact", "/contact-us", "/about", "/about-us", "/reach-us", "/get-in-touch", "/enquiry", "/contact.html", "/about.html"];

/**
 * readGroundTruth: fetch the site plus contact/about/sitemap pages with our own reader and
 * record the true facts. Items the reader cannot confirm (JS-hidden content, fetch failure)
 * are marked unsure and excluded from scoring downstream.
 */
export async function readGroundTruth(lead: RawLead, fetchFn: typeof fetch): Promise<GroundTruth> {
  const website = normalizeUrl(lead.website) ?? String(lead.website ?? "");
  const truth: GroundTruth = {
    name: lead.name,
    website,
    pagesRead: [],
    emails: [],
    phones: [],
    whatsapp: false,
    socials: {},
    summary: "",
    needsJs: false,
    needsJsUnsure: false,
    contactsUnsure: false,
    summaryUnsure: false,
    unsure: false,
    corpus: "",
  };
  const htmlPages: string[] = [];

  let homeHtml: string | undefined;
  let homeUrl: string | undefined;
  try {
    const home = new URL(website);
    homeUrl = home.toString();
    if (await robotsAllows(homeUrl, fetchFn)) {
      const res = await fetchFn(homeUrl);
      if (res.ok) {
        homeHtml = await res.text();
        truth.pagesRead.push(homeUrl);
      }
    }
  } catch {
    /* unparseable website */
  }

  if (!homeHtml) {
    // Could not read anything: mark unsure so the business is excluded.
    truth.unsure = true;
    truth.summary = "unsure: home page could not be read";
    return truth;
  }
  htmlPages.push(homeHtml);

  const base = homeUrl;
  if (!base) {
    truth.unsure = true;
    truth.summary = "unsure: website address could not be parsed";
    return truth;
  }
  const candidates = new Set<string>();
  // 1. links found on the home page
  for (const link of linksFrom(homeHtml, base, CONTACT_WANT)) candidates.add(link);
  // 2. sitemap.xml
  const sitemapUrl = new URL("/sitemap.xml", base).toString();
  const sitemap = await fetchText(sitemapUrl, fetchFn);
  if (sitemap) {
    truth.pagesRead.push(sitemapUrl);
    for (const loc of locsFromSitemap(sitemap)) {
      if (CONTACT_WANT.test(loc)) candidates.add(loc);
    }
  }
  // 3. common paths
  for (const p of COMMON_PATHS) {
    try {
      candidates.add(new URL(p, base).toString());
    } catch {
      /* ignore */
    }
  }
  candidates.delete(base);
  let extra = 0;
  for (const url of candidates) {
    if (extra >= 4) break;
    if (truth.pagesRead.includes(url)) continue;
    const html = await fetchText(url, fetchFn);
    if (!html) continue;
    htmlPages.push(html);
    truth.pagesRead.push(url);
    extra += 1;
  }

  const joined = htmlPages.join("\n");
  const contacts = extractContacts(joined);
  truth.emails = dedupe(contacts.emails.map(emailKey).filter(cleanEmail));
  truth.phones = dedupe(contacts.phones.map(phoneKey).filter((p) => p.length >= 8));
  const socials = extractSocials(joined);
  truth.socials = socials as Record<string, string>;
  truth.whatsapp = !!socials.whatsapp || contacts.whatsapp.length > 0 || /wa\.me|api\.whatsapp\.com/i.test(joined);

  // summary: reuse the product's own text summer (meta description / headings), else first text.
  const text = visibleText(homeHtml);
  truth.needsJs = looksLikeSpa(homeHtml) || text.length < 250;
  truth.needsJsUnsure = text.length < 120;
  const description = firstMatch(homeHtml, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ??
    firstMatch(homeHtml, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ??
    firstMatch(homeHtml, /<title[^>]*>([^<]+)<\/title>/i);
  truth.summary = stripTags(description ?? "").slice(0, 300) || text.slice(0, 300);
  truth.summaryUnsure = truth.summary.replace(/[^A-Za-z0-9]/g, "").length < 15;
  // Corpus for claim checking: title, meta description and all visible page text we read.
  const title = firstMatch(homeHtml, /<title[^>]*>([^<]+)<\/title>/i);
  truth.corpus = [title ?? "", description ?? "", ...htmlPages.map(visibleText)].join(" ").slice(0, 60_000);

  // If the site hides content behind JS or returned almost nothing, we cannot trust that the
  // absence of contacts is real: exclude contacts for this business.
  truth.contactsUnsure = truth.needsJs || text.length < 250;
  truth.unsure = truth.summaryUnsure;
  return truth;
}

function firstMatch(s: string, re: RegExp): string | undefined {
  const m = String(s ?? "").match(re);
  return m ? m[1] : undefined;
}

// --------------------------------------------------------------------------- arm B strength

/**
 * makeStrongEnrich: our own path, made as strong as honestly possible inside this file.
 * Runs the product enrich() first, then probes sitemap.xml and common contact/about paths,
 * merging anything new. Used only for arm B (LEADSCOUT_REACH_MODE=off).
 */
export function makeStrongEnrich(counter: { calls: number }): ResearchDeps["enrich"] {
  return async (lead, d) => {
    const fetchFn = d?.fetchFn ?? makePoliteFetch(counter);
    const base = await enrich(lead, { fetchFn });
    const home = normalizeUrl(lead.website);
    if (!home) return base;

    const extraUrls = new Set<string>();
    const sitemapUrl = new URL("/sitemap.xml", home).toString();
    const sitemap = await fetchText(sitemapUrl, fetchFn);
    if (sitemap) {
      for (const loc of locsFromSitemap(sitemap)) if (CONTACT_WANT.test(loc)) extraUrls.add(loc);
    }
    for (const p of COMMON_PATHS) {
      try {
        extraUrls.add(new URL(p, home).toString());
      } catch {
        /* ignore */
      }
    }

    const emails = [...base.emails];
    const phones = [...base.phones];
    const socials: Enrichment["socials"] = { ...base.socials };
    const signals = [...base.signals];
    let extra = 0;
    const seen = new Set<string>();
    for (const url of extraUrls) {
      if (extra >= 4) break;
      if (seen.has(url)) continue;
      seen.add(url);
      const html = await fetchText(url, fetchFn);
      if (!html) continue;
      extra += 1;
      const c = extractContacts(html);
      for (const e of c.emails) if (cleanEmail(e) && !emails.some((x) => emailKey(x) === emailKey(e))) emails.push(e);
      for (const p of c.phones) if (!phones.some((x) => phoneKey(x) === phoneKey(p))) phones.push(p);
      const s = extractSocials(html) as Record<string, string>;
      for (const [k, v] of Object.entries(s)) {
        if (!socials[k as keyof Enrichment["socials"]]) socials[k as keyof Enrichment["socials"]] = v;
      }
    }
    if (emails.length) signals.push("has-email");
    if (phones.length) signals.push("has-phone");
    return {
      ...base,
      emails: dedupe(emails.filter(cleanEmail)),
      phones: dedupe(phones),
      socials,
      signals: dedupe(signals),
    };
  };
}

// --------------------------------------------------------------------------- arm runner

/**
 * Windows-safe exec transport for the agent-reach CLI. The product's `defaultReachApi()`
 * uses research.ts's own execFile, which runs `agent-reach` without a shell; on Windows the
 * tool is `agent-reach.cmd`, so that spawn fails with ENOENT and reach silently degrades to
 * the plain path. reach.ts's own default already wraps `cmd.exe`; we supply the same wrapper
 * here so arm A actually exercises Agent Reach. (reported as an open issue; not fixed in
 * research.ts, which this order does not own.)
 */
async function wrappedExecFile(
  file: string,
  args: readonly string[],
  opts: { timeout: number; windowsHide?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFileCb) as ReachExecFile;
  const tool = file === "agent-reach" ? (process.env.AGENT_REACH_CMD || "").trim() || file : file;
  const spawn =
    process.platform === "win32"
      ? { file: "cmd.exe", args: ["/d", "/s", "/c", tool, ...args] as string[] }
      : { file: tool, args: [...args] as string[] };
  return run(spawn.file, spawn.args, { ...opts, windowsHide: true });
}

function countingReach(api: ReachApi, counter: { calls: number }): ReachApi {
  return {
    reachStatus: () => api.reachStatus(),
    readPage: (url) => {
      counter.calls += 1;
      return api.readPage(url);
    },
    searchWeb: (q) => {
      counter.calls += 1;
      return api.searchWeb(q);
    },
    readFeed: (url) => {
      counter.calls += 1;
      return api.readFeed(url);
    },
    socialSearch: (channel, q) => {
      counter.calls += 1;
      return api.socialSearch(channel, q);
    },
  };
}

async function withTimeout(
  p: Promise<unknown>,
  ms: number,
): Promise<{ value?: unknown; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ timedOut: true });
      }
    }, ms);
    p.then((value) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ value, timedOut: false });
      }
    }).catch((err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ timedOut: false, error: String((err as Error)?.message ?? err) });
      }
    });
  });
}

function toOutcome(arm: "A" | "B", mode: string, result: unknown, calls: number, timeMs: number): ArmOutcome {
  const r = result as { enrichment?: Enrichment; evidence?: { url: string; quote: string }[]; degraded?: boolean; notes?: string[] } | undefined;
  const e = r?.enrichment;
  const outcome: ArmOutcome = {
    arm,
    mode,
    ok: !!e,
    timedOut: false,
    degraded: !!r?.degraded,
    summary: e?.summary ?? "",
    ...(e?.title ? { title: e.title } : {}),
    emails: (e?.emails ?? []).map(emailKey),
    phones: (e?.phones ?? []).map(phoneKey).filter((p) => p.length >= 8),
    socials: (e?.socials ?? {}) as Record<string, string>,
    evidence: (r?.evidence ?? []).map((x) => ({ url: x.url, quote: x.quote })),
    calls,
    timeMs,
    injections: [],
    notes: r?.notes ?? [],
  };
  outcome.injections = outcomeInjections(outcome);
  return outcome;
}

/** Run one arm once for one business under its mode, within the timeout. */
export async function runArm(
  arm: "A" | "B",
  lead: RawLead,
  opts: BakeoffOptions = {},
): Promise<ArmOutcome> {
  const mode = arm === "A" ? "primary" : "off";
  const counter = { calls: 0 };
  const fetchFn = makePoliteFetch(counter, opts.fetchFn);
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? PER_BUSINESS_TIMEOUT_MS;
  const prev = process.env.LEADSCOUT_REACH_MODE;
  process.env.LEADSCOUT_REACH_MODE = mode;
  const started = Date.now();
  try {
    const reach: ReachApi | null =
      arm === "A" ? countingReach(defaultReachApi({ execFile: wrappedExecFile }), counter) : null;
    const enrichFn: ResearchDeps["enrich"] = arm === "B" ? makeStrongEnrich(counter) : enrich;
    const deps: ResearchDeps = { enrich: enrichFn, fetchFn, reach, now };
    const race = await withTimeout(researchBusiness(lead, { maxSeconds: Math.floor(timeoutMs / 1000) }, deps), timeoutMs);
    const timeMs = Date.now() - started;
    if (race.timedOut) {
      const outcome = toOutcome(arm, mode, undefined, counter.calls, timeMs);
      outcome.ok = false;
      outcome.timedOut = true;
      outcome.error = `timeout after ${timeoutMs}ms`;
      return outcome;
    }
    if (race.error) {
      const outcome = toOutcome(arm, mode, undefined, counter.calls, timeMs);
      outcome.ok = false;
      outcome.error = race.error;
      return outcome;
    }
    const outcome = toOutcome(arm, mode, race.value, counter.calls, timeMs);
    if (!outcome.summary && outcome.evidence.length === 0) outcome.ok = false;
    return outcome;
  } catch (err) {
    const outcome = toOutcome(arm, mode, undefined, counter.calls, Date.now() - started);
    outcome.ok = false;
    outcome.error = String((err as Error)?.message ?? err);
    return outcome;
  } finally {
    if (prev === undefined) delete process.env.LEADSCOUT_REACH_MODE;
    else process.env.LEADSCOUT_REACH_MODE = prev;
  }
}

// --------------------------------------------------------------------------- scoring

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "you", "our", "are", "was",
  "have", "has", "had", "not", "but", "all", "any", "can", "will", "their", "them", "they",
  "its", "into", "out", "about", "more", "than", "when", "what", "which", "who", "how",
  "best", "new", "one", "two", "get", "use", "used", "via", "per", "also", "contact",
]);

function contentTokens(text: string): string[] {
  return stripTags(String(text ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

function sentences(text: string): string[] {
  return String(text ?? "").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Fraction of the arm summary's content words that appear in the ground-truth corpus. */
function summarySupported(summary: string, corpusTokens: Set<string>): { ok: boolean; ratio: number } {
  const text = String(summary ?? "").trim();
  if (text.length < 20 || /no website is on record/i.test(text)) return { ok: false, ratio: 0 };
  const ss = sentences(text);
  if (ss.length === 0) return { ok: false, ratio: 0 };
  let good = 0;
  for (const s of ss) {
    const toks = contentTokens(s);
    if (toks.length === 0) {
      good += 1;
      continue;
    }
    if (toks.every((t) => corpusTokens.has(t))) good += 1;
  }
  return { ok: good === ss.length, ratio: good / ss.length };
}

function cross<T>(arm: T[], truth: T[]): { tp: number; fp: number; fn: number } {
  const t = new Set(truth);
  const a = new Set(arm);
  let tp = 0;
  for (const x of a) if (t.has(x)) tp += 1;
  const fp = a.size - tp;
  const fn = t.size - tp;
  return { tp, fp, fn };
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

export function aggregateArm(arm: "A" | "B", mode: string, businesses: BusinessResult[]): ArmAggregate {
  const agg: ArmAggregate = {
    arm,
    mode,
    scored: 0,
    failed: 0,
    timedOut: 0,
    failuresAndTimeouts: 0,
    failureRate: 0,
    emailTp: 0,
    emailFp: 0,
    emailFn: 0,
    emailRecall: null,
    emailPrecision: null,
    phoneTp: 0,
    phoneFp: 0,
    phoneFn: 0,
    phoneRecall: null,
    phonePrecision: null,
    socialTrue: 0,
    socialFound: 0,
    socialRecall: null,
    summariesCorrect: 0,
    summaryCorrectness: null,
    jsBusinesses: 0,
    jsCovered: 0,
    jsCoverage: null,
    evidenceItems: 0,
    evidenceWithValidUrl: 0,
    evidencePerLead: 0,
    avgTimeMs: 0,
    totalCalls: 0,
    avgCalls: 0,
    injectionStrings: 0,
  };
  let timeSum = 0;
  let summaryScored = 0;
  let socialTp = 0;
  for (const b of businesses) {
    const o = arm === "A" ? b.armA : b.armB;
    if (!o) continue;
    agg.scored += 1;
    timeSum += o.timeMs;
    agg.totalCalls += o.calls;
    agg.injectionStrings += o.injections.length;
    if (o.timedOut) agg.timedOut += 1;
    if (!o.ok) agg.failed += 1;

    const contactScored = !b.truth.contactsUnsure && !b.truth.unsure;
    if (contactScored) {
      const em = cross(o.emails, b.truth.emails);
      agg.emailTp += em.tp;
      agg.emailFp += em.fp;
      agg.emailFn += em.fn;
      const ph = cross(o.phones, b.truth.phones);
      agg.phoneTp += ph.tp;
      agg.phoneFp += ph.fp;
      agg.phoneFn += ph.fn;
    }

    const truthSocial = Object.keys(b.truth.socials);
    const armSocial = Object.keys(o.socials);
    agg.socialTrue += truthSocial.length;
    agg.socialFound += truthSocial.filter((k) => armSocial.includes(k)).length;

    if (!b.truth.unsure && !b.truth.summaryUnsure) {
      summaryScored += 1;
      if (o.summarySupported === true) agg.summariesCorrect += 1;
    }

    if (b.truth.needsJs) {
      agg.jsBusinesses += 1;
      const covered = o.ok && o.summary.trim().length >= 20 && !/no website is on record/i.test(o.summary);
      if (covered) agg.jsCovered += 1;
    }

    agg.evidenceItems += o.evidence.length;
    agg.evidenceWithValidUrl += o.evidence.filter((e) => /^https?:\/\//i.test(e.url)).length;
  }
  agg.emailRecall = ratio(agg.emailTp, agg.emailTp + agg.emailFn);
  agg.emailPrecision = ratio(agg.emailTp, agg.emailTp + agg.emailFp);
  agg.phoneRecall = ratio(agg.phoneTp, agg.phoneTp + agg.phoneFn);
  agg.phonePrecision = ratio(agg.phoneTp, agg.phoneTp + agg.phoneFp);
  agg.socialRecall = ratio(agg.socialFound, agg.socialTrue);
  agg.summaryCorrectness = ratio(agg.summariesCorrect, summaryScored);
  agg.jsCoverage = ratio(agg.jsCovered, agg.jsBusinesses);
  agg.failuresAndTimeouts = agg.failed;
  agg.failureRate = ratio(agg.failed, agg.scored) ?? 0;
  agg.evidencePerLead = ratio(agg.evidenceItems, agg.scored) ?? 0;
  agg.avgTimeMs = ratio(timeSum, agg.scored) ?? 0;
  agg.avgCalls = ratio(agg.totalCalls, agg.scored) ?? 0;
  return agg;
}

// --------------------------------------------------------------------------- main

export const RESULTS_DIR = fileURLToPath(new URL("../data/bakeoff/", import.meta.url));
export const RESULTS_PATH = fileURLToPath(new URL("../data/bakeoff/results.json", import.meta.url));
export const SAMPLE_PATH = fileURLToPath(new URL("../data/bakeoff/sample.json", import.meta.url));
export const GROUND_TRUTH_PATH = fileURLToPath(new URL("../data/bakeoff/ground-truth.json", import.meta.url));
export const PAGES_DIR = fileURLToPath(new URL("../data/bakeoff/pages/", import.meta.url));

// --------------------------------------------------------------------------- artifacts

export function slugify(name: string): string {
  const s = String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "business";
}

/**
 * exportArtifacts: offline (no network). Projects the single, already-completed bake-off run
 * (`results.json`) into the order's `sample.json` and `ground-truth.json`. This does NOT run the
 * bake-off again; the arms and page reads happened once in `--phase=run`. Only the recorded
 * leads and the recorded, hand-checked ground truth are written out, with the unsure items listed
 * explicitly so they stay excluded from scoring.
 */
export function exportArtifacts(): { leads: number; unsure: string[] } {
  const results = JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as BakeoffResults;
  const leads = results.businesses.map((b) => b.lead);
  const sample = {
    generatedAt: results.finishedAt,
    queries: results.queries,
    target: TARGET_SAMPLE,
    sampleSize: leads.length,
    ...(results.missing ? { missing: results.missing } : {}),
    leads,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(SAMPLE_PATH, JSON.stringify(sample, null, 2), "utf8");

  const unsure: string[] = [];
  const businesses = results.businesses.map((b) => {
    const t = b.truth;
    const flagged = t.unsure || t.contactsUnsure || t.summaryUnsure || t.needsJsUnsure;
    if (flagged) unsure.push(t.name);
    return {
      name: t.name,
      website: t.website,
      pagesRead: t.pagesRead,
      emails: t.emails,
      phones: t.phones,
      whatsapp: t.whatsapp,
      socials: t.socials,
      summary: t.summary,
      needsJs: t.needsJs,
      needsJsUnsure: t.needsJsUnsure,
      contactsUnsure: t.contactsUnsure,
      summaryUnsure: t.summaryUnsure,
      unsure: t.unsure,
    };
  });
  const groundTruth = {
    generatedAt: results.finishedAt,
    source: "results.json (the single bake-off run)",
    note:
      "True facts read from each business's own pages during the one capture. Items that could " +
      "not be confirmed are flagged (unsure/contactsUnsure/summaryUnsure/needsJsUnsure) and are " +
      "excluded from scoring; the top-level `unsure` array lists those businesses.",
    unsure,
    businesses,
  };
  writeFileSync(GROUND_TRUTH_PATH, JSON.stringify(groundTruth, null, 2), "utf8");
  return { leads: leads.length, unsure };
}

export type PageDump = {
  name: string;
  slug: string;
  website: string;
  files: { url: string; file: string; bytes: number }[];
  unreachable: string[];
};

function pageFileName(url: string, index: number): string {
  let base = "page";
  try {
    base = new URL(url).pathname.replace(/\/+$/, "").split("/").pop() || "index";
  } catch {
    /* keep default */
  }
  const clean = base.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
  return `${String(index).padStart(2, "0")}-${clean}`;
}

/**
 * capturePages: the order's capture phase. It persists the raw response text of each sample
 * lead's home + contact/about pages (+ sitemap) to `data/bakeoff/pages/<slug>/*.txt`. It reuses
 * the leads already recorded by the single run (no second discovery) and makes every outside
 * call through the injected, robot-respecting, <=1 request/second fetch. Safe to call offline by
 * passing a `fetchFn`.
 */
export async function capturePages(opts: BakeoffOptions = {}): Promise<{ dumps: PageDump[]; calls: number }> {
  let leads: RawLead[] = [];
  try {
    const sample = JSON.parse(readFileSync(SAMPLE_PATH, "utf8")) as { leads?: RawLead[] };
    if (Array.isArray(sample.leads) && sample.leads.length > 0) leads = sample.leads;
  } catch {
    /* fall through to results.json */
  }
  if (leads.length === 0) {
    const results = JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as BakeoffResults;
    leads = results.businesses.map((b) => b.lead);
  }

  const counter = { calls: 0 };
  const fetchFn = makePoliteFetch(counter, opts.fetchFn);
  mkdirSync(PAGES_DIR, { recursive: true });
  const used = new Set<string>();
  const dumps: PageDump[] = [];

  for (const lead of leads) {
    const baseSlug = slugify(lead.name);
    let slug = baseSlug;
    let n = 2;
    while (used.has(slug)) slug = `${baseSlug}-${n++}`;
    used.add(slug);
    const dir = `${PAGES_DIR}${slug}`;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* already exists */
    }
    const dump: PageDump = { name: lead.name, slug, website: String(lead.website ?? ""), files: [], unreachable: [] };
    const home = normalizeUrl(lead.website);
    if (!home) {
      dump.unreachable.push(String(lead.website ?? ""));
      dumps.push(dump);
      continue;
    }
    dump.website = home;

    let index = 0;
    const writePage = async (url: string): Promise<void> => {
      const text = await fetchText(url, fetchFn);
      if (text === undefined) {
        dump.unreachable.push(url);
        return;
      }
      const name = pageFileName(url, index);
      const file = `${dir}/${name}.txt`;
      const body = text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
      writeFileSync(file, body, "utf8");
      dump.files.push({ url, file, bytes: Buffer.byteLength(body, "utf8") });
      index += 1;
    };

    const homeText = await fetchText(home, fetchFn);
    if (homeText === undefined) {
      dump.unreachable.push(home);
      dumps.push(dump);
      continue;
    }
    const firstName = pageFileName(home, index);
    const firstFile = `${dir}/${firstName}.txt`;
    const firstBody = homeText.length > 2_000_000 ? homeText.slice(0, 2_000_000) : homeText;
    writeFileSync(firstFile, firstBody, "utf8");
    dump.files.push({ url: home, file: firstFile, bytes: Buffer.byteLength(firstBody, "utf8") });
    index += 1;

    const candidates = new Set<string>();
    for (const link of linksFrom(homeText, home, CONTACT_WANT)) candidates.add(link);
    const sitemapUrl = new URL("/sitemap.xml", home).toString();
    const sitemap = await fetchText(sitemapUrl, fetchFn);
    if (sitemap) {
      await writePage(sitemapUrl);
      for (const loc of locsFromSitemap(sitemap)) if (CONTACT_WANT.test(loc)) candidates.add(loc);
    }
    for (const p of COMMON_PATHS) {
      try {
        candidates.add(new URL(p, home).toString());
      } catch {
        /* ignore */
      }
    }
    candidates.delete(home);
    let extra = 0;
    for (const url of candidates) {
      if (extra >= 4) break;
      if (dump.files.some((f) => f.url === url)) continue;
      await writePage(url);
      extra += 1;
    }
    dumps.push(dump);
    opts.log?.(`capture: ${lead.name} -> ${dump.files.length} page(s)`);
  }

  mkdirSync(PAGES_DIR, { recursive: true });
  writeFileSync(`${PAGES_DIR}manifest.json`, JSON.stringify({ generatedAt: new Date().toISOString(), dumps }, null, 2), "utf8");
  return { dumps, calls: counter.calls };
}

export async function runBakeoff(opts: BakeoffOptions = {}): Promise<BakeoffResults> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const startedAt = now().toISOString();
  const { leads, queries, notes } = await sampleLeads(opts);
  for (const n of notes) log(`sample: ${n}`);
  log(`sample: ${leads.length} website-bearing businesses`);

  const live = opts.fetchFn === undefined;
  const businesses: BusinessResult[] = [];
  const assemble = (): BakeoffResults => {
    const r: BakeoffResults = {
      startedAt,
      finishedAt: now().toISOString(),
      queries,
      sampleSize: businesses.length,
      businesses,
      aggregate: {
        ...(businesses.some((b) => b.armA) ? { A: aggregateArm("A", "primary", businesses) } : {}),
        ...(businesses.some((b) => b.armB) ? { B: aggregateArm("B", "off", businesses) } : {}),
      },
    };
    if (businesses.length < (opts.targetSample ?? TARGET_SAMPLE)) {
      r.missing = `fewer than ${opts.targetSample ?? TARGET_SAMPLE} website-bearing leads were found (found ${businesses.length}); sample size is small`;
    }
    if (live) {
      mkdirSync(RESULTS_DIR, { recursive: true });
      writeFileSync(RESULTS_PATH, JSON.stringify(r, null, 2), "utf8");
    }
    return r;
  };

  const gtCounter = { calls: 0 };
  const gtFetch = makePoliteFetch(gtCounter, opts.fetchFn);
  for (const lead of leads) {
    log(`ground truth: ${lead.name} (${lead.website})`);
    const truth = await readGroundTruth(lead, gtFetch);
    const armA = await runArm("A", lead, opts);
    const armB = await runArm("B", lead, opts);
    const corpus = new Set(contentTokens(truth.corpus));
    armA.summarySupported = summarySupported(armA.summary, corpus).ok;
    armB.summarySupported = summarySupported(armB.summary, corpus).ok;
    log(
      `done: ${lead.name} | A calls=${armA.calls} ${armA.timeMs}ms ok=${armA.ok} ` +
        `| B calls=${armB.calls} ${armB.timeMs}ms ok=${armB.ok}`,
    );
    const truthForDisk: GroundTruth = { ...truth };
    delete (truthForDisk as Partial<GroundTruth>).corpus;
    businesses.push({ lead, truth: truthForDisk, armA, armB });
    assemble(); // persist after every business so a killed run still leaves data
  }

  return assemble();
}

async function main(): Promise<void> {
  if (process.argv.includes("--reaggregate")) {
    const { readFileSync } = await import("node:fs");
    const prior = JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as BakeoffResults;
    const businesses = prior.businesses;
    prior.aggregate = {
      ...(businesses.some((b) => b.armA) ? { A: aggregateArm("A", "primary", businesses) } : {}),
      ...(businesses.some((b) => b.armB) ? { B: aggregateArm("B", "off", businesses) } : {}),
    };
    writeFileSync(RESULTS_PATH, JSON.stringify(prior, null, 2), "utf8");
    process.stdout.write(`[bakeoff] re-aggregated ${businesses.length} businesses from ${RESULTS_PATH}\n`);
    return;
  }
  if (process.argv.includes("--phase=export")) {
    const out = exportArtifacts();
    process.stdout.write(
      `[bakeoff] export: ${out.leads} leads -> ${SAMPLE_PATH}; ground truth -> ${GROUND_TRUTH_PATH} ` +
        `(${out.unsure.length} businesses flagged unsure: ${out.unsure.join(", ") || "none"})\n`,
    );
    return;
  }
  if (process.argv.includes("--phase=capture")) {
    const out = await capturePages({ log: (l) => process.stdout.write(`[bakeoff] ${l}\n`) });
    process.stdout.write(`[bakeoff] capture: ${out.dumps.length} businesses, ${out.calls} outside calls -> ${PAGES_DIR}\n`);
    return;
  }
  if (!process.argv.includes("--run") && !process.argv.includes("--phase=run")) {
    process.stdout.write(
      "bakeoff.ts: dry import (no network). Phases: --phase=run (bake-off; already run once), " +
        "--phase=capture (dump raw pages), --phase=export (write sample.json + ground-truth.json).\n",
    );
    return;
  }
  const log = (line: string): void => {
    process.stdout.write(`[bakeoff] ${line}\n`);
  };
  const results = await runBakeoff({ log });
  const a = results.aggregate.A;
  const b = results.aggregate.B;
  const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  log(`sample size: ${results.sampleSize}${results.missing ? ` (${results.missing})` : ""}`);
  log(`arm A primary : recall(email)=${pct(a?.emailRecall ?? null)} precision=${pct(a?.emailPrecision ?? null)} ` +
    `phoneRecall=${pct(a?.phoneRecall ?? null)} jsCoverage=${pct(a?.jsCoverage ?? null)} ` +
    `failureRate=${pct(a?.failureRate ?? null)} calls/lead=${(a?.avgCalls ?? 0).toFixed(1)} evidence/lead=${(a?.evidencePerLead ?? 0).toFixed(1)} inj=${a?.injectionStrings ?? 0}`);
  log(`arm B off     : recall(email)=${pct(b?.emailRecall ?? null)} precision=${pct(b?.emailPrecision ?? null)} ` +
    `phoneRecall=${pct(b?.phoneRecall ?? null)} jsCoverage=${pct(b?.jsCoverage ?? null)} ` +
    `failureRate=${pct(b?.failureRate ?? null)} calls/lead=${(b?.avgCalls ?? 0).toFixed(1)} evidence/lead=${(b?.evidencePerLead ?? 0).toFixed(1)} inj=${b?.injectionStrings ?? 0}`);
  log(`results written to ${RESULTS_PATH}`);
}

const invokedDirectly = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`bakeoff failed: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
