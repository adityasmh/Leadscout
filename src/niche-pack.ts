// src/niche-pack.ts
// Generic niche-pack loader and query/target helpers for Leadscout.
//
// A "niche pack" is the data that tells every other part of Leadscout how to
// hunt one niche: its sub-categories, the web search phrases that find them,
// the cities and areas worth covering, the seasonality, and how observed
// signals map to the seller's services. Nothing about a niche is hardcoded
// here: the next niche is just another JSON file under
// data/niche-packs/.
//
// Pure and offline: reads one JSON file from disk, no network, no database.
// Node 24 built-ins only, ES module, .js import suffix.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type VideoNeed = "high" | "medium" | "low";

export type NicheCategory = {
  id: string;
  label: string;
  aliases: string[];
  /** One plain sentence on why this business buys the seller's video work. */
  buyerReason: string;
  videoNeed: VideoNeed;
  /** Web search phrases; {city} and {area} are filled by expandQueries. */
  queries: string[];
};

export type NicheCity = {
  name: string;
  tier: number;
  /** Optional locality list; a city with no areas is hunted city-wide. */
  areas?: string[];
};

export type NicheSignal = {
  id: string;
  meaning: string;
  /** Service ids this signal favours (raises their score); may be empty. */
  favours: string[];
};

export type NicheSeasonality = {
  category?: string;
  country?: string;
  peakMonths: number[];
  note?: string;
  basis?: string;
};

export type NichePack = {
  id: string;
  label: string;
  note?: string;
  categories: NicheCategory[];
  cities: NicheCity[];
  seasonality?: NicheSeasonality;
  signals: NicheSignal[];
};

export type HuntTarget = { category: string; city: string; area?: string };

export type ExpandQueryInput = { category: string; city: string; area?: string };

export const NICHE_PACK_DIR = new URL("../data/niche-packs/", import.meta.url);

const VIDEO_NEEDS: readonly VideoNeed[] = ["high", "medium", "low"];
const PLACEHOLDERS = new Set(["city", "area"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// ------------------------------------------------------------------ validation

function fail(message: string): never {
  throw new Error(`niche-pack: invalid pack: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Every `{token}` in a query. An empty array means the query is city-free by design. */
export function queryPlaceholders(query: string): string[] {
  const out: string[] = [];
  const re = /\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(query ?? ""))) !== null) out.push(m[1].toLowerCase());
  return out;
}

/** A query with no {city} or {area} placeholder is city-free by design, not an error. */
export function isCityFree(query: string): boolean {
  return !/\{(?:city|area)\}/i.test(String(query ?? ""));
}

function validatePack(raw: unknown): NichePack {
  if (!isObject(raw)) fail("root is not an object");
  if (!isNonEmptyString(raw.id)) fail("missing id");
  if (!isNonEmptyString(raw.label)) fail("missing label");
  if (!Array.isArray(raw.categories) || raw.categories.length === 0) fail("categories must be a non-empty array");
  if (!Array.isArray(raw.cities) || raw.cities.length === 0) fail("cities must be a non-empty array");
  if (raw.signals !== undefined && !Array.isArray(raw.signals)) fail("signals must be an array");

  const seenCategories = new Set<string>();
  for (const entry of raw.categories) {
    if (!isObject(entry)) fail("a category is not an object");
    if (!isNonEmptyString(entry.id)) fail("a category has no id");
    if (seenCategories.has(entry.id)) fail(`duplicate category id "${entry.id}"`);
    seenCategories.add(entry.id);
    if (!isNonEmptyString(entry.label)) fail(`category "${entry.id}" has no label`);
    if (!isNonEmptyString(entry.buyerReason)) fail(`category "${entry.id}" has no buyerReason`);
    if (!VIDEO_NEEDS.includes(entry.videoNeed as VideoNeed)) fail(`category "${entry.id}" has an invalid videoNeed`);
    if (entry.aliases !== undefined && !Array.isArray(entry.aliases)) fail(`category "${entry.id}" aliases must be an array`);
    if (!Array.isArray(entry.queries) || entry.queries.length === 0) fail(`category "${entry.id}" has no queries`);
    for (const query of entry.queries) {
      if (!isNonEmptyString(query)) fail(`category "${entry.id}" has an empty query`);
      for (const token of queryPlaceholders(query)) {
        if (!PLACEHOLDERS.has(token)) fail(`category "${entry.id}" query uses unknown placeholder "{${token}}"`);
      }
    }
  }

  const seenCities = new Set<string>();
  for (const entry of raw.cities) {
    if (!isObject(entry)) fail("a city is not an object");
    if (!isNonEmptyString(entry.name)) fail("a city has no name");
    if (seenCities.has(entry.name)) fail(`duplicate city "${entry.name}"`);
    seenCities.add(entry.name);
    if (typeof entry.tier !== "number" || !Number.isFinite(entry.tier)) fail(`city "${entry.name}" has no tier`);
    if (entry.areas !== undefined && !Array.isArray(entry.areas)) fail(`city "${entry.name}" areas must be an array`);
  }

  if (raw.signals !== undefined) {
    const seenSignals = new Set<string>();
    for (const entry of raw.signals) {
      if (!isObject(entry)) fail("a signal is not an object");
      if (!isNonEmptyString(entry.id)) fail("a signal has no id");
      if (seenSignals.has(entry.id)) fail(`duplicate signal id "${entry.id}"`);
      seenSignals.add(entry.id);
      if (!isNonEmptyString(entry.meaning)) fail(`signal "${entry.id}" has no meaning`);
      if (entry.favours !== undefined && !Array.isArray(entry.favours)) fail(`signal "${entry.id}" favours must be an array`);
    }
  }

  return raw as unknown as NichePack;
}

// ------------------------------------------------------------------ loader

const cache = new Map<string, NichePack>();

/** Load and validate one niche pack by id (the JSON file name without .json). */
export function loadNichePack(id: string): NichePack {
  const key = String(id ?? "").trim();
  if (!ID_PATTERN.test(key)) fail(`invalid pack id "${id}"`);
  const cached = cache.get(key);
  if (cached) return cached;
  const url = new URL(`${key}.json`, NICHE_PACK_DIR);
  let text: string;
  try {
    text = readFileSync(url, "utf8");
  } catch (err) {
    throw new Error(`niche-pack: could not read pack "${key}": ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`niche-pack: pack "${key}" is not valid JSON: ${(err as Error).message}`);
  }
  const pack = validatePack(parsed);
  cache.set(key, pack);
  return pack;
}

/** Path of a pack file, for callers that want to point elsewhere in tests. */
export function nichePackPath(id: string): string {
  return fileURLToPath(new URL(`${id}.json`, NICHE_PACK_DIR));
}

// ------------------------------------------------------------------ categories

/** Find a category by canonical id, then by label, then by alias. Case-insensitive. */
export function findCategory(pack: NichePack, category: string): NicheCategory | undefined {
  const needle = String(category ?? "").trim().toLowerCase();
  if (!needle) return undefined;
  const byId = pack.categories.find((c) => c.id.toLowerCase() === needle);
  if (byId) return byId;
  const byLabel = pack.categories.find((c) => c.label.toLowerCase() === needle);
  if (byLabel) return byLabel;
  return pack.categories.find((c) => (c.aliases ?? []).some((a) => a.toLowerCase() === needle));
}

function requireCategory(pack: NichePack, category: string): NicheCategory {
  const found = findCategory(pack, category);
  if (!found) throw new Error(`niche-pack: pack "${pack.id}" has no category "${category}"`);
  return found;
}

/** high, medium or low for one category id. Throws for an unknown category. */
export function categoryVideoNeed(pack: NichePack, category: string): VideoNeed {
  return requireCategory(pack, category).videoNeed;
}

// ------------------------------------------------------------------ queries

function normalisePhrase(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Fill {city} and {area} in one category's queries and de-duplicate the result.
 * area is optional: without it, queries that only exist to name an area are
 * dropped (they cannot be filled), while {city} and city-free phrases still
 * expand. De-duplication is case-insensitive on the filled phrase.
 */
export function expandQueries(pack: NichePack, input: ExpandQueryInput): string[] {
  const category = requireCategory(pack, input.category);
  const city = String(input.city ?? "").trim();
  const area = input.area === undefined || input.area === null ? undefined : String(input.area).trim();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const query of category.queries) {
    if (/\{area\}/i.test(query) && !area) continue;
    let text = query.replace(/\{city\}/gi, city);
    if (area) text = text.replace(/\{area\}/gi, area);
    text = normalisePhrase(text);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

// ------------------------------------------------------------------ hunt targets

function targetKey(target: HuntTarget): string {
  return `${String(target.category ?? "").trim().toLowerCase()}|${String(target.city ?? "").trim().toLowerCase()}|${String(
    target.area ?? "",
  )
    .trim()
    .toLowerCase()}`;
}

function historyKey(entry: HuntTarget | string): string {
  if (typeof entry === "string") return entry.trim().toLowerCase();
  return targetKey(entry);
}

/** Every (category, city, area) triple in a deterministic canonical order. */
export function allHuntTargets(pack: NichePack): HuntTarget[] {
  const out: HuntTarget[] = [];
  for (const category of pack.categories) {
    for (const city of pack.cities) {
      const areas: Array<string | undefined> = city.areas && city.areas.length > 0 ? city.areas : [undefined];
      for (const area of areas) out.push({ category: category.id, city: city.name, area });
    }
  }
  return out;
}

/**
 * Ordered (category, city, area) triples not present in history. history is a
 * plain array (no database): either HuntTarget objects or "category|city|area"
 * strings, case-insensitive. Because recent hunts are filtered out, each call
 * with the growing history advances (rotates) through the canonical order.
 */
export function nextHuntTargets(pack: NichePack, history: Array<HuntTarget | string> = []): HuntTarget[] {
  const recent = new Set((history ?? []).map(historyKey));
  return allHuntTargets(pack).filter((target) => !recent.has(targetKey(target)));
}
