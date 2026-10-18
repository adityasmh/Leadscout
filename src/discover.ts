// src/discover.ts
// L3-discover: find businesses by category and place, using free OpenStreetMap services.
//   Nominatim resolves the place (city, state or country) to a bounding box.
//   The Overpass API then returns the matching businesses.
// Node 24 built-ins only, ES module, .js import suffix.
//
// RawLead is copied from docs/leadgen/CONTRACT.md (owned by worker L2).

import { readFileSync } from "node:fs";
import type { RawLead } from "./types.js";

export type DiscoverQuery = {
  category: string;
  city?: string;
  country?: string;
  limit?: number;
  // Quality ranking (ORDER_DEMO3). Absent -> behaviour is unchanged.
  // requireWebsite: keep only objects that carry a website tag and rank them by completeness.
  // minCompleteness: drop objects below this completeness score (no effect when absent).
  requireWebsite?: boolean;
  minCompleteness?: number;
};

export type DiscoverDeps = {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
  overpassUrls?: string[];
  tileAreaThresholdDeg2?: number;
  overpassTimeoutMs?: number;
  overallTimeoutMs?: number;
};

export type CategorySelector = Record<string, string>;
export type CategoryDef = {
  id: string;
  label: string;
  aliases: string[];
  selectors: CategorySelector[];
};

export const USER_AGENT = "Leadscout/0.1";

/** Descriptive User-Agent for Overpass requests; contact from env LEADSCOUT_CONTACT (default "local"). */
export function overpassUserAgent(): string {
  const contact = String(process.env.LEADSCOUT_CONTACT ?? "").trim() || "local";
  return `Leadscout/1.0 (+${contact})`;
}

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// Public Overpass API mirrors, confirmed from https://wiki.openstreetmap.org/wiki/Overpass_API
// section "Public Overpass API instances / Instances with global data coverage", 2026-10-07.
//   - Main Overpass API instance (operated by FOSSGIS): https://overpass-api.de/api/interpreter
//   - Private.coffee Overpass Instance (previously overpass.kumi.systems): https://overpass.private.coffee/api/interpreter
//   - VK Maps Overpass API instance (Russia): https://maps.mail.ru/osm/tools/overpass/api/interpreter
//   - Kumi Systems mirror: https://overpass.kumi.systems/api/interpreter
//   - FOSSGIS load-balancer nodes: https://lz4.overpass-api.de / https://z.overpass-api.de
export const DEFAULT_OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
];
// Backward compatibility: the first default mirror.
export const OVERPASS_URL = DEFAULT_OVERPASS_URLS[0];

const NOMINATIM_MIN_INTERVAL_MS = 1000; // at most one request per second to Nominatim
const OVERPASS_MIN_INTERVAL_MS = 1000; // at most one request per second to any Overpass mirror
const OVERPASS_TIMEOUT_S = 25;
const DEFAULT_OVERPASS_HTTP_TIMEOUT_MS = (OVERPASS_TIMEOUT_S + 5) * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const TAGS = ["name", "name:en", "brand"];

// Transient statuses the failover retries (429 and 5xx). A client error
// (400/401/403/404) fails on every mirror, so it stops the search at once.
export const RETRYABLE_OVERPASS_STATUSES = [429, 500, 502, 503, 504];
// Growing pause between rounds: 2s, then 5s, then 12s.
export const OVERPASS_BACKOFF_MS = [2000, 5000, 12000];
// At most three rounds per search; each round tries every mirror in order.
export const OVERPASS_MAX_ROUNDS = 3;
// A mirror that failed is demoted to the end of the list for this long.
export const MIRROR_FAILURE_TTL_MS = 5 * 60 * 1000;
// Plain, user-facing message when every mirror failed (technical detail goes in `detail`).
export const OVERPASS_BUSY_MESSAGE = "The free map service is busy right now. Try again in a few minutes.";

// Cache successful discover results for 10 minutes per (category, city).
const RESULT_CACHE_TTL_MS = 10 * 60 * 1000;

// Tiling: if a Nominatim bbox exceeds this area (deg^2), split it into at most 4 tiles.
const DEFAULT_TILE_AREA_THRESHOLD_DEG2 = 0.5;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Module-level timestamp for the Nominatim politeness limit.
let lastNominatimAt = 0;
// Module-level timestamp for the Overpass politeness limit (applies across mirrors and tiles).
let lastOverpassAt = 0;

// In-memory cache of the last successful result per (category, place).
type CacheEntry = { leads: RawLead[]; at: number };
const resultCache = new Map<string, CacheEntry>();

let cachedCategories: CategoryDef[] | null = null;

// Mirrors that failed recently, keyed by URL -> timestamp of the last failure.
// Used to demote a dead mirror to the end of the list on the next search.
const mirrorFailedAt = new Map<string, number>();

/** Clear the recent-failure memory (used by tests). */
export function resetOverpassFailures(): void {
  mirrorFailedAt.clear();
}

/** Thrown when every Overpass mirror failed. `message` is safe for the user, `detail` is technical. */
export class OverpassUnavailableError extends Error {
  detail: string;
  constructor(detail: string) {
    super(OVERPASS_BUSY_MESSAGE);
    this.name = "OverpassUnavailableError";
    this.detail = detail;
  }
}

export function loadCategories(): CategoryDef[] {
  if (cachedCategories) return cachedCategories;
  const url = new URL("../data/categories.json", import.meta.url);
  let parsed: { categories?: CategoryDef[] };
  try {
    parsed = JSON.parse(readFileSync(url, "utf8")) as { categories?: CategoryDef[] };
  } catch (err) {
    throw new Error(`discover: could not read categories.json: ${(err as Error).message}`);
  }
  if (!parsed || !Array.isArray(parsed.categories) || parsed.categories.length === 0) {
    throw new Error("discover: categories.json has no categories");
  }
  cachedCategories = parsed.categories;
  return cachedCategories;
}

function normKey(value: string): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Category lookup key: like normKey but treats hyphens/underscores as spaces, so the
 *  canonical id "jewellery-store" and the spellings "jewellery store" / "jewellery_store"
 *  all compare equal. */
function catKey(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
}

function resultCacheKey(category: string, place: string): string {
  return `${normKey(category)}|${normKey(place)}`;
}

function getCachedResult(category: string, place: string, now: number): RawLead[] | undefined {
  const entry = resultCache.get(resultCacheKey(category, place));
  if (!entry) return undefined;
  if (now - entry.at > RESULT_CACHE_TTL_MS) {
    resultCache.delete(resultCacheKey(category, place));
    return undefined;
  }
  return entry.leads;
}

function setCachedResult(category: string, place: string, leads: RawLead[], now: number): void {
  resultCache.set(resultCacheKey(category, place), { leads, at: now });
}

/** Resolve the Overpass mirror list. Env LEADSCOUT_OVERPASS_URLS replaces the default list.
 *  Read at call time so tests can mutate process.env before calling discover(). */
export function resolveOverpassUrls(provided?: string[]): string[] {
  const env = process.env.LEADSCOUT_OVERPASS_URLS;
  if (env !== undefined) {
    const urls = env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length > 0) return urls;
  }
  return provided && provided.length > 0 ? provided : DEFAULT_OVERPASS_URLS;
}

/** Resolve a plain category ("dental clinic") to its OSM tag selectors. Throws on unknown input.
 *  Resolution is separator-insensitive (hyphen / underscore / space are equal) and tries the
 *  canonical id first, then the label, then the aliases. When more than one category shares an
 *  alias (jewellery-shop and jewellery-store both list "jewelry store" and "jeweller"), the
 *  tie is broken by the lowest id so the result is deterministic and never order-dependent. */
export function resolveCategory(category: string): CategoryDef {
  const all = loadCategories();
  const q = catKey(category);
  if (!q) throw new Error("discover: category is required");
  const byId = all.find((c) => catKey(c.id) === q);
  if (byId) return byId;
  const byLabel = all.find((c) => catKey(c.label) === q);
  if (byLabel) return byLabel;
  const byAlias = all.filter((c) => c.aliases.some((a) => catKey(a) === q));
  if (byAlias.length > 0) return [...byAlias].sort((a, b) => a.id.localeCompare(b.id))[0];
  throw new Error(
    `discover: unknown category "${category}". Known categories: ${all.map((c) => c.id).join(", ")}`,
  );
}

/** Escape a value for an Overpass QL quoted string (backslash first, then quote). */
function escapeOverpassString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** One selector (AND of tags) as an Overpass element fragment, e.g. ["amenity"="dentist"].
 *  A value of "*" means "the key exists": ["key"].
 *  A value starting with "~" is a case-insensitive regex: ["key"~"pattern",i]. */
export function selectorFragment(selector: CategorySelector): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(selector)) {
    const k = escapeOverpassString(String(key));
    const v = String(value);
    if (v === "*") {
      parts.push(`["${k}"]`);
      continue;
    }
    if (v.startsWith("~")) {
      parts.push(`["${k}"~"${escapeOverpassString(v.slice(1))}",i]`);
      continue;
    }
    parts.push(`["${k}"="${escapeOverpassString(v)}"]`);
  }
  return parts.join("");
}

/** Build the Overpass QL query. bbox is "south,west,north,east".
 *  Emits `out center tags N` — the lightest form that returns tags plus center
 *  geometry for ways/relations, with N = limit * 3 (capped at 1000) by default.
 *  outCap overrides that N (used by requireWebsite, which fetches limit * 6 objects). */
export function buildOverpassQuery(
  selectors: CategorySelector[],
  bbox: string,
  limit = DEFAULT_LIMIT,
  outCap?: number,
): string {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw new Error("discover: no tag selectors for this category");
  }
  if (!bbox) throw new Error("discover: bounding box is required");
  const cap = outCap === undefined ? Math.min(limit * 3, 1000) : Math.min(outCap, 1000);
  const lines = selectors.map((s) => `  nwr${selectorFragment(s)}(${bbox});`);
  return `[out:json][timeout:${OVERPASS_TIMEOUT_S}];\n(\n${lines.join("\n")}\n);\nout center tags ${cap};`;
}

export function nominatimUrl(place: string): string {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", place);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  return url.toString();
}

export type Place = { bbox: string; lat: number; lon: number; displayName: string };

/** Parse a Nominatim search response. Throws a clear error when the place is not found. */
export function parseNominatim(data: unknown): Place {
  const arr = Array.isArray(data) ? data : [];
  const first = arr[0];
  if (!first) throw new Error("discover: Nominatim found no matching place");
  const bb = first.boundingbox;
  if (!Array.isArray(bb) || bb.length !== 4) {
    throw new Error("discover: Nominatim result had no bounding box");
  }
  const [south, north, west, east] = bb.map((n: unknown) => Number(n));
  if (![south, north, west, east].every((n) => Number.isFinite(n))) {
    throw new Error("discover: Nominatim bounding box was not numeric");
  }
  return {
    bbox: `${south},${west},${north},${east}`,
    lat: Number(first.lat),
    lon: Number(first.lon),
    displayName: String(first.display_name ?? ""),
  };
}

/** Parse a bbox string "south,west,north,east" into numbers. */
function parseBbox(bbox: string): { s: number; w: number; n: number; e: number } {
  const parts = bbox.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || !parts.every(Number.isFinite)) {
    throw new Error("discover: invalid bounding box");
  }
  const [s, w, n, e] = parts;
  return { s, w, n, e };
}

/** Split a bbox into at most 4 non-overlapping tiles if it exceeds the area threshold.
 *  Threshold is injectable via deps.tileAreaThresholdDeg2 for deterministic tests. */
export function splitBbox(bbox: string, thresholdDeg2 = DEFAULT_TILE_AREA_THRESHOLD_DEG2): string[] {
  const { s, w, n, e } = parseBbox(bbox);
  const area = (n - s) * (e - w);
  if (area <= thresholdDeg2 || thresholdDeg2 <= 0) return [bbox];
  const midLat = (s + n) / 2;
  const midLon = (w + e) / 2;
  return [
    `${s},${w},${midLat},${midLon}`,
    `${s},${midLon},${midLat},${e}`,
    `${midLat},${w},${n},${midLon}`,
    `${midLat},${midLon},${n},${e}`,
  ];
}

function serviceError(service: string, status: number): Error {
  if (status === 429) {
    return new Error(
      `${service} returned HTTP 429 (rate limited). Leadscout made one retry after 5 seconds and was still limited; wait about a minute and try again.`,
    );
  }
  if (status === 504) {
    return new Error(
      `${service} returned HTTP 504 (gateway timeout). Leadscout made one retry after 5 seconds; try again shortly.`,
    );
  }
  return new Error(`${service} request failed: HTTP ${status}`);
}

/** Fetch with at most one retry after 5s, and only on 429 or 504. No retry loops. */
async function fetchWithOneRetry(
  url: string,
  init: RequestInit,
  deps: DiscoverDeps,
  service: string,
): Promise<Response> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleepFn ?? defaultSleep;
  let res = await fetchFn(url, init);
  if (res.status === 429 || res.status === 504) {
    await sleep(5000);
    res = await fetchFn(url, init);
  }
  if (!res.ok) throw serviceError(service, res.status);
  return res;
}

function elementIdentity(el: unknown): string {
  const r = asRecord(el);
  const type = String(r.type ?? "node");
  const id = typeof r.id === "number" || typeof r.id === "string" ? r.id : 0;
  return `${type}:${id}`;
}

/** Pace Overpass requests to at most 1 per second across mirrors and tiles. */
async function paceOverpass(deps: DiscoverDeps): Promise<void> {
  const sleep = deps.sleepFn ?? defaultSleep;
  const wait = OVERPASS_MIN_INTERVAL_MS - (Date.now() - lastOverpassAt);
  if (wait > 0) await sleep(wait);
  lastOverpassAt = Date.now();
}

/** POST a single Overpass query to one mirror with a timeout. */
async function postOverpass(
  url: string,
  query: string,
  deps: DiscoverDeps,
): Promise<Response> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.overpassTimeoutMs ?? DEFAULT_OVERPASS_HTTP_TIMEOUT_MS;
  await paceOverpass(deps);
  return fetchFn(url, {
    method: "POST",
    headers: {
      "User-Agent": overpassUserAgent(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

type Attempt = { url: string; reason: string };

/** Sort mirrors so those that failed in the last MIRROR_FAILURE_TTL_MS are tried last,
 *  preserving the original relative order within each group. */
export function orderOverpassUrls(urls: string[], now: number): string[] {
  const healthy: string[] = [];
  const recentlyFailed: string[] = [];
  for (const url of urls) {
    const at = mirrorFailedAt.get(url);
    if (at !== undefined && now - at <= MIRROR_FAILURE_TTL_MS) {
      recentlyFailed.push(url);
    } else {
      if (at !== undefined) mirrorFailedAt.delete(url);
      healthy.push(url);
    }
  }
  return [...healthy, ...recentlyFailed];
}

/** Build the technical detail for an all-mirrors failure (the plain message stays in `message`). */
function overpassFailureDetail(attempts: Attempt[]): string {
  const detail = attempts
    .map((a, i) => `attempt ${i + 1}: ${a.url} (${a.reason})`)
    .join("; ");
  return `Overpass API failed after ${attempts.length} attempt(s): ${detail}`;
}

/** Query Overpass with mirror failover: up to OVERPASS_MAX_ROUNDS rounds (3). Every round tries
 *  every mirror in order; between rounds the search waits OVERPASS_BACKOFF_MS (2s, then 5s), all
 *  bounded by the job's overall time limit. Recently failed mirrors are tried last. A 429, any 5xx
 *  status, a timeout, a network error, a non-JSON body, missing elements or an Overpass remark
 *  error moves on to the next mirror. A client error (400/401/403/404) would fail on every mirror,
 *  so it stops the search at once instead of waiting out the remaining rounds.
 *  When everything fails, throws OverpassUnavailableError (plain message + technical detail). */
export async function fetchOverpassWithFailover(
  query: string,
  deps: DiscoverDeps,
): Promise<{ elements: unknown[]; sourceUrl: string }> {
  const urls = resolveOverpassUrls(deps.overpassUrls);
  const sleep = deps.sleepFn ?? defaultSleep;
  const nowFn = deps.now ?? Date.now;
  const attempts: Attempt[] = [];
  const startedAt = nowFn();

  // One ordering per search: mirrors that failed recently are tried last.
  const ordered = orderOverpassUrls(urls, nowFn());

  for (let round = 0; round < OVERPASS_MAX_ROUNDS; round++) {
    if (round > 0) {
      const wait = OVERPASS_BACKOFF_MS[Math.min(round - 1, OVERPASS_BACKOFF_MS.length - 1)];
      if (deps.overallTimeoutMs !== undefined && nowFn() - startedAt + wait > deps.overallTimeoutMs) break;
      await sleep(wait);
    }

    // Walk the whole mirror list in order; a later round retries the same list.
    for (const url of ordered) {
      if (deps.overallTimeoutMs !== undefined && nowFn() - startedAt > deps.overallTimeoutMs) {
        throw new OverpassUnavailableError(overpassFailureDetail(attempts));
      }

      let res: Response;
      try {
        res = await postOverpass(url, query, deps);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const isTimeout = err instanceof Error && (err.name === "AbortError" || /abort/i.test(reason));
        attempts.push({ url, reason: isTimeout ? "timeout" : reason });
        mirrorFailedAt.set(url, nowFn());
        continue;
      }

      if (!res.ok) {
        attempts.push({ url, reason: `HTTP ${res.status}` });
        if (res.status !== 429 && res.status < 500) {
          // A client error (400/401/403/404) fails on every mirror: stop at once.
          throw new OverpassUnavailableError(overpassFailureDetail(attempts));
        }
        mirrorFailedAt.set(url, nowFn());
        continue;
      }

      let data: unknown;
      try {
        data = await res.json();
      } catch {
        attempts.push({ url, reason: "non-JSON body" });
        mirrorFailedAt.set(url, nowFn());
        continue;
      }

      const elements = asRecord(data).elements;
      if (!Array.isArray(elements)) {
        attempts.push({ url, reason: "missing elements" });
        mirrorFailedAt.set(url, nowFn());
        continue;
      }

      const remark = asRecord(data).remark;
      if (typeof remark === "string" && /\berror\b/i.test(remark)) {
        attempts.push({ url, reason: `Overpass remark: ${remark.slice(0, 200)}` });
        mirrorFailedAt.set(url, nowFn());
        continue;
      }

      mirrorFailedAt.delete(url);
      return { elements, sourceUrl: url };
    }
  }

  throw new OverpassUnavailableError(overpassFailureDetail(attempts));
}

/** Query one tile, returning its elements. */
async function queryTile(
  selectors: CategorySelector[],
  tile: string,
  limit: number,
  deps: DiscoverDeps,
  outCap?: number,
): Promise<unknown[]> {
  const query = buildOverpassQuery(selectors, tile, limit, outCap);
  const { elements } = await fetchOverpassWithFailover(query, deps);
  return elements;
}

/** Resolve a place name to a bounding box via Nominatim, honouring the 1 request/second limit. */
export async function resolvePlace(place: string, deps: DiscoverDeps = {}): Promise<Place> {
  const name = String(place ?? "").trim();
  if (!name) throw new Error("discover: place name is required");
  const sleep = deps.sleepFn ?? defaultSleep;
  const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimAt);
  if (wait > 0) await sleep(wait);
  lastNominatimAt = Date.now();
  const res = await fetchWithOneRetry(
    nominatimUrl(name),
    { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
    deps,
    "Nominatim",
  );
  return parseNominatim(await res.json());
}

function clean(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s ? s : undefined;
}

function pick(tags: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = clean(tags[key]);
    if (v) return v;
  }
  return undefined;
}

/** Address built from addr:* tags: house number + street, suburb, state, postcode. */
export function buildAddress(tags: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const house = clean(tags["addr:housenumber"]);
  const street = clean(tags["addr:street"]);
  if (house && street) parts.push(`${house} ${street}`);
  else if (street) parts.push(street);
  else if (house) parts.push(house);
  for (const key of ["addr:suburb", "addr:state", "addr:postcode"]) {
    const v = clean(tags[key]);
    if (v) parts.push(v);
  }
  const joined = parts.join(", ");
  return joined || undefined;
}

function normToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hostOf(website: string): string {
  try {
    const url = new URL(website.includes("://") ? website : `http://${website}`);
    return url.host.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function elementUrl(el: unknown): string {
  if (typeof el !== "object" || el === null) return "https://www.openstreetmap.org/node/0";
  const record = el as Record<string, unknown>;
  const rawType = record.type;
  const type = rawType === "way" ? "way" : rawType === "relation" ? "relation" : "node";
  const id = typeof record.id === "number" || typeof record.id === "string" ? record.id : 0;
  return `https://www.openstreetmap.org/${type}/${id}`;
}

function toNum(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Parse an Overpass `out center` response into RawLead[].
 * Drops elements without a name; dedupes by normalised name + city (or address) and by website host.
 */
function isOverpassResponse(value: unknown): value is { elements: unknown[] } {
  return typeof value === "object" && value !== null && Array.isArray(asRecord(value).elements);
}

export function parseOverpass(data: unknown, categoryId: string, q: DiscoverQuery): RawLead[] {
  const elements = isOverpassResponse(data) ? data.elements : [];
  const out: RawLead[] = [];
  const seenPlace = new Set<string>();
  const seenHost = new Set<string>();

  for (const rawEl of elements) {
    const el = asRecord(rawEl);
    const tags = asRecord(el.tags);
    const name = pick(tags, TAGS);
    if (!name) continue; // drop elements without a name

    const website = pick(tags, ["website", "contact:website", "url"]);
    const phone = pick(tags, ["phone", "contact:phone"]);
    const email = pick(tags, ["email", "contact:email"]);
    const address = buildAddress(tags);
    const city = clean(tags["addr:city"]) ?? clean(q.city);
    const country = clean(tags["addr:country"]) ?? clean(q.country);

    const placeKey = `${normToken(name)}|${normToken(city ?? address ?? "")}`;
    const host = website ? hostOf(website) : "";
    if (seenPlace.has(placeKey)) continue;
    if (host && seenHost.has(host)) continue;
    seenPlace.add(placeKey);
    if (host) seenHost.add(host);

    const center = asRecord(el.center);
    const lat = toNum(el.lat ?? center.lat);
    const lon = toNum(el.lon ?? center.lon);

    const lead: RawLead = { name, category: categoryId, source: "osm", sourceUrl: elementUrl(rawEl) };
    if (address) lead.address = address;
    if (city) lead.city = city;
    if (country) lead.country = country;
    if (lat !== undefined) lead.lat = lat;
    if (lon !== undefined) lead.lon = lon;
    if (phone) lead.phone = phone;
    if (email) lead.email = email;
    if (website) lead.website = website;
    out.push(lead);
  }
  return out;
}

function clampLimit(limit?: number): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Tag keys that count as "has a website" for requireWebsite filtering. */
export function hasWebsiteTag(tags: Record<string, unknown>): boolean {
  return Boolean(clean(tags["website"]) ?? clean(tags["contact:website"]) ?? clean(tags["url"]));
}

/** Completeness score used by requireWebsite ranking: a business is more useful to a buyer the
 *  more contact and presence data it already carries. Deterministic and tag-only. */
export function completenessScore(tags: Record<string, unknown>): number {
  let score = 0;
  if (hasWebsiteTag(tags)) score += 8;
  if (clean(tags["phone"]) ?? clean(tags["contact:phone"])) score += 4;
  if (clean(tags["email"]) ?? clean(tags["contact:email"])) score += 4;
  if (clean(tags["opening_hours"])) score += 2;
  for (const key of Object.keys(tags)) {
    if (key.startsWith("addr:")) score += 1;
  }
  if (clean(tags["brand"]) ?? clean(tags["operator"])) score += 2;
  if (clean(tags["wikidata"])) score += 1;
  return score;
}

/** Rank raw Overpass elements by completeness (best first), optionally dropping objects with no
 *  website tag and/or below minCompleteness, then parse them to RawLead[] preserving that order. */
function rankElements(
  elements: unknown[],
  categoryId: string,
  q: DiscoverQuery,
  wantWebsite: boolean,
  minCompleteness: number | undefined,
): RawLead[] {
  const hasMin = typeof minCompleteness === "number" && Number.isFinite(minCompleteness);
  const scored = elements
    .map((el) => {
      const tags = asRecord(asRecord(el).tags);
      return { el, tags, score: completenessScore(tags) };
    })
    .filter((x) => (wantWebsite ? hasWebsiteTag(x.tags) : true))
    .filter((x) => (hasMin ? x.score >= (minCompleteness as number) : true))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const an = pick(a.tags, TAGS) ?? "";
      const bn = pick(b.tags, TAGS) ?? "";
      if (an !== bn) return an < bn ? -1 : 1;
      const au = elementUrl(a.el);
      const bu = elementUrl(b.el);
      return au < bu ? -1 : au > bu ? 1 : 0;
    });
  return parseOverpass({ elements: scored.map((x) => x.el) }, categoryId, q);
}

/**
 * discover: find businesses by category and place using OpenStreetMap.
 * Resolves the place with Nominatim, fetches with Overpass across mirrors/tiles,
 * caches the last successful result per (category, city), and returns RawLead[].
 */
export async function discover(q: DiscoverQuery, deps: DiscoverDeps = {}): Promise<RawLead[]> {
  if (!q || !q.category) throw new Error("discover: category is required");
  const place = clean(q.city) ?? clean(q.country);
  if (!place) throw new Error("discover: a city or country is required to locate the search area");

  const limit = clampLimit(q.limit);
  const def = resolveCategory(q.category);
  const nowFn = deps.now ?? Date.now;
  const now = nowFn();

  const wantWebsite = q.requireWebsite === true;
  const minCompleteness = q.minCompleteness === undefined ? undefined : Number(q.minCompleteness);
  // The quality options change what is returned, so they must not share a cache entry
  // with a plain request for the same category and place.
  const variant =
    (wantWebsite ? "::requireWebsite" : "") +
    (typeof minCompleteness === "number" && Number.isFinite(minCompleteness)
      ? `::minCompleteness=${minCompleteness}`
      : "");
  const cacheCategory = `${def.id}${variant}`;

  const cached = getCachedResult(cacheCategory, place, now);
  if (cached) return cached.slice(0, limit);

  const { bbox } = await resolvePlace(place, deps);
  const threshold =
    deps.tileAreaThresholdDeg2 === undefined
      ? DEFAULT_TILE_AREA_THRESHOLD_DEG2
      : deps.tileAreaThresholdDeg2;
  const tiles = splitBbox(bbox, threshold);

  // requireWebsite needs more candidates to rank: fetch up to min(limit*6, 1000) objects.
  const outCap = wantWebsite ? Math.min(limit * 6, 1000) : undefined;

  const allElements: unknown[] = [];
  const seen = new Set<string>();
  for (const tile of tiles) {
    const elements = await queryTile(def.selectors, tile, limit, deps, outCap);
    for (const el of elements) {
      const key = elementIdentity(el);
      if (seen.has(key)) continue;
      seen.add(key);
      allElements.push(el);
    }
  }

  const ranked = wantWebsite || minCompleteness !== undefined;
  const leads = ranked
    ? rankElements(allElements, def.id, q, wantWebsite, minCompleteness)
    : parseOverpass({ elements: allElements }, def.id, q);
  const capped = leads.slice(0, limit);
  // Only cache non-empty results: a transient empty answer must never be reused,
  // so a later run always re-queries instead of silently returning zero again.
  if (capped.length > 0) setCachedResult(cacheCategory, place, capped, nowFn());
  return capped;
}
