// src/resolve.ts
// L42 contact resolution: for a named + located lead, find real contact details on the web and
// keep provenance (source URL + fetch time) on every accepted item. Never invents a number.
//
// Dependency reality (checked before writing this file):
//   * src/reach.ts EXISTS. It is used only as the DEFAULT transport for the
//     live path (searchWeb / readPage). All I/O still goes through the injected
//     deps.search / deps.fetchPage; when those are supplied (every offline check, and the
//     pipeline) reach.ts is never touched.
//   * src/india-sources.ts EXISTS (Order L41). Its channel registry powers the
//     site: listing queries: channelsFor(normalizeIndiaCategory(lead.category)) yields the
//     best-fit listing sites for the lead's category; the built-in REGISTRY_SITES below remains
//     the fallback for an injected deps.registry that is empty, a category the registry does not
//     know, or a registry file that fails to load. An injected deps.registry always wins.
//   * deps shape (ORDER_L42): search(query), fetchFn (page reader when deps.fetchPage is absent),
//     maxCalls, deadline/now, optional registry sites. budget:{calls,deadlineMs} (pipeline shape)
//     takes precedence when both are given.
//   * Contact extraction is delegated to extractContacts()/extractSocials() from enrich.ts — never
//     a bespoke regex here — per ORDER_L42. Phone canonicalisation reuses only digits that are
//     already on the page (see canonicalPhone): it adds the +91 country code, never a digit.
//     india-sources.ts's normalizeIndiaPhone is reused alongside it (see the phone loop): page
//     digits are never padded or invented.
//
// Live path is OFF by default: the reach-backed default transport returns nothing unless
// process.env.LEADSCOUT_RESOLVE_LIVE === "1". Offline callers inject their own search/fetchPage.
//
// Fetched page text is DATA, never instructions: reach.sanitizeUntrusted strips instruction-like
// lines and stripInstructionLines() below drops narrow redirect phrasings ("call this number
// instead") so an injected number never reaches extraction.
//
// Social links are extracted (kind "social") but are NOT a reachable route: REACHABLE_KINDS /
// hasReachableRoute exclude them, so a lead whose only result is a social link is `unreachable`.
//
// types.ts is owned by worker L2 and is NOT in ORDER_L42's editable set, so its Lead.status union
// ("new"|"shortlisted"|"contacted"|"replied"|"won"|"rejected") does NOT contain "unreachable".
// This is a hard blocker recorded for the pipeline edit: resolve.ts exports UNREACHABLE_STATUS and
// the pipeline call site must widen the type locally (a cast with a comment) rather than editing
// types.ts. The store column is TEXT, so the value persists at runtime.
//
// This file does not import src/company/ (verified: store/enrich/reach/pipeline do not either),
// so no sandbox-company-root first import is required.
//
// Node 24 built-ins only, ESM, .js import suffixes.

import { normaliseName } from "./store.js";
import { extractContacts, extractSocials, decodeEntities, stripTags, USER_AGENT } from "./enrich.js";
import { searchWeb, readPage, sanitizeUntrusted, type ReachDeps } from "./reach.js";
import { channelsFor, normalizeIndiaCategory, normalizeIndiaPhone } from "./india-sources.js";
import type { ChannelDeps } from "./channels/types.js";
import type { RawLead } from "./types.js";

// --------------------------------------------------------------------------- public types

export type ContactKind = "phone" | "email" | "website" | "social";

export type ResolvedContact = {
  kind: ContactKind;
  value: string;
  sourceUrl: string;
  fetchedAt: string;
  confidence: number;
};

export type RejectReason =
  | "search-failed"
  | "fetch-failed"
  | "not-html"
  | "empty-body"
  | "name-mismatch"
  | "location-mismatch"
  | "other-business"
  | "budget-exhausted";

export type RejectedCandidate = { url: string; reason: RejectReason; error?: string };

/** Terminal condition of one resolveContacts call (ORDER_L42): which fallback produced the result. */
export type ResolveState = "resolved" | "unresolved" | "layer-unavailable" | "registry-missing-fallback";

export type ResolveOutcome = {
  contacts: ResolvedContact[];
  rejected: RejectedCandidate[];
  confidence: number;
  queries: string[];
  state: ResolveState;
};

export type ResolveSearchHit = { url: string; title?: string; snippet?: string };

// Injected I/O boundary. Return shapes are coerced, so callers may hand back either a plain
// {url,title} list or a reach-style {ok,text,...} result.
export type ResolveSearchFn = (query: string, opts?: { limit?: number }) => Promise<unknown>;
export type ResolveFetchPageFn = (url: string, opts?: { timeoutMs?: number }) => Promise<unknown>;
export type ResolveBudget = { calls: number; deadlineMs: number };
export type ResolveRegistry = { sites?: string[]; queries?: string[] } | string[];

// RawLead has no explicit `area` field (discovery keeps it inside address); callers may pass one.
export type ResolveLead = RawLead & { area?: string };

export type ResolveDeps = {
  search?: ResolveSearchFn;
  fetchPage?: ResolveFetchPageFn;
  registry?: ResolveRegistry;
  budget?: ResolveBudget; // pipeline shape: {calls, deadlineMs}; wins over maxCalls/deadline
  maxCalls?: number; // flat alternative to budget.calls (ORDER_L42 deps shape)
  deadline?: number; // epoch ms; flat alternative to budget.deadlineMs
  now?: () => Date;
  fetchFn?: typeof fetch; // page reader when deps.fetchPage is absent; reach transport when live
  channelDeps?: ChannelDeps; // optional channel help (Order L54D); absent = unchanged behaviour
};

export type ResolveContactsFn = (lead: ResolveLead, deps: ResolveDeps) => Promise<ResolveOutcome>;

// --------------------------------------------------------------------------- constants

export const LIVE_ENV_VAR = "LEADSCOUT_RESOLVE_LIVE";
export const UNREACHABLE_STATUS = "unreachable" as const;
export const UNREACHABLE_SCORE_CAP = 30;
// Social is deliberately excluded: a social profile is a link, not a contact route.
export const REACHABLE_KINDS: ContactKind[] = ["phone", "email", "website"];
// Built-in fallback only, for when an injected deps.registry is empty AND the india-sources
// registry cannot answer the lead's category (unknown category or registry file load failure).
export const REGISTRY_SITES = ["practo.com", "justdial.com", "google.com/maps"];

const SEARCH_LIMIT = 8;
const MAX_CANDIDATE_PAGES = 8;
// Cap on the site: listing queries taken from the india-sources registry so the per-lead
// call budget stays dominated by the base name query and page reads.
const REGISTRY_SITES_MAX = 4;
const PAGE_TIMEOUT_MS = 8000;
const CONTACT_WINDOW = 800; // chars of plain text around a name match where a contact is "its own"
const NAME_TOLERANCE = 0.85; // dice() against the result title before we accept a fuzzy variant
// Defaults only when neither budget nor maxCalls/deadline is injected; bounded either way.
const DEFAULT_MAX_CALLS = 8;
const DEFAULT_DEADLINE_MS = 20000;

// Narrow, high-precision instruction patterns layered on top of reach.sanitizeUntrusted.
// Deliberately narrow: "call this number for appointments" is normal business copy and must
// survive; only redirect phrasings ("call this number instead") are dropped, so an injected
// instruction never steers extraction.
const INSTEAD_PATTERNS: RegExp[] = [
  /(?:call|dial|whatsapp|message|text|use|phone)\s+(?:this|the|our|that)\s+(?:number|no\.?|phone|mobile)\s+instead/i,
  /instead\s+of\s+(?:the\s+)?(?:number|phone|mobile|above)/i,
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:above|prior|these|those|earlier)\s+(?:instructions?|prompts?|directions?)/i,
];

function stripInstructionLines(text: string): string {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !INSTEAD_PATTERNS.some((re) => re.test(line)))
    .join("\n");
}

const AGGREGATOR_HOSTS = [
  "justdial.com",
  "practo.com",
  "google.com",
  "goo.gl",
  "maps.google.com",
  "sulekha.com",
  "indiamart.com",
  "tradeindia.com",
  "olx.in",
  "yelp.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "wa.me",
  "pinterest.com",
];

// --------------------------------------------------------------------------- tiny helpers

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isAggregatorHost(url: string): boolean {
  const host = hostOf(url);
  return AGGREGATOR_HOSTS.some((a) => host === a || host.endsWith(`.${a}`));
}

function normalizeUrl(raw: string): string | undefined {
  const value = String(raw ?? "").trim();
  if (!value) return undefined;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

function isHtmlLike(contentType: string): boolean {
  return /html|xml|xhtml|text\/plain|text\/markdown/i.test(contentType);
}

function isStopToken(t: string): boolean {
  return t.length < 3 || ["the", "and", "pvt", "ltd", "llp", "inc", "co"].includes(t);
}

function tokens(s: string): string[] {
  return normaliseName(s)
    .split(" ")
    .filter((t) => t.length >= 2);
}

function dice(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const t of A) if (B.has(t)) intersection++;
  return (2 * intersection) / (A.size + B.size);
}

// ---------------------------------------------------------------------------
// Listing-site selection. A site is a verbatim search-engine restriction token such as
// "site:practo.com" or "site:google.com/maps/place". Priority: an injected deps.registry,
// then the india-sources.ts registry for the lead's canonical category, then the built-in
// REGISTRY_SITES.

function readInjectedRegistrySites(registry?: ResolveRegistry): string[] | undefined {
  if (Array.isArray(registry)) {
    const sites = registry.filter((s): s is string => typeof s === "string" && s.trim() !== "");
    if (sites.length > 0) return sites;
  } else if (registry && typeof registry === "object") {
    const obj = registry as { sites?: unknown; queries?: unknown };
    if (Array.isArray(obj.sites)) {
      const sites = obj.sites.filter((s): s is string => typeof s === "string" && s.trim() !== "");
      if (sites.length > 0) return sites;
    }
  }
  return undefined;
}

const SITE_TOKEN_RE = /(?:^|\s)site:(\S+)/;

/**
 * Verbatim site: tokens of the best-fit registry channels for a canonical category
 * (Order L41 India channel registry). Channels whose categories are "any"-only are
 * skipped — their boundless "site:" scopes would burn call budget without helping a
 * named-business lookup. Returns undefined when the registry cannot answer (unknown
 * category, or the registry JSON is missing/corrupt): the caller then falls back to
 * the built-in REGISTRY_SITES instead of throwing.
 */
export function indiaListingSites(category?: string): string[] | undefined {
  let canonical: string;
  try {
    canonical = normalizeIndiaCategory(category);
  } catch {
    return undefined;
  }
  const sites: string[] = [];
  try {
    for (const ch of channelsFor(canonical)) {
      if (!ch.categories.includes(canonical)) continue; // skip "any"-only channels
      const m = SITE_TOKEN_RE.exec(ch.queryTemplates[0] ?? "");
      if (m) sites.push(`site:${m[1]}`);
      if (sites.length >= REGISTRY_SITES_MAX) break;
    }
  } catch {
    return undefined; // registry file missing/corrupt -> built-in fallback
  }
  return sites.length > 0 ? sites : undefined;
}

function registrySites(registry?: ResolveRegistry, category?: string): string[] {
  return (
    readInjectedRegistrySites(registry) ??
    indiaListingSites(category) ??
    REGISTRY_SITES
  );
}

/** Base query `"{name}" {category} {area} {city}` plus one listing query per registry site. */
export function buildQueries(lead: ResolveLead, registry?: ResolveRegistry): string[] {
  const name = String(lead?.name ?? "").trim();
  const category = lead?.category?.trim();
  const base = [`"${name}"`, category, lead?.area?.trim(), lead?.city?.trim()]
    .filter((p): p is string => typeof p === "string" && p !== "")
    .join(" ");
  const queries: string[] = [base];
  for (const s of registrySites(registry, category)) {
    // Sites can arrive as bare domains ("practo.com") or as verbatim search-restriction
    // tokens ("site:google.com/maps/place" from the india-sources registry vendors).
    const site = s.startsWith("site:") ? s : `site:${s}`;
    const listing = [site, `"${name}"`, lead?.city?.trim()].filter(Boolean).join(" ");
    queries.push(listing);
  }
  return [...new Set(queries)];
}

// --------------------------------------------------------------------------- search coercion

function urlsFromText(text: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s"'<>()[\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push(m[0].replace(/[.,;:]+$/, ""));
  }
  return out;
}

/** Accepts a plain list, a reach {ok,text} result, or an object wrapping results under known keys. */
export function coerceSearchHits(raw: unknown): ResolveSearchHit[] {
  const out: ResolveSearchHit[] = [];
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === "string") {
      for (const url of urlsFromText(v)) out.push({ url });
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const url = firstString(o.url, o.href, o.link, o.uri);
      if (url) {
        out.push({ url, title: firstString(o.title, o.name), snippet: firstString(o.snippet, o.description, o.text) });
        return;
      }
      for (const key of ["results", "hits", "items", "links", "data", "organic", "entries"]) {
        if (o[key] !== undefined) visit(o[key]);
      }
      if (typeof o.text === "string") visit(o.text);
      if (typeof o.html === "string") visit(o.html);
    }
  };
  visit(raw);
  return out;
}

// --------------------------------------------------------------------------- page coercion

type CoercedPage = { body: string; status?: number; contentType?: string; url: string };

export async function coercePage(raw: unknown, fallbackUrl: string): Promise<CoercedPage | undefined> {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string") return { body: raw, url: fallbackUrl };
  if (typeof (raw as { text?: unknown }).text === "function") {
    const res = raw as Response;
    let body = "";
    try {
      body = await res.text();
    } catch {
      return { body: "", status: res.status, url: res.url || fallbackUrl };
    }
    const ct = typeof res.headers?.get === "function" ? res.headers.get("content-type") ?? undefined : undefined;
    return { body, status: res.status, contentType: ct ?? undefined, url: res.url || fallbackUrl };
  }
  const o = raw as Record<string, unknown>;
  const body = firstString(o.body, o.text, o.html, o.content) ?? "";
  const explicitStatus = typeof o.status === "number" ? o.status : undefined;
  const ok = typeof o.ok === "boolean" ? o.ok : undefined;
  const status = explicitStatus ?? (ok === false ? 502 : ok === true ? 200 : undefined);
  const contentType = firstString(o.contentType, o.content_type) ?? undefined;
  const url = firstString(o.url, o.finalUrl) ?? fallbackUrl;
  return { body, status, contentType, url };
}

// --------------------------------------------------------------------------- matching

function plainText(body: string): string {
  return decodeEntities(stripTags(body)).replace(/\s+/g, " ").trim();
}

function pageMatchesName(name: string, normPlain: string, title: string | undefined): boolean {
  const normName = normaliseName(name);
  if (normName && ` ${normPlain} `.includes(` ${normName} `)) return true;
  if (title) return dice(name, title) >= NAME_TOLERANCE;
  return false;
}

function locationText(lead: ResolveLead): string {
  return [lead?.city, lead?.area]
    .map((v) => normaliseName(String(v ?? "")))
    .filter((v) => v !== "")
    .join(" ");
}

function pageMatchesLocation(lead: ResolveLead, normPlain: string): boolean {
  const normCity = normaliseName(String(lead?.city ?? ""));
  const normArea = normaliseName(String(lead?.area ?? ""));
  const hits = [normCity, normArea].filter((v) => v !== "" && ` ${normPlain} `.includes(` ${v} `));
  return hits.length > 0;
}

function namePositions(plainLower: string, name: string): number[] {
  const toks = tokens(name).filter((t) => !isStopToken(t));
  if (toks.length === 0) return [];
  const build = (list: string[]): RegExp =>
    new RegExp(list.map(escapeRegex).join("[^a-z0-9]+"), "g");
  const positions: number[] = [];
  const collect = (re: RegExp): void => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(plainLower))) positions.push(m.index);
  };
  collect(build(toks));
  if (positions.length === 0) {
    const longest = [...toks].sort((a, b) => b.length - a.length)[0];
    collect(new RegExp(escapeRegex(longest), "g"));
  }
  return positions;
}

function findDigitIndex(text: string, digits: string): number {
  if (digits.length < 8) return -1;
  const re = new RegExp(digits.split("").join("\\D{0,3}"), "g");
  const m = re.exec(text);
  return m ? m.index : -1;
}

/**
 * A contact is kept only when it sits within CONTACT_WINDOW chars of a match of the target
 * business name. This is what stops an aggregator or a sibling-clinic page from leaking the
 * number of a different business. When the name (or the contact) cannot be located, we fall back
 * to the whole-page name+location gate rather than dropping a real contact.
 */
function isNearName(
  plainLower: string,
  value: string,
  namePos: number[],
  kind: "phone" | "email" | "social",
): boolean {
  if (namePos.length === 0) return true;
  let pos = -1;
  if (kind === "phone") pos = findDigitIndex(plainLower, value.replace(/\D/g, "").slice(-10));
  else pos = plainLower.indexOf(value.toLowerCase());
  if (pos < 0) return true;
  return namePos.some((p) => Math.abs(p - pos) <= CONTACT_WINDOW);
}

// --------------------------------------------------------------------------- phone canonical form

/**
 * Canonicalise an Indian number to +91XXXXXXXXXX (10 digits after +91). Existing digits are only
 * rearranged: a leading 0 is dropped, a +91 prefix is collapsed, extensions are stripped. `value`
 * digits are never added or padded — an unparseable string returns undefined.
 */
export function canonicalPhone(raw: string): string | undefined {
  let s = String(raw ?? "").trim();
  if (!s) return undefined;
  s = s.replace(/^(?:tel|call):/i, "").trim();
  // strip a trailing extension ("ext 12", "x12", "extension: 5")
  s = s.replace(/[\s,;]*(?:ext(?:ension)?|x)\.?\s*[:#]?\s*\d{1,6}\s*$/i, "");
  const hasPlus = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (!digits) return undefined;
  if (hasPlus) {
    if (digits.startsWith("91") && digits.length >= 12) digits = digits.slice(2);
    else if (digits.startsWith("0")) digits = digits.replace(/^0+/, "");
  } else {
    digits = digits.replace(/^0+/, "");
    if (digits.startsWith("91") && digits.length >= 12) digits = digits.slice(2);
  }
  if (digits.length === 10) return `+91${digits}`; // mobile, or STD+local (e.g. 22 + 8 digits)
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  if (hasPlus && digits.length >= 8 && digits.length <= 13) return `+${digits}`; // international E.164
  return undefined;
}

// --------------------------------------------------------------------------- ranking

type Ranked = { hit: ResolveSearchHit; nameScore: number; cityScore: number };

function rankCandidates(lead: ResolveLead, hits: ResolveSearchHit[]): ResolveSearchHit[] {
  const ranked: Ranked[] = hits.map((hit) => ({
    hit,
    nameScore: dice(lead.name, hit.title ?? hit.url),
    cityScore: pageMatchesLocation(lead, normaliseName(`${hit.title ?? ""} ${hit.snippet ?? ""} ${hit.url}`)) ? 1 : 0,
  }));
  ranked.sort((a, b) => {
    if (b.nameScore !== a.nameScore) return b.nameScore - a.nameScore;
    if (b.cityScore !== a.cityScore) return b.cityScore - a.cityScore;
    if (a.hit.url !== b.hit.url) return a.hit.url < b.hit.url ? -1 : 1; // deterministic URL tie-break
    return 0;
  });
  return ranked.map((r) => r.hit);
}

// --------------------------------------------------------------------------- confidence / dedupe

function contactConfidence(official: boolean, factor: number): number {
  const base = official ? 90 : 70;
  return clamp(Math.round(base * factor), 0, 100);
}

const KIND_RANK: Record<ContactKind, number> = { phone: 0, email: 1, website: 2, social: 3 };

function sortContacts(contacts: ResolvedContact[]): ResolvedContact[] {
  return [...contacts].sort((a, b) => {
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.value !== b.value) return a.value < b.value ? -1 : 1;
    return a.sourceUrl < b.sourceUrl ? -1 : a.sourceUrl > b.sourceUrl ? 1 : 0;
  });
}

/** Collapse identical values from several sources, keeping the highest-confidence occurrence. */
function dedupeContacts(contacts: ResolvedContact[]): ResolvedContact[] {
  const best = new Map<string, ResolvedContact>();
  for (const c of contacts) {
    const key = `${c.kind}:${c.value.toLowerCase()}`;
    const prev = best.get(key);
    if (
      !prev ||
      c.confidence > prev.confidence ||
      (c.confidence === prev.confidence && c.sourceUrl < prev.sourceUrl)
    ) {
      best.set(key, c);
    }
  }
  return sortContacts([...best.values()]);
}

// --------------------------------------------------------------------------- live transport

export function isLiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[LIVE_ENV_VAR] === "1";
}

/** reach.ts-backed default transport. Returns empty, inert results unless the live flag is set. */
export function reachTransport(deps: ReachDeps = {}): { search: ResolveSearchFn; fetchPage: ResolveFetchPageFn } {
  const search: ResolveSearchFn = async (query, opts) => {
    if (!isLiveEnabled()) return { ok: false, text: "", results: [] as ResolveSearchHit[] };
    return searchWeb(query, { ...deps });
  };
  const fetchPage: ResolveFetchPageFn = async (url, opts) => {
    if (!isLiveEnabled()) return { ok: false, text: "", error: "live path off" };
    return readPage(url, { ...deps });
  };
  return { search, fetchPage };
}

// --------------------------------------------------------------------------- main

export async function resolveContacts(lead: ResolveLead, deps: ResolveDeps): Promise<ResolveOutcome> {
  const now = deps.now ?? (() => new Date());
  const t0 = now().getTime();
  const queries = buildQueries(lead, deps.registry);
  const rejected: RejectedCandidate[] = [];
  const callsAllowed = Math.max(0, deps.maxCalls ?? deps.budget?.calls ?? DEFAULT_MAX_CALLS);
  const deadlineMs =
    deps.budget?.deadlineMs ??
    (deps.deadline !== undefined ? Math.max(0, deps.deadline - t0) : DEFAULT_DEADLINE_MS);
  const deadline = t0 + deadlineMs;
  let calls = 0;
  // True when no deps.registry was injected: the listing queries then come from the
  // india-sources.ts registry (preferred) or the built-in REGISTRY_SITES fallback, and
  // pages accepted via that path are reported through the fallback state below.
  const registryFallbackUsed = deps.registry === undefined;

  const search = deps.search;
  // ORDER_L42 deps shape: deps.fetchFn is the page reader when deps.fetchPage is absent.
  const injectedFetchPage: ResolveFetchPageFn | undefined =
    deps.fetchPage ??
    (deps.fetchFn
      ? async (url, opts) =>
          await (deps.fetchFn as typeof fetch)(url, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(opts?.timeoutMs ?? PAGE_TIMEOUT_MS),
          })
      : undefined);
  const transport =
    search && injectedFetchPage
      ? { search, fetchPage: injectedFetchPage }
      : isLiveEnabled()
        ? reachTransport(deps.fetchFn ? { fetchFn: deps.fetchFn } : {})
        : undefined;

  let searchAttempted = 0;
  let searchOk = 0;
  // First failed search call (query + error) so callers can report exactly which
  // call failed instead of just seeing "no contacts".
  let searchFailure: RejectedCandidate | undefined;
  const empty = (state: ResolveState): ResolveOutcome => ({ contacts: [], rejected, confidence: 0, queries, state });

  if (!transport) return empty("layer-unavailable"); // research layer off/unavailable and nothing injected: zero I/O
  if (!String(lead?.name ?? "").trim() || locationText(lead) === "") return empty("unresolved");

  const canCall = (): boolean => calls < callsAllowed && now().getTime() < deadline;

  // 1. gather candidate URLs from the name query and the registry listing queries
  const candidates: ResolveSearchHit[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    if (!canCall()) {
      rejected.push({ url: query, reason: "budget-exhausted" });
      break;
    }
    calls++;
    searchAttempted++;
    let rawSearch: unknown;
    try {
      rawSearch = await transport.search(query, { limit: SEARCH_LIMIT });
    } catch (err) {
      // a failing search call is skipped; record exactly which call failed, once
      if (!searchFailure) {
        searchFailure = { url: query, reason: "search-failed", error: String((err as Error)?.message ?? err) };
        rejected.push(searchFailure);
      }
      continue;
    }
    // reach-shaped failure (e.g. agent-reach unavailable) counts as a failed layer call
    if (rawSearch && typeof rawSearch === "object" && (rawSearch as { ok?: unknown }).ok === false) {
      if (!searchFailure) {
        searchFailure = {
          url: query,
          reason: "search-failed",
          error: String((rawSearch as { error?: unknown }).error ?? "search layer answered ok:false"),
        };
        rejected.push(searchFailure);
      }
      continue;
    }
    searchOk++;
    let hits: ResolveSearchHit[] = [];
    hits = coerceSearchHits(rawSearch);
    for (const hit of hits) {
      const url = normalizeUrl(hit.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      candidates.push({ ...hit, url });
    }
  }

  // 2. rank deterministically (name similarity, then city/area, then URL lexicographic)
  const ranked = rankCandidates(lead, candidates);

  // 3. read the best candidates and accept only what the page itself proves
  const accepted: Array<{
    url: string;
    clean: string;
    plain: string;
    plainLower: string;
    namePos: number[];
    official: boolean;
  }> = [];
  let pagesRead = 0;
  for (const cand of ranked) {
    if (pagesRead >= MAX_CANDIDATE_PAGES) break;
    if (!canCall()) {
      rejected.push({ url: cand.url, reason: "budget-exhausted" });
      break;
    }
    calls++;
    pagesRead++;
    let page: CoercedPage | undefined;
    try {
      page = await coercePage(await transport.fetchPage(cand.url, { timeoutMs: PAGE_TIMEOUT_MS }), cand.url);
    } catch {
      rejected.push({ url: cand.url, reason: "fetch-failed" });
      continue;
    }
    if (!page) {
      rejected.push({ url: cand.url, reason: "fetch-failed" });
      continue;
    }
    if (typeof page.status === "number" && page.status >= 400) {
      rejected.push({ url: cand.url, reason: "fetch-failed" });
      continue;
    }
    if (page.contentType && !isHtmlLike(page.contentType)) {
      rejected.push({ url: cand.url, reason: "not-html" });
      continue;
    }
    // Page text is data only: reach.sanitizeUntrusted strips instruction-like lines and
    // stripInstructionLines drops narrow redirect phrasings, before any extraction (injected
    // instructions are ignored end to end).
    const clean = stripInstructionLines(sanitizeUntrusted(String(page.body ?? "")));
    if (clean.trim() === "") {
      rejected.push({ url: cand.url, reason: "empty-body" });
      continue;
    }
    const plain = plainText(clean);
    const normPlain = normaliseName(plain);
    if (!pageMatchesName(lead.name, normPlain, cand.title)) {
      rejected.push({ url: cand.url, reason: "name-mismatch" });
      continue;
    }
    if (!pageMatchesLocation(lead, normPlain)) {
      rejected.push({ url: cand.url, reason: "location-mismatch" });
      continue;
    }
    accepted.push({
      url: page.url,
      clean,
      plain,
      plainLower: plain.toLowerCase(),
      namePos: namePositions(plain.toLowerCase(), lead.name),
      official: !isAggregatorHost(page.url),
    });
  }

  // 4. extract contacts with enrich.ts and keep only those proved by name + location + proximity
  const collected: ResolvedContact[] = [];
  for (const a of accepted) {
    const fetchedAt = now().toISOString();
    const contacts = extractContacts(a.clean); // emails / phones / whatsapp
    for (const phone of contacts.phones) {
      // canonicalPhone stays authoritative (adds the +91 country code, never a digit).
      // india-sources.ts's normalizeIndiaPhone is reused as the only salvage step for
      // page-text encodings it normalises differently; it never invents digits either.
      const canon = canonicalPhone(phone) ?? canonicalPhone(normalizeIndiaPhone(phone) ?? "");
      if (!canon) continue;
      if (!isNearName(a.plainLower, phone, a.namePos, "phone")) {
        rejected.push({ url: a.url, reason: "other-business" });
        continue;
      }
      collected.push({ kind: "phone", value: canon, sourceUrl: a.url, fetchedAt, confidence: contactConfidence(a.official, 1) });
    }
    for (const email of contacts.emails) {
      if (!isNearName(a.plainLower, email, a.namePos, "email")) {
        rejected.push({ url: a.url, reason: "other-business" });
        continue;
      }
      collected.push({ kind: "email", value: email.toLowerCase(), sourceUrl: a.url, fetchedAt, confidence: contactConfidence(a.official, 0.95) });
    }
    const socials = extractSocials(a.clean);
    for (const value of Object.values(socials)) {
      if (!value) continue;
      if (!isNearName(a.plainLower, value, a.namePos, "social")) continue;
      collected.push({ kind: "social", value, sourceUrl: a.url, fetchedAt, confidence: contactConfidence(a.official, 0.5) });
    }
    if (a.official) {
      collected.push({ kind: "website", value: a.url, sourceUrl: a.url, fetchedAt, confidence: contactConfidence(true, 0.85) });
    }
  }

  const deduped = dedupeContacts(collected);
  let merged = deduped;
  if (deps.channelDeps) {
    try {
      const ch = await (await import("./resolve-channels.js")).channelContactsFor(lead, deps.channelDeps);
      const seenKeys = new Set(merged.map((c) => `${c.kind}:${c.value.toLowerCase()}`));
      for (const cc of ch.contacts) { const k = `${cc.kind}:${cc.value.toLowerCase()}`; if (!seenKeys.has(k)) { seenKeys.add(k); merged = [...merged, { kind: cc.kind, value: cc.value, sourceUrl: cc.source, fetchedAt: now().toISOString(), confidence: contactConfidence(false, 1) }]; } }
      merged = sortContacts(merged);
    } catch (err) { rejected.push({ url: "channel", reason: "fetch-failed", error: String((err as Error)?.message ?? err) }); }
  }
  const confidence = merged.length > 0 ? Math.max(...merged.map((c) => c.confidence)) : 0;
  // ORDER_L42 states are mutually exclusive: "resolved" = a reachable route
  // (phone/email/website) survived the name+location gate; "unresolved" = the
  // search layer answered but proved nothing (no results, or only rejected
  // candidates) — nothing is fabricated; "layer-unavailable" = the research
  // layer itself could not answer (every search attempt failed); and
  // "registry-missing-fallback" = no deps.registry was injected, so the listing
  // queries were built from the india-sources.ts registry (or, when that registry
  // cannot answer the lead's category, the built-in REGISTRY_SITES fallback) AND
  // pages accepted through those queries were read, but no reachable route
  // survived (e.g. social-only). Zero usable results is always "unresolved".
  const state: ResolveState = hasReachableRoute(merged)
    ? "resolved"
    : searchAttempted > 0 && searchOk === 0
      ? "layer-unavailable" // every search attempt failed (e.g. agent-reach unavailable)
      : registryFallbackUsed && accepted.length > 0
        ? "registry-missing-fallback" // fallback ran pages but no reachable route survived
        : "unresolved";
  return { contacts: merged, rejected: dedupeRejected(rejected), confidence, queries, state };
}

function dedupeRejected(list: RejectedCandidate[]): RejectedCandidate[] {
  const seen = new Set<string>();
  const out: RejectedCandidate[] = [];
  for (const r of list) {
    const key = `${r.url}\n${r.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// --------------------------------------------------------------------------- pipeline contract

/** A lead is "located" when it names a city or an area (RawLead.address is not used as a proxy). */
export function leadLocation(lead: ResolveLead): string {
  return locationText(lead);
}

/** S1 predicate: keep a lead that has a name and a location even with zero OSM contact tags. */
export function keepNamedLocatedLead(lead: ResolveLead): boolean {
  return String(lead?.name ?? "").trim() !== "" && leadLocation(lead) !== "";
}

/** Social links are extracted but do not make a lead reachable. */
export function hasReachableRoute(contacts: ResolvedContact[]): boolean {
  return (contacts ?? []).some((c) => REACHABLE_KINDS.includes(c.kind));
}

/** Post-resolution reachability rule: unresolved => unreachable with the existing score cap. */
export function resolutionStatus(outcome: ResolveOutcome): {
  status: "resolved" | typeof UNREACHABLE_STATUS;
  scoreCap?: number;
} {
  return hasReachableRoute(outcome.contacts)
    ? { status: "resolved" }
    : { status: UNREACHABLE_STATUS, scoreCap: UNREACHABLE_SCORE_CAP };
}
