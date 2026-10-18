// src/evidence.ts - evidence builder and facts (Order L15)
// Builds numbered evidence (E1..En) and cited public facts for a business.

// @ts-ignore node:crypto is a Node 24 built-in; ambient types are not available in this environment.
import { createHash } from "node:crypto";
// @ts-ignore node:sqlite is a Node 24 built-in; ambient types are not available in this environment.
import { DatabaseSync } from "node:sqlite";
import { normaliseName, normaliseCity, websiteHost, getDb } from "./store.js";
import type { RawLead, Enrichment } from "./types.js";
import type { Evidence, Verification, Dossier } from "./types-v2.js";

export type Page = { url: string; body: string; fetchedAt: string };

const EVIDENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS evidence_snapshots (
  bizKey TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  evidence TEXT NOT NULL,
  savedAt TEXT NOT NULL
);
`;

const ABSENT_SIGNALS = new Set([
  "no-online-booking",
  "no-chat-widget",
  "no-contact-form",
  "no-analytics",
  "no-https",
  "not-mobile-friendly",
]);

const SIGNAL_LOOKUP: Record<string, { what: string; lookedFor: string }> = {
  "no-online-booking": {
    what: "booking widget",
    lookedFor: "calendly, cal.com, practo and booking form",
  },
  "no-chat-widget": {
    what: "chat widget",
    lookedFor: "intercom, drift, tawk.to, crisp, zendesk",
  },
  "no-contact-form": {
    what: "contact form",
    lookedFor: "contact or enquiry form",
  },
  "no-analytics": {
    what: "analytics script",
    lookedFor: "google analytics, plausible, mixpanel",
  },
  "no-https": { what: "HTTPS", lookedFor: "https://" },
  "not-mobile-friendly": {
    what: "viewport meta tag",
    lookedFor: "viewport meta tag",
  },
};

// ------------------------------------------------------------------ bizKey

/** Global business identity. Priority: website host, OSM id, E.164 phone, normName|normCity. */
export function bizKey(raw: RawLead, phonesE164?: string[]): string {
  const host = websiteHost(raw.website);
  if (host) return host;

  const osm = parseOsmKey(raw.sourceUrl);
  if (osm) return osm;

  const phone = phonesE164?.find((p) => typeof p === "string" && p.startsWith("+"));
  if (phone) return phone;

  return `${normaliseName(raw.name)}|${normaliseCity(raw.city)}`;
}

function parseOsmKey(sourceUrl: string): string | undefined {
  if (!sourceUrl) return undefined;
  const match = sourceUrl.match(/openstreetmap\.org\/(node|way|relation)\/(\d+)/i);
  if (match) return `osm:${match[1].toLowerCase()}/${match[2]}`;
  return undefined;
}

// ------------------------------------------------------------------ cleaning

/** Strip tags/scripts/styles, decode common entities, collapse whitespace. Exported for checks. */
export function cleanPageText(html: string): string {
  return (html ?? "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max = 300): string {
  if (text.length <= max) return text;
  // Prefer a word boundary, but never drop below 80 % of max.
  let end = max;
  while (end > 0 && text[end] !== " ") end -= 1;
  if (end < max * 0.8) end = max;
  return text.slice(0, end).trim();
}

// ------------------------------------------------------------------ buildEvidence

type EvidenceSeed = Omit<Evidence, "id">;

function makeSeed(kind: Evidence["kind"], url: string, quote: string, field: string, fetchedAt: string): EvidenceSeed {
  return { kind, url, quote: truncate(quote), field, fetchedAt };
}

/** Pure builder: turns a raw listing, enrichment, fetched pages and verification into evidence items. */
export function buildEvidence(raw: RawLead, e: Enrichment, pages: Page[], v?: Verification): Evidence[] {
  const fetchedAt = pages[0]?.fetchedAt ?? new Date().toISOString();
  const required: EvidenceSeed[] = [];

  // Listing items (always kept under the cap).
  if (raw.name) required.push(makeSeed("listing", raw.sourceUrl, raw.name, "name", fetchedAt));
  if (raw.phone) required.push(makeSeed("listing", raw.sourceUrl, raw.phone, "phone", fetchedAt));
  if (raw.website) required.push(makeSeed("listing", raw.sourceUrl, raw.website, "website", fetchedAt));
  if (raw.email) required.push(makeSeed("listing", raw.sourceUrl, raw.email, "email", fetchedAt));
  if (raw.address) required.push(makeSeed("listing", raw.sourceUrl, raw.address, "address", fetchedAt));
  // City is emitted as a listing item so the area fact has evidence (PLAN_V2 2.2).
  if (raw.city) required.push(makeSeed("listing", raw.sourceUrl, raw.city, "area", fetchedAt));
  if (!raw.website) {
    required.push(
      makeSeed("listing", raw.sourceUrl, "No website on the public listing", "no-website", fetchedAt)
    );
  }

  // Absence items (always kept under the cap).
  const absentSignals = (e.signals ?? []).filter((s) => ABSENT_SIGNALS.has(s));
  for (const signal of absentSignals) {
    required.push(makeAbsenceSeed(signal, pages, fetchedAt));
  }

  // Verification items (always kept under the cap).
  if (v) {
    required.push(...verificationSeeds(v, fetchedAt));
  }

  // Page-derived items (page-text + structured); these compete for the remaining slots.
  const pageDerived: EvidenceSeed[] = [];
  for (const page of pages) {
    const cleaned = cleanPageText(page.body);
    pageDerived.push(...pageTextSeeds(page.url, page.body, cleaned, page.fetchedAt));
    pageDerived.push(...structuredSeeds(page.url, page.body, page.fetchedAt));
  }

  const capped = capItems(required, pageDerived, 14);
  return assignIds(capped);
}

function makeAbsenceItemSeed(signal: string, pages: Page[], fetchedAt: string): EvidenceSeed {
  const info = SIGNAL_LOOKUP[signal];
  const pageNames = pages.map((p) => p.url).join(", ");
  const quote =
    pages.length === 0
      ? `Checked 0 pages; found no ${info.what} (${info.lookedFor})`
      : `Checked ${pages.length} page${pages.length === 1 ? "" : "s"} (${pageNames}); found no ${info.what} (${info.lookedFor})`;
  return makeSeed("absence", pages[0]?.url ?? "", quote, `signal:${signal}`, fetchedAt);
}

// Backwards-compatible alias used above.
const makeAbsenceSeed = makeAbsenceItemSeed;

function verificationSeeds(v: Verification, fallbackFetchedAt: string): EvidenceSeed[] {
  const fetchedAt = v.checkedAt ?? fallbackFetchedAt;
  const items: EvidenceSeed[] = [];
  items.push(
    makeSeed(
      "verification",
      "",
      `Website status: ${v.website}${v.httpStatus ? ` (${v.httpStatus})` : ""}`,
      "website-status",
      fetchedAt
    )
  );
  for (const email of v.emails ?? []) {
    const domain = email.value.split("@")[1] ?? email.value;
    items.push(makeSeed("verification", "", `MX for ${domain}: ${email.result}`, `mx:${domain}`, fetchedAt));
  }
  for (const phone of v.phones ?? []) {
    const key = phone.e164 ?? phone.value;
    items.push(makeSeed("verification", "", `Phone ${key}: ${phone.result}`, `phone:${key}`, fetchedAt));
  }
  return items;
}

function extractTagText(html: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = html.match(re);
  return m ? m[1] : "";
}

function extractMetaDescription(html: string): string {
  const m =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ??
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i);
  return m ? m[1] : "";
}

function extractHeadings(html: string): string[] {
  const matches = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi) ?? [];
  return matches
    .map((h) => {
      const m = h.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
      return m ? m[1] : "";
    })
    .filter(Boolean);
}

function findCopyrightSpan(cleaned: string): string | undefined {
  const idx = cleaned.indexOf("©");
  const idx2 = cleaned.toLowerCase().indexOf("copyright");
  const start = idx >= 0 ? idx : idx2;
  if (start < 0) return undefined;
  return truncate(cleaned.slice(start, start + 300).trim());
}

function findSinceSpan(cleaned: string): string | undefined {
  const re = /\b(since|established|estd\.?)\s+(?:the\s+year\s+)?(?:in\s+)?(18|19|20)\d{2}\b/gi;
  const m = re.exec(cleaned);
  if (!m) return undefined;
  return truncate(m[0]);
}

function findOwnerSpan(cleaned: string): string | undefined {
  // "Owner" is ambiguous in titles (e.g. "Fixture No Owner Home"), so reject
  // matches whose first captured word is a common non-name word.
  const nonName = new Set([
    "home", "page", "us", "the", "of", "at", "in", "and", "a", "an",
    "we", "are", "is", "it", "by", "on", "for", "to", "from", "with",
  ]);

  const patterns = [
    /\b(founded by|proprietor)\s+([A-Z][A-Za-z0-9\s\.\-]+?)(?=\s+(?:in|on|at|and|is|has|with|for|from|to|of)|$)/i,
    /\bowner\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/i,
    /\b(dr\.)\s+([A-Z](?:\.[A-Z])?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
  ];

  for (const re of patterns) {
    const m = re.exec(cleaned);
    if (!m) continue;
    const namePart = m[m.length - 1].trim();
    const firstWord = namePart.split(/\s+/)[0].replace(/\.$/, "").toLowerCase();
    if (re.source.includes("\\bowner\\s+") && nonName.has(firstWord)) continue;
    return truncate(m[0].trim());
  }
  return undefined;
}

function findTimingSpan(cleaned: string): string | undefined {
  const re = /\b(new branch|now open|opening|hiring)\b[^.]{0,200}/i;
  const m = cleaned.match(re);
  if (!m) return undefined;
  return truncate(m[0]);
}

function pageTextSeeds(url: string, html: string, cleaned: string, fetchedAt: string): EvidenceSeed[] {
  const seeds: EvidenceSeed[] = [];

  const title = cleanPageText(extractTagText(html, "title"));
  if (title) seeds.push(makeSeed("page-text", url, title, "title", fetchedAt));

  const desc = cleanPageText(extractMetaDescription(html));
  if (desc) seeds.push(makeSeed("page-text", url, desc, "description", fetchedAt));

  const headings = extractHeadings(html);
  for (let i = 0; i < Math.min(headings.length, 2); i += 1) {
    const h = cleanPageText(headings[i]);
    if (h) seeds.push(makeSeed("page-text", url, h, "heading", fetchedAt));
  }

  const copyright = findCopyrightSpan(cleaned);
  if (copyright) seeds.push(makeSeed("page-text", url, copyright, "copyright", fetchedAt));

  const since = findSinceSpan(cleaned);
  if (since) seeds.push(makeSeed("page-text", url, since, "since-year", fetchedAt));

  const owner = findOwnerSpan(cleaned);
  if (owner) seeds.push(makeSeed("page-text", url, owner, "owner", fetchedAt));

  const timing = findTimingSpan(cleaned);
  if (timing) seeds.push(makeSeed("page-text", url, timing, "timing", fetchedAt));

  // Safety: drop any seed whose quote cannot be found in the cleaned source.
  return seeds.filter((s) => cleaned.includes(s.quote));
}

function findAggregateRating(obj: unknown): any | undefined {
  if (obj === null || typeof obj !== "object") return undefined;
  const typed = obj as Record<string, unknown>;
  const typeValue = typed["@type"];
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  if (types.some((t) => t === "AggregateRating")) {
    return typed;
  }
  for (const value of Object.values(typed)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findAggregateRating(item);
        if (found) return found;
      }
    } else {
      const found = findAggregateRating(value);
      if (found) return found;
    }
  }
  return undefined;
}

function buildRatingQuote(jsonText: string, rating: Record<string, unknown>): string | undefined {
  const rv = String(rating.ratingValue ?? "");
  const rc = rating.reviewCount != null ? String(rating.reviewCount) : undefined;
  if (!rv) return undefined;

  const rvKeyIdx = jsonText.indexOf('"ratingValue"');
  const rvIdx = jsonText.indexOf(rv);
  if (rvKeyIdx < 0 || rvIdx < 0) return undefined;

  if (rc) {
    const rcKeyIdx = jsonText.indexOf('"reviewCount"');
    const rcIdx = jsonText.indexOf(rc);
    if (rcKeyIdx >= 0 && rcIdx >= 0) {
      const start = Math.min(rvKeyIdx, rcKeyIdx);
      const end = Math.max(rvIdx + rv.length, rcIdx + rc.length);
      return jsonText.slice(start, end);
    }
  }

  const end = Math.min(jsonText.length, rvIdx + rv.length + 30);
  return jsonText.slice(rvKeyIdx, end);
}

function structuredSeeds(url: string, html: string, fetchedAt: string): EvidenceSeed[] {
  const seeds: EvidenceSeed[] = [];
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const script of scripts) {
    const jsonText = script.replace(/<[^>]+>/g, "");
    try {
      const data = JSON.parse(jsonText);
      const rating = findAggregateRating(data);
      if (rating && rating.ratingValue != null) {
        const quote = buildRatingQuote(jsonText, rating as Record<string, unknown>);
        if (quote && jsonText.includes(quote)) {
          seeds.push(makeSeed("structured-data", url, quote, "rating", fetchedAt));
        }
      }
    } catch {
      // Malformed JSON-LD is skipped silently.
    }
  }
  return seeds;
}

function capItems(required: EvidenceSeed[], pageDerived: EvidenceSeed[], max: number): EvidenceSeed[] {
  if (required.length + pageDerived.length <= max) {
    return [...required, ...pageDerived];
  }
  const slots = Math.max(0, max - required.length);

  // Deterministic richness rule:
  // 1. structured-data before page-text (ratings/reviews are scarce and factual)
  // 2. longer quote before shorter quote
  // 3. url ascending
  // 4. field ascending
  const sorted = [...pageDerived].sort((a, b) => {
    const aStruct = a.kind === "structured-data" ? 1 : 0;
    const bStruct = b.kind === "structured-data" ? 1 : 0;
    if (aStruct !== bStruct) return bStruct - aStruct;
    if (b.quote.length !== a.quote.length) return b.quote.length - a.quote.length;
    if (a.url !== b.url) return a.url.localeCompare(b.url);
    return (a.field ?? "").localeCompare(b.field ?? "");
  });

  return [...required, ...sorted.slice(0, slots)];
}

function assignIds(seeds: EvidenceSeed[]): Evidence[] {
  return seeds.map((seed, i) => ({ ...seed, id: `E${i + 1}` }));
}

// ------------------------------------------------------------------ facts

/** Derive cited public facts from evidence. rating/reviewCount come ONLY from structured data. */
export function extractFacts(evidence: Evidence[], raw: RawLead): Partial<Dossier["facts"]> {
  const facts: Partial<Dossier["facts"]> = {};
  const currentYear = new Date().getFullYear();

  const ownerItem = evidence.find((i) => i.field === "owner");
  if (ownerItem) {
    facts.owner = { value: ownerItem.quote, evidence: [ownerItem.id] };
  }

  const sinceItem = evidence.find((i) => i.field === "since-year");
  if (sinceItem) {
    const year = parseSinceYear(sinceItem.quote, currentYear);
    if (year) {
      facts.sinceYear = { value: year, evidence: [sinceItem.id] };
    }
  }

  const ratingItem = evidence.find((i) => i.kind === "structured-data" && i.field === "rating");
  if (ratingItem) {
    const parsed = parseRatingQuote(ratingItem.quote);
    if (parsed.rating != null) {
      facts.rating = { value: parsed.rating, evidence: [ratingItem.id] };
    }
    if (parsed.count != null) {
      facts.reviewCount = { value: parsed.count, evidence: [ratingItem.id] };
    }
  }

  const areaItem = evidence.find((i) => i.field === "area");
  if (areaItem) {
    facts.area = { value: areaItem.quote, evidence: [areaItem.id] };
  }

  return facts;
}

function parseSinceYear(quote: string, currentYear: number): number | undefined {
  const matches = quote.match(/\b(18|19|20)\d{2}\b/g);
  if (!matches) return undefined;
  for (const m of matches) {
    const year = parseInt(m, 10);
    if (year >= 1800 && year <= currentYear) return year;
  }
  return undefined;
}

function parseRatingQuote(quote: string): { rating?: number; count?: number } {
  const ratingMatch = quote.match(/"ratingValue"\s*:\s*"?([\d.]+)"?/);
  const countMatch = quote.match(/"reviewCount"\s*:\s*"?(\d+)"?/);
  return {
    rating: ratingMatch ? parseFloat(ratingMatch[1]) : undefined,
    count: countMatch ? parseInt(countMatch[1], 10) : undefined,
  };
}

// ------------------------------------------------------------------ hash + persistence

/** Order-independent sha256 of the cleaned text of all fetched pages. */
export function contentHash(pages: Page[]): string {
  const hashes = pages.map((page) => {
    const cleaned = cleanPageText(page.body);
    return createHash("sha256").update(cleaned).digest("hex");
  });
  hashes.sort();
  return createHash("sha256").update(hashes.join("")).digest("hex");
}

function resolveDb(dbOrPath?: DatabaseSync | string): DatabaseSync {
  if (dbOrPath) {
    if (dbOrPath instanceof DatabaseSync) {
      dbOrPath.exec(EVIDENCE_SCHEMA);
      return dbOrPath;
    }
    const db = new DatabaseSync(dbOrPath);
    db.exec(EVIDENCE_SCHEMA);
    return db;
  }
  const db = getDb();
  db.exec(EVIDENCE_SCHEMA);
  return db;
}

/** Save or replace an evidence snapshot keyed by bizKey. */
export function saveEvidence(bizKey: string, hash: string, evidence: Evidence[], dbOrPath?: DatabaseSync | string): void {
  const db = resolveDb(dbOrPath);
  const stmt = db.prepare(`
    INSERT INTO evidence_snapshots (bizKey, hash, evidence, savedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(bizKey) DO UPDATE SET
      hash = excluded.hash,
      evidence = excluded.evidence,
      savedAt = excluded.savedAt
  `);
  stmt.run(bizKey, hash, JSON.stringify(evidence), new Date().toISOString());
}

/** Load a saved evidence snapshot by bizKey. */
export function loadEvidence(
  bizKey: string,
  dbOrPath?: DatabaseSync | string
): { hash: string; evidence: Evidence[] } | undefined {
  const db = resolveDb(dbOrPath);
  const row = db.prepare("SELECT hash, evidence FROM evidence_snapshots WHERE bizKey = ?").get(bizKey);
  if (!row) return undefined;
  const r = row as Record<string, unknown>;
  return {
    hash: String(r.hash),
    evidence: JSON.parse(String(r.evidence)) as Evidence[],
  };
}
