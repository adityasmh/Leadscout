// ChannelAdapter for generic web-search discovery of wedding / event niche
// businesses (Order WE9-ch-websearch-discovery).
//
// This is the SAFETY NET for any category the structured directories (Sulekha,
// JustDial, ...) do not list: it runs a bounded number of generic web-search
// queries through the injected `deps.search` (src/reach.ts searchWeb, rate- and
// credit-limited by order BD1), drops aggregator / news pages with an in-file
// deny list, then reads each remaining candidate page ONCE through
// `deps.readPage` to confirm it is a real business of the requested category.
//
// OFF by default: status() is disabled with a plain `why` unless the operator
// sets CHANNEL_CH_WEBSEARCH_DISCOVERY=1. Every outside call goes through `deps`
// (never a direct import of reach.ts network functions), so the check runs
// offline with injected search / readPage fakes.
//
// Rules honoured: business contact data only (business name, business phone,
// business email, business website, public social links); the page URL is the
// source; a field the page does not show stays missing (never inferred); every
// fetched byte is neutralised with reach.sanitizeUntrusted and evidence is
// marked untrusted: true. The limiter (ChannelDeps.limiter.sleep) is awaited
// between page reads so paging stays polite.
import { extractSocialLinks, parseSearchOutput, sanitizeUntrusted } from "../reach.js";
import { reachBlocked } from "./types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, ChannelStatus, DiscoverQuery } from "./types.js";
import type { RawLead } from "../types.js";
import { registerChannel } from "./registry.js";

export const WEBSEARCH_CHANNEL_ID = "ch-websearch-discovery";
const MAX_TEXT = 20000;
const DEFAULT_LIMIT = 20;
/** At most this many search queries per discover() call (the order's cap). */
export const MAX_QUERIES = 6;
/** A candidate below this confidence (0-1) is dropped. */
export const MIN_CONFIDENCE = 0.4;
/** Polite pause between page reads; injected limiter replaces it in checks. */
export const PAGE_DELAY_MS = 400;
export const ENABLE_ENV = "CHANNEL_CH_WEBSEARCH_DISCOVERY";

// The canonical category ids this source really lists (order WE9).
export const WEBSEARCH_CATEGORIES = [
  "wedding-planner", "event-company", "banquet-hall", "wedding-decorator",
  "caterer", "bridal-wear", "makeup-artist", "photographer", "dj-entertainer",
  "florist", "invitation-designer", "destination-wedding-agent", "jewellery-store",
];

// Niche phrases per canonical category -> search queries.
const NICHE_PHRASES: Record<string, string[]> = {
  "wedding-planner": ["wedding planner", "wedding planning company", "shaadi planner"],
  "event-company": ["event management company", "event company", "event organiser"],
  "banquet-hall": ["banquet hall", "wedding venue", "marriage hall"],
  "wedding-decorator": ["wedding decorator", "wedding decoration service", "mandap decorator"],
  "caterer": ["wedding caterer", "catering service", "event caterer"],
  "bridal-wear": ["bridal wear boutique", "bridal lehenga store", "wedding dress designer"],
  "makeup-artist": ["bridal makeup artist", "makeup artist", "bridal makeup studio"],
  "photographer": ["wedding photographer", "wedding photography", "event photographer"],
  "dj-entertainer": ["wedding DJ", "DJ and entertainer", "event entertainer"],
  "florist": ["wedding florist", "flower decorator", "floral designer"],
  "invitation-designer": ["wedding invitation designer", "invitation card designer", "wedding card designer"],
  "destination-wedding-agent": ["destination wedding planner", "destination wedding agency", "destination wedding agent"],
  "jewellery-store": ["bridal jewellery store", "jewellery showroom", "wedding jewellery designer"],
};

// Small in-file deny list: aggregators, social networks and news portals are
// NOT businesses we can call, and the order says to drop them. Directory
// entries (weddingwire, weddingsutra, ...) are deliberately kept.
const DENY_HOSTS = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com", "youtu.be",
  "pinterest.com", "linkedin.com", "wikipedia.org", "reddit.com", "quora.com",
  "medium.com", "glassdoor.com", "yelp.com", "tripadvisor.com", "justdial.com",
  "sulekha.com", "indiamart.com", "practo.com", "zomato.com", "swiggy.com",
  "olx.in", "99acres.com", "magicbricks.com", "nobroker.in", "asklaila.com",
  "mapsofindia.com", "timesofindia.com", "hindustantimes.com", "thehindu.com",
  "ndtv.com", "economictimes.com", "business-standard.com", "indiatimes.com",
  "deccanherald.com", "google.com", "bing.com", "duckduckgo.com", "github.com",
];
const DENY_HOST_SUFFIXES = [".gov.in", ".nic.in"];

export function isDeniedUrl(url: string): boolean {
  try {
    const host = new URL(String(url ?? "")).hostname.toLowerCase().replace(/^www\./, "");
    if (DENY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
    if (DENY_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;
    return false;
  } catch {
    return true; // not a usable URL -> treat as denied
  }
}

/** Category words used to confirm the page is about this niche. */
export function categoryWords(category: string): string[] {
  const cat = String(category ?? "").trim().toLowerCase();
  const words = cat.split(/[-_\s]+/).filter((w) => w.length >= 3);
  const phrases = NICHE_PHRASES[cat] ?? [];
  for (const p of phrases) for (const w of p.split(/\s+/)) if (w.length >= 4) words.push(w);
  return [...new Set(words)];
}

/** Build the bounded search queries for a (category, city, area) request. */
export function buildQueries(q: { category: string; city?: string; area?: string }): string[] {
  const cat = String(q.category ?? "").trim().toLowerCase();
  const phrases = NICHE_PHRASES[cat] ?? [cat.replace(/[-_]+/g, " ").trim() || "business"];
  const loc = [q.area, q.city].filter(Boolean).join(", ").trim();
  const out: string[] = [];
  for (const p of phrases) {
    if (out.length >= MAX_QUERIES) break;
    out.push(loc ? `"${p}" ${loc}` : `"${p}"`);
  }
  return out;
}

// ---- page parser: only exact matches become fields --------------------------

export type WebsearchFields = {
  name?: string; city?: string; area?: string; address?: string;
  phone?: string; email?: string;
  photoCount?: number; videoCount?: number; hasVideo?: boolean;
  reviewCount?: number; rating?: number; price?: string; startingPrice?: string;
  services?: string; yearsInBusiness?: number; sinceYear?: number;
  instagram?: string; facebook?: string; youtube?: string; twitter?: string;
  linkedin?: string; whatsapp?: string; localBusiness?: boolean;
};

const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?(previous|prior|above)\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b/i;
const JSONLD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const LOCAL_BUSINESS_TYPE_RE =
  /(LocalBusiness|Organization|ProfessionalService|Store|EntertainmentBusiness|FoodEstablishment|LodgingBusiness|EventVenue|JewelryStore|ClothingStore|BeautySalon|Photograph)/i;
const VIDEO_RE = /\b(?:videos?|films?|reels?)\b|youtube\.com|youtu\.be|vimeo\.com|\bvimeo\b/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?\d{1,3}[-\s]?)?(?:\d[\d\s()-]{7,}\d)/;

function stripTags(html: string): string {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\r?\n\s*\r?\n/g, "\n");
}

type LdObj = Record<string, unknown>;

function ldObjects(html: string): LdObj[] {
  const out: LdObj[] = [];
  for (const m of String(html ?? "").matchAll(JSONLD_RE)) {
    try {
      const j = JSON.parse(m[1].trim()) as unknown;
      if (Array.isArray(j)) out.push(...(j.filter((x) => x && typeof x === "object") as LdObj[]));
      else if (j && typeof j === "object") {
        const o = j as LdObj;
        out.push(o);
        if (Array.isArray(o["@graph"])) out.push(...(o["@graph"].filter((x) => x && typeof x === "object") as LdObj[]));
      }
    } catch {
      /* keep scanning: a broken JSON-LD block must never throw */
    }
  }
  return out;
}

function num(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = Number(String(raw).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function addrLocality(ld: LdObj): { address?: string; area?: string } {
  const a = ld["address"];
  if (typeof a === "string") return { address: a };
  if (a && typeof a === "object") {
    const o = a as LdObj;
    const street = typeof o["streetAddress"] === "string" ? o["streetAddress"] : undefined;
    const locality = typeof o["addressLocality"] === "string" ? o["addressLocality"] : undefined;
    return { ...(street ? { address: street } : {}), ...(locality ? { area: locality } : {}) };
  }
  return {};
}

/** Parse a vendor profile / business site page. Every value is a verbatim copy
 *  from the page text or its schema.org JSON-LD; anything unmatched stays
 *  undefined (never inferred or invented). */
export function parseWebsearchPage(text: string): WebsearchFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const plain = stripTags(clean);
  const lines = plain.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: WebsearchFields = {};

  // schema.org JSON-LD: merge the first LocalBusiness-like object.
  const lds = ldObjects(clean);
  const ld = lds.find((o) => LOCAL_BUSINESS_TYPE_RE.test(String(o["@type"] ?? ""))) ?? lds[0];
  if (ld) {
    f.localBusiness = LOCAL_BUSINESS_TYPE_RE.test(String(ld["@type"] ?? "")) || undefined;
    if (typeof ld["name"] === "string") f.name = ld["name"].trim() || undefined;
    if (typeof ld["telephone"] === "string") f.phone = ld["telephone"].trim() || undefined;
    if (typeof ld["email"] === "string") f.email = ld["email"].trim() || undefined;
    if (typeof ld["priceRange"] === "string") f.price = ld["priceRange"].trim() || undefined;
    const loc = addrLocality(ld);
    if (loc.address) f.address = loc.address;
    if (loc.area) f.area = loc.area;
    if (loc.area && !f.city) f.city = loc.area;
    if (typeof ld["address"] === "string" && !f.city) {
      const m = ld["address"].match(/([A-Za-z .'-]{3,40})\s*$/);
      if (m) f.city = m[1].trim();
    }
    const ar = ld["aggregateRating"];
    if (ar && typeof ar === "object") {
      const o = ar as LdObj;
      const rc = num(o["reviewCount"]);
      const rv = num(o["ratingValue"]);
      if (rc !== undefined) f.reviewCount = rc;
      if (rv !== undefined && rv > 0 && rv <= 5) f.rating = rv;
    }
  }

  // name from <title> or the first heading when JSON-LD has none.
  if (!f.name) {
    const title = clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    if (title) {
      const t = stripTags(title).trim();
      if (t && !INJECTION_NEVER_COPY.test(t)) f.name = t;
    }
  }
  if (!f.name) {
    const h1 = clean.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    if (h1) {
      const t = stripTags(h1).trim();
      if (t && !INJECTION_NEVER_COPY.test(t)) f.name = t;
    }
  }

  // phone / email from a contact label, else anywhere on the page.
  if (!f.phone) {
    const labelled = plain.match(/(?:phone|mobile|call|contact(?:\s+number)?)\s*[:：]?\s*((?:\+?\d[\d\s()-]{7,}\d))/i)?.[1];
    f.phone = labelled?.trim() || plain.match(PHONE_RE)?.[0]?.trim() || undefined;
  }
  if (!f.email) f.email = clean.match(EMAIL_RE)?.[0]?.trim() || undefined;

  // services: an explicit "Services:" label line.
  const servicesLine = lines.find((l) => /^services?\s*[:：]\s*\S/i.test(l));
  if (servicesLine) f.services = servicesLine.replace(/^services?\s*[:：]\s*/i, "").trim() || undefined;

  // portfolio photos: "<N> photos" text, else the number of <img> tags.
  const photoText = plain.match(/(\d{1,4})\s+photos?\b/i)?.[1];
  const imgCount = (clean.match(/<img\b/gi) ?? []).length;
  const photoCount = photoText !== undefined ? num(photoText) : (imgCount > 0 ? imgCount : undefined);
  if (photoCount !== undefined) f.photoCount = photoCount;

  // video presence: word or known video host; count when "<N> videos". Only
  // recorded when the page actually rendered text, so a blocked/empty page
  // yields no fields at all.
  if (plain.trim().length > 0) {
    f.hasVideo = VIDEO_RE.test(plain);
    if (f.hasVideo) {
      const vc = num(plain.match(/(\d{1,4})\s+videos?\b/i)?.[1]);
      if (vc !== undefined) f.videoCount = vc;
    }
  }

  // reviews / rating from plain text when JSON-LD had none.
  if (f.reviewCount === undefined) {
    const rc = num(plain.match(/([\d,]{1,9})\s+(?:reviews?|ratings?)\b/i)?.[1]);
    if (rc !== undefined) f.reviewCount = rc;
  }
  if (f.rating === undefined) {
    const rv = num(plain.match(/\b([0-5](?:\.\d{1,2})?)\s*\/\s*5\b/)?.[1]) ?? num(plain.match(/\b([0-5]\.\d)\s*(?:stars?|★)/i)?.[1]);
    if (rv !== undefined && rv > 0 && rv <= 5) f.rating = rv;
  }

  // price: an explicit "starting from <amount>" then any currency amount.
  const startPrice = plain.match(/(?:starting\s+(?:from|at))\s*((?:₹|rs\.?|inr|\$)\s*[\d,]+(?:\+)?)/i)?.[1];
  if (startPrice) f.startingPrice = startPrice.trim();
  if (!f.price) f.price = f.startingPrice ?? plain.match(/(?:₹|rs\.?|inr|\$)\s*[\d,]+(?:\+)?/i)?.[0]?.trim();

  // years in business / since year: only when the page literally says it.
  const years = num(plain.match(/\b(\d{1,3})\+?\s+years?\s+(?:in business|of experience|experience)\b/i)?.[1]);
  if (years !== undefined) f.yearsInBusiness = years;
  const since = num(plain.match(/\b(?:since|established|estd\.?)\s*(\d{4})\b/i)?.[1]);
  if (since !== undefined) f.sinceYear = since;

  // public social links.
  const socials = extractSocialLinks(clean) as Record<string, string | undefined>;
  for (const k of ["instagram", "facebook", "youtube", "twitter", "linkedin", "whatsapp"] as const) {
    if (socials[k]) f[k] = socials[k];
  }
  return f;
}

// ---- signals ----------------------------------------------------------------

const CITY_NAMES = [
  "mumbai", "delhi", "new delhi", "bangalore", "bengaluru", "hyderabad", "chennai",
  "kolkata", "pune", "ahmedabad", "jaipur", "goa", "kochi", "cochin", "lucknow",
  "chandigarh", "indore", "surat", "nagpur",
];
const VIDEO_ACTIVE_RE = /\b(?:reel|video|film|post(?:ed)?|update)\b/i;
const REL_AGO_RE = /(\d{1,4})\s*(hour|hours|hrs?|min|mins?|minute|minutes|day|days|week|weeks|month|months|year|years)\s+ago/i;

function relativeDays(unit: string, n: number): number {
  const u = unit.toLowerCase();
  if (u.startsWith("hour") || u.startsWith("hr") || u.startsWith("min")) return 0;
  if (u.startsWith("day")) return n;
  if (u.startsWith("week")) return n * 7;
  if (u.startsWith("month")) return n * 30;
  return n * 365;
}

/** How many days ago the most recent dated post/video/reel was, or undefined. */
export function latestSocialDays(text: string): number | undefined {
  let best: number | undefined;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!VIDEO_ACTIVE_RE.test(line)) continue;
    const m = line.match(REL_AGO_RE);
    if (!m) continue;
    const days = relativeDays(m[2], Number(m[1]));
    if (best === undefined || days < best) best = days;
  }
  return best;
}

/** Stable signal ids over parsed fields + raw text (order WE9 exact ids):
 *  portfolio-no-video, has-video-portfolio, social-video-active, social-inactive,
 *  high-review-count, premium-listing, multi-city, price-band-known. */
export function websearchSignals(f: WebsearchFields, text: string = ""): string[] {
  const t = String(text ?? "");
  const out: string[] = [];
  const hasVideo = f.hasVideo === true || VIDEO_RE.test(t);

  // portfolio exists (photos / portfolio words) but shows no video.
  const hasPortfolio = (typeof f.photoCount === "number" && f.photoCount > 0) || /\b(?:portfolio|gallery|photos?|our work|albums?)\b/i.test(t);
  if (hasPortfolio && !hasVideo) out.push("portfolio-no-video");
  if (hasVideo) out.push("has-video-portfolio");

  // social activity: latest post/video/reel within 30 days, or none within 90.
  const days = latestSocialDays(t);
  if (days !== undefined && days <= 30) out.push("social-video-active");
  if ((days !== undefined && days > 90) || /\bno posts?\b|\bnot (?:posted|active)\b|\baccount inactive\b/i.test(t)) {
    out.push("social-inactive");
  }

  // 50+ reviews or ratings.
  if (typeof f.reviewCount === "number" && f.reviewCount >= 50) out.push("high-review-count");

  // featured / verified-plus / paid-tier label on a directory.
  if (/\bfeatured\b|verified[- ]?plus|premium\s+listing|paid\s+(?:listing|tier)|sponsored|top\s+rated|best\s+of\b/i.test(t)) {
    out.push("premium-listing");
  }

  // serves more than one city.
  const cities = new Set(CITY_NAMES.filter((c) => t.toLowerCase().includes(c)));
  if (cities.size >= 2 || /\bmulti-?city\b|multiple cities|pan[- ]?india|across india|all over india|we serve\b/i.test(t)) {
    out.push("multi-city");
  }

  // a price or starting price is published.
  if (f.price !== undefined || f.startingPrice !== undefined) out.push("price-band-known");

  return [...new Set(out)];
}

// ---- confidence -------------------------------------------------------------

/** 0-1 confidence from independent agreeing cues; below MIN_CONFIDENCE -> drop. */
export function confidence(f: WebsearchFields, text: string, q: { category: string; city?: string }): number {
  const t = String(text ?? "").toLowerCase();
  let c = 0;
  if (categoryWords(q.category).some((w) => t.includes(w))) c += 0.3;
  if (q.city && t.includes(String(q.city).toLowerCase())) c += 0.2;
  if (f.phone || f.email) c += 0.3;
  if (f.localBusiness === true) c += 0.2;
  return Math.round(c * 100) / 100;
}

// ---- status -----------------------------------------------------------------

export function websearchStatus(env: Record<string, string | undefined> = process.env): ChannelStatus {
  if (env[ENABLE_ENV] === "1") return { enabled: true };
  return {
    enabled: false,
    why: `generic web-search discovery is off by default: set ${ENABLE_ENV}=1 to switch it on `
      + `(currently "${String(env[ENABLE_ENV] ?? "")}"; absent and =0 both mean off)`,
  };
}

// ---- the adapter ------------------------------------------------------------

function toFields(f: WebsearchFields): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined) continue;
    out[k] = typeof v === "boolean" ? (v ? "yes" : "no") : v;
  }
  return out;
}

export const chWebsearchDiscovery: ChannelAdapter = {
  id: WEBSEARCH_CHANNEL_ID,
  name: "Web search discovery (wedding & events)",
  tier: "B",
  categories: WEBSEARCH_CATEGORIES,
  status: () => websearchStatus(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT));
    const seen = new Set<string>();
    const candidates: { url: string; title?: string }[] = [];

    let queries: string[];
    try {
      queries = buildQueries(q);
    } catch {
      return [];
    }
    for (const query of queries) {
      let r;
      try {
        r = await deps.search(query);
      } catch {
        continue; // one query failing must not lose the others
      }
      if (!r || !r.ok || reachBlocked(r)) continue;
      const results = r.results && r.results.length
        ? r.results.map((x) => ({ title: x.title, url: x.url }))
        : parseSearchOutput(r.text).map((x) => ({ title: x.title, url: x.url }));
      for (const res of results) {
        const url = String(res.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) continue;
        if (isDeniedUrl(url)) continue; // aggregator / social / news page
        const key = url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ url, title: res.title });
      }
    }

    const out: RawLead[] = [];
    for (const cand of candidates) {
      if (out.length >= limit) break;
      await deps.limiter?.sleep?.(PAGE_DELAY_MS);
      let p;
      try {
        p = await deps.readPage(cand.url);
      } catch {
        continue; // a blocked / changed page never throws out of discover
      }
      if (!p || !p.ok || reachBlocked(p)) continue;
      const text = sanitizeUntrusted(p.text);
      const parsed = parseWebsearchPage(text);
      if (confidence(parsed, text, q) < MIN_CONFIDENCE) continue;
      const name = parsed.name ?? cand.title?.trim();
      if (!name) continue;
      out.push({
        name,
        category: q.category,
        source: WEBSEARCH_CHANNEL_ID,
        sourceUrl: cand.url,
        website: cand.url,
        ...(q.city ? { city: q.city } : {}),
        ...(parsed.address ? { address: parsed.address } : parsed.area ? { address: parsed.area } : {}),
        ...(parsed.phone ? { phone: parsed.phone } : {}),
        ...(parsed.email ? { email: parsed.email } : {}),
      });
    }
    return out;
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let text = "";
    try {
      const r = await deps.readPage(lead.sourceUrl);
      if (r && r.ok && !reachBlocked(r)) text = sanitizeUntrusted(r.text);
    } catch {
      text = ""; // a blocked / changed page yields empty evidence, never a throw
    }
    const parsed = parseWebsearchPage(text);
    return {
      channel: WEBSEARCH_CHANNEL_ID,
      url: lead.sourceUrl,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: "page",
      fields: toFields(parsed),
      signals: websearchSignals(parsed, text),
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => websearchSignals(parseWebsearchPage(text), text),
};

registerChannel(chWebsearchDiscovery);
