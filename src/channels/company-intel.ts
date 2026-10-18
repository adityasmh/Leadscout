// ChannelAdapter for company intelligence on Screener, Tickertape, Trendlyne
// and MoneyControl (Order L65-ch-company-intel).
//
// One adapter covers four public company-information sites for listed / larger
// firms. It is OFF by default and switched on ONLY by env
// LEADSCOUT_COMPANY_INTEL=1 (integrations OFF by default, PLAN_V2). The
// injected browser reader (the operator's own logged-in browser) is reached
// only through the registry's readWithFallback AFTER search and the plain page
// read both return blocked (403 / 429 / captcha / empty body); a login wall
// becomes needs-human evidence and is never solved or bypassed.
//
// NOTE: src/reach.ts (sanitizeUntrusted, searchWeb, readPage) lives at
// src/reach.ts, NOT under src/channels/. This adapter
// imports it as "../reach.js".
//
// Robots.txt / structure verified with web fetch on 2026-10-09:
//  - screener.in/robots.txt: Disallow /user/*, /*?q=, /*?sort=, /*?limit=,
//    /*?page=, /company/source/quarter/* (all other paths allowed).
//    Company page shows "Market Cap" ("₹ N Cr."), "About", Website, ticker,
//    sales/net-profit tables in "Rs. Crores" (quarterly columns are dates).
//  - tickertape.in/robots.txt: only /smallcase/*, /space/*, a US-stocks
//    pricing path disallowed; company page shows "<Name>", "<Sector>",
//    "<Sub-sector>", "Largecap", "With a market cap of ₹N cr", "Company
//    Profile", "Total Promoter Holding N%", "Announced On <date> ...".
//  - trendlyne.com/robots.txt: per-bot Disallow:/ list; for User-agent:* only
//    functional paths are disallowed; Crawl-delay: 1. Pages show
//    "SECTOR : <X>", "INDUSTRY : <Y>", "<Name>", "NSE: X | BSE: Y", and
//    "Promoters have increased holdings from A% to B% in <Mon YYYY> qtr." with
//    named promoter entities.
//  - moneycontrol.com/robots.txt: Disallow /stocks/company_info/* and
//    /stocks/stock_market/*. So company_info is NOT read here; discovery uses
//    allowed company/search pages and, when blocked, the browser fallback.
//    The MoneyControl terms text could not be fetched this run -> unverified
//    (see report).
//
// Rules: every field value is copied verbatim from the page text or the search
// snippet with its source URL; a value the page does not show stays missing
// (never inferred or invented). A revenue/profit trend is only accepted when
// the printed line also carries a date/year, so no undated financial figure is
// ever presented. All fetched text is neutralised via reach.sanitizeUntrusted
// and evidence is marked untrusted: true. Per-platform browser caps and pauses
// are enforced by browser.ts itself; the adapter never loops or re-reads a
// blocked page.
import { sanitizeUntrusted } from "../reach.js";
import { BrowserBlockedError } from "./types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "./types.js";
import type { RawLead } from "../types.js";
import { readWithFallback, registerChannel } from "./registry.js";
import type { FallbackRead } from "./registry.js";

export const COMPANY_INTEL_CHANNEL_ID = "company-intel";
export const COMPANY_INTEL_ENV = "LEADSCOUT_COMPANY_INTEL";
export const COMPANY_INTEL_SITES = ["screener.in", "tickertape.in", "trendlyne.com", "moneycontrol.com"] as const;
const MAX_TEXT = 20000;

export type CompanyIntelFields = {
  companyName?: string;
  sector?: string;
  marketCapBand?: string;
  revenueTrend?: string;
  profitTrend?: string;
  employees?: number;
  promoters?: string;
  announcements?: string[];
  website?: string;
};

// ---- helpers ----------------------------------------------------------------

const INJECTION_NEVER_COPY =
  /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)|reveal your|new instructions/i;
const DATE_RE =
  /\b(?:FY\s?\d{2,4}|Q[1-4]\s?FY\s?\d{2,4}|(?:19|20)\d{2}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i;
const UP_RE = /\b(?:up|grew|grow|growth|increased|increase|rose|rise|higher)\b/i;
const YOY_RE = /(?:yoy|year[ -]on[ -]year|year over year|year-on-year)/i;

export function hasDate(text: string): boolean {
  return DATE_RE.test(String(text ?? ""));
}

/** Collapse a page / snippet into trimmed non-empty lines with instruction-like
 *  text removed (injected text is data, never instructions). */
function cleanLines(text: string): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !INJECTION_NEVER_COPY.test(l));
}

function labelValue(lines: string[], label: string): string | undefined {
  const re = new RegExp(`^${label}\\s*[:：]\\s*\\S`, "i");
  const strip = new RegExp(`^${label}\\s*[:：]\\s*`, "i");
  const line = lines.find((l) => re.test(l));
  if (!line) return undefined;
  const v = line.replace(strip, "").trim();
  return v || undefined;
}

function labelValues(lines: string[], label: string): string[] {
  const re = new RegExp(`^${label}\\s*[:：]\\s*(\\S.*)$`, "i");
  const out: string[] = [];
  for (const l of lines) {
    const m = l.match(re);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(String(raw).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Find a printed revenue/profit trend line. Only lines that carry a date/year
 *  AND a direction/percentage are accepted, so an undated figure is never
 *  presented. The returned string is the page line verbatim (leading "X:"
 *  label stripped). */
function findTrend(lines: string[], kindRe: RegExp): string | undefined {
  for (const l of lines) {
    if (!kindRe.test(l)) continue;
    if (!hasDate(l)) continue;
    if (!/(%|\bup\b|\bdown\b|\bgrew\b|\bgrowth\b|\bdeclin|\bfell\b|\brise\b|\brose\b|\bhigher\b|\blower\b|\bincreas|\bdecreas)/i.test(l)) continue;
    return l.replace(/^[A-Za-z ()&/]{2,40}[:：]\s*/, "").trim() || l;
  }
  return undefined;
}

// ---- page / snippet parser --------------------------------------------------

/** Parse a company page (or a search snippet block) into fields. Every value is
 *  a verbatim copy from the text or URL; anything unmatched stays undefined. */
export function parseCompanyPage(text: string): CompanyIntelFields {
  const raw = String(text ?? "");
  const lines = cleanLines(raw);
  const flat = lines.join(" ").replace(/[ \t]+/g, " ");
  const f: CompanyIntelFields = {};

  // company name: explicit label first, else the first heading-looking line.
  const companyName =
    labelValue(lines, "Company") ??
    labelValue(lines, "Company Name") ??
    labelValue(lines, "Name");
  if (companyName) f.companyName = companyName;

  // sector: explicit label, else Trendlyne "SECTOR : X", else Tickertape prose.
  const sector =
    labelValue(lines, "Sector") ??
    flat.match(/\bSECTOR\s*[:：]\s*([^|]{2,60}?)(?:\s+INDUSTRY\b|$)/i)?.[1]?.trim() ??
    flat.match(/belongs to the ([A-Za-z &]{2,50}?) sector/i)?.[1]?.trim();
  if (sector) f.sector = sector;

  // market cap band: explicit label, else a printed band word. A bare rupee
  // market-cap value (Screener) is a figure, not a band, so it is not used.
  const band =
    labelValue(lines, "Market Cap Band") ??
    flat.match(/\b(Large ?cap|Mid ?cap|Small ?cap)\b/i)?.[1]?.trim();
  if (band) f.marketCapBand = band;

  // revenue / profit trend as printed, with its date.
  const revenueTrend = findTrend(lines, /\b(revenue|sales|total income|turnover)\b/i);
  if (revenueTrend) f.revenueTrend = revenueTrend;
  const profitTrend = findTrend(lines, /\b(profit|net profit|net income|pat|pbt)\b/i);
  if (profitTrend) f.profitTrend = profitTrend;

  // employee count if shown.
  const employees = num(labelValue(lines, "Employees") ?? labelValue(lines, "Employee Count"));
  if (employees !== undefined) f.employees = employees;

  // promoter names: explicit label only (never inferred from a holding %).
  const promoters =
    labelValue(lines, "Promoters") ??
    labelValue(lines, "Promoter") ??
    labelValue(lines, "Promoter Names");
  if (promoters) f.promoters = promoters;

  // recent announcements: every "Announcement:" line, else Tickertape's
  // "Announced On <date> ..." markers (verbatim, joined).
  const anns = labelValues(lines, "Announcement");
  if (anns.length) f.announcements = anns;
  else {
    const tt = [...flat.matchAll(/Announced On\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}[^A-Z]*)/g)].map((m) => m[0].trim());
    if (tt.length) f.announcements = tt;
  }

  // website: explicit label, else a labelled bare domain line (Screener style).
  const website =
    labelValue(lines, "Website") ??
    labelValue(lines, "Web") ??
    lines.find((l) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l));
  if (website) f.website = website;
  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids over parsed fields + raw text. */
export function companyIntelSignals(f: CompanyIntelFields, text: string = ""): string[] {
  const out: string[] = [];
  // growth: revenue up year on year AS PRINTED (both up-wards and YoY wording).
  if (f.revenueTrend && UP_RE.test(f.revenueTrend) && YOY_RE.test(f.revenueTrend)) out.push("growth");
  const t = String(text ?? "");
  if (/\bnew plant\b|\bnew unit\b|\bnew factory\b|\bnew facility\b|\bexpansion\b|\bgreenfield\b|\bcapacity expansion\b/i.test(t)) {
    out.push("new-plant-expansion");
  }
  if (/\bfunding\b|\bfundrais|\bfund raise\b|\braised\b[^.\n]{0,40}\b(?:cr|crore|million|billion|₹|rs\.?)\b|\bseries [a-e]\b/i.test(t)) {
    out.push("recent-funding");
  }
  const namedMd = /\b(?:managing director|MD)\b\s*[:：-]?\s*[A-Z][A-Za-z.]+/.test(t);
  if ((f.promoters && f.promoters.length > 0) || namedMd) out.push("promoter-or-md");
  return [...new Set(out)];
}

// ---- discovery ---------------------------------------------------------------

function hostMatches(url: string): boolean {
  const h = String(url).replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
  return COMPANY_INTEL_SITES.some((d) => h === d || h.endsWith(`.${d}`));
}

function nameFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    if (segs.length === 0) return undefined;
    let slug = segs[segs.length - 1];
    if (/^(latest|consolidated|standalone|overview|financials)$/i.test(slug) && segs.length > 1) slug = segs[segs.length - 2];
    const prev = segs[segs.length - 2];
    if (/^[A-Z0-9]{1,10}$/.test(slug) && prev && /[a-z]/.test(prev)) slug = prev;
    const name = slug.replace(/[-_+]/g, " ").replace(/\s+/g, " ").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

const URL_RE = /https?:\/\/(?:www\.)?(?:screener\.in|tickertape\.in|trendlyne\.com|moneycontrol\.com)\/[^\s"'<>),\]]+/gi;

/** Search-snippet lines (or a raw list) -> RawLead[]. Name comes from the URL
 *  slug; non-company URLs (moneycontrol /stocks/company_info disallowed) skip. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  const seen = new Set<string>();
  const raw = String(text ?? "");
  for (const m of raw.matchAll(URL_RE)) {
    if (leads.length >= limit) break;
    const url = m[0].replace(/[\s,.;]+$/, "");
    if (!hostMatches(url)) continue;
    if (/moneycontrol\.com\/stocks\/(?:company_info|stock_market)\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const name = nameFromUrl(url);
    if (!name) continue;
    leads.push({ name, category, source: COMPANY_INTEL_CHANNEL_ID, sourceUrl: url });
  }
  return leads;
}

// ---- status ------------------------------------------------------------------

export function companyIntelEnabled(): boolean {
  return process.env[COMPANY_INTEL_ENV] === "1";
}

function statusText(): { enabled: boolean; why?: string } {
  if (companyIntelEnabled()) return { enabled: true };
  return {
    enabled: false,
    why: "company intelligence is OFF by default (integrations are off unless switched on). "
      + `Set ${COMPANY_INTEL_ENV}=1 to read public company pages on Screener, Tickertape, Trendlyne and MoneyControl; `
      + `${COMPANY_INTEL_ENV} is "${String(process.env[COMPANY_INTEL_ENV] ?? "")}" (absent and 0 both mean off). `
      + "MoneyControl /stocks/company_info/* is disallowed by its robots.txt and is never read here.",
  };
}

// ---- the adapter -------------------------------------------------------------

export const companyIntel: ChannelAdapter = {
  id: COMPANY_INTEL_CHANNEL_ID,
  name: "Company Intel (Screener/Tickertape/Trendlyne/MoneyControl)",
  tier: "B",
  categories: ["manufacturing", "b2b-suppliers", "legal-and-accounting", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    const leads: RawLead[] = [];
    const seen = new Set<string>();
    for (const site of COMPANY_INTEL_SITES) {
      if (leads.length >= limit) break;
      const query = `site:${site} "${q.category}" ${loc}`.trim();
      const read = await readWithFallback(deps, { searchQuery: query });
      const text = sanitizeUntrusted(read.text);
      for (const lead of resultsToLeads(text, q.category, limit - leads.length)) {
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
      // search -> plain page read -> browser only when both are blocked
      // (403 / 429 / captcha / empty); browser caps enforced by browser.ts.
      const host = (() => {
        try { return new URL(lead.sourceUrl).hostname.replace(/^www\./, ""); } catch { return "screener.in"; }
      })();
      read = await readWithFallback(deps, {
        searchQuery: `site:${host} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: COMPANY_INTEL_CHANNEL_ID,
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
    const parsed = parseCompanyPage(text);
    const fields: Record<string, string | number | undefined> = {};
    if (parsed.companyName !== undefined) fields.companyName = parsed.companyName;
    if (parsed.sector !== undefined) fields.sector = parsed.sector;
    if (parsed.marketCapBand !== undefined) fields.marketCapBand = parsed.marketCapBand;
    if (parsed.revenueTrend !== undefined) fields.revenueTrend = parsed.revenueTrend;
    if (parsed.profitTrend !== undefined) fields.profitTrend = parsed.profitTrend;
    if (parsed.employees !== undefined) fields.employees = parsed.employees;
    if (parsed.promoters !== undefined) fields.promoters = parsed.promoters;
    if (parsed.announcements !== undefined) fields.announcements = parsed.announcements.join(" | ");
    if (parsed.website !== undefined) fields.website = parsed.website;
    return {
      channel: COMPANY_INTEL_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals: companyIntelSignals(parsed, text),
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => companyIntelSignals(parseCompanyPage(text), text),
};

registerChannel(companyIntel);
