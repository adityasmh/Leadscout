// Order CW2-channel-probe: a live channel probe that, per connector, reports
// whether it really returns data from the live site, is blocked, or needs a
// logged-in browser (so blocked ones can later be routed via a logged-in
// browser on a VPS, order VPS1).
//
// This module is BOTH:
//   - a library (`probeAdapters`, `classify`, `routeFor`, `renderMatrix`,
//     `writeMatrixJson`, `runCli`) used offline with injected fakes, and
//   - a CLI:
//       npx tsx src/channel-probe.ts \
//         --category <id> --city <name> [--live] [--only id1,id2] \
//         [--out docs/leadgen/CHANNEL_MATRIX.md]
//
// Safety / politeness (PLAN_V2, CHANNELS_CONTRACT, PITFALLS):
//   - never logs in, never clicks, never submits a form, never writes
//     credentials or cookies; every printed page text is truncated to 200 chars;
//   - enable variables are set inside the process for the run only and restored
//     after each adapter, never persisted anywhere;
//   - at most 6 outside calls per adapter (search + page read + browser reader
//     share one counter) plus the registry limiter; adapters run one by one;
//   - a host is stopped after 3 consecutive BLOCKED results.
// Node 24 built-ins only, ES modules, `.js` import suffixes, no new deps.
//
// `--live` refuses unless env LEADSCOUT_PROBE_LIVE=1 is set.
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence } from "./channels/types.js";
import { BrowserBlockedError } from "./channels/types.js";
import type { RawLead } from "./types.js";
import { channelAdapters } from "./channels/registry.js";

// ---- verdict / route vocabulary --------------------------------------------

export type Verdict =
  | "OK"
  | "PARTIAL"
  | "BLOCKED"
  | "NEEDS-LOGIN"
  | "SEARCH-LIMITED"
  | "NO-DATA"
  | "NOT-APPLICABLE"
  | "ERROR";

export type Route = "direct" | "browser" | "vps-browser" | "retry-later" | "fix" | "skip";

export type BlockKind = "403" | "429" | "captcha" | "empty" | "access-denied";

/** One outside call, attributed to its source (PR2-probe-truth): a search-provider
 *  answer is never the site's own page. `status` is a short code, not an HTTP code. */
export type ReachCall = {
  kind: "search" | "page";
  backend: string;
  host: string;
  status: string;
};

/** One search backend and how many of its calls returned a quota/limit answer. */
export type SearchQuotaEntry = { backend: string; limitedCalls: number };

export type ProbeRow = {
  adapter: string;
  verdict: Verdict;
  route: Route;
  leads: number;
  /** Leads with a name and a sourceUrl on the adapter's own site (PR2 item 3). */
  validLeads?: number;
  fields: number;
  /** Which search backend answered for this adapter (when it made a search call). */
  searchBackend?: string;
  reason: string;
  probeTime: string;
  /** Which page read produced the block, and what kind, when verdict is BLOCKED.
   *  Only a read of the SITE's own page can set this (PR2 item 1). */
  blocked?: { kind: BlockKind; on: "search" | "page" };
};

export type ProbeResult = {
  probedAt: string;
  category: string;
  city: string;
  rows: ProbeRow[];
  /** Per search backend, how many calls returned a limit (PR2 item 4). */
  searchQuota?: SearchQuotaEntry[];
};

// ---- enable variables (exact names; the report lists the direct ones) -------

/** The environment variable that switches each wired adapter's integration ON.
 *  An empty string means the adapter has no enable path (intentionally always
 *  off). Names are copied from the adapters themselves (channels/*.ts). */
export const ENABLE_ENV: Record<string, string> = {
  "google-maps-places": "GOOGLE_PLACES_API_KEY",
  justdial: "LEADSCOUT_INDIA_TIER_C",
  practo: "LEADSCOUT_PRACTO",
  "ninenine-acres": "LEADSCOUT_INDIA_TIER_C",
  "company-intel": "LEADSCOUT_COMPANY_INTEL",
  "dev-forums": "LEADSCOUT_DEVFORUMS",
  "facebook-pages": "LEADSCOUT_INDIA_TIER_C",
  indiamart: "",
  "instagram-business": "LEADSCOUT_INDIA_TIER_C",
  "jobs-india": "LEADSCOUT_INDIA_TIER_C",
  "linkedin-company": "LEADSCOUT_INDIA_TIER_C",
  lybrate: "LEADSCOUT_LYBRATE",
  magicbricks: "LEADSCOUT_INDIA_TIER_C",
  naukri: "LEADSCOUT_INDIA_TIER_C",
  nobroker: "LEADSCOUT_INDIA_TIER_C",
  podcasts: "LEADSCOUT_CH_PODCASTS",
  sharechat: "LEADSCOUT_SHARECHAT_ENABLED",
  sulekha: "LEADSCOUT_INDIA_TIER_C",
  swiggy: "LEADSCOUT_INDIA_TIER_C",
  travel: "LEADSCOUT_INDIA_TIER_C",
  udaan: "",
  "urban-company": "LEADSCOUT_INDIA_TIER_C",
  "youtube-official": "LEADSCOUT_YOUTUBE",
  zomato: "LEADSCOUT_INDIA_TIER_C",
};

/** The exact env var to enable an adapter, or undefined when there is none. */
export function enableEnvFor(adapterId: string): string | undefined {
  const v = ENABLE_ENV[adapterId];
  return v ? v : undefined;
}

// ---- verdict -> route -------------------------------------------------------

/** Exactly one route per verdict. `OK` is `browser` only when the content came
 *  through the BrowserReader; every other OK/PARTIAL is `direct`.
 *  BLOCKED/NEEDS-LOGIN -> `vps-browser`; SEARCH-LIMITED -> `retry-later`;
 *  NO-DATA/ERROR -> `fix`; NOT-APPLICABLE -> `skip`. */
export function routeFor(verdict: Verdict, opts: { viaBrowser?: boolean } = {}): Route {
  switch (verdict) {
    case "OK":
      return opts.viaBrowser ? "browser" : "direct";
    case "PARTIAL":
      return "direct";
    case "BLOCKED":
    case "NEEDS-LOGIN":
      return "vps-browser";
    case "SEARCH-LIMITED":
      return "retry-later";
    case "NO-DATA":
    case "ERROR":
      return "fix";
    case "NOT-APPLICABLE":
      return "skip";
  }
}

// ---- classification ---------------------------------------------------------

export type ProbeObservation = {
  /** Adapter does not list the category -> no outside calls, skip. */
  notApplicable?: boolean;
  leads: number;
  /** Leads that have both a name and a source URL. */
  leadsWithSource: number;
  /** Leads with a name and a sourceUrl host matching the adapter's own-site table. */
  validLeads?: number;
  /** Non-empty enrich fields found on the first lead. */
  fields: number;
  error?: string;
  /** A BrowserReader was needed but not configured. */
  browserRequired?: boolean;
  /** A real login form (password input / sign-in form / login wall) was read.
   *  A plain "Log in" navigation link is NOT a login form (PR2 item 2). */
  loginForm?: boolean;
  /** Length of the useful text the adapter read (short text < 400 chars). */
  textLen?: number;
  /** A browser read raised BrowserBlockedError (login wall / captcha / checkpoint). */
  browserBlocked?: boolean;
  /** A search backend returned 429 / quota / rate-limit; never the site itself. */
  searchLimited?: { backend: string; reason?: string };
  /** First blocked SITE page read seen, with which read and what kind. */
  blocked?: { kind: BlockKind; on: "search" | "page" };
  /** Content used for the result came through the BrowserReader. */
  viaBrowser?: boolean;
};

export type Classification = { verdict: Verdict; route: Route; reason: string };

/** Exactly one verdict (and its route) per adapter. Precedence: skip -> browser
 *  wall -> real login form -> site block -> search limit -> browser required ->
 *  error -> OK -> PARTIAL -> no-data. Only a site page block gives BLOCKED; a
 *  search-backend limit gives SEARCH-LIMITED and never BLOCKED (PR2 item 1). */
export function classify(o: ProbeObservation): Classification {
  if (o.notApplicable) {
    return { verdict: "NOT-APPLICABLE", route: "skip", reason: "adapter does not list this category" };
  }
  if (o.browserBlocked) {
    return { verdict: "NEEDS-LOGIN", route: "vps-browser", reason: "browser needs a human: login wall / captcha / checkpoint" };
  }
  const valid = o.validLeads ?? o.leadsWithSource;
  const hasRealData = valid >= 1 && o.fields >= 2;
  // A page with >=1 valid lead and >=2 fields can never be NEEDS-LOGIN (PR2 item 2).
  if (!hasRealData && o.loginForm && ((o.textLen ?? 0) < 400 || o.fields === 0)) {
    return {
      verdict: "NEEDS-LOGIN",
      route: "vps-browser",
      reason: `login form on the page read (${o.fields === 0 ? "0 fields" : "useful text under 400 chars"})`,
    };
  }
  if (o.blocked) {
    return { verdict: "BLOCKED", route: "vps-browser", reason: `blocked on ${o.blocked.on} (${o.blocked.kind})` };
  }
  if (o.searchLimited) {
    const backend = o.searchLimited.backend || "search";
    return {
      verdict: "SEARCH-LIMITED",
      route: "retry-later",
      reason: `search backend ${backend} hit its limit (${o.searchLimited.reason ?? "429/quota/rate-limit"}); not a site block`,
    };
  }
  if (o.browserRequired) {
    return {
      verdict: "NEEDS-LOGIN",
      route: "vps-browser",
      reason: "BrowserReader required but absent (LEADSCOUT_BROWSER unset)",
    };
  }
  if (o.error) {
    return { verdict: "ERROR", route: "fix", reason: `error: ${truncate(o.error, 200)}` };
  }
  if (o.leads > 0) {
    if (hasRealData) {
      return {
        verdict: "OK",
        route: routeFor("OK", { viaBrowser: o.viaBrowser }),
        reason: `${o.leads} lead(s), ${valid} valid lead(s), ${o.fields} enrich field(s)${o.viaBrowser ? " via browser" : ""}`,
      };
    }
    return {
      verdict: "PARTIAL",
      route: routeFor("PARTIAL"),
      reason:
        valid === 0
          ? `${o.leads} lead(s) but none from the adapter's own site`
          : `${o.leads} lead(s) but empty/incomplete enrich`,
    };
  }
  return { verdict: "NO-DATA", route: "fix", reason: "page read fine, zero leads for a listed category" };
}

// ---- block / login detection ------------------------------------------------

/** A real login form / login wall, NOT a plain "Log in" navigation link: a
 *  password input, a wall phrase ("log in to continue"), or a sign-in form with
 *  an email/username field (PR2 item 2). */
function detectLoginForm(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (/type\s*=\s*["']?password|name\s*=\s*["']?password|\bpassword\b/.test(t)) return true;
  if (/(log ?in|sign ?in|sign ?up)[^.]{0,48}(to continue|to proceed|required|to your account|to view|to see|to buy|to book)/.test(t)) return true;
  if (/you must (log|sign) ?in|sign into your account|log ?in to continue|sign ?in to continue/.test(t)) return true;
  if (/(log ?in|sign ?in|sign ?up)/.test(t) && /(e-?mail|username|user name|forgot)/.test(t)) return true;
  return false;
}

/** 403, 429, captcha, empty body or "access denied" text, else null. */
function blockKind(r: { ok?: boolean; text?: string; error?: string } | undefined): BlockKind | null {
  const text = String(r?.text ?? "");
  const err = String(r?.error ?? "");
  const hay = `${text} ${err}`.toLowerCase();
  if (/access denied/.test(hay)) return "access-denied";
  if (/\b403\b|forbidden/.test(hay)) return "403";
  if (/\b429\b|too many requests|rate limit/.test(hay)) return "429";
  if (/captcha|unusual activity|verify you are human/.test(hay)) return "captcha";
  if (text.trim() === "") return "empty";
  return null;
}

/** A quota / 429 / rate-limit answer from a SEARCH backend (not a site page). */
const SEARCH_LIMIT_RE = /\b429\b|too many requests|rate[ -]?limit|quota|limit exceeded|exhausted|out of (?:search )?(?:credits|queries)/i;

function isSearchLimit(r: { ok?: boolean; text?: string; error?: string } | undefined): boolean {
  const hay = `${String(r?.text ?? "")} ${String(r?.error ?? "")}`;
  return blockKind(r) === "429" || SEARCH_LIMIT_RE.test(hay);
}

function backendOf(r: { channel?: string } | undefined, fallback: string): string {
  const c = String(r?.channel ?? "").trim();
  return c || fallback;
}

function statusOf(r: { ok?: boolean; text?: string; error?: string } | undefined): string {
  const kind = blockKind(r);
  if (kind) return kind;
  if (r && r.ok === false) return "error";
  return "ok";
}

function truncate(s: string, max: number): string {
  const t = String(s ?? "");
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function countFields(ev: ChannelEvidence | undefined): number {
  const f = ev?.fields ?? {};
  return Object.values(f).filter((v) => v !== undefined && v !== null && String(v).trim() !== "").length;
}

function hostnameOf(url: string): string {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    const m = String(url ?? "").toLowerCase().match(/^(?:https?:\/\/)?([^/?#:]+)/);
    return m ? m[1].replace(/^www\./, "") : "";
  }
}

// ---- own-site host table (PR2 item 3) --------------------------------------

/** Each adapter's own site host(s). A lead is valid only when it has a name and
 *  its sourceUrl host is one of these (www and subdomains allowed). `*` marks a
 *  multi-host adapter (websearch discovery) whose lead host is unconstrained.
 *  Adapters absent from this table fall back to "has a name + a source URL". */
export const OWN_SITE_HOSTS: Record<string, string[]> = {
  "google-maps-places": ["google.com"],
  justdial: ["justdial.com"],
  practo: ["practo.com"],
  "ninenine-acres": ["99acres.com"],
  "company-intel": ["screener.in", "tickertape.in", "trendlyne.com", "moneycontrol.com"],
  "dev-forums": ["reddit.com", "news.ycombinator.com", "dev.to"],
  "facebook-pages": ["facebook.com"],
  indiamart: ["indiamart.com", "tradeindia.com"],
  "instagram-business": ["instagram.com"],
  "jobs-india": ["apna.co", "workindia.in", "foundit.in", "shine.com"],
  "linkedin-company": ["linkedin.com"],
  lybrate: ["lybrate.com"],
  magicbricks: ["magicbricks.com"],
  naukri: ["naukri.com", "in.indeed.com", "linkedin.com"],
  nobroker: ["nobroker.in", "housing.com"],
  podcasts: ["spotify.com", "podcasts.apple.com", "apple.com", "jiosaavn.com"],
  sharechat: ["sharechat.com", "mojapp.in"],
  sulekha: ["sulekha.com"],
  swiggy: ["swiggy.com", "dineout.co.in", "eazydiner.com"],
  travel: ["makemytrip.com", "yatra.com", "booking.com"],
  udaan: ["udaan.com", "exportersindia.com"],
  "urban-company": ["urbancompany.com"],
  "youtube-official": ["youtube.com"],
  zomato: ["zomato.com"],
  "ch-event-organisers": ["allevents.in", "insider.in", "in.bookmyshow.com", "eventbrite.in"],
  "ch-expos-awards": ["tradeindia.com", "showbride.com", "worldspaawards.com"],
  "ch-instagram-vendors": ["instagram.com"],
  "ch-venues": ["venuelook.com", "bookeventz.com"],
  "ch-websearch-discovery": ["*"],
  "ch-weddingsutra": ["weddingsutra.com"],
  "ch-weddingwire-in": ["weddingwire.in"],
  "ch-wedmegood": ["wedmegood.com"],
};

/** Own-site host list for an adapter id, or undefined when it is not in the table. */
export function ownSiteHostsFor(adapterId: string): string[] | undefined {
  return OWN_SITE_HOSTS[adapterId];
}

/** A lead is valid when it has a non-empty name and its sourceUrl host matches the
 *  adapter's own-site table (www/subdomains allowed; `*` = any host). Unknown
 *  adapters fall back to name + sourceUrl only. */
export function isLeadValid(lead: { name?: string; sourceUrl?: string } | undefined, adapterId: string): boolean {
  if (!String(lead?.name ?? "").trim()) return false;
  const src = String(lead?.sourceUrl ?? "").trim();
  if (!src) return false;
  const hosts = OWN_SITE_HOSTS[adapterId];
  if (!hosts) return true;
  if (hosts.includes("*")) return true;
  const h = hostnameOf(src);
  if (!h) return false;
  return hosts.some((x) => h === x.toLowerCase() || h.endsWith(`.${x.toLowerCase()}`));
}

// ---- the per-adapter outside-call recorder ----------------------------------

type Recorder = {
  deps: ChannelDeps;
  calls: number;
  capHit: boolean;
  /** Records {kind, backend, host, status} for every outside call (PR2 item 1). */
  reachCalls: ReachCall[];
  /** Only a SITE page read can set this; a search-backend block never does. */
  blocked: { kind: BlockKind; on: "search" | "page" } | null;
  /** A real login form was seen on the text the adapter actually read. */
  loginForm: boolean;
  /** Length of the longest useful text the adapter read. */
  textLen: number;
  /** A search-backend 429/quota/rate-limit answer was seen. */
  searchLimited: { backend: string; reason?: string } | null;
  /** Per search backend, how many calls returned a limit. */
  limitCounts: Record<string, number>;
  /** Which backend answered the adapter's last search call. */
  searchBackend: string | undefined;
  viaBrowser: boolean;
};

function recordingDeps(base: ChannelDeps, maxCalls: number): Recorder {
  const rec: Recorder = {
    deps: base,
    calls: 0,
    capHit: false,
    reachCalls: [],
    blocked: null,
    loginForm: false,
    textLen: 0,
    searchLimited: null,
    limitCounts: {},
    searchBackend: undefined,
    viaBrowser: false,
  };

  const bump = (): void => {
    rec.calls += 1;
    if (rec.calls > maxCalls) {
      rec.capHit = true;
      throw new Error(`probe: outside-call cap (${maxCalls}) exceeded`);
    }
  };
  const noteText = (text: unknown): void => {
    const t = String(text ?? "");
    rec.textLen = Math.max(rec.textLen, t.length);
    if (detectLoginForm(t)) rec.loginForm = true;
  };
  const noteSearch = (r: { ok?: boolean; text?: string; error?: string; channel?: string } | undefined): void => {
    const backend = backendOf(r, "search");
    rec.searchBackend = backend;
    rec.reachCalls.push({ kind: "search", backend, host: "", status: statusOf(r) });
    noteText(r?.text);
    if (isSearchLimit(r)) {
      const reason = blockKind(r) === "429" ? "429" : "quota/rate-limit";
      rec.searchLimited = { backend, reason };
      rec.limitCounts[backend] = (rec.limitCounts[backend] ?? 0) + 1;
    }
  };
  const notePage = (u: string, r: { ok?: boolean; text?: string; error?: string; channel?: string } | undefined): void => {
    const kind = blockKind(r);
    rec.reachCalls.push({ kind: "page", backend: backendOf(r, "page"), host: hostnameOf(u), status: statusOf(r) });
    noteText(r?.text);
    if (kind && !rec.blocked) rec.blocked = { kind, on: "page" };
  };
  const noteBrowser = (r: { text?: string } | undefined): void => {
    if (r && String(r.text ?? "").trim() !== "") rec.viaBrowser = true;
    noteText(r?.text);
  };

  const search: ChannelDeps["search"] = async (q, d) => {
    bump();
    const r = await base.search(q, d);
    noteSearch(r);
    return r;
  };
  const readPage: ChannelDeps["readPage"] = async (u, d) => {
    bump();
    const r = await base.readPage(u, d);
    notePage(u, r);
    return r;
  };

  let browser: ChannelDeps["browser"];
  if (base.browser) {
    const b = base.browser;
    browser = {
      read: async (u, o) => {
        bump();
        const r = await b.read(u, o);
        noteBrowser(r);
        return r;
      },
      search: async (site, q) => {
        bump();
        const r = await b.search(site, q);
        noteBrowser(r);
        return r;
      },
      status: () => b.status(),
    };
  }
  rec.deps = { ...base, search, readPage, browser };
  return rec;
}

/** Host for the 3-consecutive-BLOCKED stop (an adapter may declare `host` or
 *  `domain`; otherwise its id is used). */
export function hostOf(a: ChannelAdapter): string {
  const anyA = a as { host?: unknown; domain?: unknown };
  const h = anyA.host ?? anyA.domain;
  return h ? String(h).toLowerCase() : a.id;
}

// ---- probe one adapter ------------------------------------------------------

async function probeOne(
  a: ChannelAdapter,
  category: string,
  city: string,
  deps: ChannelDeps,
  opts: { maxCalls: number },
): Promise<{ row: Omit<ProbeRow, "probeTime">; blocked: boolean; limits: Record<string, number> }> {
  const cat = category.trim().toLowerCase();
  const lists = a.categories.map((c) => c.trim().toLowerCase());
  if (!lists.includes(cat) && !lists.includes("any")) {
    const c = classify({ notApplicable: true, leads: 0, leadsWithSource: 0, fields: 0 });
    return {
      row: { adapter: a.id, verdict: c.verdict, route: c.route, leads: 0, validLeads: 0, fields: 0, reason: c.reason },
      blocked: false,
      limits: {},
    };
  }

  const rec = recordingDeps(deps, opts.maxCalls);
  let leads = 0;
  let leadsWithSource = 0;
  let validLeads = 0;
  let fields = 0;
  let runErr: unknown;
  let enrichErr: unknown;

  const envVar = enableEnvFor(a.id);
  const saved = envVar ? process.env[envVar] : undefined;
  try {
    if (envVar) process.env[envVar] = "1";
    const found = (await a.discover({ category, city, limit: 3 }, rec.deps)) as RawLead[];
    leads = Array.isArray(found) ? found.length : 0;
    leadsWithSource = Array.isArray(found)
      ? found.filter((l) => String(l?.name ?? "").trim() !== "" && String(l?.sourceUrl ?? "").trim() !== "").length
      : 0;
    validLeads = Array.isArray(found) ? found.filter((l) => isLeadValid(l, a.id)).length : 0;
    if (found && found.length > 0) {
      try {
        const ev = await a.enrich(found[0], rec.deps);
        fields = countFields(ev);
      } catch (e) {
        enrichErr = e;
      }
    }
  } catch (e) {
    runErr = e;
  } finally {
    if (envVar) {
      if (saved === undefined) delete process.env[envVar];
      else process.env[envVar] = saved;
    }
  }

  const err = runErr ?? enrichErr;
  let error: string | undefined;
  let browserBlocked = false;
  let browserRequired = false;
  if (err) {
    const msg = String((err as { message?: unknown })?.message ?? err);
    if (err instanceof BrowserBlockedError) browserBlocked = true;
    else if (!deps.browser && /browser/i.test(msg) && !rec.blocked) browserRequired = true;
    else if (/log ?in|sign ?in/i.test(msg)) browserBlocked = true;
    else error = msg;
  }

  const c = classify({
    leads,
    leadsWithSource,
    validLeads,
    fields,
    error,
    browserRequired,
    loginForm: rec.loginForm,
    textLen: rec.textLen,
    browserBlocked,
    searchLimited: rec.searchLimited ?? undefined,
    blocked: rec.blocked ?? undefined,
    viaBrowser: rec.viaBrowser,
  });
  const row: Omit<ProbeRow, "probeTime"> = {
    adapter: a.id,
    verdict: c.verdict,
    route: c.route,
    leads,
    validLeads,
    fields,
    ...(rec.searchBackend ? { searchBackend: rec.searchBackend } : {}),
    reason: c.reason,
    ...(rec.blocked ? { blocked: rec.blocked } : {}),
  };
  return { row, blocked: c.verdict === "BLOCKED", limits: rec.limitCounts };
}

// ---- probe all selected adapters --------------------------------------------

export type ProbeOptions = {
  category: string;
  city?: string;
  adapters: ChannelAdapter[];
  deps: ChannelDeps;
  /** Read-only view of the environment; process.env by default. */
  env?: Record<string, string | undefined>;
  /** Injected clock. */
  now?: () => number;
  /** Live mode; enable variables are applied to process.env for the run only. */
  live?: boolean;
  /** Restrict to these adapter ids. */
  only?: string[];
  /** At most this many outside calls per adapter (default 6). */
  maxCalls?: number;
  /** Stop a host after this many consecutive BLOCKED results (default 3). */
  stopAfterBlocked?: number;
  /** Cooldown before the single SEARCH-LIMITED retry pass (default 90_000 ms). */
  cooldownMs?: number;
  /** Injected sleep; real setTimeout by default. */
  sleep?: (ms: number) => Promise<void>;
};

/** Probe the selected adapters strictly one after another against the injected
 *  deps/adapters/env/clock, returning exactly one row per adapter. After the full
 *  pass, SEARCH-LIMITED adapters are retried once after the cooldown, at most 2
 *  tries per adapter (PR2 item 4). */
export async function probeAdapters(opts: ProbeOptions): Promise<ProbeResult> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  void opts.live;
  const now = opts.now ?? Date.now;
  const maxCalls = opts.maxCalls ?? 6;
  const stopAfterBlocked = opts.stopAfterBlocked ?? 3;
  const cooldownMs = opts.cooldownMs ?? 90_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const city = opts.city ?? "";
  const selected = opts.only && opts.only.length > 0 ? opts.adapters.filter((a) => opts.only!.includes(a.id)) : opts.adapters;

  const quota = new Map<string, number>();
  const addLimits = (limits: Record<string, number>): void => {
    for (const [backend, count] of Object.entries(limits)) quota.set(backend, (quota.get(backend) ?? 0) + count);
  };

  const streak = new Map<string, number>();
  const rows: ProbeRow[] = [];
  const index = new Map<string, number>();
  const tries = new Map<string, number>();
  for (const a of selected) {
    const probeTime = new Date(now()).toISOString();
    const host = hostOf(a);
    const st = streak.get(host) ?? 0;
    if (st >= stopAfterBlocked) {
      rows.push({
        adapter: a.id,
        verdict: "BLOCKED",
        route: "vps-browser",
        leads: 0,
        validLeads: 0,
        fields: 0,
        reason: `host ${host}: stopped after ${st} consecutive blocked results`,
        probeTime,
      });
      continue;
    }
    const { row, blocked, limits } = await probeOne(a, opts.category, city, opts.deps, { maxCalls });
    addLimits(limits);
    index.set(a.id, rows.length);
    tries.set(a.id, 1);
    rows.push({ ...row, probeTime });
    streak.set(host, blocked ? st + 1 : 0);
  }

  const limited = rows.filter((r) => r.verdict === "SEARCH-LIMITED" && (tries.get(r.adapter) ?? 1) < 2);
  if (limited.length > 0) {
    await sleep(cooldownMs);
    for (const lr of limited) {
      const a = selected.find((x) => x.id === lr.adapter);
      if (!a) continue;
      const { row, limits } = await probeOne(a, opts.category, city, opts.deps, { maxCalls });
      addLimits(limits);
      const at = index.get(a.id);
      if (at !== undefined) rows[at] = { ...row, probeTime: new Date(now()).toISOString() };
      tries.set(a.id, (tries.get(a.id) ?? 1) + 1);
    }
  }

  const searchQuota: SearchQuotaEntry[] = [...quota.entries()].map(([backend, limitedCalls]) => ({ backend, limitedCalls }));
  return { probedAt: new Date(now()).toISOString(), category: opts.category, city, rows, searchQuota };
}

// ---- output: markdown matrix + atomic JSON ----------------------------------

export function renderMatrix(
  rows: ProbeRow[],
  opts: { probedAt?: string; category?: string; city?: string; searchQuota?: SearchQuotaEntry[] } = {},
): string {
  const lines: string[] = [];
  lines.push("# Channel probe matrix");
  lines.push("");
  if (opts.probedAt) lines.push(`Probed at: ${opts.probedAt}`);
  if (opts.category) lines.push(`Category: ${opts.category}${opts.city ? ` - City: ${opts.city}` : ""}`);
  lines.push("");
  lines.push("| Adapter | Verdict | Route | Leads | Valid leads | Fields | Search backend | Reason | Probed at |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |");
  for (const r of rows) {
    const valid = r.validLeads ?? r.leads;
    const backend = r.searchBackend ?? "";
    lines.push(
      `| ${r.adapter} | ${r.verdict} | ${r.route} | ${r.leads} | ${valid} | ${r.fields} | ${backend} | ${r.reason.replace(/\|/g, "\\|")} | ${r.probeTime} |`,
    );
  }
  lines.push("");
  const direct = rows.filter((r) => r.route === "direct");
  lines.push("## Direct adapters - exact environment variables to enable them");
  lines.push("");
  if (direct.length === 0) {
    lines.push("_No direct adapter in this run._");
  } else {
    for (const r of direct) {
      const ev = enableEnvFor(r.adapter);
      lines.push(ev ? `- \`${r.adapter}\`: set \`${ev}=1\`` : `- \`${r.adapter}\`: (no enable variable; always off)`);
    }
  }
  lines.push("");
  lines.push("Browser-route reads additionally need `LEADSCOUT_BROWSER=1`.");
  lines.push("");
  const quota = opts.searchQuota ?? [];
  if (quota.length > 0) {
    lines.push("## Search quota status");
    lines.push("");
    for (const q of quota) lines.push(`- ${q.backend}: ${q.limitedCalls} search call(s) returned a limit`);
    lines.push("");
    lines.push("the search provider quota is exhausted; discovery by search cannot run until it resets or a paid key is set");
    lines.push("");
  }
  return lines.join("\n");
}

/** Atomic JSON write: write a temp file in the target directory, then rename. */
export function writeMatrixJson(path: string, result: ProbeResult): void {
  const target = resolve(path);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(result, null, 2), "utf8");
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function writeTextAtomic(path: string, text: string): void {
  const target = resolve(path);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

// ---- named aliases (order names: probe/run, renderMarkdown, writeJsonAtomic) --
// Thin aliases so callers can import either the descriptive or the short name.

export const probe = probeAdapters;
export const renderMarkdown = renderMatrix;
export const writeJsonAtomic = writeMatrixJson;

// ---- real (live) deps -------------------------------------------------------

/** Build real ChannelDeps. The BrowserReader exists only when
 *  LEADSCOUT_BROWSER=1; nothing here dials out until an adapter runs. */
export async function buildLiveDeps(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Promise<ChannelDeps> {
  const { searchWeb, readPage } = await import("./reach.js");
  let browser: ChannelDeps["browser"];
  if (env.LEADSCOUT_BROWSER === "1") {
    const { BrowserReader } = await import("./channels/browser.js");
    browser = new BrowserReader({});
  }
  return {
    search: (q, d) => searchWeb(q, d),
    readPage: (u, d) => readPage(u, d),
    browser,
    limiter: { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) },
  };
}

// ---- CLI --------------------------------------------------------------------

export type CliOptions = {
  category: string;
  city: string;
  live: boolean;
  only?: string[];
  out: string;
  /** Seconds to wait before the single SEARCH-LIMITED retry pass (default 90). */
  cooldown: number;
};

export function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = { category: "", city: "", live: false, out: "docs/leadgen/CHANNEL_MATRIX.md", cooldown: 90 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--live") out.live = true;
    else if (a === "--category") out.category = String(argv[++i] ?? "");
    else if (a === "--city") out.city = String(argv[++i] ?? "");
    else if (a === "--out") out.out = String(argv[++i] ?? "");
    else if (a === "--cooldown") out.cooldown = Number(argv[++i] ?? "90");
    else if (a === "--only") {
      const v = String(argv[++i] ?? "");
      out.only = v.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

export type CliIO = {
  out?: (s: string) => void;
  err?: (s: string) => void;
  env?: Record<string, string | undefined>;
  adapters?: ChannelAdapter[];
  deps?: ChannelDeps;
  /** Override the markdown target (CLI default docs/leadgen/CHANNEL_MATRIX.md). */
  outPath?: string;
  /** Override the JSON target (default data/channel-matrix.json). */
  jsonPath?: string;
  /** Override the injected clock. */
  now?: () => number;
  /** Override --only. */
  only?: string[];
};

const DEFAULT_JSON = "data/channel-matrix.json";

/** CLI entry. Returns an exit code; never calls process.exit itself. */
export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
  const log = io.out ?? ((s: string) => console.log(s));
  const err = io.err ?? ((s: string) => console.error(s));
  const env = io.env ?? (process.env as Record<string, string | undefined>);
  const args = parseArgs(argv);
  if (io.only) args.only = io.only;

  if (!args.category) {
    err("channel-probe: --category is required");
    return 2;
  }

  if (args.live && env.LEADSCOUT_PROBE_LIVE !== "1") {
    err("channel-probe: --live refused; set LEADSCOUT_PROBE_LIVE=1 to run against live sites");
    return 2;
  }

  let adapters = io.adapters;
  let deps = io.deps;
  if (!adapters || !deps) {
    if (!args.live) {
      err("channel-probe: no injected adapters and --live not set; refusing to run");
      return 2;
    }
    await import("./channels/index.js");
    adapters = adapters ?? channelAdapters();
    deps = deps ?? (await buildLiveDeps(env));
  }

  const result = await probeAdapters({
    category: args.category,
    city: args.city,
    adapters,
    deps,
    env,
    live: args.live,
    only: args.only,
    now: io.now,
    cooldownMs: Math.max(0, (Number.isFinite(args.cooldown) ? args.cooldown : 90) * 1000),
  });

  const md = renderMatrix(result.rows, {
    probedAt: result.probedAt,
    category: result.category,
    city: result.city,
    searchQuota: result.searchQuota,
  });
  writeTextAtomic(io.outPath ?? args.out, md);
  writeMatrixJson(io.jsonPath ?? DEFAULT_JSON, result);
  log(md);
  return 0;
}

// ---- main guard: only run as a CLI when executed directly -------------------

const thisFile = resolve(fileURLToPath(import.meta.url));
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && thisFile === invoked) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      console.error(`channel-probe: ${(e as Error).message}`);
      process.exitCode = 1;
    });
}
