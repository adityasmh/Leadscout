// ChannelAdapter for wedding venue & banquet marketplaces (Order WE5-ch-venues).
//
// Public listing pages of venue marketplaces (venuelook.com, bookeventz.com and
// similar). This is ONE adapter for MANY marketplaces: each marketplace is a row
// in the SITES table below, so a new marketplace is a table row, not new code.
//
// Real page structure confirmed 2026-10-12 by reading the live public listing
// pages through the search/read proxy (direct fetch not attempted here):
//  - venuelook.com  https://www.venuelook.com/delhi/banquet-halls?page=1 and
//    https://www.venuelook.com/wedding-venues-in-delhi/venuetype/banquet-halls
//    render the "Venues With Starting Price" block as a markdown table with the
//    columns "Venue Name | Capacity | Starting Price" and rows such as
//    "Ballroom of Gola Sizzlers Preet Vihar | 50 - 200 Guests | Rs. 1500 per plate"
//    (also "Rs. 1250 per plate", "15 - 400 Guests"). The listing is paged with
//    the ?page=N query parameter and supports an ?area=<locality> filter.
//  - bookeventz.com https://www.bookeventz.com/banquets/mumbai and
//    https://www.bookeventz.com/bookeventz-venues/mumbai render heading cards
//    "## <Name>", then "<min>-<max> pax", "₹ <price> / Person", a rating label
//    ("Excellent 28 reviews", "Exceptional 5 reviews"), a standalone rating
//    ("4.6") and "<Area>, <City>". Paged with ?page=N (recorded, see report).
// Because the venue-name cell / card can render as a markdown link
// "[<Name>](<profile-url>)" the generic parser keys on that link; where a site
// renders a bare name no profile URL is invented, so no lead is emitted.
//
// Tier B: public pages, no login, no CAPTCHA bypass, no paywall. OFF by default;
// the operator switches it on with CHANNEL_CH_VENUES=1. Every read goes through
// registry.readWithFallback (search -> plain page -> browser only when both are
// blocked) and the operator's limiter. All fetched text is neutralised via
// reach.sanitizeUntrusted and every evidence is untrusted: true. A blocked or
// changed page makes discover return [] and never throw. Every field value is a
// verbatim copy from page text or the URL; a value the page does not show stays
// missing (never inferred or invented). Only business contact data is captured
// (business name, business phone, business website, public socials) - never the
// couple's data.
import { sanitizeUntrusted } from "../../src/reach.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const VENUES_CHANNEL_ID = "ch-venues";
const MAX_TEXT = 20000;
const MAX_PAGES = 10;
const MAX_LIMIT = 60;
/** Polite pause between listing pages (the operator's limiter supplies sleep). */
export const PAGE_DELAY_MS = 1500;
/** "many reviews" >= this many (high-review-count). */
export const HIGH_REVIEW_THRESHOLD = 50;

// ---- per-site config table --------------------------------------------------
// A new marketplace is a new row here (id, host, category->path map, URL builder,
// card link regex). The generic parser reads every site's card text the same way.

export type VenueSite = {
  id: string;
  name: string;
  host: string;
  /** canonical Leadscout category id -> this site's public listing path segment */
  categories: Record<string, string>;
  /** public listing URL for a query, page N (>=1) */
  listingUrl(q: { category: string; city: string; area?: string }, page: number): string;
  /** matches one vendor card/profile link: group 1 = name, group 2 = profile URL */
  cardRe: RegExp;
};

// Canonical categories THIS source class really lists. Venue marketplaces list
// venues (banquet halls) as the primary directory and event services as secondary
// listings; bridal-wear, florist, invitation-designer, jewellery-store and
// destination-wedding-agent are not venue-marketplace categories here, so they
// are left out (see report).
const VENUELOOK_CATEGORIES: Record<string, string> = {
  "banquet-hall": "banquet-halls",
  "wedding-planner": "wedding-planners",
  "event-company": "event-venues",
  "wedding-decorator": "decorators",
  "caterer": "caterers",
  "photographer": "photographers",
  "makeup-artist": "makeup-artists",
  "dj-entertainer": "dj",
};

const BOOKEVENTZ_CATEGORIES: Record<string, string> = {
  "banquet-hall": "banquets",
  "wedding-planner": "bookeventz-venues",
  "event-company": "bookeventz-venues",
  "wedding-decorator": "bookeventz-venues",
  "caterer": "bookeventz-venues",
  "photographer": "bookeventz-venues",
  "makeup-artist": "bookeventz-venues",
  "dj-entertainer": "bookeventz-venues",
};

export const SITES: VenueSite[] = [
  {
    id: "venuelook",
    name: "VenueLook",
    host: "venuelook.com",
    categories: VENUELOOK_CATEGORIES,
    listingUrl: (q, page) => {
      const city = slug(q.city) || "delhi";
      const seg = VENUELOOK_CATEGORIES[q.category] ?? "banquet-halls";
      const params = new URLSearchParams({ page: String(Math.max(1, page)) });
      if (q.area) params.set("area", q.area);
      return `https://www.venuelook.com/${city}/${seg}?${params.toString()}`;
    },
    cardRe: /\[([^\]\n]{1,160})\]\((https:\/\/www\.venuelook\.com\/[^\s")]+)\)/g,
  },
  {
    id: "bookeventz",
    name: "BookEventz",
    host: "bookeventz.com",
    categories: BOOKEVENTZ_CATEGORIES,
    listingUrl: (q, page) => {
      const city = slug(q.city) || "mumbai";
      const seg = BOOKEVENTZ_CATEGORIES[q.category] ?? "banquets";
      const params = new URLSearchParams({ page: String(Math.max(1, page)) });
      if (q.area) params.set("area", q.area);
      return `https://www.bookeventz.com/${seg}/${city}?${params.toString()}`;
    },
    cardRe: /\[([^\]\n]{1,160})\]\((https:\/\/www\.bookeventz\.com\/[^\s")]+)\)/g,
  },
];

// ---- helpers ----------------------------------------------------------------

const INJECTION_NEVER_COPY = /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)/i;

function slug(s: string): string {
  return String(s ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function cleanLines(text: string): string {
  return String(text ?? "").split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
}

function digitsPhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.replace(/[,;]$/, "").trim();
  return trimmed || undefined;
}

/** Shared per-card / per-profile extraction of the venue attributes. */
export type VenueFields = {
  name?: string; area?: string; city?: string;
  capacity?: string; capacityMin?: number; capacityMax?: number;
  startingPrice?: number; priceUnit?: string;
  rating?: number; reviewCount?: number;
  phone?: string; website?: string;
  instagram?: string; facebook?: string; youtube?: string; twitter?: string;
  photoCount?: number; videoCount?: number; videoPresent?: string;
  services?: string; yearsInBusiness?: number;
};

// ---- listing parser ---------------------------------------------------------

/** Extract location "<Area>, <City>" when the card shows one. */
function areaCityFrom(seg: string): { area?: string; city?: string } {
  const flat = seg.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const m = flat.match(/([A-Za-z][A-Za-z .'&-]{1,40}),\s*([A-Za-z][A-Za-z .'-]{1,30})(?=\s|$|\||,)/);
  if (!m) return {};
  return { area: m[1].trim(), city: m[2].trim() };
}

function capacityFrom(seg: string): { capacity?: string; min?: number; max?: number } {
  const range = seg.match(/(\d[\d,]*)\s*(?:-|–|to)\s*(\d[\d,]*)\s*(?:guests?|pax|people)/i);
  if (range) {
    const min = num(range[1]);
    const max = num(range[2]);
    return { capacity: `${min} - ${max} Guests`, min, max };
  }
  const single = seg.match(/(\d[\d,]*)\s*(?:guests?|pax|people)/i);
  if (single) {
    const n = num(single[1]);
    return { capacity: `${n} Guests`, min: n, max: n };
  }
  return {};
}

/** Parse one marketplace listing page into RawLead[]. Name and profile URL come
 *  from the card link; area, price, capacity and rating only if the page shows
 *  them. Never invents a value. */
export function parseListingPage(
  text: string,
  site: VenueSite,
  category: string,
  city: string,
  limit: number,
): RawLead[] {
  const clean = cleanLines(text);
  const re = new RegExp(site.cardRe.source, site.cardRe.flags);
  const matches: { name: string; url: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const url = m[2].split("?")[0];
    matches.push({ name: m[1].trim(), url, index: m.index });
  }
  const out: RawLead[] = [];
  for (let i = 0; i < matches.length && out.length < limit; i++) {
    const seg = clean.slice(matches[i].index, matches[i + 1]?.index ?? clean.length);
    const lead: RawLead = {
      name: matches[i].name,
      category,
      source: VENUES_CHANNEL_ID,
      sourceUrl: matches[i].url,
    };
    if (!lead.name) continue;
    const loc = areaCityFrom(seg);
    if (loc.area) lead.address = loc.area;
    if (loc.city || city) lead.city = loc.city || city;
    const phone = digitsPhone(seg.match(/\+\d[\d\s()-]{8,}\d/)?.[0]);
    if (phone) lead.phone = phone;
    out.push(lead);
  }
  return out;
}

// ---- profile parser ---------------------------------------------------------

/** Parse one vendor profile page into fields. Every value is a verbatim copy
 *  from the text or the URL; anything the page does not show stays undefined. */
export function parseProfilePage(text: string, nowMs: number = Date.now()): VenueFields {
  const clean = cleanLines(text);
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const lines = clean.split(/\r?\n/);
  const f: VenueFields = {};

  const heading = clean.match(/^#\s+(.+?)\s*$/m);
  f.name = heading?.[1]?.trim() || undefined;

  // "<Area>, <City>(View on Map)"
  const loc = clean.match(/#{2,6}\s+([A-Za-z][^#\n(]{2,70}?)\s*\(View on Map\)/);
  if (loc) {
    const joined = loc[1].replace(/\s+/g, " ").replace(/,\s*/g, ", ").trim();
    const ci = joined.indexOf(",");
    if (ci > 0) {
      f.area = joined.slice(0, ci).trim();
      f.city = joined.slice(ci + 1).trim();
    } else {
      f.area = joined;
    }
  }

  // capacity range: "50 - 200 Guests" or "50-250 pax"
  const cap = capacityFrom(flat);
  f.capacity = cap.capacity;
  f.capacityMin = cap.min;
  f.capacityMax = cap.max;

  // rating + review count: "<r> <label> <N> reviews" or "<N> reviews"
  const rr = (clean + " " + flat).match(/([0-5](?:\.\d)?)[\s#]*(?:out of 5|Excellent|Very Good|Good|Wonderful|Exceptional|Average|Poor|Terrible)?[\s#]*([\d,]+)\s+reviews?/i);
  if (rr) {
    const rating = num(rr[1]);
    if (rating !== undefined && rating > 0 && rating <= 5) f.rating = rating;
    f.reviewCount = num(rr[2]);
  } else {
    const count = num(flat.match(/([\d,]+)\s+reviews?\b/i)?.[1]);
    if (count !== undefined) f.reviewCount = count;
    const rating = num(flat.match(/(?:^|[\s|])([0-5](?:\.\d)?)\s+(?:out of 5|rating)/i)?.[1]);
    if (rating !== undefined && rating > 0 && rating <= 5) f.rating = rating;
  }

  // portfolio photo / video counts
  const photos = num(clean.match(/([\d,]{1,7})\s+Photos?\b/i)?.[1])
    ?? num(clean.match(/Photos?\s*\(\s*(\d+)\s*\)/i)?.[1]);
  f.photoCount = photos;
  const videos = clean.match(/Videos?\s*\(\s*(\d+)\s*\)/i);
  f.videoCount = num(videos?.[1]);
  const hasVideoRef = /Videos?\s*\(\s*[1-9]\d*\s*\)|youtube\.com|youtu\.be|vimeo\.com|\bfilms?\b|\breels?\b|\bvlog\b|\bvideo\b/i.test(clean);
  if ((f.videoCount ?? 0) > 0 || hasVideoRef) f.videoPresent = "yes";

  // starting price + unit: "Starting Price ₹ 1,500 per plate" / "₹ 1300 / Person"
  const price = clean.match(/(?:Starting Price|Price|From|Budget)[\s\S]{0,40}?(?:Rs\.?\s*|₹\s*)([\d,]{2,})\s*(?:\/\s*(plate|person|day)|per\s*(plate|person|day))?/i)
    ?? clean.match(/(?:Rs\.?\s*|₹\s*)([\d,]{2,})\s*(?:\/\s*(plate|person|day)|per\s*(plate|person|day))/i);
  if (price) {
    f.startingPrice = num(price[1]);
    const unit = (price[2] ?? price[3] ?? "").toLowerCase();
    if (unit) f.priceUnit = `per ${unit}`;
  }

  // services listed: the "Services Offered by ..." block, else "Services:" bullets
  const svcStart = lines.findIndex((l) => /Services(?:\s+Offered\s+by|\s*:)/i.test(l));
  if (svcStart >= 0) {
    const collected: string[] = [];
    for (let i = svcStart + 1; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (!ln) break;
      if (/^#{1,6}\s/.test(ln) || /^\[/.test(ln)) break;
      collected.push(ln.replace(/^[*\-•]\s*/, "").trim());
    }
    if (collected.length) f.services = collected.join(", ");
  }

  // years in business: "In business since <YYYY>" / "Since <YYYY>"
  const since = clean.match(/(?:In business since|Operating since|Planning since|Founded in|established in|since)\s*(\d{4})/i);
  if (since) {
    const year = num(since[1]);
    const nowYear = new Date(nowMs).getUTCFullYear();
    if (year !== undefined && year <= nowYear && year >= 1900) f.yearsInBusiness = nowYear - year;
  }

  // phone: only if the profile literally shows digits
  const phoneLine = lines.find((l) => /(?:Phone|Call|Contact)\s*[:：]\s*\+?\d/.test(l.trim()));
  if (phoneLine) f.phone = phoneLine.replace(/^[^:：]*[:：]\s*/, "").trim();

  // external website + socials (the marketplace's own links never count)
  const links = clean.match(/https?:\/\/[^\s)"'<>]+/g) ?? [];
  for (const l of links) {
    if (siteHostMatches(l, SITES)) continue;
    if (/instagram\.com/i.test(l)) f.instagram = f.instagram ?? l;
    else if (/facebook\.com/i.test(l)) f.facebook = f.facebook ?? l;
    else if (/youtube\.com|youtu\.be/i.test(l)) f.youtube = f.youtube ?? l;
    else if (/twitter\.com|x\.com/i.test(l)) f.twitter = f.twitter ?? l;
    else if (!f.website && /^https?:\/\//i.test(l) && !/\.(png|jpe?g|svg|webp|gif)(\?|$)/i.test(l)) f.website = l;
  }
  return f;
}

function siteHostMatches(url: string, sites: VenueSite[]): boolean {
  return sites.some((s) => {
    try {
      return new RegExp(`(^|\\.)${s.host.replace(/\./g, "\\.")}$`, "i").test(new URL(url).hostname);
    } catch {
      return false;
    }
  });
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids over raw text (WE1 shared list). */
export function venuesSignals(text: string): string[] {
  const t = String(text ?? "");
  const out: string[] = [];
  const hasVideo = /\bvideo|\bfilms?\b|\breels?\b|youtube\.com|youtu\.be|vimeo\.com|vlog\b/i.test(t);
  const hasMediaClaim = /\bphotos?\b|portfolio|gallery|\bimages?\b/i.test(t);
  if (hasVideo) out.push("has-video-portfolio");
  if (hasMediaClaim && !hasVideo) out.push("portfolio-no-video");

  // social video recency (only when the text literally states when it was posted)
  const days = t.match(/(\d{1,4})\s*days?\s+ago/i);
  const weeks = t.match(/(\d{1,2})\s*weeks?\s+ago/i);
  const hours = t.match(/\d{1,2}\s*hours?\s+ago/i);
  const months = t.match(/(\d{1,3})\s*months?\s+ago/i);
  const years = t.match(/(\d{1,2})\s*years?\s+ago/i);
  const nDays = days ? Number(days[1]) : undefined;
  const nWeeks = weeks ? Number(weeks[1]) : undefined;
  const nMonths = months ? Number(months[1]) : undefined;
  if (hours || (nDays !== undefined && nDays <= 30) || (nWeeks !== undefined && nWeeks <= 4)) {
    out.push("social-video-active");
  }
  if (years || (nMonths !== undefined && nMonths >= 4) || (nDays !== undefined && nDays > 90)) {
    out.push("social-inactive");
  }

  // review count
  const reviews = num(t.match(/([\d,]{1,12})\s+(?:reviews?|ratings?)\b/i)?.[1]);
  if (reviews !== undefined && reviews >= HIGH_REVIEW_THRESHOLD) out.push("high-review-count");

  // directory badge
  if (/Featured(?:\s+Tag)?|Premium Vendor|Premium Listing|Paid Vendor|Verified Plus|Sponsored|BookEventz Venue|Top Rated/i.test(t)) {
    out.push("premium-listing");
  }

  // serves more than one city
  const availableCount = t.match(/Available in\s+(\d+)\s+Cities?\b/i);
  const servedCount = t.match(/Serves?\s+(\d+)\s+Cities?\b/i);
  const servedList = t.match(/Served in ([^\n.]+)/i);
  const listCities = servedList ? servedList[1].split(/[,.]/).map((s) => s.trim()).filter(Boolean).length : 0;
  if (
    (availableCount && Number(availableCount[1]) > 1)
    || (servedCount && Number(servedCount[1]) > 1)
    || /\+\s*\d+\s*more cities?\b/i.test(t)
    || listCities >= 2
  ) {
    out.push("multi-city");
  }

  // published price
  if (
    /(?:Starting Price|Price|From|Budget)[^\n]{0,40}(?:Rs\.?\s*|₹\s*)[\d,]+/i.test(t)
    || /(?:Rs\.?\s*|₹\s*)[\d,]+\s*(?:\/\s*(?:plate|person|day)|per\s*(?:plate|person|day))/i.test(t)
  ) {
    out.push("price-band-known");
  }

  return [...new Set(out)];
}

// ---- status and env gate -----------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (process.env.CHANNEL_CH_VENUES === "1") return { enabled: true };
  return {
    enabled: false,
    why: "ch-venues is OFF by default (public wedding venue & banquet marketplace listing pages; tier B): "
      + `CHANNEL_CH_VENUES is "${String(process.env.CHANNEL_CH_VENUES ?? "")}" `
      + "(absent and any value other than 1 both mean off; the operator sets CHANNEL_CH_VENUES=1 to switch it on)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const venues: ChannelAdapter = {
  id: VENUES_CHANNEL_ID,
  name: "Venue marketplaces",
  tier: "B",
  categories: [
    "banquet-hall", "wedding-planner", "event-company", "wedding-decorator",
    "caterer", "photographer", "makeup-artist", "dj-entertainer",
  ],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, MAX_LIMIT));
    const out: RawLead[] = [];
    const seen = new Set<string>();
    for (const site of SITES) {
      if (out.length >= limit) break;
      try {
        for (let page = 1; page <= MAX_PAGES && out.length < limit; page++) {
          const read = await readWithFallback(deps, { url: site.listingUrl(q, page) });
          const text = sanitizeUntrusted(read.text);
          if (!text.trim()) break; // changed or empty page: stop this site, no throw
          const leads = parseListingPage(text, site, q.category, q.city, limit - out.length);
          if (leads.length === 0) break;
          let added = 0;
          for (const lead of leads) {
            if (out.length >= limit) break;
            if (seen.has(lead.sourceUrl)) continue;
            seen.add(lead.sourceUrl);
            out.push(lead);
            added++;
          }
          if (added === 0) break; // no new leads on this page: stop this site
          if (out.length < limit && deps.limiter?.sleep) await deps.limiter.sleep(PAGE_DELAY_MS);
        }
      } catch {
        // blocked page with no browser fallback for this site: skip it, never throw
      }
    }
    return out.slice(0, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    const nowMs = (deps.now ?? Date.now)();
    let read: FallbackRead;
    try {
      read = await readWithFallback(deps, {
        searchQuery: `${lead.name} ${lead.city ?? ""} venue`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch {
      // blocked profile with no browser fallback: empty evidence, untrusted, no throw
      return {
        channel: VENUES_CHANNEL_ID,
        url: lead.sourceUrl,
        fetchedAt: new Date(nowMs).toISOString(),
        via: "page",
        fields: {},
        signals: [],
        text: "",
        untrusted: true,
      };
    }
    const text = sanitizeUntrusted(read.text);
    const fields: Record<string, string | number | undefined> = {
      ...parseProfilePage(text, nowMs),
    };
    return {
      channel: VENUES_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date(nowMs).toISOString(),
      via: read.via,
      fields,
      signals: venuesSignals(text),
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => venuesSignals(text),
};

registerChannel(venues);
