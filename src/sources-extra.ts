// src/sources-extra.ts
// Optional extra lead sources for Leadscout. Both are OFF/optional by default (Order L23-places):
//   - discoverPlaces: official Google Places API (New) Text Search, enabled only by
//     GOOGLE_PLACES_API_KEY (deps.env, falling back to process.env). Never scrapes Google pages.
//   - importScraperCsv: offline parse of a user-owned scraper CSV export. No network.
// Node 24 built-ins only, ES module, .js import suffix.

import type { RawLead } from "./types.js";

export const SOURCE_NOTICE =
  "Places data is subject to Google's terms. Scraping Google Maps pages may break those terms. " +
  "The operator is responsible for lawful use.";

export const PLACES_API_URL = "https://places.googleapis.com/v1/places:searchText";
// Exactly the fields the order allows: place id, name, address, phone, website,
// Google Maps URL, rating, review count, plus the paging token.
export const PLACES_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber," +
  "places.websiteUri,places.googleMapsUri,places.rating,places.userRatingCount,nextPageToken";
export const SOURCE_PLACES = "google-places";
export const SOURCE_CSV = "csv-import";

const DEFAULT_LIMIT = 50; // same default as discover()
const MAX_LIMIT = 500;
const MAX_PAGE_SIZE = 20; // Places API: pageSize is between 1 and 20
export const PLACES_MAX_PAGES = 10; // hard cap on pages fetched per call

export type SourceFact = {
  leadIndex: number; // index into the leads array of the same result
  field: "rating" | "reviewCount";
  value: number;
  source: string; // "google-places" or "csv-import"
  fetchedAt: string; // ISO time
};

export type SourceResult = { leads: RawLead[]; facts: SourceFact[]; notice: string };
export type PlacesResult = SourceResult & { enabled: boolean };

export type PlacesQuery = { category: string; city?: string; country?: string; limit?: number };

export type ExtraSourceDeps = {
  fetchFn?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
};

export type CsvMapping = Partial<{
  name: string; address: string; phone: string; website: string;
  rating: string; reviews: string; category: string; link: string;
}>;

// --------------------------------------------------------------------- helpers

function cleanStr(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s ? s : undefined;
}

function toNum(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : undefined;
}

function clampLimit(limit?: number): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

// ---------------------------------------------------- Google Places (New) API

function pickDisplayName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return cleanStr(value);
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return cleanStr(record.text);
}

/** Pure mapping of one Places API place to RawLead. Drops places without a name. */
export function placeToRawLead(place: unknown, category: string): RawLead | undefined {
  const p = typeof place === "object" && place !== null ? (place as Record<string, unknown>) : {};
  const name = pickDisplayName(p.displayName);
  if (!name) return undefined;

  const lead: RawLead = {
    name,
    category,
    source: SOURCE_PLACES,
    sourceUrl: cleanStr(p.googleMapsUri) ?? SOURCE_PLACES,
  };

  const address = cleanStr(p.formattedAddress);
  if (address) lead.address = address;
  const phone = cleanStr(p.nationalPhoneNumber);
  if (phone) lead.phone = phone;
  const website = cleanStr(p.websiteUri);
  if (website) lead.website = website;

  return lead;
}

/** Provenance entries for one place. rating/reviewCount appear only here —
 *  never on the RawLead (it has no rating field), never zero-filled. */
export function placeFacts(place: unknown, leadIndex: number, fetchedAt: string): SourceFact[] {
  const p = typeof place === "object" && place !== null ? (place as Record<string, unknown>) : {};
  const facts: SourceFact[] = [];
  const rating = toNum(p.rating);
  if (rating !== undefined) {
    facts.push({ leadIndex, field: "rating", value: rating, source: SOURCE_PLACES, fetchedAt });
  }
  const reviewCount = toNum(p.userRatingCount);
  if (reviewCount !== undefined) {
    facts.push({ leadIndex, field: "reviewCount", value: reviewCount, source: SOURCE_PLACES, fetchedAt });
  }
  return facts;
}

async function fetchPage(
  fetchFn: typeof fetch,
  apiKey: string,
  textQuery: string,
  pageSize: number,
  pageToken: string | undefined,
): Promise<Response> {
  const body: Record<string, unknown> = { textQuery, pageSize };
  if (pageToken) body.pageToken = pageToken;
  return fetchFn(PLACES_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": PLACES_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
}

/** Discover leads through the official Google Places API (New) Text Search endpoint.
 *  Enabled only when GOOGLE_PLACES_API_KEY is set (deps.env, else process.env) and non-blank;
 *  without it returns { enabled: false } and never calls fetchFn.
 *  Paging follows nextPageToken, hard-capped at limit, stops on a missing or repeated token,
 *  and never fetches more than PLACES_MAX_PAGES pages. */
export async function discoverPlaces(q: PlacesQuery, deps: ExtraSourceDeps = {}): Promise<PlacesResult> {
  const notice = SOURCE_NOTICE;

  const env = deps.env ?? process.env;
  const apiKey = cleanStr(env.GOOGLE_PLACES_API_KEY);
  if (!apiKey) {
    return { enabled: false, leads: [], facts: [], notice };
  }

  const category = cleanStr(q?.category);
  if (!category) throw new Error("discoverPlaces: category is required");
  const city = cleanStr(q?.city);
  const country = cleanStr(q?.country);
  const placeText = [city, country].filter(Boolean).join(", ");
  const textQuery = placeText ? `${category} in ${placeText}` : category;

  const limit = clampLimit(q?.limit);
  const fetchFn = deps.fetchFn ?? fetch;
  const fetchedAt = new Date((deps.now ?? Date.now)()).toISOString();

  const leads: RawLead[] = [];
  const facts: SourceFact[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  let pages = 0;

  while (leads.length < limit && pages < PLACES_MAX_PAGES) {
    pages += 1;
    // Never ask a page for more than what the limit still needs.
    const pageSize = Math.min(MAX_PAGE_SIZE, limit - leads.length);

    let res: Response;
    try {
      res = await fetchPage(fetchFn, apiKey, textQuery, pageSize, pageToken);
    } catch {
      break;
    }
    if (!res.ok) break;

    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      data = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      break;
    }

    const places = Array.isArray(data.places) ? data.places : [];
    for (const item of places) {
      if (leads.length >= limit) break;
      const lead = placeToRawLead(item, category);
      if (!lead) continue;
      leads.push(lead);
      facts.push(...placeFacts(item, leads.length - 1, fetchedAt));
    }

    const token = cleanStr(data.nextPageToken);
    // Missing/empty token, or the server repeating a token we already used: stop.
    if (!token || seenTokens.has(token)) break;
    seenTokens.add(token);
    pageToken = token;
  }

  return { enabled: true, leads, facts, notice };
}

// ----------------------------------------------------------- offline CSV import

/**
 * Parse CSV text (RFC4180-style) into rows of cells. Hand-written for the quirks
 * that matter: quoted fields with commas, doubled quotes, CRLF rows, blank rows
 * dropped, surrounding whitespace trimmed, leading BOM removed.
 */
export function parseCsvRows(text: string): string[][] {
  const cleaned = (text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  const endRow = (): void => {
    row.push(cell.trim());
    cell = "";
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    const next = cleaned[i + 1];
    if (inQuotes) {
      if (char === '"') {
        if (next === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n") {
      endRow();
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

type CsvField = "name" | "address" | "phone" | "website" | "rating" | "reviews" | "category" | "link";

const CSV_FIELDS: Set<string> = new Set([
  "name", "address", "phone", "website", "rating", "reviews", "category", "link",
]);

// Case-insensitive header aliases. The link field matches both "link" and "url".
const HEADER_ALIASES = new Map<string, CsvField>([
  ["title", "name"],
  ["name", "name"],
  ["address", "address"],
  ["phone", "phone"],
  ["website", "website"],
  ["rating", "rating"],
  ["reviews", "reviews"],
  ["category", "category"],
  ["link", "link"],
  ["url", "link"],
]);

function csvCell(cells: string[], index: number | undefined): string | undefined {
  if (index === undefined) return undefined;
  return cleanStr(cells[index]);
}

function csvFact(
  cells: string[],
  index: number | undefined,
  leadIndex: number,
  field: "rating" | "reviewCount",
  source: string,
  fetchedAt: string,
): SourceFact | undefined {
  const value = toNum(csvCell(cells, index));
  if (value === undefined) return undefined;
  return { leadIndex, field, value, source, fetchedAt };
}

/** Import leads from a user-supplied scraper CSV export.
 *  Headers are matched case-insensitively ("title"/"name"/"link"/"url" aliases);
 *  a mapping override {field: columnName} wins over the defaults; unknown columns
 *  are ignored; rows without a name are dropped. Rating/review values come back
 *  as provenance-labelled facts entries. Pure local parse — no network. */
export function importScraperCsv(csvText: string, mapping?: CsvMapping): SourceResult {
  const notice = SOURCE_NOTICE;
  const rows = parseCsvRows(csvText ?? "");
  if (rows.length === 0) return { leads: [], facts: [], notice };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const taken = new Set<number>();
  const fieldAt = new Map<CsvField, number>();

  // Explicit mapping first: {field: columnName} wins over the defaults.
  if (mapping) {
    for (const [key, column] of Object.entries(mapping)) {
      const field = key.trim().toLowerCase();
      if (!CSV_FIELDS.has(field) || typeof column !== "string" || !column.trim()) continue;
      const col = column.trim().toLowerCase();
      const index = headers.findIndex((h, i) => h === col && !taken.has(i));
      if (index >= 0) {
        fieldAt.set(field as CsvField, index);
        taken.add(index);
      }
    }
  }

  // Then the default aliases, for headers not already claimed.
  for (let i = 0; i < headers.length; i += 1) {
    if (taken.has(i)) continue;
    const field = HEADER_ALIASES.get(headers[i]);
    if (field !== undefined && !fieldAt.has(field)) {
      fieldAt.set(field, i);
      taken.add(i);
    }
  }

  const fetchedAt = new Date().toISOString();
  const leads: RawLead[] = [];
  const facts: SourceFact[] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const name = csvCell(cells, fieldAt.get("name"));
    if (!name) continue; // drop rows without a name

    const lead: RawLead = {
      name,
      category: csvCell(cells, fieldAt.get("category")) ?? "business",
      source: SOURCE_CSV,
      sourceUrl: csvCell(cells, fieldAt.get("link")) ?? SOURCE_CSV,
    };

    const address = csvCell(cells, fieldAt.get("address"));
    if (address) lead.address = address;
    const phone = csvCell(cells, fieldAt.get("phone"));
    if (phone) lead.phone = phone;
    const website = csvCell(cells, fieldAt.get("website"));
    if (website) lead.website = website;

    leads.push(lead);
    const leadIndex = leads.length - 1;
    const ratingFact = csvFact(cells, fieldAt.get("rating"), leadIndex, "rating", SOURCE_CSV, fetchedAt);
    if (ratingFact) facts.push(ratingFact);
    const reviewFact = csvFact(cells, fieldAt.get("reviews"), leadIndex, "reviewCount", SOURCE_CSV, fetchedAt);
    if (reviewFact) facts.push(reviewFact);
  }

  return { leads, facts, notice };
}
