// ChannelAdapter for Facebook Pages and the Meta Ad Library (Order L51-ch-facebook).
//
// Tier C channel: OFF by default. Matches india-sources.json (L41) id
// "facebook-pages", tier C, because facebook.com/robots.txt says "Collection of
// data on Facebook through automated means is prohibited unless you have express
// written permission from Facebook" (verified 2026-10-07; see report). Enabled
// only by env LEADSCOUT_INDIA_TIER_C=1 (the tier-C switch from india-sources.ts),
// OR the operator-approved read-only browser mode (LEADSCOUT_BROWSER=1), exactly
// like the JustDial adapter (L45). The official Graph API is the sanctioned route
// and is out of scope here.
//
// Read order for every page (registry.readWithFallback): search first, then a
// plain page read, then the browser reader ONLY when both returned a blocked
// result (403 / 429 / captcha / empty body). The browser reader runs on the
// operator's own logged-in session (OpenCLI backend when connected); a login
// wall yields needs-human, never solved or bypassed. The per-platform caps,
// pauses, allowlist and one-page-at-a-time queue in browser.ts are respected by
// never retrying a blocked page and by using the registry's own fallback.
//
// Fields are copied verbatim from page text or a search snippet with its source
// URL; a value the page does not show stays missing (never inferred or invented).
// The Meta Ad Library (facebook.com/ads/library) is read by business name to see
// whether the Page runs ads; both texts are neutralised with
// reach.sanitizeUntrusted and stored as untrusted evidence.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const FACEBOOK_CHANNEL_ID = "facebook-pages"; // matches india-sources.json registry data (L41)
export const FACEBOOK_SITE = "facebook.com";
export const FACEBOOK_AD_LIBRARY_URL = "https://www.facebook.com/ads/library/";
const MAX_TEXT = 20000;
// A Page with no post on/after this many days is "inactive" (signal below).
export const INACTIVE_DAYS = 30;
// "Poor" website = a link-in-bio / aggregator / social-profile stand-in, i.e. a
// page that exists only to funnel, not a real business site. Used with ads.
export const POOR_SITE_RE =
  /(?:^|\.)(?:linktr\.ee|linkin\.bio|beacons\.ai|taplink\.cc|bio\.link|linkr\.bio|wa\.me|whatsapp\.com|facebook\.com|instagram\.com|bit\.ly|tinyurl\.com|carrd\.co|wixsite\.com|blogspot\.com|wordpress\.com|godaddysites\.com)\b/i;

export const FB_SIGNALS = {
  adsPoorWebsite: "ads-poor-website",
  inactive: "page-inactive-30d",
  slowReply: "slow-reply",
  noWebsite: "no-website",
  whatsappOnly: "whatsapp-only-about",
} as const;

export type FacebookFields = {
  name?: string; category?: string; followers?: number; likes?: number;
  recommendationPercent?: number; reviewCount?: number;
  phone?: string; email?: string; website?: string; hours?: string; address?: string;
  lastPostDate?: string; messaging?: string; replyTime?: string;
};

export type FacebookAdFields = { activeAdsCount?: number; earliestAdDate?: string };

// ---- page/snippet parser: only exact matches become fields ------------------

const FB_URL_RE = /https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/[^\s"'<>]+/i;
const NON_PAGE_PATH_RE =
  /\/(?:ads|ads\/library|login|login\/|help|privacy|policies|terms|legal|business|settings|messages|notifications|marketplace|groups|events|watch|gaming|reels?|stories|photo|video|hashtag|sharer|plugins|campaign|cause)(?:\/|$|\?)/i;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const INJECTION_NEVER_COPY = /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)/i;
const NAV_WORDS = new Set([
  "log in", "login", "sign up", "home", "about", "posts", "reels", "photos", "videos",
  "more", "follow", "following", "followers", "message", "send message", "see more", "see all",
  "contact info", "page transparency", "privacy", "terms", "advertising", "cookies", "meta",
]);

function linesOf(text: string): string[] {
  return String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Parse a count that may carry a K/M suffix and/or thousands separators
 *  ("1.3K", "5K", "2,185", "~400", "50,000"). Returns undefined if not a count. */
export function parseCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const s = String(raw).trim().replace(/^[~≈]\s*/, "").replace(/,/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([KkMm])?$/);
  if (!m) return undefined;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const suf = m[2]?.toLowerCase();
  if (suf === "k") n *= 1000;
  else if (suf === "m") n *= 1_000_000;
  return Math.round(n);
}

function labelled(lines: string[], label: string): string | undefined {
  const re = new RegExp(`^${label}\\s*[:：]\\s*(.+)$`, "i");
  const hit = lines.find((l) => re.test(l));
  const v = hit?.match(re)?.[1]?.trim();
  return v || undefined;
}

/** Parse a Facebook Page about/posts page (or a search snippet block) into
 *  fields. Every value is a verbatim copy from the text or URL; anything the
 *  text does not show stays undefined (never inferred). Injected instruction
 *  lines are dropped before parsing. */
export function parseFacebookPage(text: string): FacebookFields {
  const raw = String(text ?? "");
  const clean = linesOf(raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n")).join("\n");
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const flat = lines.join(" ");
  const f: FacebookFields = {};

  // name: a Name: label, else the /pages/<Name>/<id> URL slug, else the first
  // line that is not a nav word / metric / label / URL.
  f.name = labelled(lines, "Name");
  if (!f.name) {
    const url = clean.match(FB_URL_RE)?.[0];
    if (url) {
      const path = url.replace(/^https?:\/\/[^/]+/i, "").replace(/[?#].*$/, "");
      const segs = path.split("/").filter(Boolean);
      const slug = segs[0]?.toLowerCase() === "pages" ? (segs[1] ?? "") : (segs[0] ?? "");
      const decoded = (() => { try { return decodeURIComponent(slug); } catch { return slug; } })()
        .replace(/[-_]+/g, " ").trim();
      if (decoded && !/^(pages|people|profile\.php)$/i.test(decoded)) f.name = decoded;
    }
  }
  if (!f.name) {
    const cand = lines.find((l) =>
      l.length >= 2 && l.length <= 80
      && !NAV_WORDS.has(l.toLowerCase())
      && !/^\d/.test(l)
      && !/[:：]/.test(l)
      && !/https?:/i.test(l)
      && !/\b(?:followers?|likes?|reviews?|following)\b/i.test(l));
    if (cand) f.name = cand;
  }

  // category: a Categories/Category label, else a "A · B · C" dot-separated line
  // that is not the page name.
  f.category = labelled(lines, "Categories") ?? labelled(lines, "Category");
  if (!f.category) {
    const dot = lines.find((l) => /^[A-Z][\w &'’.-]{1,40}(?:\s*[·|]\s*[A-Z][\w &'’.-]{1,40})+$/.test(l));
    if (dot) f.category = dot;
  }

  // followers / likes: exact count words with an optional K/M suffix.
  const fol = flat.match(/\b([~≈]?\s*\d[\d,.]*\s*[KkMm]?)\s+followers?\b/i)?.[1];
  const folCount = parseCount(fol);
  if (folCount !== undefined) f.followers = folCount;
  const like = flat.match(/\b([~≈]?\s*\d[\d,.]*\s*[KkMm]?)\s+(?:people\s+)?likes?\b/i)?.[1]
    ?? flat.match(/\b([~≈]?\s*\d[\d,.]*\s*[KkMm]?)\s+people\s+like this\b/i)?.[1];
  const likeCount = parseCount(like);
  if (likeCount !== undefined) f.likes = likeCount;

  // recommendation percentage + review count: "100% recommend (2,185 reviews)"
  // or "Not yet rated (3 Reviews)".
  const rec = flat.match(/(\d{1,3})%\s+recommend/i)?.[1];
  if (rec !== undefined) {
    const n = Number(rec);
    if (Number.isFinite(n) && n >= 0 && n <= 100) f.recommendationPercent = n;
  }
  const rev = flat.match(/\(([\d,]+)\s+reviews?\)/i)?.[1]
    ?? flat.match(/\b([\d,]+)\s+reviews?\b/i)?.[1];
  const revCount = rev !== undefined ? Number(rev.replace(/,/g, "")) : undefined;
  if (revCount !== undefined && Number.isFinite(revCount)) f.reviewCount = revCount;

  // phone: labelled first, else a +country number span.
  const phone = labelled(lines, "Phone") ?? labelled(lines, "Mobile") ?? flat.match(PHONE_RE)?.[0];
  if (phone) f.phone = phone.trim().replace(/[,;]$/, "");

  // email.
  const email = labelled(lines, "Email") ?? flat.match(EMAIL_RE)?.[0];
  if (email) f.email = email.trim();

  // website: a Website label, else an http(s) URL that is not a Facebook one.
  const site = labelled(lines, "Website");
  if (site) f.website = site.split(/\s/)[0];
  else {
    const u = clean.match(/https?:\/\/(?!.*?facebook\.com)[^\s"'<>)]+/i)?.[0];
    if (u) f.website = u.replace(/[.,;]+$/, "");
  }

  // hours: an Hours label, else an explicit open/closed status run.
  f.hours = labelled(lines, "Hours")
    ?? clean.match(/(?:Open now|Closed now|Open 24 hours|Open\s*⋅\s*Closes[^\n]*|Closed\s*⋅\s*Opens[^\n]*)/i)?.[0]?.trim();

  // address: an Address label, else the line immediately before a lone "Address".
  f.address = labelled(lines, "Address");
  if (!f.address) {
    const idx = lines.findIndex((l) => /^address\b/i.test(l) && l.length <= 10);
    if (idx > 0) {
      const prev = lines[idx - 1];
      if (/\d/.test(prev) && prev.length >= 5 && prev.length <= 160) f.address = prev;
    }
  }

  // last post date: a "Last post" label, a relative post age, or "Just now" /
  // "Yesterday". Lines that are ad-library "Started running on" data are ignored.
  const postLines = lines.filter((l) => !/started running on/i.test(l));
  const postFlat = postLines.join(" ");
  const lastLabel = labelled(postLines, "Last post");
  const rel = postFlat.match(/\b((?:Just now)|(?:Yesterday)|(?:\d+\s+(?:minute|hour|day|week|month|year)s?\s+ago))\b/i)?.[1];
  if (lastLabel) f.lastPostDate = lastLabel;
  else if (rel) f.lastPostDate = rel;

  // messaging availability + typical reply time.
  if (/Send message|Send Message|Messenger\b/i.test(clean) || labelled(lines, "Messaging")) f.messaging = "yes";
  const reply = clean.match(/Typically replies\s+(?:within|in)\s+([^\n.·]+)/i)?.[1]
    ?? labelled(lines, "Reply time") ?? labelled(lines, "Replies");
  if (reply) f.replyTime = reply.trim();

  return f;
}

/** Parse the Meta Ad Library results text for the active-ad count and the
 *  earliest "Started running on <date>". Only values present in the text are
 *  returned; a count or date the page does not show stays missing. */
export function parseAdLibrary(text: string): FacebookAdFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const out: FacebookAdFields = {};
  const results = flat.match(/[~≈]?\s*(\d[\d,]*)\s+results?\b/i)?.[1];
  const active = flat.match(/([\d,]+)\s+active ads?\b/i)?.[1];
  const count = parseCount(results ?? active);
  if (count !== undefined) out.activeAdsCount = count;

  const dates: { text: string; t: number }[] = [];
  const re = /Started running on\s+([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t)) dates.push({ text: m[1], t });
  }
  if (dates.length > 0) {
    dates.sort((a, b) => a.t - b.t);
    out.earliestAdDate = dates[0].text;
  }
  return out;
}

// ---- inactivity helper ------------------------------------------------------

/** Whole days since the (verbatim) last-post value, or 0 when it cannot be
 *  determined. Relative labels are converted at their conventional lengths; an
 *  absolute date is parsed; anything else returns 0 (never guessed). */
export function pageInactiveDays(lastPostDate: string | undefined, nowMs: number): number {
  const s = String(lastPostDate ?? "").trim();
  if (!s) return 0;
  const rel = s.match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult: Record<string, number> = { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 };
    return n * (mult[unit] ?? 0);
  }
  if (/just now/i.test(s)) return 0;
  if (/yesterday/i.test(s)) return 1;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, (nowMs - t) / 86_400_000);
  return 0;
}

// ---- signals ----------------------------------------------------------------

/** Stable, channel-specific signal ids over parsed fields + raw text
 *  (CONTRACT.md SIGNALS plus Facebook ids declared in the report). */
export function facebookSignals(f: FacebookFields & FacebookAdFields, text: string, nowMs: number): string[] {
  const out: string[] = [];
  const hasWebsite = typeof f.website === "string" && f.website.trim() !== "";
  const poorSite = hasWebsite && POOR_SITE_RE.test(f.website as string);
  if (typeof f.activeAdsCount === "number" && f.activeAdsCount > 0 && (!hasWebsite || poorSite)) {
    out.push(FB_SIGNALS.adsPoorWebsite);
  }
  if (pageInactiveDays(f.lastPostDate, nowMs) >= INACTIVE_DAYS) out.push(FB_SIGNALS.inactive);
  if (f.messaging === "yes" && (!f.replyTime || /day|week|month|year|never|slow/i.test(f.replyTime))) {
    out.push(FB_SIGNALS.slowReply);
  }
  if (!hasWebsite) out.push(FB_SIGNALS.noWebsite);
  if (!hasWebsite && /(?:wa\.me|api\.whatsapp\.com|\bwhatsapp\b)/i.test(text)) {
    out.push(FB_SIGNALS.whatsappOnly);
  }
  return out;
}

// ---- helpers ----------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. Name comes from the Facebook Page URL
 *  slug (verbatim from the URL); non-Page URLs (ads, login, help, groups, ...)
 *  and lines with no Facebook URL are skipped. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  const seen = new Set<string>();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const m = line.match(FB_URL_RE);
    if (!m) continue;
    const url = m[0].replace(/[\s,.;]+$/, "");
    if (NON_PAGE_PATH_RE.test(url)) continue;
    let name = "";
    try {
      const path = url.replace(/^https?:\/\/[^/]+/i, "").replace(/[?#].*$/, "");
      const segs = path.split("/").filter(Boolean);
      const slug = segs[0]?.toLowerCase() === "pages" ? (segs[1] ?? "") : (segs[0] ?? "");
      name = decodeURIComponent(slug).replace(/[-_]+/g, " ").trim();
    } catch { name = ""; }
    if (!name || /^(pages|people|profile\.php)$/i.test(name)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    leads.push({
      name,
      category,
      source: FACEBOOK_CHANNEL_ID,
      sourceUrl: url,
      ...(line.match(PHONE_RE) ? { phone: line.match(PHONE_RE)![0].trim() } : {}),
    });
  }
  return leads;
}

export function adLibraryUrl(name: string): string {
  return `${FACEBOOK_AD_LIBRARY_URL}?active_status=active&ad_type=all&country=ALL`
    + `&q=${encodeURIComponent(String(name ?? ""))}&search_type=keyword_unordered`;
}

/** Read the Meta Ad Library for a business name. The operator's browser reader
 *  is preferred (logged-in session, OpenCLI backend when connected); otherwise a
 *  plain page read. Any failure yields "" so ad fields simply stay missing. */
async function readAdLibrary(lead: RawLead, deps: ChannelDeps): Promise<string> {
  const url = adLibraryUrl(lead.name);
  try {
    if (deps.browser) {
      const b = await deps.browser.read(url, { platform: "facebook", reason: "meta ad library search" });
      return b.text;
    }
    const r = await deps.readPage(url);
    return r.ok ? r.text : "";
  } catch {
    return "";
  }
}

function statusText(): { enabled: boolean; why?: string } {
  if (tierCEnabled()) return { enabled: true };
  if (process.env.LEADSCOUT_BROWSER === "1") return { enabled: true }; // operator-approved read mode
  return {
    enabled: false,
    why: "tier C (facebook.com/robots.txt forbids automated collection without written permission; "
      + "the official Graph API is the sanctioned route): LEADSCOUT_INDIA_TIER_C is "
      + `"${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off (absent and =0 both mean off); `
      + "the operator-approved browser-read fallback is also off (LEADSCOUT_BROWSER is not 1)",
  };
}

// ---- the adapter -------------------------------------------------------------

export const facebook: ChannelAdapter = {
  id: FACEBOOK_CHANNEL_ID,
  name: "Facebook Pages",
  tier: "C", // india-sources.json (L41): facebook-pages is tier C
  categories: ["restaurant", "salon", "gym", "retail", "school-and-coaching", "legal-and-accounting", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    const read = await readWithFallback(deps, {
      searchQuery: `site:${FACEBOOK_SITE}/pages "${q.category}" "${loc}"`.trim(),
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${FACEBOOK_SITE} "${lead.name}" ${lead.city ?? ""}`.trim(),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: FACEBOOK_CHANNEL_ID,
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
    const mainText = sanitizeUntrusted(read.text);
    const adText = sanitizeUntrusted(await readAdLibrary(lead, deps));
    const fields: Record<string, string | number | undefined> = {
      ...parseFacebookPage(mainText),
      ...parseAdLibrary(adText),
    };
    const combined = `${mainText}\n${adText}`;
    const signals = facebookSignals(fields as FacebookFields & FacebookAdFields, combined, (deps.now ?? Date.now)());
    return {
      channel: FACEBOOK_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: combined.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] =>
    facebookSignals(parseFacebookPage(text), sanitizeUntrusted(text), Date.now()),
};

registerChannel(facebook);
