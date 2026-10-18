// ChannelAdapter for Urban Company (home and beauty services), Order L56-ch-urbancompany.
//
// Tier C channel in data/india-sources.json (L41, id "urban-company"): OFF by
// default. Enabled only by env LEADSCOUT_INDIA_TIER_C=1 (the same switch the
// sibling tier-C adapters justdial.ts / zomato.ts / sulekha.ts use; no new env
// name is introduced), or the operator-approved browser-read mode on the
// operator's own logged-in browser, gated by LEADSCOUT_BROWSER=1
// (data/browser-allowlist.json already lists urbancompany.com). LEADSCOUT_BROWSER=0
// is a hard kill switch that wins over both.
//
// Read order per page (registry.readWithFallback): search first -> plain page
// read -> browser reader ONLY when both are blocked (403, 429, captcha, empty
// body). A login wall after browser escalation surfaces as needs-human; the
// adapter never re-reads a blocked page and never bypasses needs-human.
//
// Verified 2026-10-09 by web search + a plain fetch of robots.txt:
//  - robots.txt (https://www.urbancompany.com/robots.txt) opens with
//    "Notice: Crawling UrbanCompany is prohibited unless you have express
//    written permission!!!" and disallows /api/*, /auth/*, /admin/*, /pro/*,
//    /request/*, /customer/*, /static/* and more. Confirms the tier C default.
//  - Real category+city URL shapes confirmed from search results:
//    /delhi-ncr-salon-at-home-central-delhi, /bangalore-salon-luxe,
//    /kolkata-salon-basics, /lucknow-salon-luxe.
//  - Real page fields confirmed from search snippets: a heading such as
//    "# Salon Prime" / "Salon Luxe", a rating+count run "4.85 (14.1 M bookings)"
//    and "4.85 (3.7M reviews)", price points "₹1,347" and "Starts at ₹1,419",
//    a duration "2 hrs 25 mins", and the platform blurb "Urban Company is your
//    one-stop destination for expert local services in <City>, India".
//  - The exact markup for "partner vs competes" markers and the price-gap
//    heuristic could NOT be fetched (tier C off; pages not read this run); both
//    stay heuristic over the page text with explicit markers and are reported as
//    UNVERIFIED in the report.
//
// Rules: every field value is copied verbatim from page text or the URL / search
// snippet with its source URL; a value the page does not show stays missing
// (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const URBAN_COMPANY_CHANNEL_ID = "urban-company"; // matches india-sources.json registry data (L41)
export const URBAN_COMPANY_SITE = "urbancompany.com";
const MAX_TEXT = 20000;

export type UrbanCompanyFields = {
  name?: string;
  serviceCategory?: string;
  city?: string;
  pricePoints?: string;
  rating?: number;
  bookingCount?: number;
  reviewCount?: number;
  relationship?: string; // "partner" | "competes" (only when the page says so)
};

// ---- page/snippet parser: only exact matches become fields ------------------

const UC_URL_RE = /https?:\/\/(?:www\.)?urbancompany\.com\/[^\s"'<>*]+/i;
const URL_IN_SNIPPET_RE = /https?:\/\/(?:www\.)?urbancompany\.com\/[^\s"'<>]+/i;
// robots.txt disallows /api/*, /auth/*, /admin/*, /pro/*, /request/*,
// /customer/*, /static/*, /dist/*, /weddings*, /homes*, /s/* and more.
const NON_BUSINESS_PATH_RE =
  /\/(?:api|auth|admin|adminlogin|pro|request|customer|customer_reviews|static|dist|edit-profile|editProfileV2|article|evaluation|resolution|business|images|photos|weddings|homes|fulfillmentSummary|orderFailed|orderSuccessful|add_review|view_quote|provider|request_status|provider_response|request_success|add_reference)(?:\/|\b)|\/s\/|\/(?:reviews|about|careers|terms|privacy|help|faq|login|signup)\/?$/i;
const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?previous\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b/i;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
// "Starts at ₹1,419" / "₹1,347" (the two confirmed price shapes).
const STARTS_PRICE_RE = /\bStarts at ₹\s*[\d,]+/i;
const PRICE_RE = /₹\s*[\d,]+/;
// The confirmed rating+count run: "4.85 (14.1 M bookings)" / "4.85 (3.7M reviews)".
const BOOKINGS_RE = /\b([0-5]\.\d{1,2})\s*\(\s*([\d.,]+\s*[KMB]?)\s*bookings?\b/i;
const REVIEWS_RE = /\b([0-5]\.\d{1,2})\s*\(\s*([\d.,]+\s*[KMB]?)\s*reviews?\b/i;
// The platform's own service families (verbatim keywords; used only to decide
// whether the page is about a covered local-services business).
const SERVICE_RE = /\b(salon|spa|beauty|parlour|repair|repairs|cleaning|clean|pest|appliance|plumbing|electrician|electrical|handyman|massage|facial|waxing)\b/i;
// partner markers vs independent/competitor markers (explicit page text only).
const PARTNER_RE = /\b(?:urban\s*company|uc)\s+partner\b|\bpartner\s+with\s+urban\s*company\b|\bbusiness\s+partner\b/i;
const COMPETES_RE = /\bindependent\s+(?:salon|spa|repair|beauty|parlour|shop|cleaning|service)\b|\bcompeting\s+with\s+urban\s*company\b|\bcompetes?\s+with\s+urban\s*company\b|\bnot\s+(?:a\s+)?partner\b|\bunaffiliated\b/i;
// a duration token confirms it is a platform service page ("2 hrs 25 mins").
const UC_CITY_MARKER_RE = /(?:^|\/)([a-z][a-z-]{2,20})-(?:salon|spa|repair|repairs|cleaning|clean|pest|home|beauty|plumbing|electrician|appliance|ac|massage)(?:-|\/|$)/i;

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Expand a verbatim "14.1 M" / "3.7M" / "1,347" count to an integer. Deterministic
 *  arithmetic on the page's own text; never invents a count that is not shown. */
export function expandCount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/,/g, "").trim().match(/^([\d.]+)\s*([KMB]?)$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const mult = m[2] ? { K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] : 1;
  return Math.round(n * (mult ?? 1));
}

function titleFromSlug(slug: string): string | undefined {
  const s = slug.replace(/[?&#].*$/, "").replace(/-/g, " ").trim();
  if (!s) return undefined;
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function nameFromUrbanCompanyUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!/(^|\.)urbancompany\.com$/i.test(u.hostname)) return undefined;
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    const slug = segs[segs.length - 1];
    if (!slug || /^\d+$/.test(slug)) return undefined;
    return titleFromSlug(slug);
  } catch {
    return undefined;
  }
}

/** Parse an Urban Company service/category page (or a search-snippet block) into
 *  fields. Every value is a verbatim copy from the text or the URL; anything
 *  unmatched stays undefined (never inferred). */
export function parseUrbanCompanyPage(text: string): UrbanCompanyFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ").trim();
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: UrbanCompanyFields = {};

  // name: explicit "Name:" label, else the URL slug (verbatim from the URL).
  const nameLine = lines.find((l) => /^Name\s*[:：]\s*\S/.test(l));
  f.name = nameLine?.replace(/^Name\s*[:：]\s*/, "").trim() || undefined;
  if (f.name === undefined) f.name = nameFromUrbanCompanyUrl(flat.match(UC_URL_RE)?.[0]);

  // service category: an explicit label, else the first "# <Category>" heading.
  const scLine = lines.find((l) => /^(?:Service Category|Service|Category)\s*[:：]\s*\S/i.test(l));
  if (scLine) f.serviceCategory = scLine.replace(/^(?:Service Category|Service|Category)\s*[:：]\s*/i, "").trim() || undefined;
  if (f.serviceCategory === undefined) {
    const heading = lines.find((l) => /^#\s+\S/.test(l));
    if (heading) f.serviceCategory = heading.replace(/^#\s+/, "").trim() || undefined;
  }

  // city: explicit "City:" label, else the city prefix of a confirmed UC URL shape.
  const cityLine = lines.find((l) => /^City\s*[:：]\s*\S/i.test(l));
  if (cityLine) f.city = cityLine.replace(/^City\s*[:：]\s*/, "").trim() || undefined;
  if (f.city === undefined) {
    const m = flat.match(UC_CITY_MARKER_RE);
    if (m) f.city = titleFromSlug(m[1]);
  }

  // price points: the verbatim "Starts at ₹..." phrase, else the first "₹..." span.
  const price = flat.match(STARTS_PRICE_RE)?.[0] ?? flat.match(PRICE_RE)?.[0];
  if (price) f.pricePoints = price.trim();

  // rating + booking/review counts from the confirmed "<rating> (<count> <word>)" run.
  const bookings = flat.match(BOOKINGS_RE);
  const reviews = flat.match(REVIEWS_RE);
  const ratingLine = lines.find((l) => /^Rating\s*[:：]\s*[0-5]/.test(l));
  if (ratingLine) {
    const r = num(ratingLine.replace(/^Rating\s*[:：]\s*/, "").trim());
    if (r !== undefined && r > 0 && r <= 5) f.rating = r;
  }
  if (f.rating === undefined) {
    const r = num(bookings?.[1] ?? reviews?.[1]);
    if (r !== undefined && r > 0 && r <= 5) f.rating = r;
  }
  if (bookings) {
    const n = expandCount(bookings[2]);
    if (n !== undefined) f.bookingCount = n;
  }
  if (reviews) {
    const n = expandCount(reviews[2]);
    if (n !== undefined) f.reviewCount = n;
  }

  // partner vs competes: explicit marker text only; relationship omitted when the
  // page says neither.
  if (PARTNER_RE.test(clean)) f.relationship = "partner";
  else if (COMPETES_RE.test(clean)) f.relationship = "competes";

  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids over parsed fields + raw text:
 *  independent-local-services (independent salon/spa/repair/cleaning/pest business
 *  in a city where Urban Company is active -> competitive pressure, needs its own
 *  booking/reminders) and pricing-gap-vs-platform (the platform shows a price
 *  point while the local business has no booking route). Both are heuristics over
 *  page text with explicit markers; the price-gap rule is UNVERIFIED (see report). */
export function urbanCompanySignals(f: UrbanCompanyFields, text: string = ""): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  const platformMention = /urban\s*company|urbancompany/i.test(t);
  const serviceText = `${f.serviceCategory ?? ""} ${t}`;
  // independent salon / repair / cleaning / pest business competing with the platform.
  if (
    f.relationship === "competes" &&
    SERVICE_RE.test(serviceText) &&
    typeof f.city === "string" && f.city.length > 0 &&
    platformMention
  ) {
    out.push("independent-local-services");
  }
  // platform price point shown while the local business has no booking route.
  const hasPrice = typeof f.pricePoints === "string" && f.pricePoints.length > 0;
  const hasBooking = /\b(?:book now|book online|book appointment|book a slot|online booking|schedule (?:an? )?appointment|reserve now|reserve a slot)\b/i.test(t);
  if (hasPrice && !hasBooking) out.push("pricing-gap-vs-platform");
  return [...new Set(out)];
}

// ---- discovery ---------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. A "Name: <business>" line names the next
 *  Urban Company URL (verbatim); otherwise the name comes from the URL slug.
 *  Lines with no UC URL, or robots-disallowed / non-business paths, skip. */
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
    const name = pendingName ?? nameFromUrbanCompanyUrl(url);
    pendingName = undefined;
    if (!name) continue;
    leads.push({
      name,
      category,
      source: URBAN_COMPANY_CHANNEL_ID,
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
    why: "tier C (urbancompany.com robots.txt fetched 2026-10-09: \"Notice: Crawling UrbanCompany "
      + "is prohibited unless you have express written permission!!!\"; india-sources.json tier C): "
      + `LEADSCOUT_INDIA_TIER_C is "${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off `
      + "(absent and =0 both mean off); the operator-approved browser-read fallback is also off "
      + "(LEADSCOUT_BROWSER is not 1)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const urbanCompany: ChannelAdapter = {
  id: URBAN_COMPANY_CHANNEL_ID,
  name: "Urban Company",
  tier: "C", // india-sources.json (L41): tier C, robots.txt prohibits crawling
  categories: ["salon", "repair-and-services", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    // read order, per the contract: search first (cheapest).
    const read = await readWithFallback(deps, {
      searchQuery: `site:${URBAN_COMPANY_SITE} "${q.category}" "${loc}"`.trim(),
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${URBAN_COMPANY_SITE} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: URBAN_COMPANY_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = { ...parseUrbanCompanyPage(text) };
    const signals = urbanCompanySignals(fields as UrbanCompanyFields, text);
    return {
      channel: URBAN_COMPANY_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => urbanCompanySignals(parseUrbanCompanyPage(text), text),
};

registerChannel(urbanCompany);
