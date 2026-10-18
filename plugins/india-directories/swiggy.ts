// ChannelAdapter for dining aggregation: Swiggy, Dineout and EazyDiner
// (restaurants, secondary evidence), Order L60-ch-swiggy-dineout.
//
// Tier C channel: OFF by default. Enabled only by env LEADSCOUT_INDIA_TIER_C=1
// (india-sources.ts, L41: swiggy and dineout are tier C) OR the operator-approved
// browser-read mode on the operator's own logged-in browser
// (data/browser-allowlist.json lists the domain), gated by LEADSCOUT_BROWSER=1.
// LEADSCOUT_BROWSER=0 is a hard kill switch. EazyDiner is tier B in the registry
// (robots.txt Allow:/ apart from /checkout and AhrefsBot) but this adapter reads
// it only as secondary dining evidence next to the two tier-C sources, so the
// whole channel keeps the tier-C default.
//
// Read order per page comes from registry.readWithFallback: search first, then a
// plain page read, then the browser reader ONLY when both are blocked
// (403, 429, captcha, empty body). The browser reader enforces its own
// per-platform hourly caps and its 2-6 s pause; this adapter never re-reads a
// blocked page and never bypasses needs-human.
//
// Live verification (2026-10-09, web search + plain fetch):
//  - swiggy.com/robots.txt fetched: "User-agent: * / Allow: /" with Disallow on
//    /product, /cart, /payment, /checkout, /my-account, /auth*, /home and other
//    internal paths; sitemaps published. Swiggy terms text was not fetched
//    (consumer-order pages), so the conservative tier C default stands.
//  - dineout.co.in/robots.txt fetch failed (transport error), matching
//    india-sources.json "robots fetch failed 2026-10-07; unverified -> Tier C".
//    The public listing page also did not fetch this run. Dineout now serves
//    under the "Swiggy Dineout" brand (search results show district.in dining
//    pages for the same restaurants), so its markup is UNVERIFIED.
//  - eazydiner.com/robots.txt fetched: "User-agent: * / Allow: /" with
//    Disallow on /*checkout? and AhrefsBot disallowed. A restaurant page
//    (https://www.eazydiner.com/bengaluru/nagarjuna-indiranagar-334688) fetched
//    and confirms the structure: the name, a cuisine line ("North Indian"),
//    "₹ 800 for two approx.", "<rating>" plus "<N>ratings" / "<N> reviews and
//    <N> ratings", "Open till 3:30 PM" / "Opens at 7:00 PM", "% Cashback 10 +
//    25% Off" style offers, and table-booking copy.
//  - A Swiggy restaurant listing (search excerpts) shows the fields name,
//    cuisines, "4.1 · 30-35 mins", "₹800 for two", "10K+ ratings" and offers
//    such as "FLAT DEAL: 50% OFF"; the live /restaurants page body is
//    JavaScript-rendered (a plain fetch returns a near-empty shell), which is
//    exactly the empty-body case that escalates to the browser reader.
//
// Rules: every field value is copied verbatim from page text or the source URL;
// a value the page does not show stays missing (never inferred or invented).
// All fetched text is neutralised via reach.sanitizeUntrusted and evidence is
// marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const SWIGGY_CHANNEL_ID = "swiggy"; // matches india-sources.json registry data (L41)
export const DINING_SITES = [
  { site: "swiggy.com", platform: "Swiggy" },
  { site: "dineout.co.in", platform: "Dineout" },
  { site: "eazydiner.com", platform: "EazyDiner" },
] as const;
const MAX_TEXT = 20000;
/** "high rating count" >= this many ratings (a fully filled listing). */
export const HIGH_RATING_COUNT_THRESHOLD = 100;
/** "heavy discounting" >= this percentage off a bill. */
export const HEAVY_DISCOUNT_PERCENT = 40;

export type SwiggyFields = {
  name?: string;
  cuisines?: string;
  rating?: number;
  ratingCount?: number;
  deliveryTime?: string;
  costForTwo?: string;
  offers?: string;
  reservation?: string;
  platform?: string;
  address?: string;
};

// ---- parser helpers ---------------------------------------------------------

const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?previous\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b/i;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
const MOBILE_RE = /\b(?:\+?91[-\s]?)?[6-9]\d{9}\b/;
// a cuisine line: two or more comma-separated word groups, no digits/currency.
const CUISINE_LINE_RE = /^[A-Za-z][A-Za-z&'\-\. ]+(?:,\s*[A-Za-z][A-Za-z&'\-\. ]+)+$/;
// aggregator / platform / social hosts that never count as the business's own site.
const AGGREGATOR_HOST_RE =
  /(?:^|\.)(?:swiggy|zomato|dineout|district|eazydiner|magicpin|nearbuy|google|googleapis|facebook|fb|instagram|twitter|x|linkedin|youtube|justdial|sulekha|practo|whatsapp|wa)\./i;
// login / account / non-business paths on a dining host.
// NB: a real Swiggy Dineout restaurant page ends in ".../<slug>-<id>/dineout"
// (verified 2026-10-09), so a bare "/dineout" must NOT be treated as a
// non-business path; only the account/order/nav paths below are.
const NON_BUSINESS_PATH_RE =
  /\/(?:login|signin|signup|auth|users?|account|settings|cart|payment|checkout|my-account|home|help|support|about|privacy|terms|search|sitemap|cities|offers-near-me|corporate)\b/i;

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Expand a compact count like "10K+" or "1.2M" into a number; else plain digits. */
function countNum(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([km])?/i);
  if (!m) return undefined;
  let n = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  if (unit === "k") n *= 1000;
  else if (unit === "m") n *= 1000000;
  return Number.isFinite(n) ? n : undefined;
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(String(url ?? "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The dining platform a URL belongs to (a fact taken from the source URL). */
export function platformFromUrl(url: string | undefined): string | undefined {
  const h = hostOf(url);
  if (/(^|\.)swiggy\.com$/.test(h)) return "Swiggy";
  if (/(^|\.)dineout\.co\.in$/.test(h)) return "Dineout";
  if (/(^|\.)eazydiner\.com$/.test(h)) return "EazyDiner";
  return undefined;
}

function nameFromDiningUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const h = hostOf(url);
  if (!/(?:swiggy\.com|dineout\.co\.in|eazydiner\.com)$/.test(h)) return undefined;
  try {
    const u = new URL(url);
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    let slug = (segs[segs.length - 1] ?? "").replace(/\.html?$/i, "");
    slug = slug.replace(/-rest\d+$/i, "").replace(/-\d{4,}$/, "").replace(/[-_]+/g, " ").trim();
    if (!slug || /^\d+$/.test(slug)) return undefined;
    return slug;
  } catch {
    return undefined;
  }
}

/** Split "30-35 mins", "₹800 for two", "FLAT 20% OFF" etc. out of flat text. */
function offersFromText(text: string): string | undefined {
  const flat = String(text ?? "");
  const m = flat.match(/(?:FLAT|Flat)\s+\d{1,3}\s*%\s*OFF/i)
    ?? flat.match(/\d{1,3}\s*%\s*(?:OFF|off)\b/);
  if (m) return m[0].replace(/\s+/g, " ").trim();
  const bogo = flat.match(/\b(?:BOGO|buy\s*(?:one|1)\s*get\s*(?:one|1)|1\s*\+\s*1)\b/i);
  return bogo?.[0];
}

/** Parse a Swiggy / Dineout / EazyDiner restaurant page (or search-snippet block)
 *  into fields. Every value is a verbatim copy from the text or the URL; anything
 *  unmatched stays undefined (never inferred). `platform` is optional and comes
 *  from the source URL host. */
export function parseSwiggyPage(text: string, platform?: string): SwiggyFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ").trim();
  const f: SwiggyFields = {};
  if (platform) f.platform = platform;

  // name: explicit label, else the page-title head, else the URL slug.
  const nameLine = lines.find((l) => /^(?:Restaurant(?:\s+name)?|Name)\s*[:：]\s*\S/i.test(l));
  let name = nameLine?.replace(/^(?:Restaurant(?:\s+name)?|Name)\s*[:：]\s*/i, "").trim();
  if (!name) {
    const title = lines[0] ?? "";
    if (title && !/^https?:/i.test(title) && /\s+[|·]\s+/.test(title)) {
      name = title.split(/\s+[|·]\s+/)[0].trim() || undefined;
    }
  }
  if (!name) name = nameFromDiningUrl(flat.match(/https?:\/\/[^\s"'<>]+/)?.[0]);
  if (name) f.name = name;

  // cuisines: explicit label, else a comma-separated word line.
  const cuisineLine = lines.find((l) => /^Cuisines?\s*[:：]\s*\S/i.test(l));
  if (cuisineLine) {
    f.cuisines = cuisineLine.replace(/^Cuisines?\s*[:：]\s*/i, "").trim() || undefined;
  } else {
    const guess = lines.find((l) => CUISINE_LINE_RE.test(l) && !/^Name\b/i.test(l));
    if (guess) f.cuisines = guess;
  }

  // rating: explicit label, else "<rating>" next to a "ratings" run.
  const ratingLine = lines.find((l) => /^Rating\s*[:：]\s*[0-5]/.test(l));
  if (ratingLine) {
    const r = num(ratingLine.replace(/^Rating\s*[:：]\s*/, "").match(/[0-5](?:\.\d{1,2})?/)?.[0]);
    if (r !== undefined && r > 0 && r <= 5) f.rating = r;
  }
  if (f.rating === undefined) {
    const m = flat.match(/([0-5](?:\.\d{1,2})?)\s*(?:[·|]|\s)?\s*[\d.,]*\s*[KkMm]?\s*ratings?\b/i)
      ?? flat.match(/([0-5](?:\.\d{1,2})?)\s*(?:[·|]\s*\d|[)]|star)/i);
    if (m) {
      const r = num(m[1]);
      if (r !== undefined && r > 0 && r <= 5) f.rating = r;
    }
  }

  // rating count: explicit label, else "Based on N ratings" / "N ratings" / "N reviews".
  const rcLine = lines.find((l) => /^(?:Rating count|Ratings|Votes|Reviews?)\s*[:：]\s*[\d KkMm,.]/i.test(l));
  if (rcLine) {
    f.ratingCount = countNum(rcLine.replace(/^(?:Rating count|Ratings|Votes|Reviews?)\s*[:：]\s*/i, "").split(/[+\s]/)[0]);
  }
  if (f.ratingCount === undefined) {
    const m = flat.match(/Based\s+on\s+([\d,.]+)\s*([KkMm]?)\s*ratings?\b/i)
      ?? flat.match(/([\d,.]+)\s*([KkMm]?)\s*ratings?\b/i)
      ?? flat.match(/([\d,.]+)\s*([KkMm]?)\s*reviews?\b/i);
    if (m) f.ratingCount = countNum(`${m[1]}${m[2] ?? ""}`);
  }

  // delivery time: explicit label, else the "<N>-<N> mins" run.
  const dtLine = lines.find((l) => /^(?:Delivery\s*(?:time|estimate)?|Delivery)\s*[:：]\s*\S/i.test(l));
  if (dtLine) {
    f.deliveryTime = dtLine.replace(/^(?:Delivery\s*(?:time|estimate)?|Delivery)\s*[:：]\s*/i, "").trim() || undefined;
  } else {
    const m = flat.match(/\b(\d{1,3}\s*-\s*\d{1,3}\s*mins?|\d{1,3}\s*mins?)\b/i);
    if (m) f.deliveryTime = m[1].trim();
  }

  // cost for two: explicit label, else the verbatim "₹<N> for two" phrase.
  const costLine = lines.find((l) => /^(?:Cost\s*for\s*two|Cost|Average\s+cost)\s*[:：]\s*\S/i.test(l));
  if (costLine) {
    f.costForTwo = costLine.replace(/^(?:Cost\s*for\s*two|Cost|Average\s+cost)\s*[:：]\s*/i, "").trim() || undefined;
  } else {
    const m = flat.match(/[₹]\s*[\d,]+\s*for\s+two(?:\s+approx\.?)?/i);
    if (m) f.costForTwo = m[0].trim();
  }

  // offers: explicit label, else a first flat percentage/BOGO phrase.
  const offersLine = lines.find((l) => /^Offers?\s*[:：]\s*\S/i.test(l));
  if (offersLine) f.offers = offersLine.replace(/^Offers?\s*[:：]\s*/i, "").trim() || undefined;
  else f.offers = offersFromText(clean);

  // reservation availability: explicit label, else the booking copy shown.
  const resvLine = lines.find((l) => /^(?:Reservation|Booking|Book(?:\s+a)?\s*table)\s*[:：]\s*\S/i.test(l));
  if (resvLine) f.reservation = resvLine.replace(/^(?:Reservation|Booking|Book(?:\s+a)?\s*table)\s*[:：]\s*/i, "").trim() || undefined;
  else {
    const m = clean.match(/\b(?:book a table|book table|table reservation|reserve a table|pre-book(?:ing)?)\b/i);
    if (m) f.reservation = m[0];
  }

  // address: explicit label, else a line with a digit and at least two commas.
  const addrLine = lines.find((l) => /^Address\s*[:：]\s*\S/i.test(l));
  if (addrLine) f.address = addrLine.replace(/^Address\s*[:：]\s*/i, "").trim() || undefined;
  else {
    const guess = lines.find((l) => !/^(?:Name|Restaurant|Cuisines?|Rating|Votes|Reviews?|Delivery|Cost|Offers?|Reservation|Booking)\b/i.test(l)
      && !/^https?:/i.test(l) && /\d/.test(l) && (l.match(/,/g) ?? []).length >= 2);
    if (guess) f.address = guess;
  }

  return f;
}

// ---- signal helpers ---------------------------------------------------------

/** Links to domains that are not aggregator / platform / social hosts (a
 *  business's own website). */
export function externalUrls(text: string): string[] {
  const urls = String(text ?? "").match(/https?:\/\/[^\s"'<>,)]+/gi) ?? [];
  return urls.filter((u) => {
    const h = hostOf(u);
    return h !== "" && !AGGREGATOR_HOST_RE.test(`${h}.`);
  });
}

function hasDirectOrdering(text: string): boolean {
  return externalUrls(text).some((u) => /order|menu|deliver|takeaway|shop/i.test(u))
    || /(?:order online|order now|order direct)[^.\n]{0,30}https?:\/\//i.test(text);
}

function hasDirectReservation(text: string): boolean {
  return externalUrls(text).some((u) => /reserv|book|table/i.test(u))
    || /(?:reserve|book\s+a\s+table)[^.\n]{0,30}https?:\/\//i.test(text);
}

const PLATFORM_RES: RegExp[] = [/zomato/i, /swiggy/i, /dineout/i, /eazydiner/i];

function platformMentions(text: string): number {
  const t = String(text ?? "");
  return PLATFORM_RES.filter((re) => re.test(t)).length;
}

function heavyDiscount(text: string): boolean {
  const t = String(text ?? "");
  const pcts = [...t.matchAll(/(\d{1,3})\s*%\s*off/gi)].map((m) => Number(m[1]));
  if (pcts.some((n) => n >= HEAVY_DISCOUNT_PERCENT)) return true;
  return /\bbogo\b|buy\s*(?:one|1)\s*get\s*(?:one|1)|(?:^|[^\d])1\s*\+\s*1(?:[^\d]|$)/i.test(t);
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids for secondary dining evidence:
 *  listed-on-one-aggregator-only, high-rating-count-no-direct-ordering,
 *  heavy-discounting-margin-pressure, reservations-only-through-platform. */
export function swiggySignals(f: SwiggyFields, text: string = ""): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  const rc = typeof f.ratingCount === "number" ? f.ratingCount : undefined;

  if (platformMentions(t) === 1) out.push("listed-on-one-aggregator-only");
  if (rc !== undefined && rc >= HIGH_RATING_COUNT_THRESHOLD && !hasDirectOrdering(t)) {
    out.push("high-rating-count-no-direct-ordering");
  }
  if (heavyDiscount(t)) out.push("heavy-discounting-margin-pressure");
  if (
    /(?:book a table|book table|table reservation|reserve a table|reservation|book now|pre-book)/i.test(t)
    && platformMentions(t) >= 1
    && !hasDirectReservation(t)
  ) {
    out.push("reservations-only-through-platform");
  }
  return [...new Set(out)];
}

// ---- discovery ---------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. A "Name: <business>" line names the next
 *  dining URL (verbatim); otherwise the name comes from the URL slug. Lines with
 *  no usable URL (or a login / non-business path) skip. Duplicate URLs are dropped. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  const seen = new Set<string>();
  let pendingName: string | undefined;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const line = rawLine.trim();
    const nameLabel = line.match(/^Name\s*[:：]\s*(.+)$/i);
    if (nameLabel) {
      pendingName = nameLabel[1].trim();
      continue;
    }
    const urls = line.match(/https?:\/\/[^\s"'<>,)]+/gi) ?? [];
    for (const u of urls) {
      if (leads.length >= limit) break;
      const url = u.replace(/[\s,.;]+$/, "");
      if (seen.has(url)) continue;
      const host = hostOf(url);
      if (!/(?:swiggy\.com|dineout\.co\.in|eazydiner\.com)$/.test(host)) continue;
      if (NON_BUSINESS_PATH_RE.test(url)) continue;
      const name = pendingName ?? nameFromDiningUrl(url);
      pendingName = undefined;
      if (!name) continue;
      seen.add(url);
      leads.push({
        name,
        category,
        source: SWIGGY_CHANNEL_ID,
        sourceUrl: url,
        ...(line.match(PHONE_RE) ? { phone: line.match(PHONE_RE)![0].trim() } : {}),
      });
    }
  }
  return leads;
}

// ---- join with the Zomato adapter (name + area, only when both exist) --------

export type DiningJoin = {
  name: string;
  area?: string;
  platform?: string;
  swiggy?: RawLead;
  zomato?: RawLead;
  sources: string[];
};

const norm = (s: string | undefined): string =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Join this adapter's leads with Zomato's by normalised business name plus area,
 *  only when BOTH a name and an area exist. Leads missing either stay separate. */
export function joinWithZomato(swiggyLeads: RawLead[], zomatoLeads: RawLead[]): DiningJoin[] {
  const out: DiningJoin[] = [];
  const usedZ = new Set<number>();
  const zIndex = new Map<string, number>();
  zomatoLeads.forEach((z, i) => {
    const area = z.address ?? z.city;
    if (z.name && area) {
      const k = `${norm(z.name)}|${norm(area)}`;
      if (!zIndex.has(k)) zIndex.set(k, i);
    }
  });
  for (const s of swiggyLeads) {
    const area = s.address ?? s.city;
    if (s.name && area) {
      const k = `${norm(s.name)}|${norm(area)}`;
      const zi = zIndex.get(k);
      if (zi !== undefined && !usedZ.has(zi)) {
        usedZ.add(zi);
        out.push({ name: s.name, area, platform: "swiggy", swiggy: s, zomato: zomatoLeads[zi], sources: ["swiggy", "zomato"] });
        continue;
      }
    }
    out.push({ name: s.name, ...(area ? { area } : {}), platform: "swiggy", swiggy: s, sources: ["swiggy"] });
  }
  zomatoLeads.forEach((z, i) => {
    if (usedZ.has(i)) return;
    const area = z.address ?? z.city;
    out.push({ name: z.name, ...(area ? { area } : {}), platform: "zomato", zomato: z, sources: ["zomato"] });
  });
  return out;
}

// ---- status and env gate -----------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (tierCEnabled()) return { enabled: true };
  if (process.env.LEADSCOUT_BROWSER === "1") {
    return { enabled: true }; // operator-approved read mode on the operator's own browser
  }
  return {
    enabled: false,
    why: "tier C (swiggy.com robots.txt fetched 2026-10-09 allows / with account and order paths "
      + "disallowed, terms not fetched; dineout.co.in robots.txt fetch failed, page markup now served "
      + "under the Swiggy Dineout brand and UNVERIFIED; india-sources.json (L41) lists swiggy and "
      + "dineout as tier C; EazyDiner is tier B but is read only as secondary dining evidence here): "
      + `LEADSCOUT_INDIA_TIER_C is "${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off `
      + "(absent and =0 both mean off); the operator-approved browser-read fallback is also off "
      + "(LEADSCOUT_BROWSER is not 1)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const swiggy: ChannelAdapter = {
  id: SWIGGY_CHANNEL_ID,
  name: "Swiggy / Dineout / EazyDiner",
  tier: "C", // india-sources.json (L41): swiggy and dineout tier C
  categories: ["restaurant", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    let text = "";
    // Read order per site: search first (cheapest). A site that is blocked or
    // unavailable is skipped; the others still contribute.
    for (const { site } of DINING_SITES) {
      try {
        const read = await readWithFallback(deps, {
          searchQuery: `site:${site} "${q.category}" ${loc}`.trim().replace(/\s+/g, " "),
        });
        text += `\n${sanitizeUntrusted(read.text)}`;
      } catch {
        /* one site unavailable; continue with the rest */
      }
    }
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${hostOf(lead.sourceUrl) || "swiggy.com"} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: SWIGGY_CHANNEL_ID,
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
    const platform = platformFromUrl(read.url) ?? platformFromUrl(lead.sourceUrl);
    const fields: Record<string, string | number | undefined> = { ...parseSwiggyPage(text, platform) };
    const signals = swiggySignals(fields as SwiggyFields, text);
    return {
      channel: SWIGGY_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => swiggySignals(parseSwiggyPage(text), text),
};

registerChannel(swiggy);
