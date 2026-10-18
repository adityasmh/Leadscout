// ChannelAdapter for Google Maps / Google Business Profile (Order L44-ch-google).
//
// Two paths, OFF by default:
//  1. Official Places API via ../sources-extra.ts discoverPlaces (reuse only),
//     enabled only by env GOOGLE_PLACES_API_KEY.
//  2. Public Maps search results + place pages through the injected
//     search/readPage/browser readers. The browser reader is only used by the
//     registry's readWithFallback AFTER search and page read return blocked
//     results (403/429/captcha/empty body); a login wall there surfaces as
//     needs-human. The reader's own caps/pauses/allowlist are respected by
//     never retrying a blocked page and never opening more than one browser
//     read per call.
//
// Rules: every value is copied from fetched text or a URL in a snippet with its
// source URL; a field the page does not show stays missing (never inferred).
// All fetched text is neutralised (injection lines dropped) via reach.ts
// sanitizeUntrusted and stored on evidence marked untrusted: true.
import { discoverPlaces } from "../../src/sources-extra.js";
import { sanitizeUntrusted } from "../../src/reach.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const GOOGLE_CHANNEL_ID = "google-maps-places"; // matches india-sources.json registry data (L41)
const MAX_TEXT = 20000;
// "many"/"high"-thresholds for the signals; documented in the report.
export const MANY_REVIEWS_THRESHOLD = 10;
export const HIGH_REVIEWS_THRESHOLD = 50;
export const FEW_PHOTOS_THRESHOLD = 5;

export type GoogleFields = {
  name?: string; category?: string; address?: string; area?: string;
  phone?: string; website?: string; rating?: number; reviewCount?: number;
  hours?: string; priceLevel?: string; photoCount?: number;
  ownerReplies?: string; claimed?: string;
};

// ---- page/snippet parser: only exact matches become fields ------------------

const PLACE_URL_RE = /https?:\/\/[^\s"'<>]*google\.[a-z.]+\/maps\/place\/[^\s"'<>]+/i;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
const INJECTION_NEVER_COPY = /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)/i;

/** Parse a Maps place page (or a search snippet block) into fields. Every value
 *  is a verbatim copy from the text; anything unmatched stays undefined. */
export function parseMapsPage(text: string): GoogleFields {
  const t = String(text ?? "");
  const clean = t.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: GoogleFields = {};

  const labelled = (label: string): string | undefined => {
    const re = new RegExp(`^${label}\\s*[:：]\\s*(.+)$`, "i");
    const hit = lines.find((l) => re.test(l));
    const m = hit?.match(re);
    const v = m?.[1]?.trim();
    return v || undefined;
  };

  // name: from a /maps/place/ URL slug (verbatim from the URL), else the
  // "Name:" label when the page text labels it.
  const urlMatch = clean.match(PLACE_URL_RE);
  if (urlMatch) {
    try {
      const slug = urlMatch[0].split("/maps/place/")[1].replace(/[?&#].*$/, "");
      const decoded = decodeURIComponent(slug).replace(/\+/g, " ").trim();
      if (decoded) f.name = decoded;
    } catch { /* keep missing */ }
  }
  f.name = f.name ?? labelled("Name");

  // category + area: "Dentist in T. Nagar, Chennai" style line.
  const catLine = lines.find((l) => /^[^:\n]{2,60}\s+in\s+[^:\n]{2,80}$/.test(l) && !/https?:/.test(l));
  const catMatch = catLine?.match(/^(.+?)\s+in\s+(.+)$/);
  if (catMatch) { f.category = catMatch[1].trim(); f.area = catMatch[2].trim(); }
  f.category = f.category ?? labelled("Category");

  // address.
  f.address = labelled("Address");
  // phone: labelled first, else a phone-shaped span.
  const phoneLabel = labelled("Phone");
  const phoneHit = phoneLabel ?? clean.match(PHONE_RE)?.[0];
  if (phoneHit) f.phone = phoneHit.trim().replace(/[,;]$/, "");

  // website: a "Website:" label, else an http(s) URL that is not a google one.
  const siteLabel = labelled("Website");
  if (siteLabel) f.website = siteLabel.split(/\s/)[0];
  else {
    const siteHit = clean.match(/https?:\/\/(?!.*?google\.)[^\s"'<>)]+/i);
    if (siteHit) f.website = siteHit[0];
  }

  // rating + review count: "<4.x> ... <N> reviews" spans. [ \t] keeps the
  // number on the same line ("05\nPhotographer" must not read as "05 photos").
  const reviewMatch = clean.match(/([\d,]{1,12})[ \t]+reviews?(?![a-zA-Z])/i);
  if (reviewMatch) {
    const n = Number(reviewMatch[1].replace(/,/g, ""));
    if (Number.isFinite(n)) f.reviewCount = n;
  }
  if (!reviewMatch) {
    // "No reviews" is an explicit count of 0 (verbatim from the text).
    if (/^No reviews\b/im.test(clean)) f.reviewCount = 0;
  }
  const ratingRe = /\b([0-5][.,]\d{1,2})\b/;
  const ratingLabel = clean.match(new RegExp(`(?:rating|rating:\\s*)[^\\n]{0,40}?${ratingRe.source}`, "i"));
  const ratingRaw = (ratingLabel?.[1] ?? "")
    || (f.reviewCount !== undefined
      ? lines.find((l) => ratingRe.test(l) && l.length <= 24)?.match(ratingRe)?.[1]
      : undefined);
  if (ratingRaw) {
    const n = Number(String(ratingRaw).replace(",", "."));
    if (Number.isFinite(n) && n > 0 && n <= 5) f.rating = n;
  }

  // hours: an "Open ⋅ Closes 9 PM"-style line or an Hours: label.
  const hoursLabel = labelled("Hours");
  const hoursLine = clean.match(/(?:Open\s*⋅\s*(?:Closes|closes)[^\n]{0,60}|Closed\s*⋅\s*Opens[^\n]{0,60}|Open 24 hours)/i);
  f.hours = hoursLabel ?? hoursLine?.[0]?.trim();

  // price level: "Price range: ₹₹" or a ₹/$ run of 1-4 glyphs.
  const priceLabel = labelled("Price range");
  const priceRun = clean.match(/[₹$]{1,4}(?=\s*(?:\n|$|[·,]))/);
  f.priceLevel = priceLabel ?? priceRun?.[0];

  // photo count.
  const photoMatch = clean.match(/([\d,]{1,12})[ \t]+photos?(?![a-zA-Z])/i);
  if (photoMatch) {
    const n = Number(photoMatch[1].replace(/,/g, ""));
    if (Number.isFinite(n)) f.photoCount = n;
  }

  // owner replies: an owner response marker, else "no" when recent review
  // text is visible and no owner response appears anywhere in it.
  const hasOwnerReply = /(?:Response|Reply) from the owner|Owner(?:[’']?s)? (?:response|reply)/i.test(clean);
  if (hasOwnerReply) f.ownerReplies = "yes";
  else if (/(?:\d+|a|an|few|one|two)\s+(?:day|week|month|year)s?\s+ago/i.test(clean)) f.ownerReplies = "no";
  // claimed: only from explicit page text.
  if (/Claim this business/i.test(clean)) f.claimed = "no";
  else if (/This business is claimed/i.test(clean)) f.claimed = "yes";
  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids over parsed fields (CONTRACT.md SIGNALS plus Google ids). */
export function googleSignals(f: GoogleFields): string[] {
  const out: string[] = [];
  const hasProfile = f.address !== undefined || f.phone !== undefined || f.rating !== undefined || f.reviewCount !== undefined;
  if (!f.website) out.push("no-website");
  if (typeof f.rating === "number" && f.rating < 4.0
    && typeof f.reviewCount === "number" && f.reviewCount >= MANY_REVIEWS_THRESHOLD) {
    out.push("low-rating-many-reviews");
  }
  if (f.ownerReplies === "no") out.push("owner-never-replies");
  if (!f.hours && hasProfile) out.push("hours-missing");
  if (typeof f.photoCount === "number" && f.photoCount < FEW_PHOTOS_THRESHOLD && f.photoCount >= 0) {
    out.push("few-photos");
  }
  if (typeof f.reviewCount === "number" && f.reviewCount >= HIGH_REVIEWS_THRESHOLD && !f.website) {
    out.push("no-website-high-reviews");
  }
  return out;
}

// ---- helpers ----------------------------------------------------------------

function envOn(name: string, depsEnv?: Record<string, string | undefined>): boolean {
  const v = (depsEnv ?? process.env)[name];
  return typeof v === "string" && v.trim() !== "";
}

/** Search-snippet lines -> RawLead[]. Name comes from the /maps/place/ URL
 *  slug in the snippet; lines with no Maps URL are skipped. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const m = line.match(PLACE_URL_RE);
    if (!m) continue;
    const url = m[0];
    let name = "";
    try {
      name = decodeURIComponent(url.split("/maps/place/")[1].replace(/[?&#].*$/, "")).replace(/\+/g, " ").trim();
    } catch { name = ""; }
    if (!name) continue;
    leads.push({
      name,
      category,
      source: GOOGLE_CHANNEL_ID,
      sourceUrl: url,
      ...(line.match(PHONE_RE) ? { phone: line.match(PHONE_RE)![0].trim() } : {}),
    });
  }
  return leads;
}

function statusText(): { enabled: boolean; why?: string } {
  const apiKey = envOn("GOOGLE_PLACES_API_KEY");
  const browser = process.env.LEADSCOUT_BROWSER === "1";
  if (apiKey || browser) return { enabled: true };
  return {
    enabled: false,
    why: "both Google paths are off: the official Places API path needs env GOOGLE_PLACES_API_KEY and "
      + "the public-page fallback needs the browser reader (LEADSCOUT_BROWSER=1); neither is set",
  };
}

// ---- the adapter -------------------------------------------------------------

export const googleMaps: ChannelAdapter = {
  id: GOOGLE_CHANNEL_ID,
  name: "Google Maps / Business Profile",
  tier: "C", // india-sources.json (L41) lists google channels as Tier C; official-API path is the safe one
  categories: ["clinic", "dentist", "salon", "gym", "school-and-coaching", "real-estate",
    "travel-and-hotels", "retail", "manufacturing", "repair-and-services", "restaurant", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    // Path 1: official Places API (reuse sources-extra.discoverPlaces; the key
    // is read there from process.env). Returns enabled:false without a key.
    try {
      const places = await discoverPlaces(
        { category: q.category, city: q.city, limit },
        { fetchFn: deps.fetchFn },
      );
      if (places.enabled && places.leads.length > 0) return places.leads.slice(0, limit);
    } catch {
      /* fall through to the public path */
    }
    // Path 2: public Maps search results (search first; page read and browser
    // escalation are handled by readWithFallback only on blocked results).
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    const read = await readWithFallback(deps, {
      searchQuery: `site:google.com/maps/place "${q.category}" ${loc}`.trim(),
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:google.com/maps/place "${lead.name}" ${lead.city ?? ""}`.trim(),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: GOOGLE_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = parseMapsPage(text);
    const signals = googleSignals(fields as GoogleFields);
    return {
      channel: GOOGLE_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => googleSignals(parseMapsPage(text)),
};

registerChannel(googleMaps);
