// ChannelAdapter for Udaan + ExportersIndia (Order L64-ch-udaan).
//
// B2B wholesale/trade marketplace seller pages. The channel is OFF by default
// and this order names no enable variable, so status() always reports it
// disabled (tier C). Rationale, verified this run (2026-10-09) by fetch +
// web search:
//  - Udaan robots.txt (udaan.com/robots.txt): "User-agent: *" disallows
//    /listing/ and /product/; category pages are not disallowed.
//  - Udaan Terms of Use (udaan.com/pages/terms-of-use): the User "will not
//    copy, reproduce, download, compile or otherwise use any Platform Content
//    ... or otherwise commercially exploiting the Platform Content or
//    systematic retrieval of Platform Content ... to create or compile,
//    directly or indirectly, a collection, compilation, database or directory
//    (whether through deep-link, page scrape, robots, spiders, automatic
//    devices or manual processes)."
//  - ExportersIndia robots.txt (exportersindia.com/robots.txt): "User-agent: *"
//    disallows /banner/, /misc/, /catg_search.php, /products-search.php, enquiry
//    and ajax endpoints, /trade/buyingleads-india/ and more; /search.php is
//    present but commented out (not disallowed); supplier profile pages are not
//    disallowed.
//  - ExportersIndia Terms & Conditions (exportersindia.com/terms-conditions.htm):
//    users may not copy/reproduce/download content "for the purpose of
//    re-selling or re-distributing ... mass mailing ... operating a business
//    that competes with ExportersIndia.Com, or otherwise commercially
//    exploiting" it.
// Both restrict systematic retrieval / commercial exploitation, so this
// read-only adapter is policy-gated OFF exactly like the IndiaMART/TradeIndia
// channel (Order L48); PLAN_V2 4.3 bans scraping such directories.
//
// Read order per page (registry.readWithFallback): search first -> plain page
// read -> browser reader ONLY when both are blocked (403, 429, captcha, empty
// body). The browser reader is injected in deps; its per-platform hourly caps
// and random pause are enforced by browser.ts, and this adapter never re-reads
// a blocked page itself.
//
// Page-structure facts confirmed from real Udaan search-result bodies and
// pages this run (2026-10-09): Udaan exposes /category/<slug> catalogue pages
// ("FMCG Wholesale Suppliers, Buy FMCG Products in Bulk"), seller pages carry
// "See seller's business credentials and references from other buyers online"
// and buyer ratings, the Sell On Udaan page documents "basket-size minimum
// order quantities", and registration collects business name, GSTIN, PAN, TAN,
// Udyog Aadhaar, address, phone. ExportersIndia exposes supplier profile pages
// under /<company-slug>/ and custom supplier microsites.
// UNVERIFIED: the exact current DOM/class markup, the exact seller/brand URL
// shapes, and per-listing catalogue counts (only text shapes seen via search).
// Every matcher below is an exact-label extractor, so an off assumption
// degrades to a missing field, never to an invented value.
//
// Rules: every field value is copied verbatim from page text or the URL/search
// snippet with its source URL; a value the page does not show stays missing
// (never inferred). All fetched text is neutralised via reach.sanitizeUntrusted
// and evidence is untrusted: true unconditionally.
import { sanitizeUntrusted } from "../../src/reach.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const UDAAN_CHANNEL_ID = "udaan";
export const UDAAN_SITE = "udaan.com";
export const EXPORTERSINDIA_SITE = "exportersindia.com";
const MAX_TEXT = 20000;

// signal thresholds (fixtures set the bar; real pages vary)
export const THIN_CATALOGUE_MAX = 5;
export const STALE_CATALOGUE_YEAR = 2022;

export type UdaanFields = {
  name?: string;
  brand?: string;
  categories?: string;
  city?: string;
  rating?: number;
  ratingCount?: number;
  minOrder?: string;
  businessType?: string;
  catalogueYear?: number;
  productCount?: number;
  contactPage?: string;
};

// ---- page/snippet parser: only exact matches become fields ------------------

const INJECTION_NEVER_COPY =
  /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)|<\/?(?:tool|function|invoke)\b/i;
const MARKETPLACE_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*(?:udaan|exportersindia)\.com\/[^\s"'<>*)]*/i;
const OWN_URL_RE = /https?:\/\/(?![^\s"'<>,)]*(?:udaan|exportersindia)\.com)[^\s"'<>,)]+/gi;

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Find a "Label ..." line and return the inline remainder, else the next
 *  non-empty line (real pages put some values on the following line). */
function labelValue(lines: string[], re: RegExp): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const inline = (m[1] ?? "").trim().replace(/^[|:]\s*/, "").trim();
    if (inline) return inline;
    for (let j = i + 1; j < lines.length; j++) {
      const nxt = lines[j].trim();
      if (nxt) return nxt;
    }
  }
  return undefined;
}

export function firstMarketplaceUrl(text: string): string | undefined {
  const m = String(text ?? "").match(MARKETPLACE_URL_RE);
  return m ? m[0].replace(/[\s,.;]+$/, "") : undefined;
}

/** Derive a seller/brand name from a marketplace URL slug (verbatim slug text,
 *  never inferred). URLs with no usable slug carry no name -> undefined. */
export function nameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    if (host.endsWith("udaan.com")) {
      const i = segs.findIndex((s) => /^(?:seller|brand|store|shop)$/i.test(s));
      const slug = i >= 0 ? segs[i + 1] : undefined;
      if (!slug) return undefined;
      return decodeURIComponent(slug).replace(/-\d{5,}$/, "").replace(/-/g, " ").trim() || undefined;
    }
    if (host.endsWith("exportersindia.com")) {
      const last = segs[segs.length - 1] ?? "";
      if (!last || /\.(?:php|html?)$/i.test(last)) return undefined;
      return decodeURIComponent(last).replace(/-\d{4,}$/, "").replace(/-/g, " ").trim() || undefined;
    }
  } catch {
    /* keep missing */
  }
  return undefined;
}

/** A discovery URL that is one seller/brand page (not a directory, category,
 *  listing, product detail or robots-disallowed path). */
export function isBusinessUrl(url: string): boolean {
  const u = String(url ?? "");
  if (/udaan\.com/i.test(u)) {
    if (/\/(?:listing|product|category|search|help|pages|s|cart|checkout|order)\b/i.test(u)) return false;
    return /udaan\.com\/(?:seller|brand|store|shop)\/[A-Za-z0-9][A-Za-z0-9._-]*\/?$/i.test(u);
  }
  if (/exportersindia\.com/i.test(u)) {
    if (/\/(?:banner|misc|transfer-files|iyp_ftp_connect_dir|pro-invoice|report|tmp|min|dynamic|market_panel|amp|trade)\//i.test(u)) return false;
    if (/(?:catg_search|search|products-search|catalog-popup|enquiry|inquiry_form_catg_page|forgot_pass|ajax)\.php/i.test(u)) return false;
    if (/\/view_free_member_mobile\.php/i.test(u)) return false;
    return /exportersindia\.com\/[A-Za-z0-9][A-Za-z0-9._-]*\/?$/i.test(u);
  }
  return false;
}

/** Search-snippet lines -> RawLead[]. Name comes from the URL slug; lines with
 *  no seller URL, no derivable name or a disallowed path skip. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  const seen = new Set<string>();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const m = line.match(MARKETPLACE_URL_RE);
    if (!m) continue;
    const url = m[0].replace(/[\s,.;]+$/, "");
    if (seen.has(url) || !isBusinessUrl(url)) continue;
    const name = nameFromUrl(url);
    if (!name) continue;
    seen.add(url);
    leads.push({ name, category, source: UDAAN_CHANNEL_ID, sourceUrl: url });
  }
  return leads;
}

/** Parse a Udaan / ExportersIndia seller page (or a search snippet block) into
 *  fields. Every value is a verbatim copy from the text or the URL; anything
 *  unmatched stays undefined (never inferred). */
export function parseUdaanPage(text: string): UdaanFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const lines = clean.split(/\r?\n/).map((l) => l.trim());
  const nonEmpty = lines.filter(Boolean);
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const f: UdaanFields = {};

  // name: explicit label, else an "About <name>" block, else the URL slug.
  const nameLabel = labelValue(nonEmpty, /^(?:Seller|Company|Business)\s+Name\b[:|]?\s*(.*)$/i);
  const aboutLine = nonEmpty.find((l) => /^About\s+(?!Us\b)(.{2,90})$/i.test(l));
  f.name =
    nameLabel
    ?? (aboutLine ? aboutLine.replace(/^About\s+/i, "").trim() : undefined)
    ?? nameFromUrl(firstMarketplaceUrl(clean));

  // brand: an explicit "Brand"/"Brand Name" label only.
  const brand = labelValue(nonEmpty, /^Brand(?:\s+Name)?\b[:|]?\s*(.*)$/i);
  if (brand) f.brand = brand;

  // categories: a label, else a Udaan breadcrumb.
  const catLabel = labelValue(nonEmpty, /^(?:Product\s+)?Categories?\b[:|]?\s*(.*)$/i);
  const crumb = nonEmpty.find((l) => /^Udaan\s*>/.test(l));
  if (catLabel) f.categories = catLabel;
  else if (crumb) f.categories = crumb.replace(/^Udaan\s*>\s*/i, "").trim();

  // city: explicit label first segment, else "located in / based in <City>".
  const cityLabel = labelValue(nonEmpty, /^(?:City|Location|Address)\b[:|]?\s*(.*)$/i);
  if (cityLabel) f.city = cityLabel.split(",")[0].trim() || undefined;
  if (!f.city) {
    const loc = flat.match(/\b(?:located in|operates from|based in)\s+([A-Z][A-Za-z .&'()-]{2,40}?)(?:,|\s+and\b|$)/);
    if (loc) f.city = loc[1].trim();
  }

  // rating: "<R> (N ratings)", else "<R>/5" / "<R> out of 5" / "<R> stars",
  // else "Rating <R>". Copied from the page, never inferred.
  const rat =
    flat.match(/\b([0-5](?:\.\d)?)\s*\(\s*[\d,]+\s*(?:ratings?|reviews?)\s*\)/i)?.[1]
    ?? flat.match(/\b([0-5](?:\.\d)?)\s*(?:\/\s*5|out of\s*5|stars?)\b/i)?.[1]
    ?? flat.match(/\bRating\b\s*[:|]?\s*([0-5](?:\.\d)?)/i)?.[1];
  const ratNum = num(rat);
  if (ratNum !== undefined) f.rating = ratNum;

  // rating count: "<N> ratings" / "<N> reviews" / "(N)" after the rating.
  const rc = flat.match(/\b([\d,]{1,9})\s*(?:ratings?|reviews?)\b/i)?.[1] ?? flat.match(/\(\s*([\d,]{1,9})\s*\)/)?.[1];
  const rcNum = rc ? num(rc) : undefined;
  if (rcNum !== undefined) f.ratingCount = rcNum;

  // minimum order: a "Minimum Order ..." / MOQ label, copied verbatim.
  const moq =
    labelValue(nonEmpty, /^Minimum Order\s+(?:Quantity|Value|Qty|Amount)\b[:|]?\s*(.*)$/i)
    ?? labelValue(nonEmpty, /^MOQ\b[:|]?\s*(.*)$/i);
  if (moq && /\d/.test(moq)) f.minOrder = moq;

  // business type: "Nature of Business" / "Business Type" / "Seller Type".
  f.businessType =
    labelValue(nonEmpty, /^(?:GST\s+)?Nature of Business\b[:|]?\s*(.*)$/i)
    ?? labelValue(nonEmpty, /^(?:Business|Seller)\s+Type\b[:|]?\s*(.*)$/i);

  // catalogue year: an explicit catalogue date/updated/since year, verbatim.
  const catYear = labelValue(nonEmpty, /^Catalogue(?:\s+(?:updated|year|date))?\b[:|]?\s*(.*)$/i);
  const cy = catYear ? num((catYear.match(/\d{4}/) ?? [])[0]) : undefined;
  if (cy !== undefined) f.catalogueYear = cy;

  // product count: "<N> Products".
  const pcMatch = flat.match(/\b([\d,]{1,9})\s+Products?\b/i);
  const pcNum = pcMatch ? num(pcMatch[1]) : undefined;
  if (pcNum !== undefined) f.productCount = pcNum;

  // contact page presence: an explicit contact route on the page.
  if (/Contact\s+Supplier|Send\s+(?:Email|SMS|Enquiry|Inquiry|Message)|Contact\s+Us|Contact\s+Seller|Get\s+in\s+touch|Call\s+Now|Get\s+Best\s+Price/i.test(flat)) {
    f.contactPage = "yes";
  }
  return f;
}

// ---- signals ----------------------------------------------------------------

/** True when the text links to any site other than the marketplaces. */
export function hasOwnWebsiteLink(text: string): boolean {
  const urls = String(text ?? "").match(OWN_URL_RE);
  return Boolean(urls && urls.length > 0);
}

/** True when the page offers a direct ordering route: an off-marketplace link
 *  or explicit order/checkout text. */
export function hasDirectOrderingPortal(text: string): boolean {
  if (hasOwnWebsiteLink(text)) return true;
  return /\border\s+online|add\s+to\s+cart|buy\s+now|shop\s+now|place\s+(?:an\s+)?order|checkout|\bcart\b/i.test(String(text ?? ""));
}

/** Stable signal ids over parsed fields + raw text. */
export function udaanSignals(f: UdaanFields, text: string = ""): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  const bulk = /wholesal|distributor|bulk|trader|supplier|dealer/i.test(f.businessType ?? "");
  if (bulk && !hasDirectOrderingPortal(t)) out.push("bulk-no-direct-portal");
  if (typeof f.productCount === "number" && f.productCount <= THIN_CATALOGUE_MAX) out.push("catalogue-thin");
  if (typeof f.catalogueYear === "number" && f.catalogueYear <= STALE_CATALOGUE_YEAR) out.push("catalogue-outdated");
  if (!hasOwnWebsiteLink(t)) out.push("single-marketplace-dependency");
  return [...new Set(out)];
}

// ---- status -----------------------------------------------------------------

/** OFF by default; this order names no enable variable, so there is no enable
 *  path. The integration exists as read-only code the operator can drive
 *  manually; the registry never runs it because status() is always disabled. */
export function udaanEnabled(): boolean {
  return false;
}

function statusText(): { enabled: boolean; why?: string } {
  return {
    enabled: false,
    why: "OFF: Udaan terms-of-use prohibit systematic retrieval / commercial exploitation of Platform Content "
      + "(deep-link, page scrape, robots, spiders, automatic devices or manual processes) and ExportersIndia terms forbid "
      + "copying/re-distributing its content or mass mailing; PLAN_V2 4.3 bans scraping both directories. "
      + "This order names no enable variable, so there is no enable path and the adapter stays disabled.",
  };
}

// ---- the adapter ------------------------------------------------------------

export const udaan: ChannelAdapter = {
  id: UDAAN_CHANNEL_ID,
  name: "Udaan / ExportersIndia",
  tier: "C", // policy-ban channel (PLAN_V2 4.3); off by default
  categories: ["b2b-suppliers", "manufacturing", "retail", "any"],

  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(" ").trim();
    const queries = [
      `site:${UDAAN_SITE} "${q.category}" ${loc}`.trim(),
      `site:${EXPORTERSINDIA_SITE} "${q.category}" ${loc}`.trim(),
    ];
    const out: RawLead[] = [];
    const seen = new Set<string>();
    for (const searchQuery of queries) {
      if (out.length >= limit) break;
      const read = await readWithFallback(deps, { searchQuery });
      const text = sanitizeUntrusted(read.text);
      for (const l of resultsToLeads(text, q.category, limit - out.length)) {
        if (seen.has(l.sourceUrl)) continue;
        seen.add(l.sourceUrl);
        out.push(l);
      }
    }
    return out.slice(0, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    const site = /exportersindia\.com/i.test(lead.sourceUrl) ? EXPORTERSINDIA_SITE : UDAAN_SITE;
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked
      // (403/429/captcha/empty); browser caps enforced by browser.ts.
      read = await readWithFallback(deps, {
        searchQuery: `site:${site} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: UDAAN_CHANNEL_ID,
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
    const parsed = parseUdaanPage(text);
    const fields: Record<string, string | number | undefined> = { ...parsed };
    return {
      channel: UDAAN_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals: udaanSignals(parsed, text),
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => udaanSignals(parseUdaanPage(text), text),
};

registerChannel(udaan);
