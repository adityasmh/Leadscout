// ChannelAdapter for JustDial (Order L45-ch-justdial).
//
// Tier C channel: OFF by default. Enabled only by env LEADSCOUT_INDIA_TIER_C=1
// (matches india-sources.json, order L41: "JustDial scraping is banned by
// product policy (PLAN_V2 4.3)", tier C), EXCEPT the browser-read mode on the
// operator's own logged-in browser, which the operator has approved
// (data/browser-allowlist.json lists justdial.com). The browser reader is
// injected in deps and only reached by the registry's readWithFallback AFTER
// search and plain page read return blocked results (403/429/captcha/empty).
//
// Verified with web search + robots.txt fetch on 2026-10-07:
//  - robots.txt User-agent:* disallows /functions/, /webmain/, /api/,
//    /gapi/ratings and more; city listing pages are crawlable.
//  - Listing pages show: "<N> Ratings", "<City>- <N> Years\n in Business",
//    "Justdial verified" / "This business Information is verified by Justdial"
//    / "Justdial trust", "Show Number" (phone hidden until revealed),
//    and image "Slide N" galleries with "+ N More".
//  - A JustDial terms-of-service page text could NOT be fetched/verified this
//    run (Akamai blocks plain fetches of justdial.com from outside India);
//    recorded as unverified in the report. Policy default stays tier C.
//
// Rules: every field value is copied verbatim from page text or the URL /
// search snippet with its source URL; a value the page does not show stays
// missing (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const JUSTDIAL_CHANNEL_ID = "justdial"; // matches india-sources.json registry data (L41)
export const JUSTDIAL_SITE = "justdial.com";
const MAX_TEXT = 20000;
// "few ratings" <= this many (listing pages show the exact count; fixtures set the bar)
export const FEW_RATINGS_THRESHOLD = 5;

export type JustdialFields = {
  name?: string; area?: string; phone?: string; rating?: number;
  ratingCount?: number; yearsInBusiness?: number; verified?: string;
  trustBadge?: string; services?: string; photoCount?: number;
  sponsored?: string;
};

// ---- page/snippet parser: only exact matches become fields ------------------

const JD_LISTING_URL_RE = /https?:\/\/(?:www\.)?justdial\.com\/[A-Za-z-]+\/[^\s"'<>*]+/i;
const JD_URL_IN_SNIPPET_RE = /https?:\/\/(?:www\.)?justdial\.com\/[^\s"'<>]+/i;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
const INJECTION_NEVER_COPY = /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)/i;
// JustDial "area directory" pages (not one business): /nct- and /cat- hosts a city-category list.
const NON_BUSINESS_PATH_RE = /\/(nct-|cat-|Business-Directories|Just-Dial\b)/i;

/** Parse a JustDial listing/detail page (or a search snippet block) into
 *  fields. Every value is a verbatim copy from the text; anything unmatched
 *  stays undefined (never inferred). */
export function parseJustdialPage(text: string): JustdialFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const f: JustdialFields = {};

  // name: from the listing URL slug (verbatim from the URL), else a Title line.
  const urlMatch = clean.match(JD_URL_IN_SNIPPET_RE) ?? clean.match(JD_LISTING_URL_RE);
  if (urlMatch) {
    try {
      const path = urlMatch[0].split(/justdial\.com\/?i?/)[1] ?? "";
      const segs = path.replace(/[?&#].*$/, "").split("/").filter(Boolean);
      const slug = segs.length >= 2 ? segs[1] : (segs[0] ?? "");
      const name = slug.split("_")[0].replace(/-/g, " ").trim();
      if (name) f.name = name;
    } catch { /* keep missing */ }
  }
  const titleLine = clean.split(/\r?\n/).map((l) => l.trim())
    .find((l) => /^Name\s*[:：]\s*\S/.test(l));
  f.name = f.name ?? titleLine?.replace(/^Name\s*[:：]/, "").trim() ?? undefined;

  // area: "<Area> in <City>" or "<City>- <N> Years in Business" context.
  const areaLine = clean.split(/\r?\n/).map((l) => l.trim())
    .find((l) => /^[^:\n]{2,60}\s+in\s+[^:\n]{2,80}$/.test(l) && !/https?:/.test(l) && !/^Slide\b/.test(l));
  const areaMatch = areaLine?.match(/^(.+?)\s+in\s+(.+)$/);
  if (areaMatch) f.area = areaMatch[2].trim();

  // phone: only when the page actually shows digits ("Show Number" means hidden).
  if (!/\bShow Number\b/i.test(clean) || clean.match(PHONE_RE)) {
    const phoneLabel = clean.split(/\r?\n/).map((l) => l.trim())
      .find((l) => /^Phone\s*[:：]\s*\+?\d/.test(l));
    const phone = phoneLabel?.replace(/^Phone\s*[:：]\s*/, "").trim()
      ?? flat.match(PHONE_RE)?.[0];
    if (phone) f.phone = phone.trim().replace(/[,;]$/, "");
  }

  // rating + number of ratings: "4.1" next to "38 Ratings".
  const countMatch = flat.match(/([\d,]{1,12})\s+Ratings?\b/i);
  if (countMatch) {
    const n = Number(countMatch[1].replace(/,/g, ""));
    if (Number.isFinite(n)) f.ratingCount = n;
  }
  if (f.ratingCount !== undefined) {
    const ratingRaw = flat.match(/\b([0-5](?:\.\d{1,2}))\b/)?.[1];
    if (ratingRaw) {
      const n = Number(ratingRaw);
      if (Number.isFinite(n) && n > 0 && n <= 5) f.rating = n;
    }
  }

  // years in business: "<City>- <N> Years in Business" (verbatim count).
  const yearsMatch = flat.match(/\b(\d{1,3})\s+Years\s+in Business\b/i);
  if (yearsMatch) {
    const n = Number(yearsMatch[1]);
    if (Number.isFinite(n)) f.yearsInBusiness = n;
  }

  // verified / trust badges: explicit page text only.
  if (/This business Information is verified by Justdial\.?|Justdial verified/i.test(clean)) {
    f.verified = "yes";
  }
  const trust = clean.match(/Justdial trust\b/i);
  if (trust) f.trustBadge = trust[0];

  // services listed: a "Services:" label; never inferred from nearby chips.
  const servicesLine = clean.split(/\r?\n/).map((l) => l.trim())
    .find((l) => /^Services\s*[:：]\s*\S/i.test(l));
  if (servicesLine) f.services = servicesLine.replace(/^Services\s*[:：]\s*/i, "").trim();

  // photos: "<N> Photos" text (or "+ N More" gallery overflow, JD listing style).
  const photoMatch = flat.match(/([\d,]{1,12})\s+photos?\b/i);
  const moreMatch = flat.match(/\+\s*(\d{1,12})\s+More\b/i);
  const photoRaw = (photoMatch?.[1] ?? moreMatch?.[1])?.replace(/,/g, "");
  if (photoRaw !== undefined) {
    const n = Number(photoRaw);
    if (Number.isFinite(n)) f.photoCount = n;
  }
  return { ...f, ...sponsoredField(clean) };
}

function sponsoredField(text: string): Pick<JustdialFields, "sponsored"> {
  return /Trending|Sponsored|Breaking Bargains|Top Picks for you/i.test(text) ? { sponsored: "yes" } : {};
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids over parsed fields + raw text (CONTRACT.md SIGNALS). */
export function justdialSignals(f: JustdialFields, text: string = ""): string[] {
  const out: string[] = [];
  if (typeof f.ratingCount === "number" && f.ratingCount >= 0 && f.ratingCount <= FEW_RATINGS_THRESHOLD) {
    out.push("few-ratings");
  }
  // no external website link anywhere in the text (justdial links do not count)
  if (!/https?:\/\/(?!.*?justdial\.com)[^\s"'<>,)]+/i.test(text)) {
    out.push("no-website-link");
  }
  if (f.sponsored === "yes") out.push("sponsored-or-trending");
  if (/(?:calls?|enquir(?:y|ies)|complaint)[^.?!]{0,80}(?:no|not|never)\s+(?:answer|pick|respond)|no response from (?:the )?(?:business|seller|owner)/i.test(text)) {
    out.push("unanswered-enquiries");
  }
  return out;
}

// ---- helpers ----------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. Name comes from the listing URL slug;
 *  lines with no JustDial URL (or directory pages, not one business) skip. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const m = line.match(JD_URL_IN_SNIPPET_RE);
    if (!m) continue;
    const url = m[0].replace(/[\s,.;]+$/, "");
    if (NON_BUSINESS_PATH_RE.test(url)) continue;
    try {
      const path = url.split(/justdial\.com\/?i?/)[1] ?? "";
      const segs = path.replace(/[?&#].*$/, "").split("/").filter(Boolean);
      const slug = segs.length >= 2 ? segs[1] : (segs[0] ?? "");
      const name = slug.split("_")[0].replace(/-/g, " ").trim();
      if (!name) continue;
      leads.push({
        name,
        category,
        source: JUSTDIAL_CHANNEL_ID,
        sourceUrl: url,
        ...(line.match(PHONE_RE) ? { phone: line.match(PHONE_RE)![0].trim() } : {}),
      });
    } catch { /* skip this line */ }
  }
  return leads;
}

function statusText(): { enabled: boolean; why?: string } {
  if (tierCEnabled()) return { enabled: true };
  if (process.env.LEADSCOUT_BROWSER === "1") {
    return { enabled: true }; // operator-approved read mode on the operator's own browser
  }
  return {
    enabled: false,
    why: "tier C (JustDial scraping is banned by product policy PLAN_V2 4.3): LEADSCOUT_INDIA_TIER_C is "
      + `"${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off (absent and =0 both mean off); `
      + "the operator-approved browser-read fallback is also off (LEADSCOUT_BROWSER is not 1)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const justdial: ChannelAdapter = {
  id: JUSTDIAL_CHANNEL_ID,
  name: "JustDial",
  tier: "C", // india-sources.json (L41): tier C, product policy bans JustDial scraping
  categories: ["clinic", "dentist", "restaurant", "salon", "gym", "school-and-coaching",
    "real-estate", "retail", "repair-and-services", "travel-and-hotels", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    const read = await readWithFallback(deps, {
      searchQuery: `site:${JUSTDIAL_SITE} "${q.category}" ${loc}`.trim(),
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${JUSTDIAL_SITE} "${lead.name}" ${lead.city ?? ""}`.trim(),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: JUSTDIAL_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = parseJustdialPage(text);
    const signals = justdialSignals(fields as JustdialFields, text);
    return {
      channel: JUSTDIAL_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => justdialSignals(parseJustdialPage(text), text),
};

registerChannel(justdial);
