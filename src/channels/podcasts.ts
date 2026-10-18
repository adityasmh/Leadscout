// ChannelAdapter for podcasts (business / creator presence) on Spotify, Apple
// Podcasts and JioSaavn (Order L67-ch-podcasts). Useful for coaches,
// consultants, agencies and creators.
//
// OFF by default: `status()` is disabled with a `why` unless
// LEADSCOUT_CH_PODCASTS=1, and it is also disabled when the browser kill switch
// LEADSCOUT_BROWSER=0 blocks the fallback path.
//
// Read order per page (enrich): search snippet first, then a plain readPage,
// then deps.browser.read (platform "other", the reader enforces its hourly caps)
// ONLY when the previous read returned a *blocked* result (403, 429, captcha or
// an empty body) as decided by reachBlocked() from ./types.js. A login wall /
// captcha after browser escalation surfaces as BrowserBlockedError -> evidence
// with signal "needs-human" and NO fields; it is never solved or retried.
//
// Rules: every value is copied verbatim from the fetched text / search snippet
// and every claim carries its source URL (the evidence url). A field the page
// does not show stays missing (undefined key omitted) - never inferred or
// invented. Fetched text is neutralised (instruction-like lines stripped) and
// stored on evidence with untrusted: true.
//
// Real page structure verified 2026-10-09 by web search + a plain fetch
// (see docs/leadgen/REPORT_L67-ch-podcasts.md for confirmed vs unverified):
//  - Apple Podcasts (podcasts.apple.com/us/podcast/<slug>/id<id>): a plain fetch
//    returns a "Show - Podcast - Apple Podcasts" title, "Hosted by <names>" in
//    the description, "\u2026 Episodes <N> \u2026" in the Information block, relative
//    episode times ("4h ago", "3d ago"), "Hosts & Guests" with "<Name> Host",
//    and a "Show Website" row.
//  - JioSaavn (jiosaavn.com/shows/<slug>/<season>/<id>): a "# <Show name>"
//    heading, "Podcast \u00b7 <N> Fans", "<N> Season s", numbered episodes
//    ("Ep 449: \u2026") and a show-description paragraph.
//  - Spotify (open.spotify.com/show/<id>): server-rendered HTML is a shell
//    ("Spotify \u2013 Web Player"), so a plain fetch returns an empty body and the
//    reader's browser fallback is what is needed; the Spotify Web API (get-a-show)
//    documents name, description, publisher, total_episodes - not fetched here.
import { BrowserBlockedError, reachBlocked } from "./types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, ChannelStatus, DiscoverQuery } from "./types.js";
import type { RawLead } from "../types.js";
import { parseSearchOutput, sanitizeUntrusted } from "../reach.js";
import { registerChannel } from "./registry.js";

export const PODCASTS_CHANNEL_ID = "podcasts";
const MAX_TEXT = 20000;
const DEFAULT_LIMIT = 20;
/** More than this many days since the latest episode -> inactive-show. */
export const INACTIVE_DAYS = 90;

export type PodcastFields = {
  showName?: string;
  host?: string;
  episodeCount?: string;
  lastEpisodeDate?: string;
  description?: string;
  website?: string;
  instagram?: string;
  facebook?: string;
  twitter?: string;
  linkedin?: string;
  youtube?: string;
  whatsapp?: string;
} & Record<string, string | number | undefined>;

const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?(previous|prior|above)\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b|^\s*(?:<\/?(tool|function|invoke)\b|<\|[^|]*\|>)|^\s*```/i;

const RELATIVE_AGO_RE =
  /(\d+)\s*(second|minute|hour|day|week|month|year|hr|min|mo|h|d|w|y)s?\s+ago/i;
const ANY_URL_RE = /https?:\/\/[^\s"'<>)•·]+/gi;
const PLATFORM_HOST_RE = /(^|\.)(spotify\.com|scdn\.co|podcasts\.apple\.com|itunes\.apple\.com|apple\.com|jiosaavn\.com|google\.com|googleusercontent\.com)$/i;
const CONTACT_RE =
  /(mailto:|wa\.me\/\d|api\.whatsapp\.com|calendly\.com|cal\.com\/|linktr\.ee|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https?:\/\/[^\s"'<>]*\/(?:contact|book(?:ing)?|enquir|inquir|get-in-touch|schedule)\b)/i;

const PLATFORM_PATTERNS: { platform: string; re: RegExp }[] = [
  { platform: "spotify", re: /^https?:\/\/open\.spotify\.com\/show\/[A-Za-z0-9]+/i },
  { platform: "apple", re: /^https?:\/\/podcasts\.apple\.com\/[^/]+\/podcast\/[^/]+\/id\d+/i },
  { platform: "jiosaavn", re: /^https?:\/\/[^/]*jiosaavn\.com\/(?:shows|podcasts)\//i },
];

export function platformOfUrl(url: string): string | undefined {
  const u = String(url ?? "").trim();
  return PLATFORM_PATTERNS.find((p) => p.re.test(u))?.platform;
}

// ---- text neutralisation ----------------------------------------------------

/** Drop instruction-like lines (never copy them into evidence). */
export function dropInjection(text: string): string {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => !INJECTION_NEVER_COPY.test(l))
    .join("\n");
}

/** Strip injected instruction text and cap the length (from reach.ts). */
function neutralise(text: string): string {
  return sanitizeUntrusted(String(text ?? ""), MAX_TEXT);
}

// ---- date helpers -----------------------------------------------------------

/** "8 months ago" / "4h ago" -> an approximate day count; else undefined. */
export function relativeDays(raw: string): number | undefined {
  const m = String(raw ?? "").match(RELATIVE_AGO_RE);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const u = m[2].toLowerCase();
  const perUnit =
    u === "second" || u === "minute" || u === "hour" || u === "hr" || u === "min" || u === "h" ? 0
    : u === "day" || u === "d" ? 1
    : u === "week" || u === "w" ? 7
    : u === "month" || u === "mo" ? 30
    : 365;
  return n * perUnit;
}

/** Parse an absolute date (ISO or "Mon DD[, YYYY]") to epoch ms. `now` is used
 *  only to fill a missing year - never the real clock. */
function absoluteMs(raw: string, now?: number): number | undefined {
  const s = String(raw ?? "");
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const t = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    if (!Number.isNaN(t)) return t;
  }
  const mon = s.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\b/i);
  if (mon) {
    const year = mon[3] ? Number(mon[3]) : now !== undefined ? new Date(now).getUTCFullYear() : undefined;
    if (year === undefined) return undefined;
    const t = Date.parse(`${mon[1]} ${mon[2]} ${year} UTC`);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

/** Days since the latest episode, from a labelled date, a relative phrase in
 *  the text, or an absolute date (the last only when an injected `now` exists). */
export function lastEpisodeDays(f: PodcastFields, text: string, now?: number): number | undefined {
  const raw = String(f.lastEpisodeDate ?? "");
  const rel = relativeDays(raw) ?? relativeDays(RELATIVE_AGO_RE.exec(String(text ?? ""))?.[0] ?? "");
  if (rel !== undefined) return rel;
  if (now !== undefined) {
    const ms = absoluteMs(raw, now) ?? absoluteMs(text, now);
    if (ms !== undefined) return Math.max(0, Math.round((now - ms) / 86400000));
  }
  return undefined;
}

// ---- page parsing -----------------------------------------------------------

function decodeEntities(s: string): string {
  return String(s ?? "")
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** Strip trailing platform / "Podcast" suffixes from a search-result title. */
export function cleanTitle(raw?: string): string | undefined {
  let s = decodeEntities(String(raw ?? "")).replace(/\s+/g, " ").trim();
  s = s.replace(/\s*[-|–—]\s*(Apple Podcasts?|Spotify|JioSaavn)\s*$/i, "");
  s = s.replace(/\s*[-|–—]\s*Podcast\s*$/i, "");
  return s.trim() || undefined;
}

/** Derive a display name from a listing URL slug (Apple / JioSaavn only). */
export function slugFromUrl(url: string): string | undefined {
  const u = String(url ?? "");
  const apple = u.match(/\/podcast\/([^/]+)\/id\d+/i);
  if (apple) return decodeEntities(apple[1].replace(/[-_]+/g, " ")).trim() || undefined;
  const jio = u.match(/\/shows\/([^/]+)/i) ?? u.match(/\/podcasts\/([^/]+)/i);
  if (jio) return decodeEntities(jio[1].replace(/[-_]+/g, " ")).trim() || undefined;
  return undefined;
}

function classifyUrl(url: string): { kind: "website" | "social" | "skip"; key?: string } {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { kind: "skip" };
  }
  if (PLATFORM_HOST_RE.test(host)) return { kind: "skip" };
  if (/(^|\.)instagram\.com$/.test(host)) return { kind: "social", key: "instagram" };
  if (/(^|\.)facebook\.com$|(^|\.)fb\.com$/.test(host)) return { kind: "social", key: "facebook" };
  if (/(^|\.)twitter\.com$|(^|\.)x\.com$/.test(host)) return { kind: "social", key: "twitter" };
  if (/(^|\.)linkedin\.com$/.test(host)) return { kind: "social", key: "linkedin" };
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) return { kind: "social", key: "youtube" };
  if (/(^|\.)wa\.me$|(^|\.)whatsapp\.com$/.test(host)) return { kind: "social", key: "whatsapp" };
  return { kind: "website" };
}

/** Parse a podcast show page (or a search-snippet block) into fields. Every
 *  value is a verbatim copy from the text or URL; anything the page does not
 *  show stays undefined and is omitted from the result. */
export function parsePodcastPage(text: string): PodcastFields {
  const clean = dropInjection(text);
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: PodcastFields = {};

  const labelled = (re: RegExp): string | undefined => {
    for (const l of lines) {
      const m = l.match(re);
      if (m?.[1]) return decodeEntities(m[1]).trim() || undefined;
    }
    return undefined;
  };

  // labelled generic fields (highest confidence)
  f.showName = labelled(/^(?:Show name|Show|Podcast|Title)\s*[:：]\s*(.+)$/i);
  f.host = labelled(/^(?:Host|Hosted by|Hosts|Creator|Author|Publisher)\s*[:：]\s*(.+)$/i);
  const epLabel = labelled(/^(?:Episodes?|Episode count|Total episodes)\s*[:：]\s*([\d.,]+\s*[KMB]?)$/i);
  if (epLabel) f.episodeCount = epLabel.replace(/\s+/g, "");
  f.lastEpisodeDate = labelled(/^(?:Last episode|Latest episode|Last updated|Updated)\s*[:：]\s*(.+)$/i);
  f.description = labelled(/^(?:Description|About|Show description)\s*[:：]\s*(.+)$/i);
  f.website = labelled(/^(?:Website|Show website|Site)\s*[:：]\s*(\S+)$/i);
  f.instagram = labelled(/^Instagram\s*[:：]\s*(\S+)$/i);
  f.facebook = labelled(/^Facebook\s*[:：]\s*(\S+)$/i);
  f.twitter = labelled(/^(?:Twitter|X)\s*[:：]\s*(\S+)$/i);
  f.linkedin = labelled(/^LinkedIn\s*[:：]\s*(\S+)$/i);
  f.youtube = labelled(/^YouTube\s*[:：]\s*(\S+)$/i);
  f.whatsapp = labelled(/^WhatsApp\s*[:：]\s*(\S+)$/i);

  const isApple = /Apple Podcasts/i.test(clean);
  const isJio = /jiosaavn\.com|JioSaavn/i.test(clean);

  // show name: Apple "<Show> - Podcast - Apple Podcasts", then markdown heading,
  // then the first plausible short line.
  if (!f.showName && isApple) {
    const m = clean.match(/^\s*(.+?)\s+-\s+Podcast\s+-\s+Apple Podcasts\s*$/im);
    if (m) f.showName = decodeEntities(m[1]).trim() || undefined;
  }
  if (!f.showName) {
    const head = lines.find((l) => /^#\s+\S/.test(l));
    if (head) f.showName = head.replace(/^#\s+/, "").trim() || undefined;
  }
  if (!f.showName) {
    f.showName = lines.find((l) =>
      !/^#/.test(l)
      && !/subscriber|episodes?\b|seasons?\b|^podcast\b|https?:/i.test(l)
      && !/^[A-Za-z][A-Za-z ]{1,20}:\s/.test(l)
      && l.length <= 80) || undefined;
  }

  // host: "Hosted by <names>" anywhere; Apple "Hosts & Guests" + "<Name> Host".
  if (!f.host) {
    const m = clean.match(/Hosted by\s+([^\n.]{2,120})/i);
    if (m) f.host = m[1].trim() || undefined;
  }
  if (!f.host && isApple) {
    const idx = lines.findIndex((l) => /Hosts?\s*&\s*Guests/i.test(l));
    if (idx >= 0) {
      const names: string[] = [];
      for (let i = idx + 1; i < lines.length && names.length < 3; i++) {
        const m = lines[i].match(/^(.+?)\s+Host$/i);
        if (m) names.push(m[1].trim());
      }
      if (names.length) f.host = names.join(", ");
    }
  }

  // episode count: labelled, "<n> episodes", or Apple "Episodes <n>".
  if (!f.episodeCount) {
    const m = clean.match(/([\d.,]+\s*[KMB]?)\s+episodes?\b/i);
    if (m) f.episodeCount = m[1].replace(/\s+/g, "").toUpperCase();
  }
  if (!f.episodeCount && isApple) {
    const m = clean.match(/\bEpisodes\s+([\d.,]+\s*[KMB]?)\b/i);
    if (m) f.episodeCount = m[1].replace(/\s+/g, "").toUpperCase();
  }

  // last episode date: labelled, else the first relative "N ... ago" phrase.
  if (!f.lastEpisodeDate) {
    const rel = RELATIVE_AGO_RE.exec(clean);
    if (rel) f.lastEpisodeDate = rel[0].trim();
  }

  // description: labelled, else the first long, non-episode paragraph.
  if (!f.description) {
    const cand = lines.find((l) =>
      l.length >= 80
      && !/^https?:/i.test(l)
      && !/^[A-Za-z][A-Za-z ]{1,20}:\s/.test(l)
      && !/^(?:ep|episode|season)\s*\d/i.test(l));
    if (cand) f.description = cand.replace(/\s+/g, " ").slice(0, 2000);
  }

  // links found verbatim in the text, classified by host (never a platform host)
  for (const u of clean.match(ANY_URL_RE) ?? []) {
    const url = u.replace(/[.,;]+$/, "");
    if (/^https?:\/\/(?:open\.spotify\.com|podcasts\.apple\.com|jiosaavn\.com)/i.test(url)) continue;
    const c = classifyUrl(url);
    if (c.kind === "social" && c.key) {
      const target = f as Record<string, string | undefined>;
      if (target[c.key] === undefined) target[c.key] = url;
    } else if (c.kind === "website" && f.website === undefined) {
      f.website = url;
    }
  }

  // a field the page does not show stays missing (never leave an undefined key)
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f;
}

// ---- signals ----------------------------------------------------------------

export type PodcastSignalOpts = { now?: number; thresholdDays?: number };

/** Stable signal ids (CONTRACT.md SIGNALS vocabulary, channel-specific names):
 *  content-business-no-website, inactive-show, host-contact-link.
 *  `opts.now` (epoch ms, from deps.now) is used for absolute episode dates;
 *  the real clock is never read here. */
export function podcastSignals(f: PodcastFields, text: string, opts: PodcastSignalOpts = {}): string[] {
  const t = String(text ?? "");
  const threshold = opts.thresholdDays ?? INACTIVE_DAYS;
  const days = lastEpisodeDays(f, t, opts.now);
  const out: string[] = [];

  const active = days !== undefined && days <= threshold;
  const hasWebsite = f.website !== undefined && String(f.website).trim() !== "";
  const hasContact = CONTACT_RE.test(t);

  if (active && !hasWebsite && !hasContact) out.push("content-business-no-website");
  if (days !== undefined && days > threshold) out.push("inactive-show");
  if (hasContact) out.push("host-contact-link");

  return [...new Set(out)];
}

// ---- status -----------------------------------------------------------------

function envOf(env?: Record<string, string | undefined>): Record<string, string | undefined> {
  return env ?? (process.env as Record<string, string | undefined>);
}

/** Disabled by default; enabled only by LEADSCOUT_CH_PODCASTS=1. Also disabled
 *  when the browser kill switch LEADSCOUT_BROWSER=0 blocks the fallback. */
export function podcastsStatus(env?: Record<string, string | undefined>): ChannelStatus {
  const e = envOf(env);
  if (e.LEADSCOUT_BROWSER === "0") {
    return {
      enabled: false,
      why: "podcast adapter disabled: browser kill switch LEADSCOUT_BROWSER=0 is set, which blocks the "
        + "search/page-blocked fallback (unset LEADSCOUT_BROWSER=0 and set LEADSCOUT_CH_PODCASTS=1)",
    };
  }
  if (e.LEADSCOUT_CH_PODCASTS !== "1") {
    return {
      enabled: false,
      why: "podcast adapter is off by default: set LEADSCOUT_CH_PODCASTS=1 to enable the search + page-read "
        + "path (the operator browser fallback additionally needs LEADSCOUT_BROWSER=1)",
    };
  }
  return { enabled: true };
}

// ---- discovery --------------------------------------------------------------

type SearchHit = { title?: string; url: string; snippet?: string };

function platformQueries(q: DiscoverQuery): { platform: string; query: string }[] {
  const loc = [q.area, q.city].filter(Boolean).join(" ").trim();
  const term = [q.category, loc].filter(Boolean).join(" ").trim();
  return [
    { platform: "spotify", query: `site:open.spotify.com/show ${term}`.trim() },
    { platform: "apple", query: `site:podcasts.apple.com ${term}`.trim() },
    { platform: "jiosaavn", query: `site:jiosaavn.com/shows ${term}`.trim() },
  ];
}

/** Map search hits to RawLead[]. Only the snippet's title (or the URL slug) names
 *  the lead and the hit URL is the source; nothing else is fabricated. */
export function resultsToLeads(hits: SearchHit[], category: string, city: string | undefined, limit: number): RawLead[] {
  const out: RawLead[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (out.length >= limit) break;
    const url = String(hit.url ?? "").trim();
    if (!platformOfUrl(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    const name = cleanTitle(hit.title) ?? slugFromUrl(url);
    if (!name) continue;
    seen.add(key);
    out.push({
      name,
      category,
      ...(city ? { city } : {}),
      source: PODCASTS_CHANNEL_ID,
      sourceUrl: url,
    });
  }
  return out;
}

// ---- read chain + evidence --------------------------------------------------

type ReadOut = { via: "search" | "page" | "browser"; text: string; url: string };

/** search snippet -> readPage -> browser, the browser ONLY when the previous
 *  read is blocked (reachBlocked). The browser is asked for platform "other";
 *  its per-platform hourly caps are enforced inside the reader. */
async function readInOrder(deps: ChannelDeps, opts: { searchQuery: string; url?: string }): Promise<ReadOut> {
  const s = await deps.search(opts.searchQuery);
  if (!reachBlocked(s)) return { via: "search", text: s.text, url: `search:${opts.searchQuery}` };
  if (opts.url) {
    const p = await deps.readPage(opts.url);
    if (!reachBlocked(p)) return { via: "page", text: p.text, url: opts.url };
  }
  if (!deps.browser) {
    throw new Error("podcasts: search and page read are blocked and no browser fallback is configured");
  }
  const b = await deps.browser.read(opts.url || opts.searchQuery, { platform: "other", reason: "podcasts-fallback" });
  return { via: "browser", text: b.text, url: b.url };
}

function needsHumanEvidence(lead: RawLead, deps: ChannelDeps): ChannelEvidence {
  return {
    channel: PODCASTS_CHANNEL_ID,
    url: lead.sourceUrl,
    fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    via: "browser",
    fields: {},
    signals: ["needs-human"],
    text: "",
    untrusted: true,
  };
}

// ---- the adapter ------------------------------------------------------------

export const podcasts: ChannelAdapter = {
  id: PODCASTS_CHANNEL_ID,
  name: "Podcasts (Spotify, Apple Podcasts, JioSaavn)",
  tier: "B",
  categories: ["coach", "consultant", "agency", "creator", "any"],
  status: () => podcastsStatus(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT));
    const hits: SearchHit[] = [];
    for (const { query } of platformQueries(q)) {
      let res;
      try {
        res = await deps.search(query);
      } catch {
        continue; // one platform failing must not lose the others
      }
      if (!res.ok) continue;
      const results: SearchHit[] = res.results && res.results.length
        ? res.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }))
        : parseSearchOutput(res.text);
      for (const r of results) hits.push({ title: r.title, url: r.url, snippet: r.snippet });
    }
    return resultsToLeads(hits, q.category, q.city, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: ReadOut;
    try {
      read = await readInOrder(deps, {
        searchQuery: `"${lead.name}" ${lead.city ?? ""} podcast`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) return needsHumanEvidence(lead, deps);
      throw err;
    }
    const text = neutralise(read.text);
    const fields = parsePodcastPage(text);
    // the show name may come from the search snippet when the page omits it
    if (!fields.showName) fields.showName = lead.name;
    const clean: Record<string, string | number | undefined> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v;
    const signals = podcastSignals(fields, text, { now: deps.now?.() });
    return {
      channel: PODCASTS_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields: clean,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => podcastSignals(parsePodcastPage(text), text),
};

registerChannel(podcasts);
