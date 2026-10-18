// ChannelAdapter for OTA travel listings (Order L62-ch-travel): MakeMyTrip,
// Yatra and Booking.com India hotel/property pages, plus travel-agency listings
// found by search.
//
// Tier C channel: OFF by default. Enabled only by env LEADSCOUT_INDIA_TIER_C=1
// (matches india-sources.json, Order L41: makemytrip, yatra and booking-india
// are all tier C) OR the operator-approved browser-read mode on the operator's
// own logged-in browser (data/browser-allowlist.json lists the domain), gated by
// LEADSCOUT_BROWSER=1. LEADSCOUT_BROWSER=0 is a hard kill switch.
//
// Read order per page comes from registry.readWithFallback: search first, then a
// plain page read, then the browser reader ONLY when both are blocked
// (403, 429, captcha, empty body). The browser reader enforces its own
// per-platform hourly caps and its 2-6 s pause; this adapter never re-reads a
// blocked page and never bypasses needs-human.
//
// Live verification (2026-10-09, web search + plain fetch; see REPORT_L62):
//  - booking.com/robots.txt fetched. "User-agent: *" disallows /book.html,
//    /mybooking.html, /confirmation.html, /hotelfeaturedreviews/ and many
//    internal paths; /hotel/... property pages are NOT disallowed (Yandex is
//    explicitly allowed /*.en-gb.html). Booking.com ToS text was not fetched
//    (known to restrict automated access) -> conservative tier C stands.
//  - MakeMyTrip and Yatra robots.txt both timed out from this machine (outside
//    India / bot wall), matching india-sources.json "fetch timed out
//    unverified". UNVERIFIED -> tier C.
//  - Confirmed page structure from search excerpts + fetch: MakeMyTrip shows
//    "Rating 4.5 (1,996)", "Price starts at INR 19,500/Night", "Amenities of
//    <name>", "Reviews & Ratings ... 835 User Reviews and 2033 Ratings" and the
//    address line; Booking.com shows "Reviews of <name> 3 stars",
//    "Based on 2149 hotel reviews", a /10 review score and "Score breakdown"
//    (Cleanliness/Comfort/...), facilities and the address line. The exact
//    Yatra layout stays UNVERIFIED.
//
// Rules: every field value is copied verbatim from page text or the URL / search
// snippet with its source URL; a value the page does not show stays missing
// (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const TRAVEL_CHANNEL_ID = "travel";
export const TRAVEL_SITES = ["makemytrip.com", "yatra.com", "booking.com"] as const;
const MAX_TEXT = 20000;
/** "low rating" <= this on a /5 scale (only paired with a complaint does it fire). */
export const LOW_RATING_THRESHOLD = 2.5;

export type TravelFields = {
  name?: string;
  starCategory?: string;
  rating?: number;
  reviewCount?: number;
  priceBand?: string;
  amenities?: string;
  address?: string;
  bookingRoute?: string;
};

// ---- page/snippet parser: only exact matches become fields ------------------

const TRAVEL_URL_RE =
  /https?:\/\/(?:www\.)?(?:makemytrip\.com|makemytrip\.global|yatra\.com|booking\.com)\/[^\s"'<>]+/i;
const INJECTION_NEVER_COPY =
  /ignore\s+all\s+(?:the\s+)?previous|system\s+prompt|you\s+are\s+now|disregard\s+(?:all\s+)?(?:the\s+)?(?:above|previous|prior)/i;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
// OTA / aggregator / social hosts that are never the property's own website.
const AGGREGATOR_HOST_RE =
  /(?:^|\.)(?:makemytrip\.com|makemytrip\.global|yatra\.com|booking\.com|agoda\.com|goibibo\.com|trivago\.[a-z.]+|google\.com|googleapis\.com|facebook\.com|fb\.com|fbcdn\.net|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|justdial\.com|sulekha\.com|tripadvisor\.[a-z.]+|trip\.com|oyo\.com|whatsapp\.com|wa\.me)$/i;
// JustDial-style directory / login / non-business paths on an OTA host.
const NON_BUSINESS_PATH_RE =
  /\/(?:login|signin|signup|users?|account|settings|search|sitemap|static|help|support|about|privacy|terms|book\.html|mybooking\.html|confirmation\.html|hotelfeaturedreviews)\b/i;
const AGENCY_RE =
  /travel\s+(?:agency|agencies|agent)|tour\s+(?:operator|company|agency)|tour\s+operator|travel\s+operator/i;
const LOW_RESPONSE_RE =
  /(?:no|zero)\s+(?:response|replies|reply)\b|(?:owner|manager|property|hotel|host)s?\s+(?:does\s+not|doesn't|do\s+not|don't|never|rarely)\s+(?:respond|reply|repl(?:y|ies))|unanswered\s+(?:reviews?|questions?|messages?)|ignores?\s+(?:the\s+)?(?:reviews?|messages?|questions?)/i;
const MISMATCH_RE =
  /\bmismatch\b|(?:rates?|prices?|photos?|pictures?|images?)\b[^.\n]{0,60}\b(?:do(?:es)?n['o]?t|do\s+not|did\s+not|not)\s+match|(?:photos?|pictures?|images?|rates?|prices?)\b[^.\n]{0,40}\b(?:differ|different|misleading|stale|outdated|contradict)\b|\bmisrepresent/i;

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** URLs on hosts that are not OTA / aggregator / social: a property's own site. */
export function externalUrls(text: string): string[] {
  const urls = String(text ?? "").match(/https?:\/\/[^\s"'<>,)]+/gi) ?? [];
  return urls.filter((u) => {
    const h = hostOf(u);
    return h !== "" && !AGGREGATOR_HOST_RE.test(h);
  });
}

function hasOwnBookingEngine(text: string): boolean {
  return externalUrls(text).some((u) => /(?:book|reserv|enquir|contact|stay)/i.test(u))
    || /(?:direct\s+booking|book\s+direct|official\s+website|own\s+website)\s*[:：]?\s*https?:\/\//i.test(String(text ?? ""));
}

function nameFromTravelUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const host = hostOf(url);
  if (!/(?:makemytrip\.com|makemytrip\.global|yatra\.com|booking\.com)$/i.test(host)) return undefined;
  try {
    const u = new URL(url);
    let segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    if (/booking\.com$/i.test(host) && segs[0] === "hotel") segs = segs.slice(2);
    let slug = segs[segs.length - 1] ?? "";
    slug = slug.replace(/\.html?$/i, "");
    const lang = slug.match(/^(.*?)\.[a-z]{2}(?:-[a-z]{2})?$/i);
    if (lang) slug = lang[1];
    slug = slug.replace(/[-_]+/g, " ").replace(/\b(?:details?|hotels?|in|en|gb)\b/gi, " ").replace(/\s+/g, " ").trim();
    return slug || undefined;
  } catch {
    return undefined;
  }
}

/** Parse a MakeMyTrip / Yatra / Booking.com page (or a search-snippet block)
 *  into fields. Every value is a verbatim copy from the text or the URL;
 *  anything unmatched stays undefined (never inferred). */
export function parseTravelPage(text: string): TravelFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ").trim();
  const f: TravelFields = {};

  // name: explicit label, else the page-title head, else the OTA URL slug.
  const nameLine = lines.find((l) => /^(?:Property(?:\s+Name)?|Hotel(?:\s+Name)?|Name)\s*[:：]\s*\S/i.test(l));
  let name = nameLine?.replace(/^(?:Property(?:\s+Name)?|Hotel(?:\s+Name)?|Name)\s*[:：]\s*/i, "").trim();
  if (!name) {
    const title = lines[0] ?? "";
    if (title && !/^https?:/i.test(title) && /\s+[-|]\s+/.test(title)) {
      name = title.split(/\s+[-|]\s+/)[0].trim() || undefined;
    }
  }
  if (!name) name = nameFromTravelUrl(flat.match(TRAVEL_URL_RE)?.[0]);
  if (name) f.name = name;

  // star category: label, else "<N> star(s)" verbatim (not a decimal rating).
  const starLine = lines.find((l) => /^(?:Star(?:s)?|Star\s+Category|Star\s+Rating)\s*[:：]\s*\S/i.test(l));
  if (starLine) {
    f.starCategory = starLine.replace(/^(?:Star(?:s)?|Star\s+Category|Star\s+Rating)\s*[:：]\s*/i, "").trim() || undefined;
  } else {
    const m = flat.match(/(?<![\d.])([1-5])\s*-?\s*stars?\b/i);
    if (m) f.starCategory = m[0].replace(/\s+/g, " ").trim();
  }

  // rating: label, then the "Rating 4.5 (1,996)" run, then an n/5 or n/10 phrase.
  const ratingLine = lines.find((l) => /^Rating\s*[:：]\s*[\d.]/.test(l));
  if (ratingLine) {
    const r = num(ratingLine.replace(/^Rating\s*[:：]\s*/, "").match(/[\d.]+/)?.[0]);
    if (r !== undefined && r > 0) f.rating = r;
  }
  const ratingRun = flat.match(/Rating\s+([0-5](?:\.\d{1,2})?)\s*\(([\d,]+)\)/i);
  if (ratingRun) {
    if (f.rating === undefined) {
      const r = num(ratingRun[1]);
      if (r !== undefined && r > 0 && r <= 5) f.rating = r;
    }
    if (f.reviewCount === undefined) f.reviewCount = num(ratingRun[2]);
  }
  if (f.rating === undefined) {
    const m = flat.match(/\b([0-5](?:\.\d{1,2})?)\s*(?:\/\s*5|out\s+of\s+5)\b/i)
      ?? flat.match(/(?:guest\s+rating|review\s+score|scored\s+out\s+of\s+10|score)\D{0,20}\b(\d{1,2}(?:\.\d)?)\b/i);
    if (m) {
      const r = num(m[1]);
      if (r !== undefined && r > 0) f.rating = r;
    }
  }

  // review count: label, then "Based on N hotel reviews", then "N reviews".
  const rcLine = lines.find((l) => /^Review(?:\s+Count)?\s*[:：]\s*[\d,]/.test(l));
  if (rcLine) f.reviewCount = num(rcLine.replace(/^Review(?:\s+Count)?\s*[:：]\s*/, "").match(/[\d,]+/)?.[0]);
  if (f.reviewCount === undefined) {
    const m = flat.match(/Based\s+on\s+([\d,]{1,12})\s+(?:hotel\s+)?reviews?\b/i)
      ?? flat.match(/([\d,]{1,12})\s+(?:User\s+Reviews|hotel\s+reviews|guest\s+reviews|reviews?)\b/i);
    if (m) f.reviewCount = num(m[1]);
  }

  // price band: label, else a verbatim currency phrase.
  const pbLine = lines.find((l) => /^Price(?:\s+(?:Band|Range))?\s*[:：]\s*\S/i.test(l));
  if (pbLine) {
    f.priceBand = pbLine.replace(/^Price(?:\s+(?:Band|Range))?\s*[:：]\s*/i, "").trim() || undefined;
  } else {
    const m = flat.match(/(?:₹|INR|Rs\.?)\s*[\d,]+(?:\s*(?:\/|-)?\s*(?:night|day|per\s+night))?/i);
    if (m) f.priceBand = m[0].trim();
  }

  // amenities: label, else the MakeMyTrip "Amenities of <name> · ..." run.
  const amLine = lines.find((l) => /^(?:Amenities|Facilities|Popular\s+amenities)\s*[:：]\s*\S/i.test(l));
  if (amLine) {
    f.amenities = amLine.replace(/^(?:Amenities|Facilities|Popular\s+amenities)\s*[:：]\s*/i, "").trim() || undefined;
  } else {
    const m = flat.match(/Amenities\s+of\s+[^\n·•]{0,80}[·•]\s*([^\n]+?)(?:\s*[·•]\s*View\s+All\s+Amenities|$)/i);
    if (m) f.amenities = m[1].trim() || undefined;
  }

  // address: label, else a line with a digit and at least two commas.
  const addrLine = lines.find((l) => /^Address\s*[:：]\s*\S/i.test(l));
  if (addrLine) {
    f.address = addrLine.replace(/^Address\s*[:：]\s*/i, "").trim() || undefined;
  } else {
    const guess = lines.find((l) => !/^(?:Name|Property|Hotel|Amenities|Facilities|Reviews?|Rating|Star)\b/i.test(l)
      && !/^https?:/i.test(l) && /\d/.test(l) && (l.match(/,/g) ?? []).length >= 2);
    if (guess) f.address = guess;
  }

  // direct booking / contact route: label, else a property's own URL.
  const bookLine = lines.find((l) => /^(?:Direct\s+Booking|Booking(?:\s+Route)?|Book\s+Direct|Contact(?:\s+Route)?|Phone|Website)\s*[:：]\s*\S/i.test(l));
  if (bookLine) {
    f.bookingRoute = bookLine.replace(/^(?:Direct\s+Booking|Booking(?:\s+Route)?|Book\s+Direct|Contact(?:\s+Route)?|Phone|Website)\s*[:：]\s*/i, "").trim() || undefined;
  } else {
    const own = externalUrls(clean)[0];
    if (own) f.bookingRoute = own;
  }
  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids (channel-specific names over CONTRACT.md vocabulary):
 *  ota-dependence (no own booking engine on the property website),
 *  low-response-to-reviews, rate-photo-mismatch-across-platforms,
 *  agency-no-website-or-facebook-only. */
export function travelSignals(f: TravelFields, text: string = ""): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  if (/makemytrip|yatra|booking\.com|\bOTA\b/i.test(t) && !hasOwnBookingEngine(t)) {
    out.push("ota-dependence");
  }
  if (LOW_RESPONSE_RE.test(t)) out.push("low-response-to-reviews");
  if (MISMATCH_RE.test(t)) out.push("rate-photo-mismatch-across-platforms");
  if (AGENCY_RE.test(t) && externalUrls(t).length === 0) {
    out.push("agency-no-website-or-facebook-only");
  }
  void f; // signals are text-only; the field object is accepted for symmetry
  return [...new Set(out)];
}

// ---- discovery ---------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. A "Name: <business>" line names the next
 *  listing URL (verbatim); otherwise the name comes from the URL slug. Lines with
 *  no usable URL (or a login/search path) skip. Duplicate URLs are dropped. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  const seen = new Set<string>();
  let pendingName: string | undefined;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const line = rawLine.trim();
    const nameLabel = line.match(/^Name\s*[:：]\s*(.+)$/i);
    if (nameLabel) {
      pendingName = nameLabel[1].trim();
      continue;
    }
    const urls = line.match(/https?:\/\/[^\s"'<>,)]+/gi) ?? [];
    for (const u of urls) {
      if (leads.length >= limit) break;
      const url = u.replace(/[\s,.;]+$/, "");
      if (seen.has(url)) continue;
      const host = hostOf(url);
      const isOta = /(?:makemytrip\.com|makemytrip\.global|yatra\.com|booking\.com)$/i.test(host);
      const isAgency = AGENCY_RE.test(line);
      if (!isOta && !isAgency) continue;
      if (NON_BUSINESS_PATH_RE.test(url)) continue;
      const name = pendingName ?? nameFromTravelUrl(url);
      pendingName = undefined;
      if (!name) continue;
      seen.add(url);
      leads.push({
        name,
        category,
        source: TRAVEL_CHANNEL_ID,
        sourceUrl: url,
        ...(isAgency && !isOta ? { website: url } : {}),
        ...(line.match(PHONE_RE) ? { phone: line.match(PHONE_RE)![0].trim() } : {}),
      });
    }
  }
  return leads;
}

// ---- status and env gate -----------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (tierCEnabled()) return { enabled: true };
  if (process.env.LEADSCOUT_BROWSER === "1") {
    return { enabled: true }; // operator-approved read mode on the operator's own browser
  }
  return {
    enabled: false,
    why: "tier C (MakeMyTrip and Yatra robots.txt fetches timed out; Booking.com robots.txt fetched "
      + "2026-10-09 disallows /book.html, /mybooking.html, /confirmation.html and /hotelfeaturedreviews/ "
      + "for User-agent:*; Booking.com ToS restrict automated access and were not fetched; "
      + "india-sources.json (L41) lists makemytrip, yatra and booking-india as tier C): "
      + `LEADSCOUT_INDIA_TIER_C is "${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off `
      + "(absent and =0 both mean off); the operator-approved browser-read fallback is also off "
      + "(LEADSCOUT_BROWSER is not 1)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const travel: ChannelAdapter = {
  id: TRAVEL_CHANNEL_ID,
  name: "MakeMyTrip / Yatra / Booking.com India",
  tier: "C", // india-sources.json (L41): makemytrip, yatra, booking-india are tier C
  categories: ["travel-and-hotels", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    let text = "";
    // Read order per site: search first (cheapest). A site that is blocked or
    // unavailable is skipped; the others still contribute.
    for (const site of TRAVEL_SITES) {
      try {
        const read = await readWithFallback(deps, {
          searchQuery: `site:${site} "${q.category}" ${loc}`.trim().replace(/\s+/g, " "),
        });
        text += `\n${sanitizeUntrusted(read.text)}`;
      } catch {
        /* one site unavailable; continue with the rest */
      }
    }
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${hostOf(lead.sourceUrl) || "makemytrip.com"} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: TRAVEL_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = { ...parseTravelPage(text) };
    const signals = travelSignals(fields as TravelFields, text);
    return {
      channel: TRAVEL_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => travelSignals(parseTravelPage(text), text),
};

registerChannel(travel);
