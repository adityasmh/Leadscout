// ChannelAdapter for Instagram wedding/event vendors - Order WE8-ch-instagram-vendors.
//
// READ-ONLY discovery + activity checking of public Instagram profile, hashtag
// and location pages for wedding/event vendors (planners, event companies,
// venues, decorators, caterers, bridal wear, makeup artists, photographers,
// DJs/entertainers, florists, invitation designers, destination-wedding agents,
// jewellers). Tier B: the pages are public, but Instagram is read through the
// injected transports only (deps.readPage, deps.fetchFn, then the operator's
// own logged-in browser reader deps.browser as a last resort) so checks run
// offline and so the adapter never logs in, never likes, follows or messages.
//
// OFF by default: enabled only when env CHANNEL_CH_INSTAGRAM_VENDORS=1. Enforced
// in code, not data. instagram.com is already on the browser allowlist; browser
// reads keep Instagram's own 30/hour cap and 2-6 s pause (browser.ts).
//
// Source/terms: instagram.com/robots.txt prohibits automated collection and
// Meta's Terms ban collecting data "using automated means" (see the sibling
// channels/instagram.ts header, verified 2026-10-09). This adapter therefore
// runs only when the operator switches the env var on and treats the browser
// path as the operator-approved read mode. Honours the shared limiter between
// listing pages.
//
// Rules (CHANNELS_CONTRACT.md): every field value is copied verbatim from the
// page text or the URL (never inferred or invented); a value the page does not
// show stays missing; only business contact data is captured; every fetched
// text is neutralised via reach.sanitizeUntrusted and evidence is
// untrusted: true.
//
// Relative-date signals (social-video-active / social-inactive) are made
// deterministic offline with the clock already in ChannelDeps (`deps.now`).
// No new deps field was needed; the exported signal function also accepts an
// explicit `nowMs` so checks pin the clock.
import { sanitizeUntrusted } from "../../src/reach.js";
import { BrowserBlockedError, reachBlocked } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";
import { parseInstagramPage, INACTIVE_DAYS } from "./instagram.js";

export const CH_INSTAGRAM_VENDORS_CHANNEL_ID = "ch-instagram-vendors";
export const INSTAGRAM_SITE = "instagram.com";
const MAX_TEXT = 20000;
const MAX_LIMIT = 50;
const MAX_PAGES = 6;
const PAGE_PAUSE_MS = 2000;

export const MANY_PHOTOS_THRESHOLD = 5;
export const HIGH_REVIEW_THRESHOLD = 50;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Canonical Leadscout ids this source really lists (order WE8). */
export const CH_INSTAGRAM_VENDORS_CATEGORIES = [
  "wedding-planner",
  "event-company",
  "banquet-hall",
  "wedding-decorator",
  "caterer",
  "bridal-wear",
  "makeup-artist",
  "photographer",
  "dj-entertainer",
  "florist",
  "invitation-designer",
  "destination-wedding-agent",
  "jewellery-store",
] as const;

/** Canonical category id -> the vendor hashtags a wedding/event buyer uses for
 *  that category. Only ids this adapter declares appear here. */
export const CATEGORY_BASE_TAGS: Record<string, string[]> = {
  "wedding-planner": ["weddingplanner", "weddingplanners"],
  "event-company": ["eventcompany", "eventplanner"],
  "banquet-hall": ["banquethall", "weddingvenue"],
  "wedding-decorator": ["weddingdecor", "weddingdecorator"],
  "caterer": ["weddingcaterer", "weddingcatering"],
  "bridal-wear": ["bridalwear", "bridallehenga"],
  "makeup-artist": ["bridalmakeupartist", "makeupartist"],
  "photographer": ["weddingphotographer", "weddingphotography"],
  "dj-entertainer": ["weddingdj", "djentertainer"],
  "florist": ["weddingflorist", "florist"],
  "invitation-designer": ["weddinginvitation", "weddinginvitations"],
  "destination-wedding-agent": ["destinationwedding", "destinationweddingplanner"],
  "jewellery-store": ["bridaljewellery", "jewellery"],
};

/** src/niche-pack.ts exists (Order WE1) and exposes expandQueries, but every
 *  expandQueries call needs a NichePack loaded from data/niche-packs/*.json and
 *  this read-only adapter must not read data/. So this small
 *  built-in list stands in for its phrases here; each phrase becomes a hashtag. */
export const BUILTIN_EXPAND_QUERIES: string[] = [
  "wedding decor",
  "wedding planner",
  "bridal makeup artist",
  "wedding photographer",
];

export type InstagramVendorFields = {
  handle?: string;
  name?: string;
  area?: string;
  address?: string;
  city?: string;
  phone?: string;
  email?: string;
  website?: string;
  followers?: number | string;
  postCount?: number | string;
  bio?: string;
  categoryLabel?: string;
  lastPostDate?: string;
  lastVideoDate?: string;
  portfolioPhotoCount?: number;
  hasVideo?: string;
  reviewCount?: number;
  rating?: number;
  priceFrom?: number;
  priceLabel?: string;
  socials?: string;
  services?: string;
  yearsInBusiness?: number;
  premium?: string;
};

// ---- patterns ---------------------------------------------------------------

const RESERVED_SLUGS =
  /^(p|reel|reels|tv|explore|tags|stories|accounts|directory|about|legal|locations|web|developer|privacy|terms|search|explore\/tags)$/i;
const IG_PROFILE_URL_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?=["'\s<>)]|$)/gi;
const INJECTION_NEVER_COPY =
  /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous|prior)/i;
const VIDEO_WORD_RE = /\bvideos?\b|\bfilms?\b|\breels?\b|\bvideograph|\bcinematograph/i;
const VIDEO_LINK_RE =
  /youtube\.com|youtu\.be|player\.vimeo\.com\/video|vimeo\.com\/\d+|<video\b|\.mp4(?=["'\s?]|$)/i;
const PHONE_RE = /(?:\+?\d[\d\s()-]{8,}\d)/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const RATING_RE = /\b([0-5](?:\.\d{1,2})?)\s*(?:out of 5|stars?|\/\s*5)\b/i;
const REVIEW_COUNT_RE = /([\d,]{1,12})\s+reviews?\b/i;
const PRICE_LABEL_RE =
  /(?:From|Starting(?:\s+(?:at|from|price))?|Price|Planning fee)\s*[:₹]?\s*(?:₹|rs\.?|inr|\$)\s*([\d,]+)/i;
const PRICE_GENERIC_RE = /(?:₹|rs\.?\s?|inr\s?)([\d,]{3,})/i;
const SERVICES_LABEL_RE = /(?:^|\n)\s*Services?\s*[:：]\s*([^\n]{2,200})/i;
const YEARS_RE = /\b(\d{1,3})\+?\s+years?\s+(?:of\s+)?(?:experience|in business)\b/i;
const PREMIUM_RE = /\bVerified\b|\bPremium\b|\bFeatured\b|\bVerified Plus\b|\bVerified\+/i;
const SOCIAL_LINK_RE =
  /https?:\/\/(?:www\.)?(facebook|youtube|twitter|x|vimeo)\.com\/[^\s"'<>)·]+/gi;
const LOCATION_LABEL_RE =
  /(?:located in|based in|city|address)\s*[:：]?\s*([A-Z][A-Za-z .'-]{1,40}?)(?:\s*,\s*([A-Z][A-Za-z .'-]{2,40}))?(?=\n|$)/i;
const LOCATION_LINE_RE = /^(?:📍\s*)?([A-Z][A-Za-z .'-]{1,40}?)\s*,\s*([A-Z][A-Za-z .'-]{2,40})$/;

function slugToken(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Ordered candidate hashtags for (category, city, area): city-prefixed,
 *  base+city, then the plain base tags, then the built-in expand phrases. */
export function hashtagsFor(category: string, city?: string, area?: string): string[] {
  const bases = CATEGORY_BASE_TAGS[String(category ?? "").trim().toLowerCase()] ?? [];
  const cityTag = slugToken(city);
  const areaTag = slugToken(area);
  const out: string[] = [];
  const push = (t: string): void => {
    if (t && !out.includes(t)) out.push(t);
  };
  for (const base of bases) {
    if (cityTag) push(cityTag + base);
    if (cityTag) push(base + cityTag);
    push(base);
  }
  for (const phrase of BUILTIN_EXPAND_QUERIES) {
    const h = slugToken(phrase);
    if (cityTag) push(cityTag + h);
    push(h);
  }
  if (areaTag && bases[0]) push(areaTag + bases[0]);
  return out;
}

/** Public Instagram hashtag listing URLs for a query (the "pages" this adapter
 *  reads, one hashtag page per entry). Location pages are the same shape but
 *  need numeric ids the page text does not expose, so hashtag pages are used. */
export function listingUrls(category: string, city?: string, area?: string): string[] {
  return hashtagsFor(category, city, area).map(
    (tag) => `https://www.${INSTAGRAM_SITE}/explore/tags/${tag}/`,
  );
}

// ---- listing-page parser ----------------------------------------------------

/** Parse a public Instagram hashtag/explore listing page into RawLead[]. A
 *  profile link (a post author) becomes one lead; the name is the handle copied
 *  verbatim from the URL slug. Post/reel/tag/explore URLs are skipped. Returns
 *  [] when the page shows no profile links (blocked or changed layout). */
export function parseInstagramListing(
  text: string,
  category: string,
  opts: { city?: string; area?: string } = {},
  limit = 20,
): RawLead[] {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const leads: RawLead[] = [];
  const seen = new Set<string>();

  // index every profile URL occurrence, then read the small block after it
  const hits: { idx: number; handle: string }[] = [];
  const regex = new RegExp(IG_PROFILE_URL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = regex.exec(clean)) !== null) {
    const handle = m[1];
    if (!handle || RESERVED_SLUGS.test(handle)) continue;
    hits.push({ idx: m.index, handle });
  }

  for (let i = 0; i < hits.length && leads.length < limit; i++) {
    const handle = hits[i].handle;
    const url = `https://www.instagram.com/${handle}/`;
    if (seen.has(url)) continue;
    const start = hits[i].idx;
    const end = i + 1 < hits.length ? hits[i + 1].idx : Math.min(clean.length, start + 600);
    const block = clean.slice(start, end);

    let area: string | undefined;
    let city: string | undefined;
    const labelled = LOCATION_LABEL_RE.exec(block);
    if (labelled) {
      area = labelled[1]?.trim() || undefined;
      city = labelled[2]?.trim() || area;
    } else {
      const locLine = block.split(/\r?\n/).map((l) => l.trim()).find((l) => LOCATION_LINE_RE.test(l));
      const bare = locLine ? LOCATION_LINE_RE.exec(locLine) : null;
      if (bare) {
        area = bare[1].trim();
        city = bare[2].trim();
      }
    }
    const phone = block.match(PHONE_RE)?.[0]?.trim();
    const website = block.match(/(?:website|link)\s*[:：]\s*(https?:\/\/[^\s"'<>]+)/i)?.[1]
      ?? block.match(/https?:\/\/(?!.*?instagram\.com)[^\s"'<>)]+/i)?.[0];

    seen.add(url);
    leads.push({
      name: handle,
      category,
      source: CH_INSTAGRAM_VENDORS_CHANNEL_ID,
      sourceUrl: url,
      ...(area ? { address: area } : {}),
      ...(city ? { city } : (opts.city ? { city: opts.city } : {})),
      ...(phone ? { phone } : {}),
      ...(website && !/instagram\.com/i.test(website) ? { website } : {}),
    });
  }
  return leads;
}

// ---- profile-page parser ----------------------------------------------------

/** Parse an Instagram vendor profile (or site) into fields. Base profile fields
 *  are reused from channels/instagram.ts parseInstagramPage; the vendor fields
 *  (portfolio, video, reviews, price, socials, services, years, location) are
 *  read only when the text shows them. Every value is verbatim. */
export function parseInstagramVendorPage(text: string, nowMs: number = Date.now()): InstagramVendorFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const ig = parseInstagramPage(clean, nowMs);
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const f: InstagramVendorFields = {};

  f.handle = ig.handle;
  f.bio = ig.bio;
  f.categoryLabel = ig.categoryLabel;
  f.followers = ig.followers;
  f.postCount = ig.posts;
  f.lastPostDate = ig.lastPostDate;
  f.website = ig.linkInBio;
  f.phone = ig.contactCall ?? ig.contactDirections;
  f.email = ig.contactEmail;

  // display name: an explicit "Name:" label, else the handle (verbatim).
  const nameLabel = clean.split(/\r?\n/).map((l) => l.trim())
    .find((l) => /^Name\s*[:：]\s*\S/i.test(l));
  f.name = nameLabel?.replace(/^Name\s*[:：]\s*/i, "").trim() || ig.handle;

  // location: a labelled/line "<Area>, <City>".
  const locLine = clean.split(/\r?\n/).map((l) => l.trim()).find((l) => LOCATION_LINE_RE.test(l));
  const locLabel = clean.match(LOCATION_LABEL_RE);
  if (locLabel) {
    f.area = locLabel[1]?.trim() || undefined;
    f.city = locLabel[2]?.trim() || f.area;
  } else if (locLine) {
    const lm = LOCATION_LINE_RE.exec(locLine);
    if (lm) { f.area = lm[1].trim(); f.city = lm[2].trim(); }
  }

  // phone / email fall back to the raw text when the label path is empty.
  if (!f.phone) {
    const labelled = clean.match(/^Phone\s*[:：]\s*(\S[^\n]*)/im)?.[1]?.trim();
    f.phone = labelled || flat.match(PHONE_RE)?.[0]?.trim();
  }
  if (!f.email) f.email = clean.match(EMAIL_RE)?.[0];
  if (!f.website) {
    const ext = clean.match(/https?:\/\/(?!(?:www\.)?instagram\.com)[^\s"'<>)·]+/i)?.[0];
    if (ext && !/facebook|youtube|twitter|vimeo|x\.com/i.test(ext)) f.website = ext;
  }

  // portfolio photo count: an explicit "<N> photos" count (or "View N more").
  const photos = num(flat.match(/([\d,]{1,12})\s+photos?\b/i)?.[1])
    ?? num(flat.match(/View\s+([\d,]{1,12})\s+more\s+photos?/i)?.[1]);
  if (photos !== undefined) f.portfolioPhotoCount = photos;

  // video presence: a "<N> videos" count, a video word, or an embedded link.
  const videoCount = num(flat.match(/([\d,]{1,12})\s+videos?\b/i)?.[1]);
  if ((videoCount ?? 0) > 0 || VIDEO_WORD_RE.test(clean) || VIDEO_LINK_RE.test(clean)) f.hasVideo = "yes";
  else if (f.portfolioPhotoCount !== undefined) f.hasVideo = "no";

  // latest video date: "Video by ... on <Month DD, YYYY>".
  const videoDates = [...clean.matchAll(/Video\s+by\s+[^\n]*?\s+on\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/g)]
    .map((x) => ({ raw: x[1], ts: Date.parse(x[1]) }))
    .filter((x) => Number.isFinite(x.ts))
    .sort((a, b) => b.ts - a.ts);
  if (videoDates.length) f.lastVideoDate = videoDates[0].raw;

  // reviews + rating (shown verbatim only).
  const reviews = num(flat.match(REVIEW_COUNT_RE)?.[1]);
  if (reviews !== undefined) f.reviewCount = reviews;
  const rating = num(flat.match(RATING_RE)?.[1]);
  if (rating !== undefined && rating > 0 && rating <= 5) f.rating = rating;

  // price / starting price.
  const price = flat.match(PRICE_LABEL_RE)?.[1] ?? flat.match(PRICE_GENERIC_RE)?.[1];
  if (price !== undefined) {
    const n = num(price);
    if (n !== undefined && !/on request/i.test(flat)) {
      f.priceFrom = n;
      f.priceLabel = /rs|inr/i.test(flat.match(PRICE_LABEL_RE)?.[0] ?? "") ? `Rs ${price}` : `₹${price}`;
    }
  }

  // social links (never the source instagram links).
  const socials = [...new Set((clean.match(SOCIAL_LINK_RE) ?? []).map((u) => u.replace(/[.,;]+$/, "")))];
  if (socials.length) f.socials = socials.join(", ");

  // services listed: an explicit "Services:" label only.
  const services = clean.match(SERVICES_LABEL_RE)?.[1]?.trim();
  if (services) f.services = services;

  // years in business / of experience.
  const years = num(flat.match(YEARS_RE)?.[1]);
  if (years !== undefined) f.yearsInBusiness = years;

  if (PREMIUM_RE.test(clean)) f.premium = "yes";

  return f;
}

// ---- signals ----------------------------------------------------------------

function relativeAgeDays(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  if (!m) return undefined;
  const clause = m[0];
  if (!/\d/.test(clause)) return 1; // today / yesterday / this week / last week
  const n = Number(String(m[1] ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  if (/years?/i.test(clause)) return n * 365;
  if (/months?/i.test(clause)) return n * 30;
  if (/weeks?/i.test(clause)) return n * 7;
  return n;
}

/** Stable signal ids for the wedding/event niche (exact order ids), computed
 *  over the parsed fields + raw text. `nowMs` pins the relative-date signals
 *  offline. Note: `high-review-count` is emitted here for completeness but the
 *  adapter's discover path does NOT use any signal. */
export function instagramVendorSignals(text: string, nowMs: number = Date.now()): string[] {
  const raw = String(text ?? "");
  const f = parseInstagramVendorPage(raw, nowMs);
  const t = raw;
  const out: string[] = [];

  const hasVideo = f.hasVideo === "yes" || VIDEO_WORD_RE.test(t) || VIDEO_LINK_RE.test(t);
  const hasPhotos =
    (typeof f.portfolioPhotoCount === "number" && f.portfolioPhotoCount > 0) ||
    (typeof f.bio === "string" && f.bio.length > 0);
  if (hasVideo) out.push("has-video-portfolio");
  else if (hasPhotos) out.push("portfolio-no-video");

  if (typeof f.reviewCount === "number" && f.reviewCount >= HIGH_REVIEW_THRESHOLD) out.push("high-review-count");
  if (f.premium === "yes") out.push("premium-listing");

  // multi-city: "serves/locations: A, B" (>=2) or "Served in A, B".
  const multi = t.match(/\b(?:cities|locations|serves|serving|served in|available in)\s*[:\-]?\s*([^\n.]{3,120})/i);
  if (multi) {
    const parts = multi[1].split(/,| and |&|;/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) out.push("multi-city");
  }
  if (/(?:₹|rs\.?|inr)\s?[\d,]{3,}/i.test(t) || PRICE_LABEL_RE.test(t)) out.push("price-band-known");

  // social-video-active: a reel/video with a relative age <= 30 d, or a visible
  // last-video date within 30 d of nowMs.
  const relVideo = relativeAgeDays(
    t,
    /\b(?:reels?|videos?)\b[^.\n]{0,40}?\b(?:today|yesterday|this week|last week|(\d{1,3})\s+(?:days?|weeks?|months?|years?)\s+ago)\b/i,
  );
  let videoActive = relVideo !== undefined && relVideo <= 30;
  if (f.lastVideoDate) {
    const ts = Date.parse(f.lastVideoDate);
    if (Number.isFinite(ts) && nowMs - ts >= 0 && nowMs - ts <= 30 * DAY_MS) videoActive = true;
  }
  if (videoActive) out.push("social-video-active");

  // social-inactive: a last post/update 90 d or more ago
  // (relative phrasing, or an absolute last-post date older than 90 d).
  const relOld = relativeAgeDays(
    t,
    /\b(?:last|latest|no)\s*(?:post|posted|update|updated|reel|video|reels|videos)\b[^.\n]{0,40}?\b(\d{1,3})\s+(?:days?|weeks?|months?|years?)\s+ago\b/i,
  );
  let inactive = relOld !== undefined && relOld >= 90;
  if (f.lastPostDate) {
    const ts = Date.parse(f.lastPostDate);
    if (Number.isFinite(ts) && nowMs - ts >= INACTIVE_DAYS * DAY_MS) inactive = true;
  }
  if (inactive) out.push("social-inactive");

  return [...new Set(out)];
}

// ---- read helper ------------------------------------------------------------

type ReadVia = { text: string; url: string; via: "page" | "browser" };

/** Read one listing URL politely through the injected transports: plain page
 *  read first, then the injected fetchFn, then the operator's browser reader.
 *  Only a read that is not blocked counts. Throws when every path is blocked so
 *  the caller can stop without a throw. */
async function readListing(deps: ChannelDeps, url: string): Promise<ReadVia> {
  if (deps.readPage) {
    const r = await deps.readPage(url);
    if (!reachBlocked(r)) return { text: r.text, url, via: "page" };
  }
  if (deps.fetchFn) {
    try {
      const res = await deps.fetchFn(url);
      const text = await res.text();
      if (text && text.trim() !== "") return { text, url, via: "page" };
    } catch {
      /* fall through to the browser */
    }
  }
  if (deps.browser) {
    const b = await deps.browser.read(url);
    return { text: b.text, url: b.url, via: "browser" };
  }
  throw new Error("ch-instagram-vendors: listing blocked and no fetch/browser fallback configured");
}

// ---- status and env gate ----------------------------------------------------

export function statusText(): { enabled: boolean; why?: string } {
  const v = process.env.CHANNEL_CH_INSTAGRAM_VENDORS;
  if (v === "1") return { enabled: true };
  return {
    enabled: false,
    why: "channel off by default: set CHANNEL_CH_INSTAGRAM_VENDORS=1 to enable "
      + `(currently "${String(v ?? "")}"). Read-only public Instagram profile/hashtag `
      + "pages through the injected transports only; no login, no likes/follows/messages.",
  };
}

// ---- the adapter ------------------------------------------------------------

export const chInstagramVendors: ChannelAdapter = {
  id: CH_INSTAGRAM_VENDORS_CHANNEL_ID,
  name: "Instagram wedding/event vendors",
  tier: "B",
  categories: [...CH_INSTAGRAM_VENDORS_CATEGORIES],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    if (!CATEGORY_BASE_TAGS[String(q.category ?? "").trim().toLowerCase()]) return [];
    const limit = Math.max(1, Math.min(q.limit ?? 20, MAX_LIMIT));
    const urls = listingUrls(q.category, q.city, q.area).slice(0, MAX_PAGES);
    const leads: RawLead[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < urls.length; i++) {
      if (leads.length >= limit) break;
      if (i > 0 && deps.limiter?.sleep) await deps.limiter.sleep(PAGE_PAUSE_MS);
      let read: ReadVia;
      try {
        read = await readListing(deps, urls[i]);
      } catch {
        continue; // blocked / changed page: skip politely, never throw
      }
      const text = sanitizeUntrusted(read.text);
      const pageLeads = parseInstagramListing(text, q.category, { city: q.city, area: q.area }, limit - leads.length);
      for (const lead of pageLeads) {
        if (leads.length >= limit) break;
        if (seen.has(lead.sourceUrl)) continue;
        seen.add(lead.sourceUrl);
        leads.push(lead);
      }
    }
    return leads.slice(0, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${INSTAGRAM_SITE} "${lead.name}" ${lead.city ?? ""}`.trim(),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha / checkpoint after browser escalation: never
        // solved or bypassed -> needs-human evidence, no fields.
        return {
          channel: CH_INSTAGRAM_VENDORS_CHANNEL_ID,
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
    const nowMs = (deps.now ?? Date.now)();
    const fields: Record<string, string | number | undefined> = { ...parseInstagramVendorPage(text, nowMs) };
    return {
      channel: CH_INSTAGRAM_VENDORS_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date(nowMs).toISOString(),
      via: read.via,
      fields,
      signals: instagramVendorSignals(text, nowMs),
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => instagramVendorSignals(text),
};

registerChannel(chInstagramVendors);
