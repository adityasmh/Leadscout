// ChannelAdapter for event organiser and ticketing platforms
// (Order WE7-ch-event-organisers). Tier B.
//
// Harvests prospect businesses from the public organiser / event pages of
// allevents.in, insider.in, in.bookmyshow.com and eventbrite.in. An event
// company that lists many events (weddings, concerts, corporate events,
// festivals, exhibitions) but shows no promo video is a strong video-services
// prospect ("portfolio-no-video").
//
// OFF by default; the operator switches it on with
// CHANNEL_CH_EVENT_ORGANISERS=1. The adapter never talks to the network
// directly: it uses the injected `deps.search`, `deps.readPage` (src/reach.js)
// and `deps.fetchFn` (robots.txt only) so checks run offline, and it pages
// through results politely through `deps.limiter`.
//
// Real structures (verify + report in REPORT_WE7-ch-event-organisers.md):
//  - allevents.in: public event pages and organiser pages; each event card /
//    organiser profile names the organising business, its city and its events.
//  - insider.in: public event pages; the page names the "Organiser" and its
//    events and often a website + socials.
//  - in.bookmyshow.com: public event pages ("Events") naming the organiser.
//  - eventbrite.in: public organiser pages /o/<organiser>-<id> and event pages
//    naming the organiser, with its other events.
//  Where a page markup element could not be fetched from this machine the
//  parser copies only the normalised label form the sibling adapters use
//  ("Name:", "City:", "Events:", ...); anything the page does not show stays
//  missing and is never inferred.
//
// Rules: public pages only; robots.txt is honoured through deps.fetchFn when
// supplied; every fetched text is neutralised via reach.sanitizeUntrusted and
// evidence is marked untrusted: true; only BUSINESS contact data is stored
// (never a private individual).
import { sanitizeUntrusted } from "../../src/reach.js";
import type { ReachResult } from "../../src/reach.js";
import { reachBlocked, BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const EVENT_ORGANISERS_CHANNEL_ID = "ch-event-organisers";
export const MAX_TEXT = 20000;

// The four public platforms this adapter reads.
export const EVENT_ORGANISERS_SITES = ["allevents.in", "insider.in", "in.bookmyshow.com", "eventbrite.in"] as const;

// Canonical category ids this source really lists (Order WE7).
export const EVENT_ORGANISERS_CATEGORIES: string[] = [
  "wedding-planner", "event-company", "banquet-hall", "wedding-decorator",
  "caterer", "bridal-wear", "makeup-artist", "photographer", "dj-entertainer",
  "florist", "invitation-designer", "destination-wedding-agent", "jewellery-store",
];

// Polite pause between listing reads (the injected limiter sleep is a no-op in
// checks; 2-6 s is the browser-reader contract's default pause).
const PAGE_PAUSE_MS = 2500;

// RawLead carries no eventCount field, so the org's event count and event
// types ride on it as extra optional fields (documented in the report). The
// value is still a RawLead, so registry typing is unchanged.
export type EventOrganiserLead = RawLead & { eventCount?: number; eventTypes?: string };

export type EventListingEntry = {
  name: string; category: string; area?: string; city?: string;
  phone?: string; website?: string; eventCount?: number; eventTypes?: string;
};

export type EventProfileFields = {
  name?: string; category?: string; city?: string;
  portfolioPhotoCount?: number; video?: string; videoUrl?: string;
  reviewCount?: number; rating?: number; priceBand?: string;
  services?: string; yearsInBusiness?: number; eventCount?: number;
  website?: string; instagram?: string; facebook?: string; youtube?: string; whatsapp?: string;
};

// ---- category guess: text -> canonical id (never invented) -----------------

const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/\bflorist\b|\bflower boutique\b|\bflower shop\b/i, "florist"],
  [/\bmakeup|make-up|hair stylist|beauty artist|bridal makeup/i, "makeup-artist"],
  [/\bphotograph|photography|portrait|videograph/i, "photographer"],
  [/\bcater|food service|cuisine|bhojan/i, "caterer"],
  [/\binvitation|wedding card|stationery|save the date/i, "invitation-designer"],
  [/\bdestination wedding|honeymoon|travel agent|tour operator/i, "destination-wedding-agent"],
  [/\bjewel|jewellery|jewelry|gold|diamond|polki|kundan/i, "jewellery-store"],
  [/\bdecor|floral design|stage design|mandap|lighting design/i, "wedding-decorator"],
  [/\bbridal wear|bridal boutique|lehenga|sherwani|couture|designer wear|trousseau/i, "bridal-wear"],
  [/\bdj\b|entertainer|entertainment|live band|\bmusic\b|\banchor\b|choreograph/i, "dj-entertainer"],
  [/\bbanquet|venue\b|\bhall\b|resort|lawn|marriage garden/i, "banquet-hall"],
  [/\bevent company|event management|event planner|event agency|event organiser|organiser|organizer/i, "event-company"],
  [/\bwedding planner|wedding planning|\bplanner\b/i, "wedding-planner"],
];

/** Map free text (name + category label + services) to a canonical id. */
export function guessCategory(text: string): string | undefined {
  const t = String(text ?? "");
  for (const [re, id] of CATEGORY_HINTS) if (re.test(t)) return id;
  return undefined;
}

const LABEL_RE = /^([A-Za-z][A-Za-z /&-]{0,24})\s*[:：]\s*(.+)$/;
const URL_RE = /https?:\/\/[^\s"'<>)]+/gi;
const INJECTION_NEVER_COPY = /\bignore (all )?(the )?(previous|prior)\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b/i;

const NAME_KEYS = /^(?:name|organiser|organizer|company|business|vendor|host|brand)$/i;
const CITY_KEYS = /^(?:city|location)$/i;
const AREA_KEYS = /^(?:area|locality|address|neighborhood|neighbourhood)$/i;
const PHONE_KEYS = /^(?:phone|mobile|contact|contact number|telephone)$/i;
const WEBSITE_KEYS = /^(?:website|site|web|url)$/i;
const COUNT_KEYS = /^(?:events?|event count|total events|upcoming events|past events|events listed)$/i;
const TYPES_KEYS = /^(?:event types?|events types?|types?|categories)$/i;

function cleanUrl(u: string): string {
  return u.replace(/[.,;)\]]+$/, "");
}

function hostOf(u: string | undefined): string {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(String(raw).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function isNameLike(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 90) return false;
  if (URL_RE.test(t)) return false;
  if (/[:：]/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length < 2) return false;
  if (/^(?:about|contact|events?|home|login|register|copyright|all rights)\b/i.test(t)) return false;
  return /[A-Za-z]{2}/.test(t);
}

// ---- robots.txt (honoured only when a fetchFn is injected) ------------------

/** True when the site's robots.txt (fetched through the injected fetchFn)
 *  forbids the given URL's path for the generic user agent. No fetchFn, a
 *  fetch error or a non-OK answer means "cannot verify" -> not blocked (the
 *  injected readPage is assumed to be the compliant transport). */
export async function robotsDisallows(url: string, fetchFn: typeof fetch | undefined): Promise<boolean> {
  if (!fetchFn) return false;
  let origin: string;
  let path: string;
  try {
    const u = new URL(String(url));
    origin = u.origin;
    path = u.pathname || "/";
  } catch {
    return false;
  }
  let body = "";
  try {
    const res = await fetchFn(`${origin}/robots.txt`);
    if (!res || !res.ok) return false;
    body = await res.text();
  } catch {
    return false;
  }
  const disallows: string[] = [];
  let applies = false;
  for (const rawLine of String(body).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") applies = value === "*";
    else if (field === "disallow" && applies && value) disallows.push(value);
  }
  return disallows.some((d) => path.startsWith(d));
}

// ---- listing parser --------------------------------------------------------

function applyEntryField(cur: EventListingEntry, key: string, val: string): void {
  if (CITY_KEYS.test(key)) { cur.city = val; return; }
  if (AREA_KEYS.test(key)) { cur.area = val; return; }
  if (PHONE_KEYS.test(key)) { cur.phone = val; return; }
  if (WEBSITE_KEYS.test(key)) { cur.website = val; return; }
  if (COUNT_KEYS.test(key)) { const n = num(val); if (n !== undefined) cur.eventCount = n; return; }
  if (TYPES_KEYS.test(key)) { cur.eventTypes = val; return; }
  if (/^category$/i.test(key)) {
    const v = val.trim().toLowerCase();
    cur.category = EVENT_ORGANISERS_CATEGORIES.includes(v) ? v : (guessCategory(val) ?? guessCategory(cur.name) ?? cur.category);
  }
}

/** Parse one listing page into organiser entries. Only labelled values are
 *  copied; unmatched lines are ignored (never inferred). */
export function parseListingPage(text: string, url: string, defaultCategory: string): EventListingEntry[] {
  const clean = String(text ?? "").split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const out: EventListingEntry[] = [];
  let cur: EventListingEntry | null = null;

  const flush = (): void => {
    if (cur && cur.name) {
      const finalCategory = cur.category || guessCategory(`${cur.name} ${cur.eventTypes ?? ""}`) || defaultCategory;
      out.push({ ...cur, category: finalCategory });
    }
    cur = null;
  };

  for (const rawLine of clean.split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t) continue;
    const kv = t.match(LABEL_RE);
    if (kv) {
      const key = kv[1].trim().toLowerCase();
      const val = kv[2].trim();
      if (NAME_KEYS.test(key)) { flush(); cur = { name: val, category: "" }; continue; }
      if (cur) applyEntryField(cur, key, val);
      continue;
    }
    if (isNameLike(t)) { flush(); cur = { name: t, category: "" }; continue; }
  }
  flush();
  return out;
}

// ---- profile parser --------------------------------------------------------

function findUrl(text: string, test: RegExp): string | undefined {
  const urls = text.match(URL_RE) ?? [];
  for (const u of urls) {
    const c = cleanUrl(u);
    if (test.test(c)) return c;
  }
  return undefined;
}

/** Parse an organiser profile / event page into evidence fields. Verbatim
 *  copies only; anything the page does not show stays missing. */
export function parseEventProfile(text: string): EventProfileFields {
  const clean = String(text ?? "").split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: EventProfileFields = {};

  const label = (name: RegExp): string | undefined => {
    const m = lines.map((l) => l.match(LABEL_RE)).find((x) => x !== null && name.test(x[1].trim()));
    return m ? m[2].trim() : undefined;
  };

  f.name = label(NAME_KEYS);
  if (!f.name) {
    const titleLine = lines.find((l) => /\b(?:Pvt|LLP|Ltd|LLC|Events|Entertainment|Productions|Live|Experiences|Organisers?|Organizers?|Weddings)\b/.test(l) && !LABEL_RE.test(l));
    if (titleLine && isNameLike(titleLine)) f.name = titleLine;
  }
  f.city = label(CITY_KEYS);
  const catLabel = label(/^category$/i);
  const catLower = String(catLabel ?? "").trim().toLowerCase();
  f.category = EVENT_ORGANISERS_CATEGORIES.includes(catLower)
    ? catLower
    : (catLabel ? (guessCategory(catLabel) ?? catLabel) : guessCategory(`${f.name ?? ""} ${label(/^services$/i) ?? ""}`));

  // portfolio photos
  const photoLabel = label(/^(?:portfolio\s+photos?|photos?|gallery|portfolio)$/i);
  const photoBare = flat.match(/([\d,]{1,6})\s+photos?\b/i)?.[1];
  const photoCount = num(photoLabel ?? photoBare);
  if (photoCount !== undefined) f.portfolioPhotoCount = photoCount;

  // video presence (a video/film/reel or youtube/vimeo link)
  const videoUrl = findUrl(clean, /(youtube\.com|youtu\.be|vimeo\.com)/i);
  const hasVideoText = /\b(?:videos?|films?|reels?|showreel|watch (?:our|the) (?:film|video))\b/i.test(clean);
  if (videoUrl || hasVideoText) {
    f.video = "yes";
    if (videoUrl) f.videoUrl = videoUrl;
  }

  // reviews + rating
  const reviewLabel = label(/^(?:reviews?|ratings?|review count)$/i);
  const reviewBare = flat.match(/([\d,]{1,9})\s+(?:reviews?|ratings?)\b/i)?.[1];
  const reviewCount = num(reviewLabel ?? reviewBare);
  if (reviewCount !== undefined) f.reviewCount = reviewCount;
  const rating = num(flat.match(/\b([0-5](?:\.\d{1,2})?)\s*\/\s*5\b/)?.[1] ?? label(/^rating$/i));
  if (rating !== undefined && rating > 0 && rating <= 5) f.rating = rating;

  // price / starting price
  const price = label(/^(?:starting price|price|price band|starts? at|starting at)$/i)
    ?? flat.match(/(?:starting\s+(?:price|at|from)|price\s+band|starts?\s+at)\s*[:：]?\s*([^\n|]{1,40})/i)?.[1]?.trim();
  if (price) f.priceBand = price;

  // events listed, services, years
  const evLabel = label(COUNT_KEYS);
  const evBare = flat.match(/([\d,]{1,6})\s+events?\b/i)?.[1];
  const eventCount = num(evLabel ?? evBare);
  if (eventCount !== undefined) f.eventCount = eventCount;
  f.services = label(/^services(?:\s+offered)?$/i);
  const years = num(label(/^years?\s+in\s+business$/i) ?? flat.match(/\b(\d{1,3})\+?\s+years?\s+in\s+business\b/i)?.[1]);
  if (years !== undefined) f.yearsInBusiness = years;

  // links: website + socials
  f.website = label(WEBSITE_KEYS) ?? findUrl(clean, /^(?!.*(instagram|facebook|fb\.com|youtube|youtu\.be|vimeo|wa\.me|whatsapp))/i);
  f.instagram = label(/^instagram$/i) ?? findUrl(clean, /instagram\.com/i);
  f.facebook = label(/^facebook$/i) ?? findUrl(clean, /facebook\.com|fb\.com/i);
  f.youtube = label(/^youtube$/i) ?? findUrl(clean, /youtube\.com|youtu\.be/i);
  f.whatsapp = label(/^whatsapp$/i) ?? findUrl(clean, /wa\.me|whatsapp\.com/i);

  return f;
}

// ---- signals ---------------------------------------------------------------

/** "posted N days ago" style recency, in days (video/reel/post recency). */
function socialAgeDays(text: string): number | undefined {
  const t = String(text ?? "");
  if (/\b(?:posted|updated)\s+(?:today|just now)\b|\bposted\s+yesterday\b/i.test(t)) return 0;
  const d = t.match(/(?:posted|published|reel|video|film|post|updated|latest)[^.\n]{0,30}?(\d{1,3})\s*days?\s*ago/i);
  if (d) return Number(d[1]);
  const w = t.match(/(?:posted|published|reel|video|film|post|updated|latest)[^.\n]{0,30}?(\d{1,2})\s*weeks?\s*ago/i);
  if (w) return Number(w[1]) * 7;
  const mo = t.match(/(?:posted|published|reel|video|film|post|updated|latest)[^.\n]{0,30}?(\d{1,2})\s*months?\s*ago/i);
  if (mo) return Number(mo[1]) * 30;
  return undefined;
}

function maxReviewCount(text: string): number | undefined {
  const t = String(text ?? "");
  const nums: number[] = [];
  const re = /([\d,]{1,9})\s+(?:reviews?|ratings?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const n = num(m[1]);
    if (n !== undefined) nums.push(n);
  }
  if (!nums.length) return undefined;
  return Math.max(...nums);
}

/** Shared wedding/event signal ids (Order WE7, weighted by WE1). Fires only on
 *  matching text; positive and negative fixtures both covered in the check. */
export function eventOrganisersSignals(text: string): string[] {
  const t = String(text ?? "");
  const out: string[] = [];

  const hasVideo = /\b(?:videos?|films?|reels?|showreel|youtube|vimeo)\b/i.test(t)
    || /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com)\/\S+/i.test(t);
  const hasPhotos = /\b(?:photos?|photographs?|gallery|galleries|portfolio|images?|albums?)\b/i.test(t);
  if (hasPhotos && !hasVideo) out.push("portfolio-no-video");
  if (hasVideo) out.push("has-video-portfolio");

  const age = socialAgeDays(t);
  if (age !== undefined && age <= 30) out.push("social-video-active");
  if (age !== undefined && age > 90) out.push("social-inactive");
  if (/\bno (?:posts?|activity|updates?)[^.\n]{0,30}(?:last|past)\s*(?:9\d|[1-9]\d{2})\s*days/i.test(t)) out.push("social-inactive");

  const rc = maxReviewCount(t);
  if (rc !== undefined && rc >= 50) out.push("high-review-count");

  if (/\b(?:featured|verified[-\s]?plus|premium|paid tier|sponsored|elite|gold partner|platinum)\b/i.test(t)) {
    out.push("premium-listing");
  }

  if (/\bmulti[-\s]?city\b|\bmultiple cities\b|\bcities across\b|\bserves [^.\n]{0,60},|\bavailable in [^.\n]{0,60},/i.test(t)) {
    out.push("multi-city");
  }

  if (/(?:starting\s+(?:price|at|from)|price\s+band|starts?\s+at|₹\s?\d|rs\.?\s?\d|inr\s?\d|\bper plate\b|\bper day\b)/i.test(t)) {
    out.push("price-band-known");
  }
  return [...new Set(out)];
}

// ---- search + discovery ----------------------------------------------------

function categoryLabel(category: string): string {
  return String(category ?? "").replace(/-/g, " ").trim();
}

/** One search phrase per platform for this source. */
export function buildQueries(category: string, city: string, area: string): string[] {
  const loc = [area, city].filter(Boolean).join(" ").trim();
  const cat = categoryLabel(category);
  return [
    `site:allevents.in "${cat}" ${loc}`.replace(/\s+/g, " ").trim(),
    `site:insider.in "${cat}" ${loc}`.replace(/\s+/g, " ").trim(),
    `site:in.bookmyshow.com events "${cat}" ${loc}`.replace(/\s+/g, " ").trim(),
    `site:eventbrite.in organiser "${cat}" ${loc}`.replace(/\s+/g, " ").trim(),
  ];
}

export function isPlatformUrl(url: string): boolean {
  const h = hostOf(url);
  return EVENT_ORGANISERS_SITES.some((s) => h === s || h.endsWith(`.${s}`));
}

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const c = cleanUrl(u);
    if (!/^https?:\/\//i.test(c)) continue;
    if (!isPlatformUrl(c)) continue;
    let key: string;
    try {
      const parsed = new URL(c);
      key = parsed.hostname.replace(/^www\./, "").toLowerCase() + parsed.pathname.replace(/\/+$/, "");
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function urlsFromResult(text: string, results: unknown): string[] {
  const found: string[] = [];
  const re = new RegExp(URL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text ?? ""))) !== null) found.push(m[0]);
  if (Array.isArray(results)) {
    for (const r of results) {
      const u = (r as { url?: unknown })?.url;
      if (typeof u === "string") found.push(u);
    }
  }
  return uniqueUrls(found);
}

/** One listing entry -> a RawLead (business contact data only). */
export function entryToLead(e: EventListingEntry, sourceUrl: string, fallbackCategory: string): EventOrganiserLead {
  return {
    name: e.name,
    category: e.category || fallbackCategory,
    ...(e.area ? { address: e.area } : {}),
    ...(e.city ? { city: e.city } : {}),
    ...(e.phone ? { phone: e.phone } : {}),
    ...(e.website ? { website: e.website } : {}),
    source: EVENT_ORGANISERS_CHANNEL_ID,
    sourceUrl,
    ...(e.eventCount !== undefined ? { eventCount: e.eventCount } : {}),
    ...(e.eventTypes ? { eventTypes: e.eventTypes } : {}),
  };
}

// ---- status and env gate ---------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (process.env.CHANNEL_CH_EVENT_ORGANISERS === "1") return { enabled: true };
  return {
    enabled: false,
    why: "channel ch-event-organisers is off by default; set CHANNEL_CH_EVENT_ORGANISERS=\"1\" to enable it",
  };
}

// ---- the adapter -----------------------------------------------------------

export const eventOrganisers: ChannelAdapter = {
  id: EVENT_ORGANISERS_CHANNEL_ID,
  name: "Event Organisers & Ticketing",
  tier: "B",
  categories: EVENT_ORGANISERS_CATEGORIES,
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 100));
    const leads: EventOrganiserLead[] = [];

    // 1. search each platform for listing / organiser pages
    const urls: string[] = [];
    for (const query of buildQueries(q.category, q.city ?? "", q.area ?? "")) {
      if (urls.length >= limit) break;
      let res: ReachResult;
      try {
        res = await deps.search(query);
      } catch {
        continue; // search error: try the next platform
      }
      if (reachBlocked(res)) continue; // blocked / empty: try the next platform
      urls.push(...urlsFromResult(res.text, res.results));
    }

    // 2. page through the listing pages politely, stop at limit
    let page = 0;
    for (const url of uniqueUrls(urls)) {
      if (leads.length >= limit) break;
      if (await robotsDisallows(url, deps.fetchFn)) continue; // robots.txt forbids: skip
      if (page > 0) await deps.limiter.sleep?.(PAGE_PAUSE_MS); // polite pause between pages
      page += 1;
      let read: ReachResult;
      try {
        read = await deps.readPage(url);
      } catch {
        continue; // changed / unreachable page: skip, never throw
      }
      if (reachBlocked(read)) continue; // blocked or empty page: skip
      const text = sanitizeUntrusted(read.text);
      const entries = parseListingPage(text, url, q.category);
      for (const e of entries) {
        if (leads.length >= limit) break;
        leads.push(entryToLead(e, url, q.category));
      }
    }
    return leads;
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      read = await readWithFallback(deps, {
        searchQuery: `"${lead.name}" events organiser ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        return {
          channel: EVENT_ORGANISERS_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = { ...parseEventProfile(text) };
    const signals = eventOrganisersSignals(text);
    return {
      channel: EVENT_ORGANISERS_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => eventOrganisersSignals(text),
};

registerChannel(eventOrganisers);
