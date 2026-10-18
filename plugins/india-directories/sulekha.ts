// ChannelAdapter for Sulekha (Order L55-ch-sulekha).
//
// India local-services directory (salons, repairs, gyms, coaching, restaurants,
// travel, real estate). Tier C in india-sources.json (L41): robots.txt GET
// returned HTTP 403 and no terms text was fetched, so the source is unverified
// ("conservative tier C default"). OFF by default, enabled only by the same
// env var the sibling tier-C adapter (justdial.ts, L45) uses:
// LEADSCOUT_INDIA_TIER_C=1, or the operator-approved browser-read mode
// (LEADSCOUT_BROWSER=1; data/browser-allowlist.json lists sulekha.com). No new
// env name is introduced.
//
// Read order per page (registry.readWithFallback): search first -> plain page
// read -> browser reader ONLY when both are blocked (403, 429, captcha, empty
// body). Verified 2026-10-07 via web search/fetch:
//  - robots.txt (fetched through a read proxy; direct GET is 403) has a long
//    Disallow list plus a published sitemap
//    (https://www.sulekha.com/sitemap/sulekhasitemapindex.xml); /user/signin and
//    /user/dashboard are disallowed.
//  - Sulekha page GETs from this machine return 403 (Microsoft-Azure-
//    Application-Gateway) for non-Googlebot agents -> the plain page read is
//    blocked and the browser fallback is required.
//  - Real URL shapes confirmed from search results:
//    /beauty-parlour-services/chennai (category+city),
//    /beauty-parlour-services/ashok-nagar-chennai (category+area+city),
//    /lakme-salon-chromepet-chennai-contact-address (one business).
//  - Listing-card fields confirmed from search snippets:
//    "<Name> <Area>, <City>, <PIN>", "<R>/5", "Based on <N> Reviews",
//    "Sulekha score: <N>", "Closed - Opens HH:MM AM", "phone numbers", "user
//    ratings", "reviews", plus "Book for <service>" copy. The exact page markup
//    for a rating value, review count, years in business and the verified badge
//    could NOT be fetched (pages 403) and stays unverified.
//
// Rules: every field value is copied verbatim from page text or the URL /
// search snippet with its source URL; a value the page does not show stays
// missing (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true. Browsing
// respects browser.ts per-platform hourly caps; the adapter never re-reads a
// blocked page (the reader's fallback already handles escalation).
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const SULEKHA_CHANNEL_ID = "sulekha"; // matches india-sources.json registry data (L41)
export const SULEKHA_SITE = "sulekha.com";
const MAX_TEXT = 20000;
/** "listed with few reviews" <= this many (the exact count the card shows; fixtures set the bar). */
export const FEW_REVIEWS_THRESHOLD = 5;
/** "many service categories" >= this many comma/semicolon-separated services. */
export const MANY_SERVICES_THRESHOLD = 5;

export type SulekhaFields = {
  name?: string; services?: string; area?: string; phone?: string;
  rating?: number; reviewCount?: number; yearsInBusiness?: number; verified?: string;
};

// ---- page/snippet parser: only exact matches become fields ------------------

const SULEKHA_URL_RE = /https?:\/\/(?:www\.)?sulekha\.com\/[^\s"'<>*]+/i;
const URL_IN_SNIPPET_RE = /https?:\/\/(?:www\.)?sulekha\.com\/[^\s"'<>]+/i;
// robots.txt disallows /services/, /network/, /adv/, /ESS/, /fps/, /ajax/,
// /handlers/, /js/, /lsapi/, /cgi-bin/, /partners/, /members/, /user/signin,
// /user/dashboard, /articles/, /blog/common/, /getquotes/ and more.
const NON_BUSINESS_PATH_RE =
  /\/(user\/signin|user\/dashboard|services|network|adv|ESS|fps|ajax|handlers|js|lsapi|cgi-bin|partners|members|memberpages|epress|html|expressions|orgsv2|orgs|movies|photo|news|indusinquirer|philosophy|citypages|affiliate|swig|sangam|ticketsV3|getquotes|semtemplatev10|hpfps|business-owners|blog)\b/i;
const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?previous\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b/i;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
// the card hides the number behind a reveal control until clicked.
const PHONE_HIDDEN_RE = /\bShow Number\b|\bContact to view\b|\bGet (?:Phone )?Number\b|\bView Number\b|\bCall Now\b/i;
const RATING_RE = /\b([0-5](?:\.\d{1,2})?)\s*\/\s*5\b/;
// "years in business" is only copied when the page/label literally says it.
const YEARS_RE = /\b(\d{1,3})\+?\s+Years?\s+in Business\b/i;
const VERIFIED_RE = /Sulekha\s+verified|Verified\s+Business|Verified by Sulekha/i;
// "in <Area>, <City>-<PIN>" (the verified real-page / card phrasing).
const AREA_LINE_RE = /\bin\s+([^,]{1,50}),\s*(.+)$/;
const AREA_LINE_GUARD_RE = /\bin\s+[^,]{1,50},\s*[A-Za-z]/;

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function nameFromSulekhaUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!/(^|\.)sulekha\.com$/i.test(u.hostname)) return undefined;
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    const slug = segs[segs.length - 1];
    if (!slug) return undefined;
    const name = slug.replace(/-contact-address$/i, "").replace(/-/g, " ").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Parse a Sulekha listing/detail page (or search snippet block) into fields.
 *  Every value is a verbatim copy from the text or the URL; anything unmatched
 *  stays undefined (never inferred). */
export function parseSulekhaPage(text: string): SulekhaFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const lines = clean.split(/\r?\n/).map((l) => l.trim());
  const f: SulekhaFields = {};

  // name: an explicit "Name:" label, else the business-page URL slug (verbatim).
  const nameLine = lines.find((l) => /^Name\s*[:：]\s*\S/.test(l));
  f.name = nameLine?.replace(/^Name\s*[:：]\s*/, "").trim() || undefined;
  if (f.name === undefined) f.name = nameFromSulekhaUrl(flat.match(SULEKHA_URL_RE)?.[0]);

  // services: only an explicit "Services:" / "Services Offered:" label line.
  const servicesLine = lines.find((l) => /^Services(?:\s+Offered)?\s*[:：]\s*\S/i.test(l));
  if (servicesLine) f.services = servicesLine.replace(/^Services(?:\s+Offered)?\s*[:：]\s*/i, "").trim();

  // area: "<locality>, <city>" from the verified "in <Area>, <City>-<PIN>" line.
  const areaLine = lines.find((l) => AREA_LINE_GUARD_RE.test(l) && !/https?:/.test(l));
  if (areaLine) {
    const areaMatch = areaLine.match(AREA_LINE_RE);
    if (areaMatch) {
      const locality = areaMatch[1].trim();
      const city = areaMatch[2].trim().replace(/\s*-\s*\d{6}.*$/, "").replace(/\s+\d.*$/, "").trim();
      if (locality && city) f.area = `${locality}, ${city}`;
    }
  }

  // phone: only when the page actually shows digits; a reveal control means hidden.
  const phoneLine = lines.find((l) => /^(?:Phone|Mobile|Contact(?:\s+Number)?)\s*[:：]\s*\+?\d/.test(l));
  const shown = phoneLine?.replace(/^(?:Phone|Mobile|Contact(?:\s+Number)?)\s*[:：]\s*/, "").trim();
  if (shown && !PHONE_HIDDEN_RE.test(clean)) {
    f.phone = shown.replace(/[,;]$/, "");
  } else if (!PHONE_HIDDEN_RE.test(clean)) {
    const bare = flat.match(PHONE_RE)?.[0];
    if (bare) f.phone = bare.trim().replace(/[,;]$/, "");
  }

  // rating: "<R>/5" only (the confirmed card format).
  const rating = num(RATING_RE.exec(flat)?.[1]);
  if (rating !== undefined && rating > 0 && rating <= 5) f.rating = rating;

  // review count: "Based on <N> Reviews" / "<N> Reviews".
  const count = num(flat.match(/([\d,]{1,12})\s+Reviews?\b/i)?.[1]);
  if (count !== undefined) f.reviewCount = count;

  // years in business: the literal "<N> Years in Business".
  const years = num(YEARS_RE.exec(flat)?.[1]);
  if (years !== undefined) f.yearsInBusiness = years;

  // verified badge: explicit "Sulekha verified" / "Verified Business" text only.
  if (VERIFIED_RE.test(clean)) f.verified = "yes";

  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids over parsed fields + raw text:
 *  few-reviews, no-website-link, many-services-no-booking,
 *  unresolved-complaints. */
export function sulekhaSignals(f: SulekhaFields, text: string = ""): string[] {
  const out: string[] = [];
  // listed with few reviews
  if (typeof f.reviewCount === "number" && f.reviewCount >= 0 && f.reviewCount <= FEW_REVIEWS_THRESHOLD) {
    out.push("few-reviews");
  }
  // no external website link anywhere (sulekha.com links do not count)
  if (!/https?:\/\/(?!.*?sulekha\.com)[^\s"'<>,)]+/i.test(text)) {
    out.push("no-website-link");
  }
  // many service categories but no booking route
  const serviceCount = String(f.services ?? "").split(/[,;|]/).map((s) => s.trim()).filter(Boolean).length;
  const hasBooking = /\b(?:book\s+(?:now|appointment|online|a\s+slot|your)|online\s+booking|schedule\s+(?:an?\s+)?appointment|reserve\s+(?:now|a|your)|enquire\s+now|get\s+a\s+quote)\b/i.test(text);
  if (serviceCount >= MANY_SERVICES_THRESHOLD && !hasBooking) out.push("many-services-no-booking");
  // unanswered review complaints
  if (/(?:review|complaint|feedback|reviewer)[^.?!]{0,100}(?:no|not|never)\s+(?:respond|answer|repl|acknowledg)|no response from (?:the )?(?:business|owner|salon|clinic|store|firm)|(?:complaint|issue)[^.?!]{0,60}(?:unresolved|unaddressed|ignored|pending)/i.test(text)) {
    out.push("unresolved-complaints");
  }
  return [...new Set(out)];
}

// ---- discovery ---------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. A `Name: <business>` line names the next
 *  Sulekha URL (verbatim); otherwise the name comes from the URL slug. Lines
 *  with no Sulekha URL, or non-business/robots-disallowed paths, skip. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  let pendingName: string | undefined;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const line = rawLine.trim();
    const nameLabel = line.match(/^Name\s*[:：]\s*(.+)$/i);
    if (nameLabel) {
      pendingName = nameLabel[1].trim();
      continue;
    }
    const m = line.match(URL_IN_SNIPPET_RE);
    if (!m) continue;
    const url = m[0].replace(/[\s,.;]+$/, "");
    if (NON_BUSINESS_PATH_RE.test(url)) continue;
    const name = pendingName ?? nameFromSulekhaUrl(url);
    pendingName = undefined;
    if (!name) continue;
    leads.push({
      name,
      category,
      source: SULEKHA_CHANNEL_ID,
      sourceUrl: url,
      ...(line.match(PHONE_RE) ? { phone: line.match(PHONE_RE)![0].trim() } : {}),
    });
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
    why: "tier C (Sulekha robots/terms unverified: robots.txt GET 403 on 2026-10-07, pages 403 "
      + "to non-Googlebot; india-sources.json tier C): LEADSCOUT_INDIA_TIER_C is "
      + `"${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off (absent and =0 both mean off); `
      + "the operator-approved browser-read fallback is also off (LEADSCOUT_BROWSER is not 1)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const sulekha: ChannelAdapter = {
  id: SULEKHA_CHANNEL_ID,
  name: "Sulekha",
  tier: "C", // india-sources.json (L41): tier C, robots/terms unverified
  categories: ["salon", "repair-and-services", "gym", "school-and-coaching",
    "restaurant", "travel-and-hotels", "real-estate", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    // read order, per the contract: search first (cheapest).
    const read = await readWithFallback(deps, {
      searchQuery: `site:${SULEKHA_SITE} "${q.category}" "${loc}"`.trim(),
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${SULEKHA_SITE} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: SULEKHA_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = { ...parseSulekhaPage(text) };
    const signals = sulekhaSignals(fields as SulekhaFields, text);
    return {
      channel: SULEKHA_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => sulekhaSignals(parseSulekhaPage(text), text),
};

registerChannel(sulekha);
