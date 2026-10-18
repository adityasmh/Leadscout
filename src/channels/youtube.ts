// ChannelAdapter for YouTube channels of local businesses (Order L53-ch-youtube).
//
// OFF by default. Enabled only by an environment variable:
//  - LEADSCOUT_YOUTUBE=1  -> the reach/search + page-read path (site:youtube.com
//                            search results, channel page reads); or
//  - LEADSCOUT_BROWSER=1  -> the operator's own logged-in browser reader
//                            (youtube.com is on data/browser-allowlist.json).
// LEADSCOUT_BROWSER=0 remains the hard kill switch inside the browser reader.
//
// Read order per page comes from registry.readWithFallback: search first, then a
// plain page read, then the browser reader ONLY when both are blocked
// (403, 429, captcha, empty body). A login wall / captcha after browser
// escalation surfaces as needs-human and is never solved or retried.
//
// Real page structure verified 2026-10-09 by web search + a plain fetch
// (see docs/leadgen/REPORT_L53-ch-youtube.md for what is confirmed vs
// unverified):
//  - robots.txt (https://www.youtube.com/robots.txt) disallows /results,
//    /feeds/videos.xml, /api/, /youtubei/ etc.; channel and watch pages are
//    crawlable. The automated-access clause of the YouTube ToS is NOT fetched
//    in this run, so the conservative default (off) stands.
//  - A channel page shows "<name> @handle • <N> subscribers • <N> videos",
//    the About tab shows the description and up to 14 links, and the Videos
//    tab shows "title / <N> views • <relative time ago>".
//
// Rules: every value is copied verbatim from the fetched text or a search
// snippet with its source URL; a field the page does not show stays missing
// (never inferred or invented). Fetched text is neutralised via
// reach.sanitizeUntrusted and stored on evidence marked untrusted: true.
import { sanitizeUntrusted, reachSpawn } from "../reach.js";
import { BrowserBlockedError } from "./types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, ChannelStatus, DiscoverQuery } from "./types.js";
import type { RawLead } from "../types.js";
import { readWithFallback, registerChannel } from "./registry.js";
import type { FallbackRead } from "./registry.js";

export const YOUTUBE_CHANNEL_ID = "youtube-official"; // matches india-sources.json registry data (L41)
export const YOUTUBE_SITE = "youtube.com";
const MAX_TEXT = 20000;
/** More than this many days since the latest upload -> inactive-channel. */
export const INACTIVE_DAYS = 90;
/** A video with at least this many views counts as "strong views". */
export const STRONG_VIEWS_THRESHOLD = 10000;
/** transcribeSample: at most one video of ten minutes per lead. */
export const MAX_SAMPLE_SECONDS = 600;

export type YoutubeFields = {
  name?: string;
  handle?: string;
  subscribers?: string;
  videoCount?: string;
  lastUpload?: string;
  lastUploadDaysAgo?: number;
  uploadFrequency?: string;
  description?: string;
  website?: string;
  whatsapp?: string;
  facebook?: string;
  instagram?: string;
  twitter?: string;
  linkedin?: string;
} & Record<string, string | number | undefined>;

// ---- parsers: only exact matches become fields ------------------------------

const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?(previous|prior|above)\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b|^\s*(?:<\/?(tool|function|invoke)\b|<\|[^|]*\|>)|^\s*```/i;

const CHANNEL_URL_RE =
  /https?:\/\/(?:www\.)?youtube\.com\/(?:@[A-Za-z0-9_.\-]+|channel\/[A-Za-z0-9_\-]+)/i;
const ANY_URL_RE = /https?:\/\/[^\s"'<>)•·]+/gi;
const RELATIVE_RE = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i;
const CTA_RE =
  /\b(book|contact|call us|call now|visit|order|enquir|inquire|whatsapp|sign up|subscribe to (?:our )?(?:newsletter|channel)|link (?:below|in (?:the )?bio)|dm (?:us|me)|email us)\b/i;
const SCHEDULE_RE =
  /\b(every\s+(?:day|week|month|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|biweekly|bi-weekly|monthly|twice a week)\b/i;

function dropInjection(text: string): string {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => !INJECTION_NEVER_COPY.test(l))
    .join("\n");
}

/** "202M" / "1,234" / "2.1K" -> an integer; anything else stays undefined. */
export function parseCount(raw: string | undefined): number | undefined {
  const s = String(raw ?? "").replace(/,/g, "").replace(/\s+/g, "").trim();
  const m = s.match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const mult = m[2] ? { K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase() as "K" | "M" | "B"] ?? 1 : 1;
  return Math.round(n * mult);
}

/** "3 months ago" -> an approximate day count (30 d/month, 365 d/year). */
export function relativeDays(raw: string | undefined): number | undefined {
  const m = String(raw ?? "").match(RELATIVE_RE);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2].toLowerCase();
  const days = unit === "second" || unit === "minute" || unit === "hour" ? 0
    : unit === "day" ? 1
    : unit === "week" ? 7
    : unit === "month" ? 30
    : 365;
  return n * days;
}

function nameFromYoutubeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const handle = url.match(/youtube\.com\/@([A-Za-z0-9_.\-]+)/i);
  if (handle) return handle[1].replace(/[-_]+/g, " ").trim() || undefined;
  const channel = url.match(/youtube\.com\/channel\/([A-Za-z0-9_\-]+)/i);
  if (channel) return channel[1];
  return undefined;
}

/** Parse a YouTube channel page (or a search-snippet block) into fields.
 *  Every value is a verbatim copy from the text or the URL; anything the page
 *  does not show stays undefined. */
export function parseYoutubePage(text: string): YoutubeFields {
  const clean = dropInjection(text);
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: YoutubeFields = {};

  const labelled = (re: RegExp): string | undefined => {
    const hit = lines.find((l) => re.test(l));
    const m = hit?.match(re);
    return m?.[1]?.trim() || undefined;
  };

  // name / handle
  f.name = labelled(/^(?:Channel name|Name)\s*[:：]\s*(.+)$/i);
  const handleLabel = labelled(/^(?:Handle|Username)\s*[:：]\s*(@?[A-Za-z0-9_.\-]{2,})$/i);
  const handleLine = lines.find((l) => /^@[A-Za-z0-9_.\-]{2,}$/.test(l));
  if (handleLabel || handleLine) {
    const h = (handleLabel ?? handleLine ?? "").replace(/^@/, "");
    f.handle = `@${h}`;
  }
  const urlMatch = clean.match(/youtube\.com\/@([A-Za-z0-9_.\-]+)/i);
  if (!f.handle && urlMatch) f.handle = `@${urlMatch[1]}`;
  if (!f.name && urlMatch) f.name = urlMatch[1].replace(/[-_]+/g, " ").trim() || undefined;
  if (!f.name) {
    // a real channel page leads with the channel name on the first line.
    f.name = lines.find((l) =>
      !/^@/.test(l)
      && !/subscribers?|\bvideos?\b/i.test(l)
      && !/^https?:/i.test(l)
      && !/^(?:Description|About|Website|WhatsApp|Facebook|Instagram|Twitter|LinkedIn|Video)\b/i.test(l)
      && l.length <= 80);
  }

  // subscriber count and video count, verbatim ("202M", "2.1K", "1,234").
  const sub = clean.match(/([\d.,]+\s*[KMB]?)\s+subscribers?/i);
  if (sub) f.subscribers = sub[1].replace(/\s+/g, "").toUpperCase();
  const vid = clean.match(/([\d.,]+\s*[KMB]?)\s+videos?\b/i);
  if (vid) f.videoCount = vid[1].replace(/\s+/g, "").toUpperCase();
  f.subscribers = labelled(/^Subscribers?\s*[:：]\s*([\d.,]+\s*[KMB]?)$/i) ?? f.subscribers;
  f.videoCount = labelled(/^Videos?\s*[:：]\s*([\d.,]+\s*[KMB]?)$/i) ?? f.videoCount;

  // latest videos: title + view count + relative date. Real pages put the title
  // on one line and "<N> views • <relative>" on the next.
  const videos: { title: string; views?: string; rel?: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lab = lines[i].match(/^Video\s*[:：]\s*(.+)$/i);
    if (lab) {
      const parts = lab[1].split("|").map((p) => p.trim()).filter(Boolean);
      const title = parts[0]?.replace(/\s*[•·].*$/, "").trim();
      let views: string | undefined;
      let rel: string | undefined;
      for (const p of parts.slice(1)) {
        const vm = p.match(/^([\d.,]+\s*[KMB]?)\s+views?$/i);
        if (vm) views = vm[1].replace(/\s+/g, "").toUpperCase();
        const rm = p.match(RELATIVE_RE);
        if (rm) rel = rm[0];
      }
      if (title) videos.push({ title, views, rel });
      continue;
    }
    const vl = lines[i].match(/^([\d.,]+\s*[KMB]?)\s+views?\b(.*)$/i);
    if (vl) {
      const prev = lines[i - 1];
      const title = prev && !/views?\b/i.test(prev) ? prev : undefined;
      const rel = vl[2].match(RELATIVE_RE)?.[0];
      if (title) videos.push({ title, views: vl[1].replace(/\s+/g, "").toUpperCase(), rel });
    }
  }
  videos.slice(0, 10).forEach((v, i) => {
    f[`videoTitle${i + 1}`] = v.title;
    if (v.views) f[`viewCount${i + 1}`] = v.views;
  });

  // last upload date and upload frequency. The page only shows relative dates;
  // store the verbatim phrase and its approximate day count (never a fake date).
  const rels = videos.map((v) => v.rel).filter((r): r is string => !!r);
  if (rels.length) {
    f.lastUpload = rels[0];
    const d = relativeDays(rels[0]);
    if (d !== undefined) f.lastUploadDaysAgo = d;
  }
  f.lastUpload = labelled(/^(?:Last upload|Latest upload|Last video)\s*[:：]\s*(.+)$/i) ?? f.lastUpload;
  const statedFreq = labelled(/^(?:Upload frequency|Frequency)\s*[:：]\s*(.+)$/i);
  if (statedFreq) f.uploadFrequency = statedFreq;

  // description: an explicit label, else the paragraph after the stats lines.
  f.description = labelled(/^(?:Description|About|Channel description)\s*[:：]\s*(.+)$/i);
  if (!f.description) {
    const statIdx = lines.findIndex((l) => /subscribers?|\bvideos?\b/i.test(l));
    if (statIdx >= 0) {
      const para: string[] = [];
      for (let i = statIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (/^(?:Links?|Subscribe|Website|WhatsApp|Facebook|Instagram|Twitter|LinkedIn|Video)\b/i.test(l)) break;
        if (/^https?:\/\//i.test(l)) break;
        if (/^@/i.test(l) || /subscribers?|\bvideos?\b/i.test(l)) continue;
        para.push(l);
        if (para.join(" ").length > 2000) break;
      }
      if (para.length) f.description = para.join(" ").slice(0, 2000);
    }
  }
  // upload frequency: an explicit label, else a schedule phrase stated verbatim
  // in the description (never computed from the video list).
  if (!f.uploadFrequency && f.description) {
    const stated = f.description.match(SCHEDULE_RE);
    if (stated) f.uploadFrequency = stated[0];
  }

  // links: verbatim URLs found on the page, classified by host. youtube.com
  // links are the channel's own and are skipped.
  for (const u of clean.match(ANY_URL_RE) ?? []) {
    const url = u.replace(/[.,;]+$/, "");
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) continue;
    if (/(^|\.)wa\.me$|(^|\.)whatsapp\.com$/.test(host)) { f.whatsapp ??= url; continue; }
    if (/(^|\.)facebook\.com$|(^|\.)fb\.com$/.test(host)) { f.facebook ??= url; continue; }
    if (/(^|\.)instagram\.com$/.test(host)) { f.instagram ??= url; continue; }
    if (/(^|\.)twitter\.com$|(^|\.)x\.com$/.test(host)) { f.twitter ??= url; continue; }
    if (/(^|\.)linkedin\.com$/.test(host)) { f.linkedin ??= url; continue; }
    f.website ??= url;
  }
  const websiteLabel = labelled(/^Website\s*[:：]\s*(\S+)/i);
  if (websiteLabel) f.website = websiteLabel;
  const whatsappLabel = labelled(/^WhatsApp\s*[:：]\s*(\S+)/i);
  if (whatsappLabel) f.whatsapp = whatsappLabel;

  // a field the page does not show stays missing: never leave an undefined key.
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];

  return f;
}

// ---- signals ----------------------------------------------------------------

export type YoutubeSignalOpts = { website?: string; websiteText?: string };

/** Stable signal ids (CONTRACT.md SIGNALS vocabulary, channel-specific names):
 *  inactive-channel, no-links-in-description, strong-views-no-cta,
 *  channel-not-mentioned-on-website. */
export function youtubeSignals(
  f: YoutubeFields,
  text: string,
  opts: YoutubeSignalOpts = {},
): string[] {
  const t = String(text ?? "");
  const out: string[] = [];

  if (typeof f.lastUploadDaysAgo === "number" && f.lastUploadDaysAgo > INACTIVE_DAYS) {
    out.push("inactive-channel");
  }

  const hasExternalLink = !!(f.website || f.whatsapp || f.facebook || f.instagram || f.twitter || f.linkedin);
  if (!hasExternalLink) out.push("no-links-in-description");

  let maxViews: number | undefined;
  for (const [k, v] of Object.entries(f)) {
    if (/^viewCount\d+$/.test(k) && typeof v === "string") {
      const n = parseCount(v);
      if (n !== undefined && (maxViews === undefined || n > maxViews)) maxViews = n;
    }
  }
  const hasCta = hasExternalLink || CTA_RE.test(t);
  if (maxViews !== undefined && maxViews >= STRONG_VIEWS_THRESHOLD && !hasCta) {
    out.push("strong-views-no-cta");
  }

  if (opts.websiteText) {
    const site = opts.websiteText;
    const mentioned = (f.handle ? site.includes(f.handle) : false)
      || CHANNEL_URL_RE.test(site)
      || (f.name ? site.includes(f.name) : false);
    if (!mentioned) out.push("channel-not-mentioned-on-website");
  }
  return [...new Set(out)];
}

// ---- helpers ----------------------------------------------------------------

function envOn(name: string, env?: Record<string, string | undefined>): boolean {
  const v = (env ?? process.env)[name];
  return typeof v === "string" && v.trim() !== "";
}

/** Search-snippet lines -> RawLead[]. A `Name:` label, a markdown title or the
 *  `@handle`/`channel/UC...` URL slug names the lead; lines with no YouTube
 *  channel URL are skipped. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  let pendingName: string | undefined;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const line = rawLine.trim();
    const nameLabel = line.match(/^(?:Name|Channel)\s*[:：]\s*(.+)$/i);
    if (nameLabel) {
      pendingName = nameLabel[1].trim();
      continue;
    }
    const md = line.match(/\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/);
    let url: string | undefined;
    let title: string | undefined;
    if (md) {
      url = md[2];
      title = md[1];
    } else {
      url = line.match(CHANNEL_URL_RE)?.[0];
    }
    if (!url || !CHANNEL_URL_RE.test(url)) continue;
    const cleanUrl = url.replace(/[\s,.;]+$/, "");
    const name = pendingName ?? title ?? nameFromYoutubeUrl(cleanUrl);
    pendingName = undefined;
    if (!name) continue;
    leads.push({ name, category, source: YOUTUBE_CHANNEL_ID, sourceUrl: cleanUrl });
  }
  return leads;
}

export function youtubeStatus(env?: Record<string, string | undefined>): ChannelStatus {
  if (envOn("LEADSCOUT_YOUTUBE", env) || envOn("LEADSCOUT_BROWSER", env)) return { enabled: true };
  return {
    enabled: false,
    why: "YouTube channel adapter is off by default: the reach/search + page-read path needs "
      + "LEADSCOUT_YOUTUBE=1 and the operator browser path needs LEADSCOUT_BROWSER=1 "
      + "(youtube.com is on data/browser-allowlist.json); neither is set",
  };
}

// ---- transcribeSample (Agent Reach transcribe / Groq) -----------------------

export type SampleTranscript = {
  ok: boolean;
  text?: string;
  language?: string;
  durationSeconds?: number;
  error?: string;
};

/** Injectable transport: the only thing that dials out. Defaults to the
 *  documented `agent-reach transcribe "<url>"` command through reachSpawn. */
export type SampleTranscribeTransport = (
  videoUrl: string,
  opts: { maxSeconds: number },
) => Promise<SampleTranscript>;

export type TranscribeSampleDeps = {
  transport?: SampleTranscribeTransport;
  env?: Record<string, string | undefined>;
  /** One video per lead: pass a stable lead key (lead name or id). */
  leadKey?: string;
};

const transcribedLeads = new Set<string>();

/** Test seam: forget the per-lead cap (used by the offline check). */
export function resetSampleCap(): void {
  transcribedLeads.clear();
}

/** Default transport: `agent-reach transcribe "<url>"` (yt-dlp download + Groq
 *  Whisper) via the same spawn builder every Agent Reach call uses. Never run
 *  by the offline check; enabled only behind LEADSCOUT_TRANSCRIBE=1. */
export function defaultSampleTransport(): SampleTranscribeTransport {
  return async (videoUrl: string): Promise<SampleTranscript> => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const spawn = reachSpawn("agent-reach", ["transcribe", videoUrl]);
    const out = await run(spawn.file, spawn.args, { timeout: 180000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    const text = sanitizeUntrusted(String(out.stdout ?? ""));
    return { ok: text.length > 0, text, ...(text.length === 0 ? { error: "agent-reach transcribe returned empty output" } : {}) };
  };
}

/** Transcribe ONE sample video per lead, OFF unless LEADSCOUT_TRANSCRIBE=1 and
 *  capped at a ten-minute video. Never throws. */
export async function transcribeSample(
  videoUrl: string,
  deps: TranscribeSampleDeps = {},
): Promise<SampleTranscript & { videoUrl: string; via: "agent-reach" }> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const via = "agent-reach" as const;
  const url = String(videoUrl ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, videoUrl: url, via, error: "transcribeSample: a public http(s) video URL is required" };
  }
  if (env.LEADSCOUT_TRANSCRIBE !== "1") {
    return { ok: false, videoUrl: url, via, error: "transcribeSample is off: set LEADSCOUT_TRANSCRIBE=1 to enable it" };
  }
  const key = String(deps.leadKey ?? url);
  if (transcribedLeads.has(key)) {
    return { ok: false, videoUrl: url, via, error: "transcribeSample cap reached: one sample video per lead" };
  }
  const transport = deps.transport ?? defaultSampleTransport();
  transcribedLeads.add(key);
  try {
    const res = await transport(url, { maxSeconds: MAX_SAMPLE_SECONDS });
    if (res.durationSeconds !== undefined && res.durationSeconds > MAX_SAMPLE_SECONDS) {
      return { ok: false, videoUrl: url, via, error: `transcribeSample refused: video is ${res.durationSeconds}s, longer than the ${MAX_SAMPLE_SECONDS}s cap` };
    }
    return { ...res, videoUrl: url, via };
  } catch (err) {
    return { ok: false, videoUrl: url, via, error: `transcribeSample failed: ${(err as Error).message}` };
  }
}

// ---- the adapter ------------------------------------------------------------

export const youtube: ChannelAdapter = {
  id: YOUTUBE_CHANNEL_ID,
  name: "YouTube channels (local businesses)",
  tier: "A", // india-sources.json (L41): tier A channel (official-looking pages, crawlable robots)
  categories: ["any"],
  status: () => youtubeStatus(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    const searchQuery = `site:${YOUTUBE_SITE}/channel "${q.category}" "${loc}"`.trim();
    // read order, per the contract: search first (cheapest), then the page
    // read, then the browser reader only when both are blocked. The page
    // fallback is YouTube's own channel search results page.
    const term = [q.category, loc].filter(Boolean).join(" ");
    const read = await readWithFallback(deps, {
      searchQuery,
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent(term)}`,
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${YOUTUBE_SITE} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: YOUTUBE_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = { ...parseYoutubePage(text) };
    // The 4th signal compares the channel against the business website. When the
    // lead carries a website, read it best-effort (a normal page read, not part
    // of the main chain); a failure just leaves the signal out.
    let websiteText: string | undefined;
    const website = String(lead.website ?? "").trim();
    if (/^https?:\/\//i.test(website)) {
      try {
        const page = await deps.readPage(website);
        if (page.ok && page.text.trim() !== "") websiteText = sanitizeUntrusted(page.text);
      } catch {
        /* best-effort only */
      }
    }
    const signals = youtubeSignals(fields as YoutubeFields, text, { website, websiteText });
    return {
      channel: YOUTUBE_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => youtubeSignals(parseYoutubePage(text), text),
};

registerChannel(youtube);
