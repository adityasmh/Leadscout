// src/fc-reader.ts
// ORDER_FC1: optional Firecrawl fallback reader for hard-to-read clinic home pages.
//
// withFirecrawl(fetchFn, options?) wraps a page fetch function. It is OFF unless both
// LEADSCOUT_FIRECRAWL=1 and FIRECRAWL_API_KEY are set, in which case it escalates a
// home-page GET to Firecrawl only when the plain read failed (4xx/5xx other than 404)
// or the visible text is thinner than 400 characters. Every paid call is cached, credit
// guarded and capped. Any Firecrawl failure returns the original response; nothing is
// ever thrown into the pipeline. Network calls take an injected fetch function so the
// check runs offline.
//
// Node 24 built-ins only, ES module, .js import suffixes.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = join(HERE, "..", "data", "fc-cache");
const DEFAULT_BUDGET_FILE = join(HERE, "..", "..", "..", "logs", "firecrawl-budget.json");

const SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";
const CREDIT_URL = "https://api.firecrawl.dev/v1/team/credit-usage";

const MIN_VISIBLE_CHARS = 400;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Home pages of these hosts are never read with Firecrawl: social platforms and
// business directories are not the business's own website.
const EXCLUDED_HOSTS = [
  "facebook.com",
  "instagram.com",
  "justdial.com",
  "practo.com",
  "youtube.com",
  "linkedin.com",
  "google.com",
];

export type WithFirecrawlOptions = {
  /** Fetch used for Firecrawl API calls only; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Overrides the cache directory. Default: data/fc-cache. */
  cacheDir?: string;
  /** Overrides the budget file path. Default: <repo>/logs/firecrawl-budget.json. */
  budgetFile?: string;
  /** Environment map; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Clock; defaults to the real clock. */
  now?: () => Date;
};

type CreditUsage = { remaining: number; periodEndMs: number };
type Budget = { date: string; startRemaining: number; usedToday: number };

function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

function toNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function field(obj: unknown, key: string): unknown {
  if (obj && typeof obj === "object") return (obj as Record<string, unknown>)[key];
  return undefined;
}

function toMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

/** True for a GET-worthy home page of a business website (http/https, path "/" or empty, not social/directory). */
function isBusinessHomePage(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  const host = url.hostname.toLowerCase();
  if (hostMatches(host, "api.firecrawl.dev")) return false;
  for (const domain of EXCLUDED_HOSTS) {
    if (hostMatches(host, domain)) return false;
  }
  return true;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : whole;
  });
}

/** Visible text: drop script/style/comments, strip tags, decode entities, collapse whitespace. */
export function visibleText(html: string): string {
  const withoutBlocks = String(html ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withoutTags = withoutBlocks.replace(/<[^>]*>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

function syntheticResponse(markdown: string): Response {
  const body = `<html><body>${markdown}</body></html>`;
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

function cachePathFor(cacheDir: string, url: string): string {
  return join(cacheDir, sha1Hex(url) + ".json");
}

function readCache(file: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const markdown = field(parsed, "markdown");
    if (typeof markdown === "string") return markdown;
  } catch {
    /* no cache entry */
  }
  return undefined;
}

function writeCache(file: string, url: string, markdown: string, fetchedAt: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ url, fetchedAt, markdown }));
}

function readBudget(file: string): Budget | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const date = field(parsed, "date");
    const startRemaining = toNumber(field(parsed, "startRemaining"));
    const usedToday = toNumber(field(parsed, "usedToday"));
    if (typeof date === "string" && startRemaining !== undefined && usedToday !== undefined) {
      return { date, startRemaining, usedToday };
    }
  } catch {
    /* no budget yet */
  }
  return undefined;
}

function writeBudget(file: string, budget: Budget): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(budget));
}

/**
 * Wrap `fetchFn` with the optional Firecrawl fallback. Returns `fetchFn` unchanged when
 * the feature is off (LEADSCOUT_FIRECRAWL !== "1" or no FIRECRAWL_API_KEY).
 */
export function withFirecrawl(fetchFn: typeof fetch, options: WithFirecrawlOptions = {}): typeof fetch {
  const env = options.env ?? process.env;
  const apiKey = env.FIRECRAWL_API_KEY;
  if (env.LEADSCOUT_FIRECRAWL !== "1" || !apiKey) return fetchFn;

  const networkFetch = options.fetchFn ?? fetch;
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const budgetFile = options.budgetFile ?? DEFAULT_BUDGET_FILE;
  const nowFn = options.now ?? (() => new Date());

  const reserve = toNumber(env.FIRECRAWL_RESERVE) ?? 300;
  const dailyCapOverride = env.FIRECRAWL_DAILY_CAP !== undefined ? toNumber(env.FIRECRAWL_DAILY_CAP) : undefined;
  const maxPerRun = toNumber(env.FIRECRAWL_MAX_PER_RUN) ?? 40;

  let paidCallsThisRun = 0;
  let budgetState: Budget | undefined;

  async function fetchCreditUsage(): Promise<CreditUsage | undefined> {
    const res = await networkFetch(CREDIT_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return undefined;
    const json: unknown = await res.json();
    const data = field(json, "data") ?? json;
    const remaining = toNumber(field(data, "remaining_credits"));
    if (remaining === undefined) return undefined;
    const periodEndMs = toMs(field(data, "billing_period_end"));
    return { remaining, periodEndMs: periodEndMs ?? nowFn().getTime() + MS_PER_DAY };
  }

  /** Returns true when a paid call is allowed, recording the start-of-day balance as needed. */
  async function budgetAllows(): Promise<boolean> {
    if (paidCallsThisRun >= maxPerRun) return false;
    const usage = await fetchCreditUsage();
    if (!usage) return false;
    if (!(usage.remaining > reserve)) return false;

    const today = ymd(nowFn());
    if (!budgetState) budgetState = readBudget(budgetFile);
    if (!budgetState || budgetState.date !== today) {
      budgetState = { date: today, startRemaining: usage.remaining, usedToday: 0 };
      writeBudget(budgetFile, budgetState);
    }

    const nowMs = nowFn().getTime();
    const daysLeft = Math.max(1, Math.ceil((usage.periodEndMs - nowMs) / MS_PER_DAY));
    const cap =
      dailyCapOverride ??
      Math.max(10, Math.floor((budgetState.startRemaining - reserve) / daysLeft));
    return budgetState.usedToday < cap;
  }

  function markUsed(): void {
    if (!budgetState) return;
    budgetState = { ...budgetState, usedToday: budgetState.usedToday + 1 };
    writeBudget(budgetFile, budgetState);
  }

  async function scrape(url: string): Promise<string> {
    const res = await networkFetch(SCRAPE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false }),
    });
    if (!res.ok) throw new Error("firecrawl scrape failed");
    const json: unknown = await res.json();
    const markdown = field(field(json, "data"), "markdown") ?? field(json, "markdown");
    if (typeof markdown !== "string") throw new Error("firecrawl scrape returned no markdown");
    return markdown;
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" || !isBusinessHomePage(url)) {
      return fetchFn(input, init);
    }

    const original = await fetchFn(input, init);

    let text = "";
    try {
      text = await original.clone().text();
    } catch {
      text = "";
    }
    const thin = visibleText(text).length < MIN_VISIBLE_CHARS;
    const is404 = original.status === 404;
    const failed = original.status >= 400 && !is404;
    if (!failed && !(thin && !is404)) return original;

    try {
      const cacheFile = cachePathFor(cacheDir, url);
      const cached = readCache(cacheFile);
      if (cached !== undefined) return syntheticResponse(cached);

      if (!(await budgetAllows())) return original;

      paidCallsThisRun++;
      markUsed();

      const markdown = await scrape(url);
      writeCache(cacheFile, url, markdown, nowFn().toISOString());
      return syntheticResponse(markdown);
    } catch {
      return original;
    }
  };
}
