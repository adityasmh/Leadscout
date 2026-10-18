// ChannelAdapter for WeddingWire India (weddingwire.in) - Order WE3-ch-weddingwire-in.
//
// Public wedding/event vendor directory. Tier B: pages are public, but a plain
// GET from outside India returns 403 (verified 2026-10-12: both a direct fetch
// and the reach web path returned "non 2xx status code (403)"), so discovery
// and enrichment go through the injected read chain (registry.readWithFallback:
// search -> plain page read -> browser only when both are blocked). OFF by
// default; enabled only when env CHANNEL_CH_WEDDINGWIRE_IN=1.
//
// Real page structure confirmed 2026-10-12 from public listing/profile pages
// read through a read proxy (direct weddingwire.in GET is 403):
//  - Listing URL shapes: /wedding-planners/<city>, /wedding-planners/<city>/<area>
//    (e.g. /wedding-decorators/mumbai/powai); the same shape for the other
//    categories (/wedding-photographers/<city>, /wedding-venues/<city>, ...).
//  - Listing cards render as: badge "TOP"/"PREMIUM" then a markdown heading
//    "## [<Name>](https://www.weddingwire.in/<cat>/<slug>--e<id>)", the line
//    "<rating> (<reviews>)  ·<Area>, <City>", a description, and
//    "From ₹<price>   <promotions>   Request pricing   Responds within 24 hours".
//  - Profile pages render as: "# <Name>", "<r> out of 5 rating <r> <label>
//    <N> reviews", "<Area>, <City>", "Planning fee ₹<price>", "<V> videos
//    <P> photos", "On Weddingwire.in since <YYYY>", "<N> years of experience",
//    a "What specific wedding planning services does <Name> provide?" FAQ with
//    "- <service>" bullets, "## Awards <N>", locations ("Served in ...",
//    "locations in India", "international locations"), and payment methods.
//  - Pagination: the listing shows a result count and a paged list; the query
//    parameter is requested as ?page=N here and is UNVERIFIED (recorded in the
//    report). Fixtures use it; a changed page yields no cards and simply stops.
//
// Rules: every field value is copied verbatim from page text or the URL; a value
// the page does not show stays missing (never inferred or invented). Only
// business contact data is captured. All fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const WEDDINGWIRE_IN_CHANNEL_ID = "ch-weddingwire-in";
export const WEDDINGWIRE_IN_SITE = "weddingwire.in";
const MAX_TEXT = 20000;
const MAX_LIMIT = 50;
const MAX_PAGES = 5;
const PAGE_PAUSE_MS = 2000;

/** Canonical WeddingWire category path -> canonical Leadscout category id.
 *  Only categories this source really lists are included. Destination-wedding
 *  agent has no distinct directory path on weddingwire.in (destination vendors
 *  appear inside the planner/photographer lists), so it is left out. */
export const CATEGORY_PATHS: Record<string, string> = {
  "wedding-planner": "wedding-planners",
  "event-company": "wedding-planners",
  "wedding-decorator": "wedding-decorators",
  "photographer": "wedding-photographers",
  "banquet-hall": "wedding-venues",
  "caterer": "caterers",
  "bridal-wear": "bridal-lehenga",
  "makeup-artist": "bridal-makeup-artists",
  "dj-entertainer": "wedding-dj",
  "florist": "florists",
  "invitation-designer": "wedding-invitations",
  "jewellery-store": "bridal-jewellery",
};

export type WeddingwireInFields = {
  name?: string;
  area?: string;
  city?: string;
  rating?: number;
  reviewCount?: number;
  priceFrom?: number;
  priceLabel?: string;
  photoCount?: number;
  videoCount?: number;
  services?: string;
  yearsInBusiness?: number;
  socials?: string;
  website?: string;
  phone?: string;
  premium?: string;
};

// ---- small helpers ----------------------------------------------------------

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function slugify(value: string | undefined): string | undefined {
  const s = String(value ?? "").trim().toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || undefined;
}

function premiumFromText(text: string): boolean {
  return /\bPREMIUM\b|\bTOP\b|\bFeatured\b|\bVerified Plus\b|\bVerified\+/.test(text);
}

function multiCityFromText(text: string): boolean {
  if (/\bServed in\b[\s\S]{0,200}(?:,| and )/i.test(text)) return true;
  if (/locations? in India[\s\S]{0,500}(?:- .+\n){2,}/i.test(text)) return true;
  if (/international locations[\s\S]{0,400}(?:- .+\n){1,}/i.test(text)) return true;
  return false;
}

function priceFromText(text: string): boolean {
  return /(?:₹\s*[\d,]+)|\b(?:From|Planning fee|Starting (?:price|fee)|Price range)\b/i.test(text);
}

function socialLinks(text: string): string | undefined {
  const re = /https?:\/\/(?:www\.)?(?:facebook|instagram|youtube|twitter|x|vimeo)\.com\/[^\s"'<>)·]+/gi;
  const links = [...new Set((text.match(re) ?? []).map((u) => u.replace(/[.,;]+$/, "")))];
  return links.length ? links.join(", ") : undefined;
}

function externalWebsite(text: string): string | undefined {
  const labelled = text.match(/\bWebsite\s*[:：]?\s*(https?:\/\/[^\s"'<>)·]+)/i);
  if (labelled) return labelled[1].replace(/[.,;]+$/, "");
  const any = text.match(/https?:\/\/(?!www\.weddingwire\.in|weddingwire\.in)[^\s"'<>)·]+/i);
  if (any && !/facebook\.com|instagram\.com|youtube\.com|youtu\.be|twitter\.com|vimeo\.com|x\.com/i.test(any[0])) {
    return any[0].replace(/[.,;]+$/, "");
  }
  return undefined;
}

function servicesFromLines(lines: string[]): string | undefined {
  const start = lines.findIndex((l) =>
    /services?[^.\n]*\bprovide\b/i.test(l) || /expertises? in the following/i.test(l) || /following .*services/i.test(l));
  if (start < 0) return undefined;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && out.length < 15; i++) {
    const l = lines[i].trim();
    if (/^#{1,6}\s/.test(l)) break;
    const m = l.match(/^[-*•]\s+(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out.length ? out.join(", ") : undefined;
}

function nameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!/(^|\.)weddingwire\.in$/i.test(u.hostname)) return undefined;
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    const slug = (segs[segs.length - 1] ?? "").replace(/--e\d+$/i, "");
    const name = slug.replace(/-/g, " ").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

// ---- listing-page parser ----------------------------------------------------

const CARD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/(?:www\.)?weddingwire\.in\/[^\s)]+--e\d+)\)/;

/** Parse a WeddingWire listing page into RawLead[]. Every value is a verbatim
 *  copy from the card text or the URL; a value a card does not show is left
 *  missing. Returns [] when the page has no recognisable cards (blocked or
 *  changed layout). */
export function parseListingPage(text: string, category: string, fallbackCity?: string): RawLead[] {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/);
  const cards: { head: string; body: string[] }[] = [];
  for (const line of lines) {
    if (CARD_LINK_RE.test(line)) {
      cards.push({ head: line, body: [] });
      continue;
    }
    if (cards.length) cards[cards.length - 1].body.push(line);
  }
  const leads: RawLead[] = [];
  for (const card of cards) {
    const m = card.head.match(CARD_LINK_RE);
    if (!m) continue;
    const name = m[1].trim();
    const url = m[2].trim();
    const block = [card.head, ...card.body].join("\n");

    let city = fallbackCity;
    let area: string | undefined;
    const areaLine = [card.head, ...card.body].find((l) => l.includes("·"));
    if (areaLine) {
      const am = areaLine.match(/·\s*([^,\n]+),\s*([^\n]+)/);
      if (am) {
        area = am[1].trim();
        city = am[2].trim().replace(/\s*\(.*$/, "").trim() || city;
      }
    }
    const phoneMatch = block.match(/(\+91[\s-]?\d[\d\s-]{8,}\d)/);
    leads.push({
      name,
      category,
      source: WEDDINGWIRE_IN_CHANNEL_ID,
      sourceUrl: url,
      ...(area ? { address: area } : {}),
      ...(city ? { city } : {}),
      ...(phoneMatch ? { phone: phoneMatch[1].replace(/\s+$/, "") } : {}),
    });
  }
  return leads;
}

// ---- profile-page parser ----------------------------------------------------

/** Parse a WeddingWire vendor profile into fields. Every value is copied
 *  verbatim; anything the page does not show stays undefined. */
export function parseWeddingwirePage(text: string): WeddingwireInFields {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const flat = raw.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const f: WeddingwireInFields = {};

  const h1 = lines.find((l) => /^#\s+\S/.test(l) && !/^##/.test(l));
  f.name = h1?.replace(/^#\s+/, "").trim() || undefined;
  if (!f.name) {
    const link = raw.match(CARD_LINK_RE);
    f.name = link?.[1].trim() || nameFromUrl(link?.[2]);
  }

  const areaLine = lines.find((l) => /^[A-Z][^,\n]{1,50},\s+[A-Za-z][A-Za-z .-]{2,40}$/.test(l));
  if (areaLine) {
    const am = areaLine.match(/^([^,]+),\s+(.+)$/);
    if (am) { f.area = am[1].trim(); f.city = am[2].trim(); }
  }

  const rating = num(flat.match(/([0-5](?:\.\d{1,2})?)\s+out of 5 rating/i)?.[1]);
  if (rating !== undefined && rating > 0) f.rating = rating;
  const reviews = num(flat.match(/([\d,]{1,12})\s+reviews?\b/i)?.[1]);
  if (reviews !== undefined) f.reviewCount = reviews;

  const price = flat.match(/(?:Planning fee|From|Starting (?:price|fee))\s*₹\s*([\d,]+)/i);
  if (price) {
    const n = num(price[1]);
    if (n !== undefined) { f.priceFrom = n; f.priceLabel = `₹${price[1]}`; }
  }

  const videos = num(flat.match(/([\d,]{1,12})\s+videos?\b/i)?.[1]);
  if (videos !== undefined) f.videoCount = videos;
  const photos = num(flat.match(/([\d,]{1,12})\s+photos?\b/i)?.[1]);
  if (photos !== undefined) f.photoCount = photos;

  const years = num(flat.match(/(\d{1,3})\+?\s+years?\s+of\s+experience/i)?.[1]);
  if (years !== undefined) f.yearsInBusiness = years;

  f.services = servicesFromLines(lines);
  f.socials = socialLinks(raw);
  f.website = externalWebsite(raw);
  const phone = raw.match(/(\+91[\s-]?\d[\d\s-]{8,}\d)/);
  if (phone) f.phone = phone[1].replace(/\s+$/, "");
  if (premiumFromText(raw)) f.premium = "yes";

  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids over raw page text (CONTRACT.md SIGNALS + the shared
 *  wedding/event ids for order WE1). Heuristics are text-only and documented in
 *  the report; each fires only on an explicit textual cue. */
export function weddingwireSignals(text: string): string[] {
  const t = String(text ?? "");
  const out: string[] = [];

  const videos = num(/(\d+)\s+videos?\b/i.exec(t)?.[1]);
  const photos = num(/(\d+)\s+photos?\b/i.exec(t)?.[1]);
  const hasVideoLink = /youtube\.com|youtu\.be|vimeo\.com/i.test(t);
  const hasVideoWord = /\bvideos?\b|\bfilms?\b|\breels?\b|\bvideograph|\bcinematograph/i.test(t);
  const hasVideo = (videos ?? 0) > 0 || hasVideoLink || hasVideoWord;
  const hasPhotos = (photos ?? 0) > 0 || /\bphotos?\b|\bportfolio\b/i.test(t);
  if (hasVideo) out.push("has-video-portfolio");
  else if (hasPhotos) out.push("portfolio-no-video");

  const reviews = num(/([\d,]{1,12})\s+reviews?\b/i.exec(t)?.[1]);
  if (reviews !== undefined && reviews >= 50) out.push("high-review-count");

  if (premiumFromText(t)) out.push("premium-listing");
  if (multiCityFromText(t)) out.push("multi-city");
  if (priceFromText(t)) out.push("price-band-known");

  const recentNum = t.match(/\b(?:posted|uploaded|shared)\s+(\d{1,3})\s+days?\s+ago\b/i);
  const recentRel = t.match(/\b(?:posted|uploaded|shared)\s+(yesterday|today|this week)\b/i);
  const mentionsVideo = /\breels?\b|\bvideos?\b/i.test(t);
  if (mentionsVideo && ((recentNum && Number(recentNum[1]) <= 30) || !!recentRel)) {
    out.push("social-video-active");
  }

  const lastDays = t.match(/\b(?:last\s+(?:post|posted|update|updated)|no\s+(?:posts?|updates?))\b[\s\S]{0,60}?(\d{1,3})\s+days?\s+ago/i);
  const lastMonths = t.match(/\b(?:last\s+(?:post|posted|update|updated)|no\s+(?:posts?|updates?))\b[\s\S]{0,60}?(\d{1,2})\s+months?\s+ago/i);
  if ((lastDays && Number(lastDays[1]) >= 90) || (lastMonths && Number(lastMonths[1]) >= 3)) {
    out.push("social-inactive");
  }

  return [...new Set(out)];
}

// ---- status and env gate -----------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  const v = process.env.CHANNEL_CH_WEDDINGWIRE_IN;
  if (v === "1") return { enabled: true };
  return {
    enabled: false,
    why: "channel off by default: set CHANNEL_CH_WEDDINGWIRE_IN=1 to enable "
      + `(currently "${String(v ?? "")}").`
      + " Public pages are 403 to non-browser GETs; reads use the injected read chain.",
  };
}

// ---- the adapter ------------------------------------------------------------

export const weddingwireIn: ChannelAdapter = {
  id: WEDDINGWIRE_IN_CHANNEL_ID,
  name: "WeddingWire India",
  tier: "B",
  categories: Object.keys(CATEGORY_PATHS),
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, MAX_LIMIT));
    const path = CATEGORY_PATHS[String(q.category ?? "").trim().toLowerCase()];
    if (!path) return [];
    const citySlug = slugify(q.city);
    if (!citySlug) return [];
    const areaSlug = q.area ? slugify(q.area) : undefined;
    const base = `https://www.${WEDDINGWIRE_IN_SITE}/${path}/${citySlug}${areaSlug ? `/${areaSlug}` : ""}`;

    const leads: RawLead[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES && leads.length < limit; page++) {
      const url = page === 1 ? base : `${base}?page=${page}`;
      if (page > 1 && deps.limiter?.sleep) await deps.limiter.sleep(PAGE_PAUSE_MS);
      let read: FallbackRead;
      try {
        read = await readWithFallback(deps, { url });
      } catch {
        break; // blocked page with no browser fallback: stop, never throw
      }
      const text = sanitizeUntrusted(read.text);
      const pageLeads = parseListingPage(text, q.category, q.city);
      if (pageLeads.length === 0) break; // blocked or changed page: stop cleanly
      for (const lead of pageLeads) {
        if (leads.length >= limit) break;
        if (seen.has(lead.sourceUrl)) continue;
        seen.add(lead.sourceUrl);
        leads.push(lead);
      }
    }
    return leads;
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      read = await readWithFallback(deps, {
        searchQuery: `site:${WEDDINGWIRE_IN_SITE} "${lead.name}" ${lead.city ?? ""}`.trim(),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        return {
          channel: WEDDINGWIRE_IN_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = { ...parseWeddingwirePage(text) };
    return {
      channel: WEDDINGWIRE_IN_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals: weddingwireSignals(text),
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => weddingwireSignals(text),
};

registerChannel(weddingwireIn);
