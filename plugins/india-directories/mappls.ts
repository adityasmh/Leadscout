// ChannelAdapter for Mappls (MapmyIndia) and other Indian map listings
// (Order L71-ch-mappls).
//
// Sources: the Mappls places API when env MAPPLS_API_KEY is set, otherwise
// public Mappls place pages by search. OFF by default: without MAPPLS_API_KEY
// the adapter reports disabled with a clear reason (see statusText).
// Read order per page: search first, then plain page read, then the injected
// browser reader only when both are blocked (403/429/captcha/empty body).
//
// Web verification done 2026-10-13 (see docs/leadgen/REPORT_L71-ch-mappls.md):
//  - CONFIRMED via web search + fetch of about.mappls.com/api/search: the
//    Mappls Search API stack exists (Place Search, Autosuggest, Nearby,
//    Geocoding, Reverse Geocoding, Text Search, eLoc) with docs at
//    developer.mappls.com (incl. a Place Details API page).
//  - UNVERIFIED this run: the exact REST query-param contract of the places
//    search endpoint and the exact public mappls.com place-page URL shape /
//    HTML layout (no live page could be fetched from here). The API call below
//    is therefore defensive (any failure falls through to public pages) and
//    every parsed value is a verbatim copy with its source URL, never inferred.
//
// Rules: every field value is copied verbatim from page text, API JSON or the
// search snippet with its source URL; a value the source does not show stays
// missing (never invented). All fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const MAPPLS_CHANNEL_ID = "mappls"; // matches the L71 order id
export const MAPPLS_SITE = "mappls.com";
const MAX_TEXT = 20000;

// Atlas Search API family (per public MapmyIndia docs; exact param contract
// unverified this run, so the call is defensive and optional).
const MAPPLS_SEARCH_API = "https://atlas.mapmyindia.com/api/places/search/json";

export type MapplsFields = {
  name?: string;
  address?: string;
  category?: string;
  phone?: string;
  rating?: number;
  ratingCount?: number;
  lat?: number;
  lon?: number;
  mapplsAddress?: string;
  googleAddress?: string;
};

// ---- page/snippet parser: only exact matches become fields ------------------

const MAPPLS_URL_RE = /https?:\/\/(?:www\.)?mappls\.com\/[^\s"'<>]+/i;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
const INJECTION_NEVER_COPY = /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)/i;

function labelValue(clean: string, label: string): string | undefined {
  const line = clean.split(/\r?\n/).map((l) => l.trim())
    .find((l) => new RegExp(`^${label}\\s*[:\uFF1A]\\s*\\S`, "i").test(l));
  return line?.replace(new RegExp(`^${label}\\s*[:\uFF1A]\\s*`, "i"), "").trim() || undefined;
}

/** Parse a Mappls place page (or a search snippet block) into fields. Every
 *  value is a verbatim copy from the text; anything unmatched stays undefined. */
export function parseMapplsPage(text: string): MapplsFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const f: MapplsFields = {};

  f.name = labelValue(clean, "Name");
  if (!f.name) {
    const urlMatch = clean.match(MAPPLS_URL_RE);
    if (urlMatch) {
      try {
        const path = new URL(urlMatch[0]).pathname;
        const segs = path.split("/").filter(Boolean);
        const slug = segs[segs.length - 1] ?? "";
        const name = decodeURIComponent(slug).replace(/[-+_]+/g, " ").trim();
        if (name && name.length >= 3) f.name = name;
      } catch { /* keep missing */ }
    }
  }

  f.address = labelValue(clean, "Address");
  f.category = labelValue(clean, "Category");
  f.mapplsAddress = labelValue(clean, "Mappls address");
  f.googleAddress = labelValue(clean, "Google address");
  if (!f.address) f.address = f.mapplsAddress;

  const phoneLabel = labelValue(clean, "Phone");
  const phone = phoneLabel ?? flat.match(PHONE_RE)?.[0];
  if (phone) f.phone = phone.trim().replace(/[,;]$/, "");

  const ratingRaw = labelValue(clean, "Rating") ?? flat.match(/Rating\s*[:\uFF1A]?\s*([0-5](?:\.\d{1,2})?)/i)?.[1];
  if (ratingRaw) {
    const n = Number(String(ratingRaw).match(/[0-5](?:\.\d{1,2})?/)?.[0]);
    if (Number.isFinite(n) && n > 0 && n <= 5) f.rating = n;
  }
  const countRaw = labelValue(clean, "Reviews") ?? labelValue(clean, "Ratings")
    ?? flat.match(/([\d,]{1,12})\s+(?:Reviews|Ratings)\b/i)?.[1];
  if (countRaw) {
    const n = Number(String(countRaw).replace(/,/g, "").match(/[\d,]+/)?.[0]?.replace(/,/g, ""));
    if (Number.isFinite(n)) f.ratingCount = n;
  }

  const coordRaw = labelValue(clean, "Coordinates") ?? labelValue(clean, "LatLon")
    ?? flat.match(/(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/)?.[0];
  if (coordRaw) {
    const m = String(coordRaw).match(/(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
    if (m) {
      const lat = Number(m[1]);
      const lon = Number(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) { f.lat = lat; f.lon = lon; }
    }
  }
  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids over parsed fields + raw text. */
export function mapplsSignals(f: MapplsFields, text: string = ""): string[] {
  const out: string[] = [];
  const hay = String(text ?? "");
  const hasMappls = /mappls/i.test(hay) || f.mapplsAddress !== undefined;
  const hasGoogle = /google/i.test(hay) || f.googleAddress !== undefined;
  // Listed on Mappls but not on Google: Mappls evidence present, no Google
  // link or mention anywhere in the text.
  if (hasMappls && !hasGoogle && !/https?:\/\/[^\s"'<>,)]*google[^\s"'<>,)]*/i.test(hay)) {
    out.push("mappls-listed-no-google");
  }
  // Address mismatch across map platforms: both labelled addresses present
  // and textually different.
  if (f.mapplsAddress && f.googleAddress
    && f.mapplsAddress.trim().toLowerCase() !== f.googleAddress.trim().toLowerCase()) {
    out.push("address-mismatch-across-maps");
  }
  return out;
}

// ---- helpers ----------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. Lines with no mappls.com URL skip. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const m = line.match(MAPPLS_URL_RE);
    if (!m) continue;
    const url = m[0].replace(/[\s,.;]+$/, "");
    let name: string | undefined;
    try {
      const path = new URL(url).pathname;
      const segs = path.split("/").filter(Boolean);
      const slug = segs[segs.length - 1] ?? "";
      name = decodeURIComponent(slug).replace(/[-+_]+/g, " ").trim() || undefined;
    } catch { /* skip this line */ }
    if (!name) continue;
    leads.push({
      name,
      category,
      source: MAPPLS_CHANNEL_ID,
      sourceUrl: url,
      ...(line.match(PHONE_RE) ? { phone: line.match(PHONE_RE)![0].trim() } : {}),
    });
  }
  return leads;
}

/** Mappls places API search via the injected fetchFn (OFF unless the caller
 *  passes a fetchFn AND env MAPPLS_API_KEY is set). Defensive: any failure
 *  returns [] so discovery falls back to public pages. */
export async function mapplsApiSearch(
  query: string,
  fetchFn: typeof fetch,
  apiKey: string,
): Promise<{ name: string; address?: string; lat?: number; lon?: number; url: string }[]> {
  const url = `${MAPPLS_SEARCH_API}?query=${encodeURIComponent(query)}&access_token=${encodeURIComponent(apiKey)}`;
  const res = await fetchFn(url);
  if (!res.ok) return [];
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return [];
  }
  const list = (json as { suggestedLocations?: unknown })?.suggestedLocations;
  if (!Array.isArray(list)) return [];
  const out: { name: string; address?: string; lat?: number; lon?: number; url: string }[] = [];
  for (const item of list.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const name = typeof it.placeName === "string" ? it.placeName
      : typeof it.placeAddress === "string" ? it.placeAddress : undefined;
    if (!name) continue;
    const eLoc = typeof it.eLoc === "string" ? it.eLoc : undefined;
    out.push({
      name: String(name),
      ...(typeof it.placeAddress === "string" && it.placeAddress !== name ? { address: String(it.placeAddress) } : {}),
      ...(typeof it.latitude === "number" && typeof it.longitude === "number"
        ? { lat: it.latitude, lon: it.longitude } : {}),
      url: eLoc ? `https://www.mappls.com/place/${eLoc}` : "https://www.mappls.com/",
    });
  }
  return out;
}

function statusText(): { enabled: boolean; why?: string } {
  const key = String(process.env.MAPPLS_API_KEY ?? "").trim();
  if (key) return { enabled: true };
  return {
    enabled: false,
    why: "MAPPLS_API_KEY is not set, so the Mappls places API is off; "
      + "no readable public Mappls pages were verified in this run either, "
      + "so the mappls channel is disabled (set MAPPLS_API_KEY to enable)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const mappls: ChannelAdapter = {
  id: MAPPLS_CHANNEL_ID,
  name: "Mappls",
  tier: "B",
  categories: ["clinic", "dentist", "restaurant", "salon", "gym", "school-and-coaching",
    "real-estate", "retail", "repair-and-services", "travel-and-hotels", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    const query = `"${q.category}" ${loc}`.trim();
    // 1. Mappls places API when the key is set (injected fetchFn only).
    const apiKey = String(process.env.MAPPLS_API_KEY ?? "").trim();
    if (apiKey && deps.fetchFn) {
      try {
        const hits = await mapplsApiSearch(query, deps.fetchFn, apiKey);
        if (hits.length > 0) {
          return hits.slice(0, limit).map((h) => ({
            name: h.name,
            category: q.category,
            ...(h.address ? { address: h.address } : {}),
            ...(q.city ? { city: q.city } : {}),
            ...(typeof h.lat === "number" && typeof h.lon === "number" ? { lat: h.lat, lon: h.lon } : {}),
            source: MAPPLS_CHANNEL_ID,
            sourceUrl: h.url,
          }));
        }
      } catch { /* fall through to public pages */ }
    }
    // 2. Public Mappls place pages by search (search -> page -> browser).
    const read = await readWithFallback(deps, {
      searchQuery: `site:${MAPPLS_SITE} ${query}`,
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${MAPPLS_SITE} "${lead.name}" ${lead.city ?? ""}`.trim(),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: MAPPLS_CHANNEL_ID,
          url: lead.sourceUrl,
          fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
          via: "browser",
          fields: { needsHuman: "true" },
          signals: ["needs-human"],
          text: "",
          untrusted: true,
        };
      }
      throw err;
    }
    const text = sanitizeUntrusted(read.text);
    const fields: Record<string, string | number | undefined> = parseMapplsPage(text);
    const signals = mapplsSignals(fields as MapplsFields, text);
    return {
      channel: MAPPLS_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => mapplsSignals(parseMapplsPage(text), text),
};

registerChannel(mappls);
