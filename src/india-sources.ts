// src/india-sources.ts
// India data-channel registry and discovery layer for Leadscout (Order L41).
// All page reading goes through injected reach functions (deps), 1 request/second,
// per-channel call caps. Tier C channels stay off unless env LEADSCOUT_INDIA_TIER_C=1
// (absent and "0" both mean off). Everything returned is untrusted with evidence text.
// Node 24 built-ins only; imports use the .js suffix.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawLead } from "./types.js";
import { sanitizeUntrusted } from "./reach.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Registry types (typed, not a raw JSON passthrough)

export type ChannelTier = "A" | "B" | "C";

export type IndiaChannel = {
  id: string;
  name: string;
  tier: ChannelTier;
  verifiedRobots: boolean;
  listedByDefault: boolean;
  categories: string[];
  queryTemplates: string[];
  urlPatterns: string[];
  fields: string[];
  rateLimits: { minIntervalMs: number; maxCallsPerChannel: number; note: string };
  legalNote: string;
  apiNote?: string;
};

export type IndiaRegistry = { version: number; note: string; canonicalCategories: string[]; channels: IndiaChannel[] };

// Canonical categories (Order L41 list + the "others found" additions).
const CANONICAL: string[] = [
  "dentist", "clinic", "restaurant", "salon", "gym", "school-and-coaching", "real-estate",
  "travel-and-hotels", "repair-and-services", "retail", "manufacturing", "legal-and-accounting",
  "jobs", "events-cinemas", "b2b-suppliers", "any",
];

// Friendly misspellings/partial names map onto a canonical category; anything else
// is rejected (never silently passed through).
const CATEGORY_ALIASES: Record<string, string> = {
  dental: "dentist", "dental-clinic": "dentist", "dental clinic": "dentist",
  doctor: "clinic", doctors: "clinic", hospital: "clinic", healthcare: "clinic", "clinic-dental": "dentist",
  restaurants: "restaurant", cafe: "restaurant", "food-and-beverage": "restaurant", eatery: "restaurant",
  "beauty-salon": "salon", beauty: "salon", spa: "salon", barber: "salon",
  fitness: "gym", "fitness-centre": "gym", "health-club": "gym",
  school: "school-and-coaching", coaching: "school-and-coaching", "coaching-centre": "school-and-coaching",
  "tuition-centre": "school-and-coaching", tuition: "school-and-coaching", education: "school-and-coaching",
  "real-estate-agent": "real-estate", property: "real-estate", "property-dealer": "real-estate",
  travel: "travel-and-hotels", hotels: "travel-and-hotels", hotel: "travel-and-hotels",
  "travel-agency": "travel-and-hotels", "tour-operator": "travel-and-hotels",
  repair: "repair-and-services", services: "repair-and-services", logistics: "repair-and-services",
  shops: "retail", shop: "retail", trading: "retail",
  manufacturer: "manufacturing", factory: "manufacturing",
  legal: "legal-and-accounting", accounting: "legal-and-accounting", ca: "legal-and-accounting",
};

let cachedRegistry: IndiaRegistry | null = null;

function validateRegistry(raw: unknown): IndiaRegistry {
  if (!raw || typeof raw !== "object") throw new Error("india-sources.json: not an object");
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.canonicalCategories) || !Array.isArray(r.channels)) {
    throw new Error("india-sources.json: canonicalCategories and channels arrays required");
  }
  const canonical = (r.canonicalCategories as unknown[]).filter((c): c is string => typeof c === "string");
  const channels: IndiaChannel[] = r.channels.map((chRaw, i): IndiaChannel => {
    if (!chRaw || typeof chRaw !== "object") throw new Error(`india-sources.json: channel ${i} not an object`);
    const ch = chRaw as Record<string, unknown>;
    const req = (n: string): unknown => {
      if (ch[n] === undefined) throw new Error(`india-sources.json: channel ${i} missing "${n}"`);
      return ch[n];
    };
    const tier = String(req("tier"));
    if (tier !== "A" && tier !== "B" && tier !== "C") {
      throw new Error(`india-sources.json: channel ${i} tier must be A/B/C, got ${tier}`);
    }
    const categories = (req("categories") as unknown[]).filter((c): c is string => typeof c === "string")
      .filter((c) => canonical.includes(c));
    if (!Array.isArray(ch.queryTemplates) || !Array.isArray(ch.urlPatterns)) {
      throw new Error(`india-sources.json: channel ${i} queryTemplates/urlPatterns must be arrays`);
    }
    if (typeof req("legalNote") !== "string" || (req("legalNote") as string).length < 20) {
      throw new Error(`india-sources.json: channel ${i} legalNote missing or too short`);
    }
    const rl = ch.rateLimits as { minIntervalMs?: unknown; maxCallsPerChannel?: unknown; note?: unknown } | undefined;
    if (!rl || typeof rl.minIntervalMs !== "number" || typeof rl.maxCallsPerChannel !== "number" || typeof rl.note !== "string") {
      throw new Error(`india-sources.json: channel ${i} rateLimits malformed`);
    }
    return {
      id: String(req("id")),
      name: String(req("name")),
      tier: tier as ChannelTier,
      verifiedRobots: ch.verifiedRobots === true,
      listedByDefault: ch.listedByDefault === true,
      categories,
      queryTemplates: (ch.queryTemplates as unknown[]).map(String),
      urlPatterns: (ch.urlPatterns as unknown[]).map(String),
      fields: (Array.isArray(ch.fields) ? ch.fields : []).map(String),
      rateLimits: {
        minIntervalMs: rl.minIntervalMs as number,
        maxCallsPerChannel: rl.maxCallsPerChannel as number,
        note: rl.note as string,
      },
      legalNote: ch.legalNote as string,
      apiNote: typeof ch.apiNote === "string" ? ch.apiNote : undefined,
    };
  });
  return { version: Number(r.version ?? 1), note: String(r.note ?? ""), canonicalCategories: canonical, channels };
}

/** Validated, typed registry (mirrors docs/leadgen/INDIA_CHANNELS.md research of 2026-10-07). */
export function indiaChannels(): IndiaRegistry {
  if (!cachedRegistry) {
    const raw = JSON.parse(readFileSync(join(HERE, "..", "data", "india-sources.json"), "utf-8"));
    const reg = validateRegistry(raw);
    const ids = new Set<string>();
    for (const ch of reg.channels) {
      if (ids.has(ch.id)) throw new Error(`india-sources.json: duplicate channel id ${ch.id}`);
      ids.add(ch.id);
    }
    cachedRegistry = reg;
  }
  return cachedRegistry;
}

// ---------------------------------------------------------------------------

export function tierCEnabled(): boolean {
  return process.env.LEADSCOUT_INDIA_TIER_C === "1";
}

export function normalizeIndiaCategory(category: unknown): string {
  const c = String(category ?? "").trim().toLowerCase();
  if (CANONICAL.includes(c)) return c;
  const mapped = CATEGORY_ALIASES[c];
  if (mapped) return mapped;
  throw new Error(`india-sources: unknown category "${String(category).slice(0, 40)}" (canonical: ${CANONICAL.slice(0, 12).join(", ")}...)`);
}

/** Ranked channels for a canonical category (best-fit first). Unknown category
 * strings return a ranked-empty list (Order L41 edge case), never a throw. */
export function channelsFor(category: string): IndiaChannel[] {
  let cat: string;
  try {
    cat = normalizeIndiaCategory(category);
  } catch {
    return []; // unknown category string -> ranked-empty, no throw
  }
  const reg = indiaChannels();
  const matches: { ch: IndiaChannel; idx: number; order: number }[] = [];
  reg.channels.forEach((ch, order) => {
    if (!ch.categories.includes(cat) && !(cat !== "any" && ch.categories.includes("any"))) return;
    const idx = ch.categories.indexOf(cat) >= 0 ? ch.categories.indexOf(cat) : 90;
    matches.push({ ch, idx, order });
  });
  matches.sort((a, b) => a.idx - b.idx || a.order - b.order);
  return matches.map((m) => m.ch);
}

// ---------------------------------------------------------------------------
// Phone normalisation: Indian formats (+91, 0-prefix, 10-digit). Never invents
// a country code: keep whatever prefix the source used, only strip separators.

export function normalizeIndiaPhone(raw: string): string | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  let digits = "";
  let plus = false;
  if (s.startsWith("+")) plus = true;
  digits = s.replace(/\D/g, "");
  if (plus && digits.length === 12) return `+${digits}`;
  if (!plus && digits.length === 12 && digits.startsWith("91")) return `+${digits}`; // "91"-already-written 12-digit, kept as it was written
  if (digits.length === 11 && digits.startsWith("0")) return digits;
  if (digits.length === 10) return digits;
  if (digits.length >= 10 && digits.length <= 13) return plus ? `+${digits}` : digits;
  return undefined;
}

// Blocks harvesting of Aadhaar-class personal identifiers near phones.
const PERSONAL_LINE_RE = /\b(aadhaar|aadhar|uidai|pan\s*(no|number|card)|voter\s*id|passport\s*(no|number))\b/i;
const OWNER_PHONE_RE = /(owner|proprietor|founder|manager|director|principal|mobile.*(of|is)|whatsapp\s*me)[^.\n]{0,40}(phone|mobile|whatsapp|call)/i;

function harvestPhones(lineWise: string[]): string[] {
  const out: string[] = [];
  for (const line of lineWise) {
    if (PERSONAL_LINE_RE.test(line) || OWNER_PHONE_RE.test(line)) continue;
    const matches = line.match(/(?:\+\d{1,3}[\s-]?)?(?:\(?\d[\d\s()-]{7,13}\d)/g) ?? [];
    for (const m of matches) {
      const n = normalizeIndiaPhone(m);
      if (!n) continue;
      const d = n.replace(/\D/g, "");
      if (d.length === 12 && !/^\+91/.test(n) && !n.startsWith("0")) continue; // ambiguous 12-digit run, could be a personal record
      if (d.length < 10 || d.length > 13) continue;
      out.push(n);
    }
  }
  return [...new Set(out)].slice(0, 3);
}

// ---------------------------------------------------------------------------
// Deterministic dedupe key: name-hash + city + phone-last4.

export function indiaDedupeKey(name: string, city?: string, phone?: string): string {
  const norm = (s: string): string => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
  const nameHash = createHash("sha256").update(norm(name)).digest("hex").slice(0, 16);
  const digits = String(phone ?? "").replace(/\D/g, "");
  const last4 = digits.length >= 4 ? digits.slice(-4) : "nop";
  return `${nameHash}|${norm(city ?? "")}|${last4}`;
}

// ---------------------------------------------------------------------------
// Discovery: search results + optional public page text -> RawLead[].
// Every field is labelled, source-stamped, and comes only from fetched text;
// missing fields stay missing. Returns UntrustedRawLead[] (RawLead-compatible).

export type UntrustedRawLead = RawLead & { untrusted: true; evidence?: string };

export type IndiaReachDeps = {
  // injected reach functions (fake in the offline check, real reach.ts in production)
  search?: (query: string) => Promise<{ ok: boolean; text: string; error?: string }>;
  readPage?: (url: string) => Promise<{ ok: boolean; text: string; error?: string }>;
  readFeed?: (url: string) => Promise<{ ok: boolean; text: string; error?: string }>;
  now?: () => string;
  minIntervalMs?: number;
  maxCallsPerChannel?: number;
};

export type DiscoveryReport = {
  channelId: string;
  category: string;
  city?: string;
  calls: number;
  truncated: boolean;
  disabled?: string; // reason when a non-empty result was impossible (tier C off, unverified, unknown channel)
  dedupeKeys: string[];
};

let lastReport: DiscoveryReport | null = null;
export function currentDiscoverReport(): DiscoveryReport | null {
  return lastReport;
}

// 1 request/second and per-channel caps (rate-limiter; honored for page reads too)
let lastCallAt = 0;
async function throttle(minIntervalMs: number): Promise<void> {
  const wait = minIntervalMs - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** Fill a registry query template. {category} and {city} are the only slots; any
 * other placeholder raises a clear error (no silent partial fill). A missing city
 * fills as an empty string. */
export function fillQueryTemplate(tpl: string, category: string, city?: string): string {
  const unknown = [...String(tpl ?? "").matchAll(/\{([a-zA-Z0-9_-]+)\}/g)]
    .map((m) => m[1])
    .filter((n) => n !== "category" && n !== "city");
  if (unknown.length > 0) {
    throw new Error(`india-sources: unknown template placeholder {${unknown[0]}} in "${tpl}" (allowed: {category}, {city})`);
  }
  return tpl
    .replace(/\{category\}/g, category)
    .replace(/\{city\}/g, (city ?? "").trim());
}

function urlMatchesChannel(url: string, ch: IndiaChannel): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return ch.urlPatterns.some((p) => p && (p.startsWith("https://") || p.startsWith("http:"))
      ? url.startsWith(p)
      : `${u.protocol}//${u.hostname}${u.pathname}`.includes(p) && u.hostname.endsWith(p.replace(/^https?:\/\//, "").replace(/\/$/, "")));
  } catch {
    return false;
  }
}

type ParsedQuery = { category?: string; city?: string };

function splitQuery(q: string): ParsedQuery {
  const quoted = [...String(q ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1].trim());
  if (quoted.length === 0) return {};
  let category: string | undefined;
  if (CANONICAL.includes(quoted[0])) category = quoted[0];
  else {
    try { category = normalizeIndiaCategory(quoted[0]); } catch { category = undefined; }
  }
  const city = quoted[1] || undefined;
  return { category, city };
}

// segment a SERP-ish/result text into per-result blocks (numbered or blank-line separated)
function resultBlocks(text: string, max: number): string[][] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (/^\s*\d+\.\s/.test(l)) {
      if (cur.length) blocks.push(cur);
      cur = [l];
    } else if (l.trim() === "" && cur.length) {
      blocks.push(cur);
      cur = [];
    } else if (l.trim()) {
      cur.push(l);
    }
  }
  if (cur.length) blocks.push(cur);
  return blocks.slice(0, max);
}

function nameFromBlock(block: string[]): string | undefined {
  for (const l of block) {
    const named = l.match(/^\s*\d+\.\s*(?:\[([^\]]+)\]\s*)?(.+)$/);
    if (named && named[2] && named[2].length >= 3) {
      const candidate = named[2].replace(/\s*[—–|:]\s*.*$/, "").trim();
      if (/^[a-zA-Z0-9][^<>{}]{2,80}$/.test(candidate) && !/^(?:https?:\/\/|title:)/i.test(candidate)) return candidate;
    }
    const bare = l.match(/^\s*(?:\[([^\]]+)\]\s*)?([A-Z][^<>{}|:]{2,80})$/);
    if (bare) return bare[2].trim();
  }
  return undefined;
}

function urlFromTextblock(block: string[]): { url: string; line: string } | undefined {
  for (const l of block) {
    const m = l.match(/https?:\/\/[^\s"<>]+/);
    if (m) return { url: m[0].replace(/[.,;)\]]+$/, ""), line: l };
  }
  return undefined;
}

function evidenceFromBlock(block: string[], city?: string): string {
  const joined = block.join(" | ").replace(/\s+/g, " ").trim();
  return joined.slice(0, 300) + (city ? ` (city slot="${city}")` : "");
}

function wrongLanguageOrUnparseable(text: string): boolean {
  const asciiWords = text.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  return asciiWords < 3 || String(text ?? "").trim().length < 10;
}

/**
 * discoverViaChannel(channelId, q, deps): transforms registered channel search results
 * into RawLead[] with labelled, source-stamped fields. Truncation, disabled channels and
 * unparseable text are reported in `currentDiscoverReport()` (kept in module scope and
 * inspectable offline). Uses only injected reach functions in deps.
 */
export async function discoverViaChannel(
  channelId: string,
  q: string,
  deps: IndiaReachDeps = {},
): Promise<UntrustedRawLead[]> {
  const reg = indiaChannels();
  const ch = reg.channels.find((c) => c.id === channelId);
  if (!ch) {
    lastReport = { channelId, category: "", calls: 0, truncated: false, disabled: `unknown channel "${channelId}"`, dedupeKeys: [] };
    return [];
  }
  let categoryName: string;
  try { categoryName = normalizeIndiaCategory(splitQuery(q).category ?? "any"); }
  catch { categoryName = "unknown"; }
  const reasonFor = (): string | undefined => {
    if (ch.tier === "C" && !tierCEnabled()) {
      return `tier C off (LEADSCOUT_INDIA_TIER_C unset or 0; channel ${ch.id} tier C)`;
    }
    if (!ch.verifiedRobots && ch.tier !== "A") {
      return `unverified: robots.txt/terms not fetched for ${ch.name}; manual verification required before enabling`;
    }
    return undefined;
  };
  const disabled = reasonFor();
  if (disabled) {
    lastReport = { channelId, category: categoryName, calls: 0, truncated: false, disabled, dedupeKeys: [] };
    return [];
  }
  if (ch.queryTemplates.length === 0) {
    lastReport = { channelId, category: categoryName, calls: 0, truncated: false, disabled: "channel has no query templates (signal channel)", dedupeKeys: [] };
    return [];
  }
  const parsed = splitQuery(q);
  const category = parsed.category && CANONICAL.includes(parsed.category) ? parsed.category : categoryName;
  const city = parsed.city;
  const minIntervalMs = Math.max(0, deps.minIntervalMs ?? ch.rateLimits.minIntervalMs);
  const maxCalls = Math.max(0, deps.maxCallsPerChannel ?? ch.rateLimits.maxCallsPerChannel);

  let calls = 0;
  let truncated = false;
  const dedupeKeys: string[] = [];
  const search = deps.search;
  const report: DiscoveryReport = { channelId, category, city, calls: 0, truncated: false, dedupeKeys: [] };
  lastReport = report;

  const out: UntrustedRawLead[] = [];
  const query = q || fillQueryTemplate(ch.queryTemplates[0], category, city);
  if (!query) {
    report.disabled = "empty query";
    return out;
  }
  const addTo = (lead: UntrustedRawLead, evidence: string): void => {
    lead.untrusted = true;
    lead.evidence = evidence;
    lead.country = lead.country ?? "India";
    lead.category = category || (lead.category as string);
    lead.source = ch.id;
    lead.sourceUrl = lead.sourceUrl;
    const key = indiaDedupeKey(lead.name, lead.city, lead.phone);
    if (dedupeKeys.includes(key)) return;
    dedupeKeys.push(key);
    out.push(lead);
  };

  if (!search) {
    report.disabled = "no search function injected in deps";
    return out;
  }
  if (calls >= maxCalls) truncated = true;
  if (truncated) { report.truncated = true; return out; }
  calls += 1;
  report.calls = calls;
  await throttle(minIntervalMs);
  const searchRes = await search(query);
  const searchText = sanitizeUntrusted(String(searchRes?.text ?? ""));
  if (!searchRes?.ok || wrongLanguageOrUnparseable(searchText)) {
    // missing/wrong-language/unparseable -> no results, no fabrication
    report.truncated = truncated;
    return out;
  }

  const blocks = resultBlocks(searchText, 20);
  let truncatedByCap = truncated;
  for (const block of blocks) {
    if (calls >= maxCalls) { truncatedByCap = true; break; }
    const urlInfo = urlFromTextblock(block);
    if (!urlInfo) continue; // no URL -> skip; source URL is mandatory
    if (!urlMatchesChannel(urlInfo.url, ch)) continue;
    const name = nameFromBlock(block);
    if (!name) continue; // invalid/false-safe: no name -> no lead, not a fabricated one
    if (PERSONAL_LINE_RE.test(block.join(" "))) continue;
    const lead: UntrustedRawLead = {
      name,
      category: category || ch.categories[0] || "unknown",
      source: ch.id,
      sourceUrl: urlInfo.url,
      untrusted: true,
      evidence: evidenceFromBlock(block, city),
    };
    if (city) lead.city = city;
    const addrLine = block.find((l) => /^\s*address[:\s]/i.test(l));
    if (addrLine) lead.address = addrLine.replace(/^\s*address[:\s]*/i, "").trim();
    const phones = harvestPhones(block);
    if (phones.length > 0) lead.phone = phones[0];
    // optional polite read of the business page for the website field
    if (deps.readPage && calls < maxCalls) {
      calls += 1;
      report.calls = calls;
      await throttle(minIntervalMs);
      const pageRes = await deps.readPage(urlInfo.url);
      const pageText = sanitizeUntrusted(String(pageRes?.text ?? ""));
      if (!pageRes?.ok || wrongLanguageOrUnparseable(pageText)) {
        // nothing parseable: keep only the search-result fields, still no fabrication
        truncatedByCap = truncatedByCap || calls >= maxCalls;
      } else {
        const phones2 = harvestPhones(pageText.replace(/\r\n/g, "\n").split("\n"));
        if (!lead.phone && phones2.length > 0) lead.phone = phones2[0];
        const websiteMatch = pageText.match(/https?:\/\/[^\s"<>]+/);
        if (websiteMatch && !urlMatchesChannel(websiteMatch[0], ch)) lead.website = websiteMatch[0];
      }
    } else if (calls >= maxCalls) {
      truncatedByCap = true;
      break;
    }
    await addTo(lead, lead.evidence as string);
    if (out.length >= 20) { truncatedByCap = true; break; }
  }
  report.truncated = truncatedByCap;
  report.dedupeKeys = [...dedupeKeys];
  return out;
}

// ---------------------------------------------------------------------------
// signalsFromChannel: light heuristics over (already-sanitised) page text from a
// channel page. Returns labelled signal strings only, never new business facts.

export type ChannelSignal = { channelId: string; signals: string[]; untrusted: true };

export function signalsFromChannel(channelId: string, pageText: string): ChannelSignal {
  const reg = indiaChannels();
  const ch = reg.channels.find((c) => c.id === channelId);
  const text = sanitizeUntrusted(String(pageText ?? ""));
  const signals: string[] = [];
  if (!ch) {
    return { channelId, signals: [], untrusted: true };
  }
  if (wrongLanguageOrUnparseable(text)) {
    return { channelId, signals, untrusted: true }; // unparseable -> no signals invented
  }
  if (ch.name && text.toLowerCase().includes(ch.name.split(" ")[0].toLowerCase() as string)) {
    signals.push(`listed-on:${ch.name}`);
  }
  const reviewCountM = text.match(/(\d[\d,]*)\s*(?:reviews|ratings|feedback)/i);
  if (reviewCountM && parseInt(reviewCountM[1].replace(/,/g, ""), 10) >= 20) {
    signals.push(`many-reviews:${reviewCountM[1]}(reviews)`);
  }
  const hasAnySiteLink = /https?:\/\/[^\s"<>]+\.[a-z]{2,}/i.test(text);
  const siteWords = /(visit\s+(?:us|our\s+website|website))|official\s+website|www\./i.test(text);
  if (!hasAnySiteLink && !siteWords) {
    signals.push("no-website");
  }
  if (!/booking\s*now|book\s*(a|an)|appointment\s*now|reserve\s*(a|your)/i.test(text)) {
    signals.push("no-booking-widget");
  }
  if (/\b(hiring|we.{0,8}are\s+hiring|join\s+our\s+team|receptionist\s+needed|vacancy|walk[-\s]?in\s+interview)\b/i.test(text)) {
    signals.push("hiring-staff");
  }
  if (/\b(new(ly)?\s+(opened|open|listed)|grand\s+opening|now\s+open)\b/i.test(text)) {
    signals.push("new-listing-this-month");
  }
  if (/timing|open\s+hours|monday\s*[-–]\s*sunday/i.test(text)) {
    signals.push("hours-listed");
  }
  return { channelId, signals, untrusted: true };
}

// ---------------------------------------------------------------------------
// indiaChannelsStatus: per channel enabled + tier + a plain reason if disabled.

export type ChannelStatus = {
  channelId: string;
  name: string;
  tier: ChannelTier;
  enabled: boolean;
  reason?: string; // only set when disabled
  note?: string;   // warning even when enabled
};

export function indiaChannelsStatus(): ChannelStatus[] {
  const reg = indiaChannels();
  return reg.channels.map((ch): ChannelStatus => {
    const base: ChannelStatus = { channelId: ch.id, name: ch.name, tier: ch.tier, enabled: true };
    if (ch.tier === "C" && !tierCEnabled()) {
      base.enabled = false;
      base.reason = `tier C (automated access forbidden or unverifiable); LEADSCOUT_INDIA_TIER_C is "${
        process.env.LEADSCOUT_INDIA_TIER_C ?? "<unset>"
      }" so tier C is off (absent and =0 both mean off)`;
      return base;
    }
    if (!ch.verifiedRobots && ch.tier !== "A") {
      base.enabled = false;
      base.reason = `unverified: robots.txt/terms not fetched this run; manual verification required before enabling`;
      return base;
    }
    if (ch.tier === "C" && tierCEnabled()) {
      base.note = "tier C used only because LEADSCOUT_INDIA_TIER_C=1 (operator override; not a legal permission)";
    }
    if (!ch.verifiedRobots) {
      base.note = base.note ?? "robots.txt fetch failed but government open-data licence applies (see INDIA_CHANNELS.md; unverified)";
    }
    return base;
  });
}
