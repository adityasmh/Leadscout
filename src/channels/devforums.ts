// ChannelAdapter for developer forums (Order L68-ch-devforums):
//  - r/developersIndia (Reddit) — via Agent Reach; the public search is the
//    primary read, and the browser reader's OpenCLI backend (when the operator
//    has it connected) is the fallback the registry uses for a blocked search.
//  - Hacker News (site:news.ycombinator.com)
//  - Dev.to (site:dev.to)
// Technology leads only: a result from another kind of source, or one without a
// technology marker, is skipped without error.
//
// Integration is OFF by default. status() reports why it is disabled; it is
// enabled only by env LEADSCOUT_DEVFORUMS=1. Nothing dials out unless the
// caller injects search/readPage/browser (ChannelDeps); the adapter itself
// never fetches and never opens a socket, so the offline check stays offline.
//
// Read order per page is the registry's own readWithFallback: search first,
// then a plain page read, then the browser reader ONLY when both returned a
// blocked result (403 / 429 / captcha / empty body). A login-wall / captcha
// after the browser escalation raises BrowserBlockedError -> needs-human
// evidence, never solved or bypassed. The browser reader enforces its own
// per-platform hourly caps, 2-6 s pause and one-page-at-a-time queue; this
// adapter never retries a blocked page and never calls the browser directly.
//
// Every field value is copied verbatim from page text or a search snippet with
// its source URL; a value the page does not show stays missing (never inferred
// or invented). All fetched text is neutralised through reach.sanitizeUntrusted
// and every evidence is untrusted: true.
import { sanitizeUntrusted } from "../reach.js";
import { BrowserBlockedError } from "./types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "./types.js";
import type { RawLead } from "../types.js";
import { readWithFallback, registerChannel } from "./registry.js";
import type { FallbackRead } from "./registry.js";

export const DEVFORUMS_CHANNEL_ID = "dev-forums";
export const DEVFORUMS_ENV = "LEADSCOUT_DEVFORUMS";
export const HN_SITE = "news.ycombinator.com";
export const DEVTO_SITE = "dev.to";
export const REDDIT_SUBREDDIT = "developersIndia";
const MAX_TEXT = 20000;

type ForumSource = { id: string; label: string; site: string; urlRe: RegExp };

export const FORUM_SOURCES: ForumSource[] = [
  {
    id: "reddit-developersindia",
    label: "r/developersIndia",
    site: `reddit.com/r/${REDDIT_SUBREDDIT}`,
    urlRe: /^https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/developersIndia\//i,
  },
  { id: "hacker-news", label: "Hacker News", site: HN_SITE, urlRe: /^https?:\/\/(?:www\.)?news\.ycombinator\.com\//i },
  { id: "devto", label: "Dev.to", site: DEVTO_SITE, urlRe: /^https?:\/\/(?:www\.)?dev\.to\//i },
];

// A result is a technology lead only when it carries a technology marker.
const TECH_MARKER_RE =
  /\b(dev(?:eloper|elopment)?s?|engineer(?:ing)?|software|saas|api|startup|program(?:ming|mer)|cod(?:e|ing)|tech(?:nology)?|back-?end|front-?end|full-?stack|devops|data|cloud|\bai\b|machine learning|\bml\b|hiring|launch|web|app|platform|infrastructure|database|open-?source|github|javascript|typescript|python|rust|golang)\b/i;

const LAUNCH_RE =
  /show hn|launch(?:ed|ing)?\b|we just (?:shipped|launched|released)|announcing\b|product hunt|beta (?:release|launch)|now available|introducing\b/i;

const SUPPORT_COMPLAINT_RE =
  /\b(?:no|slow|terrible|awful|poor|bad|unresponsive|nonexistent|useless)\s+(?:customer\s+)?support\b|\bsupport\s+(?:is\s+)?(?:slow|terrible|awful|unresponsive|nonexistent|useless)\b|\bno (?:reply|response) from (?:customer )?support\b|\bcan(?:'|’)?t reach (?:customer )?support\b|\b(?:support|customer support)\s+(?:tickets?|emails?)\s+(?:ignored|unanswered|unresolved)\b|\bcustomer support (?:complaints?|issues?|problems?)\b/i;

// Sentiment words are copied as printed; this is the vocabulary looked for.
export const SENTIMENT_WORDS = [
  "great", "excellent", "love", "awesome", "amazing", "helpful", "fast", "reliable", "promising",
  "terrible", "awful", "slow", "broken", "frustrating", "disappointing", "buggy", "unreliable", "confusing",
] as const;

const FORUM_HOST_RE = /(?:^|\.)(?:news\.ycombinator\.com|ycombinator\.com|dev\.to|reddit\.com|redd\.it)$/i;
// Social / profile / code hosts are not the product's own marketing site.
const NON_SITE_HOST_RE =
  /(?:^|\.)(?:twitter\.com|x\.com|github\.com|gitlab\.com|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|medium\.com|wa\.me|whatsapp\.com)$/i;

export type DevForumsFields = {
  mentions?: number;
  sentiment?: string;
  hiring?: string;
  productLaunch?: string;
};

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;
const MENTIONS_LABEL_RE = /^Mentions\s*[:：]\s*([\d,]+)\s*$/i;
const MENTIONS_PHRASE_RE = /\b([\d,]{1,12})\s+mentions?\b/i;

function linesOf(text: string): string[] {
  return String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function nameFromUrl(url: string): string | undefined {
  try {
    const segs = new URL(url).pathname.replace(/[?#].*$/, "").split("/").filter(Boolean);
    const slug = segs[segs.length - 1] ?? "";
    if (!slug || /^\d+$/.test(slug) || /^(item|comments?|index|latest|new|news|search|top)$/i.test(slug)) return undefined;
    const name = decodeURIComponent(slug).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

export function forumSiteFor(url: string | undefined): string | undefined {
  const u = String(url ?? "");
  for (const s of FORUM_SOURCES) if (s.urlRe.test(u)) return s.site;
  return undefined;
}

/** True when the text links to a page that is not a forum, social or code host
 *  (i.e. a plausible product marketing site). No link -> false. */
export function hasMarketingSite(text: string): boolean {
  const urls = String(text ?? "").match(URL_RE) ?? [];
  return urls.some((raw) => {
    try {
      const host = new URL(raw).hostname.replace(/^www\./, "").toLowerCase();
      return !FORUM_HOST_RE.test(host) && !NON_SITE_HOST_RE.test(host);
    } catch {
      return false;
    }
  });
}

/** Parse a forum page (or a search-snippet block) into the listed fields.
 *  Every value is a verbatim copy; anything unmatched stays undefined. */
export function parseDevForumsPage(text: string, leadName?: string): DevForumsFields {
  const clean = sanitizeUntrusted(String(text ?? ""));
  const lines = linesOf(clean);
  const f: DevForumsFields = {};

  // mentions: an explicit printed count only (never counted or inferred).
  const label = lines.find((l) => MENTIONS_LABEL_RE.test(l));
  const raw = label?.match(MENTIONS_LABEL_RE)?.[1] ?? clean.match(MENTIONS_PHRASE_RE)?.[1];
  if (raw !== undefined) {
    const n = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(n)) f.mentions = n;
  }

  // sentiment: vocabulary words present, in text order, as printed, deduped.
  const seen = new Set<string>();
  const found: string[] = [];
  const re = new RegExp(`\\b(${SENTIMENT_WORDS.join("|")})\\b`, "gi");
  for (const m of clean.matchAll(re)) {
    const key = m[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(m[1]);
  }
  if (found.length) f.sentiment = found.join(", ");

  // hiring: a "Who is hiring" line; when the company is known the line must name it.
  const need = String(leadName ?? "").toLowerCase();
  const hireLine = lines.find((l) => /who is hiring/i.test(l) && (need === "" || l.toLowerCase().includes(need)));
  if (hireLine) f.hiring = hireLine;

  // product launch: the first launch-looking line, copied verbatim.
  const launchLine = lines.find((l) => LAUNCH_RE.test(l));
  if (launchLine) f.productLaunch = launchLine;

  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids (documented in REPORT_L68-ch-devforums.md):
 *  tech-company-hiring-developers, product-launch-no-marketing-site,
 *  customer-support-automation-need. */
export function devForumsSignals(text: string): string[] {
  const t = sanitizeUntrusted(String(text ?? ""));
  const out: string[] = [];

  const hiring = /\b(who is hiring|is hiring|we(?:['’]re| are) hiring|now hiring|hiring[:：]|open roles?|job openings?|we have openings)\b/i.test(t);
  const devRole = /\b(developers?|engineers?|software|back-?end|front-?end|full-?stack|programmers?|sde|devops|data scien\w*|machine learning|ml engineer)\b/i.test(t);
  if (hiring && devRole) out.push("tech-company-hiring-developers");

  if (LAUNCH_RE.test(t) && !hasMarketingSite(t)) out.push("product-launch-no-marketing-site");

  if (SUPPORT_COMPLAINT_RE.test(t)) out.push("customer-support-automation-need");

  return [...new Set(out)];
}

// ---- discovery ---------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. A "Name:"/"Title:" line names the next
 *  matching forum URL (verbatim); otherwise the name comes from the URL slug.
 *  Results on other hosts, and results without a technology marker, are skipped
 *  without error. */
export function resultsToLeads(text: string, source: ForumSource, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  const lines = linesOf(sanitizeUntrusted(text));
  let pending: string | undefined;
  for (const line of lines) {
    if (leads.length >= limit) break;
    const nameLabel = line.match(/^(?:Name|Title)\s*[:：]\s*(.+)$/i);
    if (nameLabel) {
      pending = nameLabel[1].trim();
      continue;
    }
    const urls = line.match(URL_RE) ?? [];
    for (const rawUrl of urls) {
      if (leads.length >= limit) break;
      const url = rawUrl.replace(/[.,;]+$/, "");
      if (!source.urlRe.test(url)) continue;
      const name = pending ?? nameFromUrl(url);
      pending = undefined;
      if (!name) continue;
      if (!TECH_MARKER_RE.test(`${name} ${line}`)) continue; // non-technology lead: skip, no error
      leads.push({ name, category, source: DEVFORUMS_CHANNEL_ID, sourceUrl: url });
    }
  }
  return leads;
}

// ---- status and env gate -----------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (process.env[DEVFORUMS_ENV] === "1") return { enabled: true };
  return {
    enabled: false,
    why: `developer-forums integration is OFF by default; set ${DEVFORUMS_ENV}=1 to enable `
      + `(currently "${String(process.env[DEVFORUMS_ENV] ?? "")}"; absent and "0" both mean off)`,
  };
}

// ---- the adapter ------------------------------------------------------------

export const devForums: ChannelAdapter = {
  id: DEVFORUMS_CHANNEL_ID,
  name: "Developer forums (r/developersIndia, Hacker News, Dev.to)",
  tier: "B", // public forums; not in india-sources.json so no tier-C gate applies
  categories: ["any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    const out: RawLead[] = [];
    for (const source of FORUM_SOURCES) {
      if (out.length >= limit) break;
      const searchQuery = `site:${source.site} "${q.category}" ${loc}`.trim().replace(/\s+/g, " ");
      try {
        // search first; the read chain only escalates to the browser on a
        // blocked result, and one blocked source must not abort the others.
        const read = await readWithFallback(deps, { searchQuery });
        const text = sanitizeUntrusted(read.text);
        out.push(...resultsToLeads(text, source, q.category, limit - out.length));
      } catch {
        // blocked with no browser fallback configured: skip this source silently
      }
    }
    return out.slice(0, limit).map((l) => ({ ...l, ...(q.city ? { city: q.city } : {}) }));
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      const site = forumSiteFor(lead.sourceUrl) ?? HN_SITE;
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${site} "${lead.name}"`,
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after the browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: DEVFORUMS_CHANNEL_ID,
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
    return {
      channel: DEVFORUMS_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields: { ...parseDevForumsPage(text, lead.name) },
      signals: devForumsSignals(text),
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => devForumsSignals(sanitizeUntrusted(text)),
};

registerChannel(devForums);
