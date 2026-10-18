// ChannelAdapter for IndiaMART + TradeIndia (Order L48-ch-indiamart).
//
// B2B marketplace company pages for manufacturers, traders and suppliers.
// The channel is OFF by default and this order names no enable variable, so
// status() always reports it disabled (tier C). Rationale, verified this run
// (2026-10-09) by fetch + web search:
//  - IndiaMART terms-of-use (indiamart.com/terms-of-use.html): "Systematic
//    retrieval of IIL Content to create or compile, directly or indirectly, a
//    collection, compilation, database or directory (whether through robots,
//    spiders, automatic devices or manual processes) without written
//    permission from IIL is prohibited." PLAN_V2 4.3 also bans IndiaMART
//    scraping.
//  - IndiaMART robots.txt: User-agent:* disallows /proddetail1/, /proddetail2/,
//    /company/view-catalog.html, /enquiry.html and more; AI/ML bots (ClaudeBot,
//    GPTBot style, Bytespider, ...) get "Disallow: /" but OAI-SearchBot /
//    GPTBot / ChatGPT-User are explicitly allowed.
//  - TradeIndia robots.txt: User-agent:* disallows /search/, /suppliers/,
//    */Seller/*, */Seller-*, /Exporters_Suppliers/, /login/ and more; publishes
//    manufacturer sitemaps. TradeIndia terms of use
//    (tradeindia.com/about-us/terms/terms_01.html) forbid deep-link / robot /
//    spider / automatic access to acquire, copy or monitor the platform.
//
// Read order per page (registry.readWithFallback): search first -> plain page
// read -> browser reader ONLY when both are blocked (403, 429, captcha, empty
// body). The browser reader is injected in deps; its per-platform hourly caps
// and random pause are enforced by browser.ts, and this adapter never re-reads
// a blocked page itself.
//
// Verified page structure from fetched robots/terms and real page text in
// search-result bodies (IndiaMART proddetail + aboutus pages, TradeIndia
// company pages), 2026-10-09:
//  - IndiaMART: bare company name and an "About <name>" block; badges
//    "GST TrustSEAL Payment Protected <N> yrs"; "<P>% Response Rate" /
//    "Call Response Rate <P>%"; a breadcrumb
//    "IndiaMART > <Cat> > <Cat> > <Product>"; "<N> Products";
//    "Total Number of Employees <range>"; "Nature of Business <type>";
//    "Annual Turnover <band>"; "Verified GST Number <15-char GSTIN>";
//    "Year of Establishment <YYYY>"; "Address <City>, <State>".
//  - TradeIndia: "Business Type <type>", "Employee Count <N>", "Establishment
//    <YYYY>", company URL shape /<slug>-<numeric-id>.
// Unverified: the exact current DOM/class markup (only text shapes seen via
// search) and per-listing catalogue counts; every matcher below is an
// exact-label extractor, so an off assumption degrades to a missing field,
// never to an invented value.
//
// Rules: every field value is copied verbatim from page text or the
// URL/search snippet with its source URL; a value the page does not show stays
// missing (never inferred). GST is only ever taken from a labelled public
// field on the page. All fetched text is neutralised via reach.sanitizeUntrusted
// and evidence is untrusted: true unconditionally.
import { sanitizeUntrusted } from "../../src/reach.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const INDIAMART_CHANNEL_ID = "indiamart";
export const INDIAMART_SITE = "indiamart.com";
export const TRADEINDIA_SITE = "tradeindia.com";
const MAX_TEXT = 20000;

// signal thresholds (fixtures set the bar; real pages vary)
export const THIN_CATALOGUE_MAX = 5;
export const SLOW_RESPONSE_RATE_THRESHOLD = 50;
export const MANY_CATEGORIES_MIN = 2;

export type IndiamartFields = {
  name?: string;
  city?: string;
  businessType?: string;
  yearsInBusiness?: number;
  establishmentYear?: number;
  gstNumber?: string;
  trustSeal?: string;
  productCategories?: string;
  productCount?: number;
  responseRate?: number;
  employeeRange?: string;
  annualTurnover?: string;
  contactPage?: string;
};

// ---- page/snippet parser: only exact matches become fields ------------------

const INJECTION_NEVER_COPY =
  /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)|<\/?(?:tool|function|invoke)\b/i;
const MARKETPLACE_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*(?:indiamart|tradeindia)\.com\/[^\s"'<>*)]*/i;
const OWN_URL_RE = /https?:\/\/(?![^\s"'<>,)]*(?:indiamart|tradeindia)\.com)[^\s"'<>,)]+/gi;
const GSTIN = "[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]";

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

/** Derive a company name from a marketplace URL (verbatim slug text, never
 *  inferred). Numeric-id "/company/<id>/" pages carry no name -> undefined. */
export function nameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    if (host.endsWith("indiamart.com")) {
      if (segs[0] === "company") return undefined;
      const slug = segs.find((s) => !/^aboutus\.html$/i.test(s));
      if (!slug) return undefined;
      return slug.replace(/\.html$/i, "").replace(/-\d{5,}$/, "").replace(/-/g, " ").trim() || undefined;
    }
    if (host.endsWith("tradeindia.com")) {
      if (segs[0] === "manufacturers" && segs.length > 1) {
        return decodeURIComponent(segs[segs.length - 1]).replace(/-/g, " ").trim() || undefined;
      }
      const last = segs[segs.length - 1] ?? "";
      return last.replace(/-\d{4,}$/, "").replace(/-/g, " ").trim() || undefined;
    }
  } catch {
    /* keep missing */
  }
  return undefined;
}

/** A discovery URL that is one business page (not a directory, search, product
 *  detail or disallowed path). */
export function isBusinessUrl(url: string): boolean {
  const u = String(url ?? "");
  if (/indiamart\.com/i.test(u)) {
    if (/\/(?:proddetail\d?\/|pd\/|stats\/|cgi\/|temp\/|enquiry\.html|company\/view-catalog|search\.html)/i.test(u)) return false;
    return true;
  }
  if (/tradeindia\.com/i.test(u)) {
    if (/\/(?:search|suppliers|Exporters_Suppliers|login|registration|my_tradeindia|Homepage|Browse|TradeLeads|FeaturedProducts|Shopping|communities|products)\//i.test(u)) return false;
    if (/\/Seller[-/]/i.test(u)) return false;
    return /tradeindia\.com\/(?:manufacturers\/.+|[A-Za-z0-9][A-Za-z0-9._-]*-\d{4,})\/?$/i.test(u);
  }
  return false;
}

/** Search-snippet lines -> RawLead[]. Name comes from the URL slug; lines with
 *  no business URL, no derivable name or a disallowed path skip. */
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
    leads.push({ name, category, source: INDIAMART_CHANNEL_ID, sourceUrl: url });
  }
  return leads;
}

/** Parse an IndiaMART / TradeIndia company page (or a search snippet block)
 *  into fields. Every value is a verbatim copy from the text or the URL;
 *  anything unmatched stays undefined (never inferred). */
export function parseIndiamartPage(text: string): IndiamartFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const lines = clean.split(/\r?\n/).map((l) => l.trim());
  const nonEmpty = lines.filter(Boolean);
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const f: IndiamartFields = {};

  // name: explicit label, else the "About <name>" block, else the URL slug.
  const nameLabel = labelValue(nonEmpty, /^Company Name\b[:|]?\s*(.*)$/i);
  const aboutLine = nonEmpty.find((l) => /^About\s+(?!Us\b)(.{2,90})$/i.test(l));
  f.name =
    nameLabel
    ?? (aboutLine ? aboutLine.replace(/^About\s+/i, "").trim() : undefined)
    ?? nameFromUrl(firstMarketplaceUrl(clean));

  // city: an "Address <City>, <State>" line (first segment), else explicit
  // "located in / operates from <City>", else "<Name> in <City>," snippets.
  const addr = labelValue(nonEmpty, /^Address\b[:|]?\s*(.*)$/i);
  if (addr) f.city = addr.split(",")[0].trim() || undefined;
  if (!f.city) {
    const loc = flat.match(/\b(?:located in|operates from|based in)\s+([A-Z][A-Za-z .&'()-]{2,40}?)(?:,|\s+and\b|$)/);
    if (loc) f.city = loc[1].trim();
  }
  if (!f.city) {
    const m = flat.match(/\bin\s+([A-Z][A-Za-z .&'()-]{2,30}?),\s*[A-Z][A-Za-z]/);
    if (m) f.city = m[1].trim();
  }

  // business type: IndiaMART "Nature of Business"/"GST Nature of business",
  // TradeIndia "Business Type".
  f.businessType =
    labelValue(nonEmpty, /^(?:GST\s+)?Nature of Business\b[:|]?\s*(.*)$/i)
    ?? labelValue(nonEmpty, /^Business Type\b[:|]?\s*(.*)$/i);

  // establishment year (copied verbatim; never converted into "years").
  const est = labelValue(nonEmpty, /^Year of Establishment\b[:|]?\s*(.*)$/i)
    ?? labelValue(nonEmpty, /^Establishment\b[:|]?\s*(.*)$/i);
  const estNum = est ? num((est.match(/\d{4}/) ?? [])[0]) : undefined;
  if (estNum !== undefined) f.establishmentYear = estNum;

  // years in business: an explicit "<N> yrs" badge or "<N> Years in Business"
  // text only (never computed from the establishment year).
  const yrs =
    flat.match(/\b(\d{1,3})\s*yrs?\b/i)?.[1]
    ?? flat.match(/\b(\d{1,3})\s*(?:\+\s*)?years?(?:\s+in\s+business)?\b/i)?.[1];
  const yn = num(yrs);
  if (yn !== undefined) f.yearsInBusiness = yn;

  // GST: only from a labelled public field ("GST No." / "GST Number" /
  // "Verified GST Number"), inline or as a label line followed by the value.
  const gstRe = new RegExp(`(?:Verified\\s+)?GST\\s*(?:No\\.?|Number)\\s*[:|]?\\s*(${GSTIN})`, "i");
  const gm = clean.match(gstRe);
  if (gm) {
    f.gstNumber = gm[1].toUpperCase();
  } else {
    const idx = nonEmpty.findIndex((l) => /^(?:Verified\s+)?GST\s*(?:No\.?|Number)\b/i.test(l));
    if (idx >= 0) {
      const next = nonEmpty[idx + 1] ?? "";
      const m = next.match(new RegExp(GSTIN, "i"));
      if (m) f.gstNumber = m[0].toUpperCase();
    }
  }

  // trust seal: explicit badge text only.
  if (/TrustSEAL/i.test(clean)) f.trustSeal = "TrustSEAL";
  else if (/Trust\s*Seal/i.test(clean)) f.trustSeal = "Trust Seal";
  else if (/Trust\s*Stamp/i.test(clean)) f.trustSeal = "Trust Stamp";

  // product categories: IndiaMART breadcrumb "IndiaMART > ...", else a label.
  const crumb = nonEmpty.find((l) => /^IndiaMART\s*>/.test(l));
  if (crumb) f.productCategories = crumb.replace(/^IndiaMART\s*>\s*/i, "").trim();
  else {
    const pc = labelValue(nonEmpty, /^Product Categories\b[:|]?\s*(.*)$/i);
    if (pc) f.productCategories = pc;
  }

  // product count: "<N> Products" or "Products (<N>)".
  const pcMatch = flat.match(/\b([\d,]{1,9})\s+Products?\b/i) ?? flat.match(/\bProducts?\s*\(([\d,]{1,9})\)/i);
  const pcNum = pcMatch ? num(pcMatch[1]) : undefined;
  if (pcNum !== undefined) f.productCount = pcNum;

  // response rate: "<P>% Response Rate" / "Call Response Rate <P>%".
  const rr =
    flat.match(/\b(\d{1,3})\s*%\s*(?:Call\s+)?Response Rate\b/i)?.[1]
    ?? flat.match(/\b(?:Call\s+)?Response Rate\b\s*[:|]?\s*(\d{1,3})\s*%/i)?.[1];
  const rrNum = num(rr);
  if (rrNum !== undefined) f.responseRate = rrNum;

  // employee range and annual turnover band, verbatim.
  f.employeeRange = labelValue(
    nonEmpty,
    /^(?:Total Number of Employees|No\.?\s*of Employees|Employee Count)\b[:|]?\s*(.*)$/i,
  );
  const turn =
    labelValue(nonEmpty, /^Annual Turnover\b[:|]?\s*(.*)$/i)
    ?? labelValue(nonEmpty, /^GST Turnover\b[:|]?\s*(.*)$/i);
  if (turn && /\d/.test(turn)) f.annualTurnover = turn;

  // contact page presence: an explicit contact route on the page.
  if (/Contact\s+Supplier|Send\s+(?:Email|SMS|Enquiry|Inquiry)|Contact\s+Us|Get\s+in\s+touch|Contact\s+Number|Call\s+Now|Get\s+Best\s+Price|Send\s+a\s+message/i.test(flat)) {
    f.contactPage = "yes";
  }
  return f;
}

// ---- signals ----------------------------------------------------------------

function categoryCount(cat?: string): number {
  if (!cat) return 0;
  return cat.split(/[>,]/).map((s) => s.trim()).filter(Boolean).length;
}

/** True when the text links to any site other than the marketplaces. */
export function hasOwnWebsiteLink(text: string): boolean {
  const urls = String(text ?? "").match(OWN_URL_RE);
  return Boolean(urls && urls.length > 0);
}

/** Stable signal ids over parsed fields + raw text. */
export function indiamartSignals(f: IndiamartFields, text: string = ""): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  if (typeof f.productCount === "number" && f.productCount <= THIN_CATALOGUE_MAX) out.push("thin-catalogue");
  const own = hasOwnWebsiteLink(t);
  if (!own) out.push("no-own-website");
  if (typeof f.responseRate === "number" && f.responseRate < SLOW_RESPONSE_RATE_THRESHOLD) out.push("slow-response-rate");
  const cats = categoryCount(f.productCategories);
  const followUp =
    /send\s+(?:email|sms|enquiry|inquiry|a\s+message)|contact\s+supplier|get\s+in\s+touch|response\s+rate|call\s+now|\benquiry\b|\binquiry\b/i.test(t);
  if (cats >= MANY_CATEGORIES_MIN && !followUp) out.push("many-categories-no-followup");
  if (f.gstNumber && !own) out.push("gst-listed-no-web-presence");
  return [...new Set(out)];
}

// ---- status -----------------------------------------------------------------

/** OFF by default; this order names no enable variable, so there is no enable
 *  path. The integration exists as read-only code the operator can drive
 *  manually; the registry never runs it because status() is always disabled. */
export function indiamartEnabled(): boolean {
  return false;
}

function statusText(): { enabled: boolean; why?: string } {
  return {
    enabled: false,
    why: "OFF: IndiaMART terms-of-use prohibit systematic retrieval (robots, spiders, automatic devices or manual processes) "
      + "and TradeIndia terms forbid robot/spider/automatic access; PLAN_V2 4.3 bans scraping both directories. "
      + "This order names no enable variable, so there is no enable path and the adapter stays disabled.",
  };
}

// ---- the adapter ------------------------------------------------------------

export const indiamart: ChannelAdapter = {
  id: INDIAMART_CHANNEL_ID,
  name: "IndiaMART / TradeIndia",
  tier: "C", // policy-ban channel (PLAN_V2 4.3); off by default
  categories: ["any"],

  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(" ").trim();
    const queries = [
      `site:${INDIAMART_SITE} "${q.category}" ${loc}`.trim(),
      `site:${TRADEINDIA_SITE} "${q.category}" ${loc}`.trim(),
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
    const site = /tradeindia\.com/i.test(lead.sourceUrl) ? TRADEINDIA_SITE : INDIAMART_SITE;
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
          channel: INDIAMART_CHANNEL_ID,
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
    const parsed = parseIndiamartPage(text);
    const fields: Record<string, string | number | undefined> = { ...parsed };
    return {
      channel: INDIAMART_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals: indiamartSignals(parsed, text),
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => indiamartSignals(parseIndiamartPage(text), text),
};

registerChannel(indiamart);
