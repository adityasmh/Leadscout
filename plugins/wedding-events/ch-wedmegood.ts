// ChannelAdapter for WedMeGood vendor directory (Order WE2-ch-wedmegood).
//
// Public wedding/event vendor directory. Vendor listings are organised by city
// and category, e.g. https://www.wedmegood.com/vendors/delhi-ncr/wedding-planners/
// and paginate with ?page=N (verified 2026-10-12 by fetching the live page
// through a read proxy). A card reads as:
//   [[<Name>](https://www.wedmegood.com/profile/<Name-slug>-<id> "<Name>")
//    4.9(175 reviews) ... <Area>, <City> Planning Fee ₹2,50,000 Onwards ...
//    Users' Choice Awards Winner ... Planned in 13 Cities]
// A profile (https://www.wedmegood.com/profile/<Name-slug>-<id>) shows
// "Portfolio (3)Albums (1)Videos (1)", "<N> Photos", "Starting Price ₹ ...",
// "Been on WedMeGood Since ...", "Planning since <YYYY>", "Services Offered by ..."
// and a "Planned in: <cities>" line.
//
// Tier B: public pages, no login. OFF by default; the operator switches it on
// with CHANNEL_CH_WEDMEGOOD=1. Every read goes through registry.readWithFallback
// (search -> plain page -> browser only when both are blocked). All fetched text
// is neutralised via reach.sanitizeUntrusted and evidence is marked untrusted:
// true. A blocked or changed page makes discover return [] and never throw.
// Every field value is copied verbatim from page text or the URL; a value the
// page does not show stays missing (never inferred or invented).
import { sanitizeUntrusted } from "../../src/reach.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";

export const WEDMEGOOD_CHANNEL_ID = "ch-wedmegood";
export const WEDMEGOOD_SITE = "wedmegood.com";
const MAX_TEXT = 20000;
const MAX_PAGES = 25;
/** Polite pause between listing pages (the operator's limiter supplies sleep). */
export const PAGE_DELAY_MS = 1500;
/** "many reviews" >= this many (high-review-count). */
export const HIGH_REVIEW_THRESHOLD = 50;

// Canonical category id -> WedMeGood public listing path segment. Only the paths
// this source really lists are used; related canonical ids that WedMeGood folds
// into one listing share that listing's path (documented in the report).
export const CATEGORY_PATH: Record<string, string> = {
  "wedding-planner": "wedding-planners",
  "event-company": "wedding-planners",
  "banquet-hall": "wedding-venues",
  "wedding-decorator": "wedding-decorators",
  "caterer": "wedding-catering",
  "bridal-wear": "bridal-wear",
  "makeup-artist": "bridal-makeup",
  "photographer": "wedding-photographers",
  "dj-entertainer": "djs",
  "florist": "wedding-decorators",
  "invitation-designer": "wedding-cards",
  "destination-wedding-agent": "wedding-planners",
  "jewellery-store": "wedding-jewellery",
};

export type WedmegoodFields = {
  name?: string; area?: string; city?: string; rating?: number; reviewCount?: number;
  startingPrice?: number; photoCount?: number; videoCount?: number; videoPresent?: string;
  services?: string; yearsInBusiness?: number; listedYears?: number;
  phone?: string; website?: string;
  instagram?: string; facebook?: string; youtube?: string; twitter?: string;
};

// ---- helpers ----------------------------------------------------------------

const INJECTION_NEVER_COPY = /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)/i;
const CARD_RE = /\[\[([^\]\n]{1,160})\]\((https:\/\/www\.wedmegood\.com\/profile\/[^\s")]+)/gi;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
const SOCIAL_RE = /https?:\/\/(?:www\.)?(instagram|facebook|youtube|twitter|x)\.com\/[^\s)"'<>]+/gi;

function slug(s: string): string {
  return String(s ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Public listing URL for a city/category (and optional area), page N. */
export function listingUrl(q: { category: string; city: string; area?: string }, page: number): string {
  const city = slug(q.city) || "all";
  const cat = CATEGORY_PATH[q.category] ?? "wedding-planners";
  const parts = ["https://www.wedmegood.com/vendors", city, cat];
  if (q.area) parts.push(slug(q.area));
  return `${parts.join("/")}/?page=${Math.max(1, page)}`;
}

function nameFromProfileUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!/(^|\.)wedmegood\.com$/i.test(u.hostname)) return undefined;
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    const slugSeg = segs[segs.length - 1];
    if (!slugSeg) return undefined;
    const name = slugSeg.replace(/-\d+$/, "").replace(/[-_]+/g, " ").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

// ---- listing parser ---------------------------------------------------------

/** Extract the "<Area>, <City>" text between the reviews count and the price
 *  label (the location icon markdown is stripped first). */
function areaFromSegment(seg: string): string | undefined {
  const idx = seg.search(/\s(?:Planning Fee|Price(?: on Request)?)\b/i);
  if (idx < 0) return undefined;
  const between = seg
    .slice(0, idx)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/reviews?\)/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  const m = between.match(/(?:^|\s)([A-Za-z][A-Za-z .'&-]{1,40},\s*[A-Za-z][A-Za-z .'-]{1,30})$/);
  return (m?.[1] ?? between).trim() || undefined;
}

/** Parse a WedMeGood listing page into RawLead[]. Name and profile URL come from
 *  the card link; area from the resolved card text; rating/price only if shown. */
export function parseListingPage(text: string, category: string, city: string, limit: number): RawLead[] {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const matches: { name: string; url: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  CARD_RE.lastIndex = 0;
  while ((m = CARD_RE.exec(clean)) !== null) {
    const url = m[2].split("?")[0];
    if (/\/reviews\//.test(url)) continue; // "Latest Reviews" links are not vendor cards
    matches.push({ name: m[1].trim(), url, index: m.index });
  }
  const out: RawLead[] = [];
  for (let i = 0; i < matches.length && out.length < limit; i++) {
    const seg = clean.slice(matches[i].index, matches[i + 1]?.index ?? clean.length);
    const area = areaFromSegment(seg);
    const phone = seg.match(PHONE_RE)?.[0]?.trim();
    const lead: RawLead = {
      name: matches[i].name || nameFromProfileUrl(matches[i].url) || "",
      category,
      source: WEDMEGOOD_CHANNEL_ID,
      sourceUrl: matches[i].url,
    };
    if (!lead.name) continue;
    if (area) lead.address = area;
    if (city) lead.city = city;
    if (phone) lead.phone = phone.replace(/[,;]$/, "");
    out.push(lead);
  }
  return out;
}

// ---- profile parser ---------------------------------------------------------

/** Parse one WedMeGood vendor profile page into fields. Every value is a verbatim
 *  copy from the text or the URL; anything unmatched stays undefined. */
export function parseProfilePage(text: string, nowMs: number = Date.now()): WedmegoodFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const lines = clean.split(/\r?\n/);
  const f: WedmegoodFields = {};

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

  // rating + review count: "5.0 ###### 12 reviews"
  const rr = flat.match(/([0-5](?:\.\d)?)[\s#]*([\d,]+)\s+reviews?\b/i);
  if (rr) {
    const rating = num(rr[1]);
    if (rating !== undefined && rating > 0 && rating <= 5) f.rating = rating;
    const count = num(rr[2]);
    if (count !== undefined) f.reviewCount = count;
  } else {
    const count = num(flat.match(/([\d,]+)\s+reviews?\b/i)?.[1]);
    if (count !== undefined) f.reviewCount = count;
  }

  // portfolio photo / video counts
  const portfolio = clean.match(/Portfolio\s*\(\s*(\d+)\s*\)/i);
  const photos = num(clean.match(/([\d,]{1,7})\s+Photos?\b/i)?.[1]);
  f.photoCount = num(portfolio?.[1]) ?? photos;
  const videos = clean.match(/Videos?\s*\(\s*(\d+)\s*\)/i);
  f.videoCount = num(videos?.[1]);
  const hasVideoRef = /Videos?\s*\(\s*[1-9]\d*\s*\)|youtube\.com|youtu\.be|vimeo\.com|\bVlog\b|\bvideo\b/i.test(clean);
  if ((f.videoCount ?? 0) > 0 || hasVideoRef) f.videoPresent = "yes";

  // starting price
  const price = clean.match(/(?:Starting Price|Price|Planning Fee)[\s\S]{0,40}?₹\s*([\d,]{2,})/i);
  f.startingPrice = num(price?.[1]);

  // services listed: the "Services Offered by ..." block, else the FAQ "They provide ..."
  const svcStart = lines.findIndex((l) => /Services Offered by\b/i.test(l));
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
  if (!f.services) {
    const prov = flat.match(/They provide ([^.]{5,300})\./i);
    if (prov) f.services = prov[1].trim();
  }

  // years in business: "Planning since <YYYY>"; else "Been on WedMeGood Since N years"
  const since = clean.match(/(?:Planning since|In business since|founded in|established in)\s*(?:in\s*)?(\d{4})/i);
  if (since) {
    const year = num(since[1]);
    const nowYear = new Date(nowMs).getUTCFullYear();
    if (year !== undefined && year <= nowYear) f.yearsInBusiness = nowYear - year;
  }
  const listed = clean.match(/Been on\s+WedMeGood Since\s*\n?\s*(\d+)\s*years?/i);
  if (listed) f.listedYears = num(listed[1]);

  // phone: only if the profile literally shows digits (otherwise it is hidden behind Contact)
  const phoneLine = lines.find((l) => /^Phone\s*[:：]\s*\+?\d/.test(l.trim()));
  if (phoneLine) f.phone = phoneLine.replace(/^Phone\s*[:：]\s*/, "").trim();

  // external website + socials (wedmegood's own links never count)
  const links = clean.match(/https?:\/\/[^\s)"'<>]+/g) ?? [];
  for (const l of links) {
    if (/wedmegood\.com/i.test(l)) continue;
    if (/instagram\.com/i.test(l)) f.instagram = f.instagram ?? l;
    else if (/facebook\.com/i.test(l)) f.facebook = f.facebook ?? l;
    else if (/youtube\.com|youtu\.be/i.test(l)) f.youtube = f.youtube ?? l;
    else if (/twitter\.com|x\.com/i.test(l)) f.twitter = f.twitter ?? l;
    else if (!f.website && /^https?:\/\//i.test(l) && !/\.(png|jpe?g|svg|webp|gif)(\?|$)/i.test(l)) f.website = l;
  }
  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids over raw text (WE1 shared list). */
export function wedmegoodSignals(text: string): string[] {
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
  if (/Paid Vendor|Handpicked|Users' Choice Awards? Winner|Featured Vendor|Premium Vendor|Verified Plus|In High Demand/i.test(t)) {
    out.push("premium-listing");
  }

  // serves more than one city
  const plannedCount = t.match(/Planned in\s+(\d+)\s+Cities\b/i);
  const moreCities = t.match(/\+\s*(\d+)\s*more cities?\b/i);
  const plannedList = t.match(/Planned in:([^\n]+)/i);
  const listCities = plannedList ? plannedList[1].split(/[,.]/).map((s) => s.trim()).filter(Boolean).length : 0;
  if ((plannedCount && Number(plannedCount[1]) > 1) || moreCities || listCities >= 2) out.push("multi-city");

  // published price
  if (/(?:Starting Price|Planning Fee)[^\n]{0,30}₹\s*[\d,]+|₹\s*[\d,]+/i.test(t)) out.push("price-band-known");

  return [...new Set(out)];
}

// ---- status and env gate -----------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (process.env.CHANNEL_CH_WEDMEGOOD === "1") return { enabled: true };
  return {
    enabled: false,
    why: "ch-wedmegood is OFF by default (public WedMeGood vendor listing pages; tier B): "
      + `CHANNEL_CH_WEDMEGOOD is "${String(process.env.CHANNEL_CH_WEDMEGOOD ?? "")}" `
      + "(absent and any value other than 1 both mean off; the operator sets CHANNEL_CH_WEDMEGOOD=1 to switch it on)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const wedmegood: ChannelAdapter = {
  id: WEDMEGOOD_CHANNEL_ID,
  name: "WedMeGood",
  tier: "B",
  categories: [
    "wedding-planner", "event-company", "banquet-hall", "wedding-decorator", "caterer",
    "bridal-wear", "makeup-artist", "photographer", "dj-entertainer", "florist",
    "invitation-designer", "destination-wedding-agent", "jewellery-store",
  ],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 60));
    const out: RawLead[] = [];
    const seen = new Set<string>();
    try {
      for (let page = 1; page <= MAX_PAGES && out.length < limit; page++) {
        const read = await readWithFallback(deps, { url: listingUrl(q, page) });
        const text = sanitizeUntrusted(read.text);
        const leads = parseListingPage(text, q.category, q.city, limit - out.length);
        if (leads.length === 0) break; // changed page or no more results: stop, no throw
        for (const lead of leads) {
          if (out.length >= limit) break;
          if (seen.has(lead.sourceUrl)) continue;
          seen.add(lead.sourceUrl);
          out.push(lead);
        }
        if (out.length < limit && deps.limiter?.sleep) await deps.limiter.sleep(PAGE_DELAY_MS);
      }
    } catch {
      return out; // blocked page with no browser fallback: [] (or what we already have), no throw
    }
    return out.slice(0, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    const read = await readWithFallback(deps, {
      searchQuery: `site:${WEDMEGOOD_SITE} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
      url: lead.sourceUrl,
    });
    const text = sanitizeUntrusted(read.text);
    const fields: Record<string, string | number | undefined> = {
      ...parseProfilePage(text, (deps.now ?? Date.now)()),
    };
    return {
      channel: WEDMEGOOD_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals: wedmegoodSignals(text),
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => wedmegoodSignals(text),
};

registerChannel(wedmegood);
