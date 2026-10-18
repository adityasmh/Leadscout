// ChannelAdapter for WeddingSutra vendor directory (Order WE4-ch-weddingsutra).
//
// Wedding/event vendor directory for the India wedding niche: planners, venues,
// decorators, caterers, bridal wear, makeup artists, photographers/filmmakers,
// DJs, invitation designers and bridal jewellers.
//
// Source verified by reading the live public pages on 2026-10-12:
//  - Listing pages: https://weddingsutra.com/wedding-vendors/<category-slug>/,
//    real slugs include wedding-planners, wedding-venues, wedding-decor,
//    catering, bridal-wear, bridal-makeup-hair, wedding-photographers, dj,
//    invitations-stationery, bridal-jewellery.
//  - Each listing card is <a href="https://weddingsutra.com/vendor/<slug>/"
//    title="<Name>"> with <h5 class="card-title">Name <span><i class="fa
//    fa-map-marker"></i> City</span>, and an optional
//    <span class="rating-count-listing">5</span> star rating.
//  - Some cards use /vendor-profile/<slug>/<id> (featured vendors).
//  - robots.txt (fetched 2026-10-12) allows "/" and only disallows /wp-admin,
//    /wp-login.php, /xmlrpc.php, /wp-includes, /readme.html, plugins, plus
//    publishes https://weddingsutra.com/sitemap_index.xml.
//  - Vendor profile pages carry: <h2>About <Name></h2> plus a description in
//    <div id="content">, a Smart Slider gallery of images under
//    /images/Vendor_Images/..., a "Price" extra field (often "On request"), an
//    awards image /images/vendors-img/weddingSutra-favorites/... ("WeddingSutra
//    Favorites"), a "Contact This Member" block with tel: links, a mailto: link
//    and a social_vendor list (Instagram etc).
//
// shaadisaga.com could NOT be reached from this environment (transport error on
// every fetch, 2026-10-12), so this adapter builds the one reachable source,
// weddingsutra.com, as the order allows.
//
// Rules (CHANNELS_CONTRACT.md): OFF by default, enabled only by
// CHANNEL_CH_WEDDINGSUTRA=1; outside access goes through deps.fetchFn/readPage
// so checks run offline; every field value is copied verbatim from the page text
// or the URL (never inferred or invented); all fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const WEDDINGSUTRA_CHANNEL_ID = "ch-weddingsutra";
export const WEDDINGSUTRA_SITE = "weddingsutra.com";
const MAX_TEXT = 20000;
const MAX_LISTING_PAGES = 5;

// Canonical category id -> real WeddingSutra category slug (verified 2026-10-12).
// Only ids this source really lists are declared. event-company, florist and
// destination-wedding-agent have NO dedicated WeddingSutra vendor category, so
// they are intentionally omitted.
export const CATEGORY_TO_SLUG: Record<string, string> = {
  "wedding-planner": "wedding-planners",
  "banquet-hall": "wedding-venues",
  "wedding-decorator": "wedding-decor",
  "caterer": "catering",
  "bridal-wear": "bridal-wear",
  "makeup-artist": "bridal-makeup-hair",
  "photographer": "wedding-photographers",
  "dj-entertainer": "dj",
  "invitation-designer": "invitations-stationery",
  "jewellery-store": "bridal-jewellery",
};
export const WEDDINGSUTRA_CATEGORIES = Object.keys(CATEGORY_TO_SLUG);

export type WeddingSutraFields = {
  name?: string; city?: string; category?: string; description?: string;
  photoCount?: number; hasVideo?: string; reviewCount?: number; rating?: number;
  price?: string; startingPrice?: string; website?: string;
  instagram?: string; facebook?: string; youtube?: string;
  services?: string; yearsInBusiness?: number; premium?: string; phone?: string;
};

// ---- patterns ---------------------------------------------------------------

const VENDOR_ANCHOR_RE =
  /<a\s+href="(https:\/\/weddingsutra\.com\/(?:vendor|vendor-profile)\/[^"\s]+)"[^>]*?title="([^"]*)"/gi;
const VENDOR_URL_RE = /https?:\/\/(?:www\.)?weddingsutra\.com\/(?:vendor|vendor-profile)\/[^\s"'<>]+/i;
const INJECTION_NEVER_COPY =
  /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous|prior)/i;
// A real portfolio video is an embedded player or a video file - never the
// site's own footer youtube channel link (youtube.com/channel/...).
const VIDEO_RE =
  /(?:youtube\.com\/(?:embed|watch)|youtu\.be\/|player\.vimeo\.com\/video|vimeo\.com\/\d+|<video\b|\.mp4(?=["'\s?]|$))/i;
const PHOTO_RE = /\/Vendor_Images\/[^\s"'<>)]+\.(?:jpe?g|png|webp)/gi;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
const RATING_RE = /\b([0-5](?:\.\d{1,2})?)\s*\/\s*5\b/;
const RATING_LISTING_RE = /rating-count-listing"?\s*>\s*([0-5](?:\.\d{1,2})?)\s*</i;
const REVIEW_COUNT_RE = /([\d,]{1,12})\s+(?:Reviews?|Ratings?)\b/i;
const YEARS_RE = /\b(\d{1,3})\+?\s+(?:Years?|yrs?)\s+in\s+(?:business|the industry)\b/i;
const FOUNDED_RE = /\bFounded\s+(\d{1,3})\s+years?\s+ago\b/i;
const PRICE_LABEL_RE =
  /itemExtraFieldsLabel"?\s*>\s*Price\s*<\/span>[\s\S]{0,300}?itemExtraFieldsValue[^>]*>(?:<b>)?\s*([^<]+)</i;
const SERVICES_LABEL_RE = /itemExtraFieldsLabel"?\s*>\s*Services\s*<\/span>[\s\S]{0,300}?itemExtraFieldsValue[^>]*>\s*([^<]+)</i;
const CATEGORY_LABEL_RE = /itemExtraFieldsLabel"?\s*>\s*Category\s*<\/span>[\s\S]{0,300}?itemExtraFieldsValue[^>]*>\s*([^<]+)</i;
const WEBSITE_LABEL_RE = /itemExtraFieldsLabel"?\s*>\s*Website\s*<\/span>[\s\S]{0,300}?itemExtraFieldsValue[^>]*>\s*([^<]+)</i;
const PREMIUM_RE =
  /WeddingSutra\s+Favorites|Editor'?s?\s+Choice|Premium\s+Listing|Verified\s+Plus|Featured\s+Vendor|weddingSutra-favorites/i;
const SOCIAL_VIDEO_ACTIVE_RE =
  /\b(?:reels?|videos?)\b[^.\n]{0,40}\b(?:today|yesterday|\d{1,2}\s+days?\s+ago|last week|this week|[1-4]\s+weeks?\s+ago)\b/i;
const SOCIAL_INACTIVE_RE =
  /\bno (?:recent |new )?(?:posts?|updates?|activity)\b|\b(?:last|latest) (?:post|update|reel|video)\b[^.\n]{0,30}\b(?:\d{1,2}\s+months?|\d{1,2}\s+years?|a year|over a year|months|years) ago\b|\bnot (?:posted|updated)\b[^.\n]{0,25}\b(?:since|for|in)\b/i;

function decodeEntities(s: string): string {
  return String(s ?? "")
    .replace(/&#0?38;|&amp;/g, "&")
    .replace(/&#8217;|&#039;|&#39;|&#x27;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(s: string): string {
  return decodeEntities(String(s ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(String(raw).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : undefined;
}

function nameFromVendorUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!/(^|\.)weddingsutra\.com$/i.test(u.hostname)) return undefined;
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    if (segs[0] === "vendor-profile") segs.splice(0, 2); // vendor-profile/<slug>/<id>
    else if (segs[0] === "vendor") segs.shift();
    const slug = segs[segs.length - 1];
    if (!slug) return undefined;
    return decodeEntities(slug.replace(/-/g, " ").trim()) || undefined;
  } catch {
    return undefined;
  }
}

/** Parse a WeddingSutra listing card block or vendor profile page into fields.
 *  Every value is a verbatim copy from the text or the URL; anything unmatched
 *  stays undefined (never inferred). */
export function parseWeddingSutraPage(text: string): WeddingSutraFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const f: WeddingSutraFields = {};

  // name: "About <Name>" heading, else the vendor URL slug (verbatim).
  const about = clean.match(/<h2[^>]*>\s*About\s+([^<]+?)\s*<\/h2>/i);
  const url = clean.match(VENDOR_URL_RE)?.[0];
  f.name = about ? decodeEntities(about[1]).trim() : nameFromVendorUrl(url);

  // city: "<i class=fa-map-marker></i> City</span>" (listing card), else the
  // profile <title> "Name | City | ..." slot.
  const marker = clean.match(/fa-map-marker[^>]*>\s*<\/i>\s*([^<]{1,60}?)\s*<\/span>/i);
  if (marker) f.city = decodeEntities(marker[1]).trim() || undefined;
  if (!f.city) {
    const title = clean.match(/<title>([^<]+)<\/title>/i);
    const parts = title ? title[1].split("|").map((s) => s.trim()).filter(Boolean) : [];
    if (parts.length >= 3) f.city = decodeEntities(parts[1]) || undefined;
  }

  // description: the profile "content" block, tags stripped.
  const content = clean.match(/<div id="content"[^>]*>([\s\S]*?)<\/div>/i);
  if (content) {
    const d = stripTags(content[1]);
    if (d) f.description = d;
  }

  // portfolio photo count: distinct /Vendor_Images/ image files.
  const photos = new Set((flat.match(PHOTO_RE) ?? []).map((p) => p.toLowerCase()));
  if (photos.size > 0) f.photoCount = photos.size;

  // video presence: positive only on an embedded player / video file.
  if (VIDEO_RE.test(clean)) f.hasVideo = "yes";
  else if (f.photoCount !== undefined) f.hasVideo = "no";

  // review count / rating (shown verbatim).
  const rc = num(flat.match(REVIEW_COUNT_RE)?.[1]);
  if (rc !== undefined) f.reviewCount = rc;
  const rating = num(flat.match(RATING_LISTING_RE)?.[1]) ?? num(flat.match(RATING_RE)?.[1]);
  if (rating !== undefined && rating > 0 && rating <= 5) f.rating = rating;

  // price / starting price: the "Price" extra field value, if numeric.
  const priceRaw = clean.match(PRICE_LABEL_RE)?.[1];
  if (priceRaw) {
    const price = decodeEntities(priceRaw).trim();
    f.price = price;
    if (/\d/.test(price) && !/on request/i.test(price)) f.startingPrice = price;
  }

  // website: a "Website" extra field, else the first external profile link.
  const websiteLabel = clean.match(WEBSITE_LABEL_RE)?.[1];
  if (websiteLabel) {
    const w = websiteLabel.trim();
    if (/^https?:\/\//i.test(w)) f.website = w;
  }
  if (!f.website) {
    const ext = clean.match(/href="(https?:\/\/(?!.*?weddingsutra\.com)[^"]+)"/i);
    if (ext && !/instagram|facebook|youtube|twitter|x\.com|mailto/i.test(ext[1])) f.website = ext[1];
  }

  // social links (never the site's own weddingsutra accounts).
  const ig = clean.match(/https?:\/\/(?:www\.)?instagram\.com\/(?!weddingsutra)[^"\s<)]+/i);
  if (ig) f.instagram = decodeEntities(ig[0]);
  const fb = clean.match(/https?:\/\/(?:www\.)?facebook\.com\/(?!weddingsutra)[^"\s<)]+/i);
  if (fb) f.facebook = decodeEntities(fb[0]);
  const yt = clean.match(/https?:\/\/(?:www\.)?youtube\.com\/(?!channel\/UCy2_8hXzJFLh1zfxjhVonAA)[^"\s<)]+/i);
  if (yt) f.youtube = decodeEntities(yt[0]);

  // services listed: an explicit "Services" extra field only.
  const services = clean.match(SERVICES_LABEL_RE)?.[1];
  if (services) f.services = decodeEntities(services).trim() || undefined;

  // years in business: "N Years in Business" or "Founded N years ago".
  const years = num(flat.match(YEARS_RE)?.[1]) ?? num(flat.match(FOUNDED_RE)?.[1]);
  if (years !== undefined) f.yearsInBusiness = years;

  // premium / featured label.
  if (PREMIUM_RE.test(clean)) f.premium = "yes";

  // phone: only digits the page actually shows in a tel: link.
  const tel = clean.match(/tel:(\+?\d[\d-]{6,}\d)/);
  if (tel) f.phone = decodeEntities(tel[1]).trim();
  else {
    const bare = flat.match(PHONE_RE)?.[0];
    if (bare) f.phone = bare.trim();
  }

  return f;
}

// ---- signals ----------------------------------------------------------------

function multiCity(text: string): boolean {
  const m = text.match(/\b(?:cities|locations|serves|serving|available in)\s*[:\-]\s*([^\n.]{3,120})/i);
  if (!m) return false;
  const parts = m[1].split(/,| and |&|;/).map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2;
}

function priceBand(text: string): boolean {
  if (/(?:starting(?:\s+(?:price|from))?|price)\s*[:]?\s*(?:₹|rs\.?|inr)\s?[\d,]+/i.test(text)) return true;
  return /₹\s?[\d,]{3,}/.test(text);
}

/** Stable signal ids for the wedding/event niche (exact order ids), computed
 *  over parsed fields + raw text. A signal fires only on matching text. */
export function weddingSutraSignals(f: WeddingSutraFields, text = ""): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  const video = VIDEO_RE.test(t);
  const portfolio =
    (typeof f.photoCount === "number" && f.photoCount > 0) ||
    (typeof f.description === "string" && f.description.length > 0);
  if (video) out.push("has-video-portfolio");
  if (portfolio && !video) out.push("portfolio-no-video");
  if (typeof f.reviewCount === "number" && f.reviewCount >= 50) out.push("high-review-count");
  if (f.premium === "yes") out.push("premium-listing");
  if (multiCity(t)) out.push("multi-city");
  if (priceBand(t)) out.push("price-band-known");
  if (SOCIAL_VIDEO_ACTIVE_RE.test(t)) out.push("social-video-active");
  if (SOCIAL_INACTIVE_RE.test(t)) out.push("social-inactive");
  return [...new Set(out)];
}

// ---- discovery --------------------------------------------------------------

export function listingUrl(categorySlug: string, page = 1): string {
  const base = `https://${WEDDINGSUTRA_SITE}/wedding-vendors/${categorySlug}/`;
  return page <= 1 ? base : `${base}page/${page}/`;
}

/** Parse a WeddingSutra category listing page into RawLead[]. Each card is an
 *  <a href=".../vendor/<slug>/" title="<Name>"> with a city span; only real
 *  vendor URLs count. City/area filters are applied when the query supplies
 *  them, and the list is capped at `limit`. */
export function parseListingLeads(
  text: string,
  category: string,
  limit: number,
  city?: string,
  area?: string,
): RawLead[] {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const leads: RawLead[] = [];
  const seen = new Set<string>();
  const wantCity = String(city ?? "").trim().toLowerCase();
  const wantArea = String(area ?? "").trim().toLowerCase();
  VENDOR_ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VENDOR_ANCHOR_RE.exec(clean)) !== null) {
    if (leads.length >= limit) break;
    const url = m[1].replace(/[\s,.;]+$/, "");
    if (seen.has(url)) continue;
    const window = clean.slice(m.index, m.index + 900);
    const marker = window.match(/fa-map-marker[^>]*>\s*<\/i>\s*([^<]{1,60}?)\s*<\/span>/i);
    const cardCity = marker ? decodeEntities(marker[1]).trim() : undefined;
    const name = decodeEntities(m[2]).trim() || nameFromVendorUrl(url);
    if (!name) continue;
    if (wantCity && !(cardCity ?? "").toLowerCase().includes(wantCity)) continue;
    if (wantArea && !window.toLowerCase().includes(wantArea)) continue;
    seen.add(url);
    const lead: RawLead = { name, category, source: WEDDINGSUTRA_CHANNEL_ID, sourceUrl: url };
    if (cardCity) lead.city = cardCity;
    const tel = window.match(PHONE_RE);
    if (tel) lead.phone = tel[0].trim();
    leads.push(lead);
  }
  return leads;
}

// ---- status and env gate ----------------------------------------------------

export function statusText(): { enabled: boolean; why?: string } {
  if (process.env.CHANNEL_CH_WEDDINGSUTRA === "1") return { enabled: true };
  return {
    enabled: false,
    why: "WeddingSutra vendor directory is off by default: set CHANNEL_CH_WEDDINGSUTRA=1 to "
      + `enable it (currently "${String(process.env.CHANNEL_CH_WEDDINGSUTRA ?? "")}")`,
  };
}

// ---- the adapter ------------------------------------------------------------

export const weddingsutra: ChannelAdapter = {
  id: WEDDINGSUTRA_CHANNEL_ID,
  name: "WeddingSutra",
  tier: "B",
  categories: [...WEDDINGSUTRA_CATEGORIES],

  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 60));
    const slug = CATEGORY_TO_SLUG[q.category] ?? "wedding-planners";
    const out: RawLead[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_LISTING_PAGES && out.length < limit; page++) {
      // polite paging: one short pause between listing pages
      if (page > 1 && deps.limiter?.sleep) await deps.limiter.sleep(300);
      let read: FallbackRead;
      try {
        read = await readWithFallback(deps, { url: listingUrl(slug, page) });
      } catch {
        break; // blocked/changed page -> stop politely, never throw
      }
      const text = sanitizeUntrusted(read.text);
      const leads = parseListingLeads(text, q.category, limit - out.length, q.city, q.area);
      let added = 0;
      for (const l of leads) {
        if (seen.has(l.sourceUrl)) continue;
        seen.add(l.sourceUrl);
        out.push(l);
        added += 1;
        if (out.length >= limit) break;
      }
      if (added === 0) break; // nothing new on this page -> no more results
    }
    return out.slice(0, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${WEDDINGSUTRA_SITE} "${lead.name}" ${lead.city ?? ""}`.trim(),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        return {
          channel: WEDDINGSUTRA_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = { ...parseWeddingSutraPage(text) };
    const signals = weddingSutraSignals(fields as WeddingSutraFields, text);
    return {
      channel: WEDDINGSUTRA_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => weddingSutraSignals(parseWeddingSutraPage(text), text),
};

registerChannel(weddingsutra);
