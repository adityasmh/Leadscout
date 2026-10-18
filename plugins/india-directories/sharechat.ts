// ChannelAdapter for ShareChat and Moj (Indian regional social + short-video),
// Order L66-ch-sharechat.
//
// OFF by default. Enabled only by env LEADSCOUT_SHARECHAT_ENABLED=1 (the channel
// is not in india-sources.json's registry, so no tier-C env applies here).
//
// Read order per page comes from registry.readWithFallback: search first, then a
// plain page read, then the browser reader ONLY when both are blocked
// (403, 429, captcha, empty body). The browser reader enforces its own
// per-platform hourly caps and its 2-6 s pause; this adapter never re-reads a
// blocked page and never bypasses needs-human. ShareChat/Moj are both on the
// browser allowlist (data/browser-allowlist.json); the browser maps both to the
// "other" platform (cap 60/h, per browser.ts).
//
// Verified 2026-10-09 by web search + page fetches:
//  - ShareChat profile URL is https://sharechat.com/profile/<handle> and the
//    profile page shows the display name, "@<handle>", a follower count
//    ("46,472फॉलोअर्स" / "38K Followers"), a post count ("6K Posts" / "1,199"),
//    and per-post view counts ("14.6K ने देखा").
//  - sharechat.com/robots.txt allows /post/, /tag/, /video/, /profile/ and
//    disallows /*?*; it blocks AdsBot and (as of 2026-10-06) allows the tracked
//    AI crawlers. The exact clause forbidding automated access in the ShareChat
//    Terms of Use was NOT fetched, so the terms position stays UNVERIFIED.
//  - Moj creator cards show "@<handle> <count>K/M Followers <Category>" (e.g.
//    "@cutepriyaa8 1.8M Followers Romance", creators.mojapp.in). Moj is operated
//    by Mohalla Tech Pvt. Ltd.; the automated-access clause was NOT verified.
//
// Rules: every field value is copied verbatim from page text or a search
// snippet with its source URL; a value the page does not show stays missing
// (never inferred, never expanded: a suffixed count like "38K" is kept verbatim,
// only a plain digit run is stored as a number). All fetched text is neutralised
// through reach.sanitizeUntrusted and evidence is marked untrusted: true.
import { parseSearchOutput, sanitizeUntrusted } from "../../src/reach.js";
import { BrowserBlockedError, reachBlocked } from "../../src/channels/types.js";
import type { BrowserReaderLike, ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const SHARECHAT_CHANNEL_ID = "sharechat"; // file id; covers ShareChat + Moj
export const SHARECHAT_ENV = "LEADSCOUT_SHARECHAT_ENABLED";
export const SHARECHAT_SITES = ["sharechat.com", "mojapp.in"] as const;
const MAX_TEXT = 20000;
const MAX_LIMIT = 20;

// Browser platform bucket both hosts map to (browser.ts platformOf -> "other").
const BROWSER_PLATFORM = "other";

export type SharechatFields = {
  profileName?: string;
  followerCount?: number | string;
  postCount?: number | string;
  lastPostDate?: string;
  category?: string;
  linkedContact?: string;
  linkedWebsite?: string;
};

// ---- injection guard (never copied into a field) ----------------------------
const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?(previous|prior|above)\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior|earlier)\b/i;

// Non-business platform paths that are never a profile / post.
const NON_PROFILE_PATH_RE =
  /\/(login|signin|signup|register|search|tag|tags|download|help|about|privacy|terms|policies|settings|account|explore|trending|discover)\b/i;

// Hosts that are never the business's own website (platforms / aggregators).
const PLATFORM_HOST_RE =
  /(?:^|\.)(?:sharechat|mojapp|google|googleapis|facebook|fbcdn|instagram|twitter|x|youtube|whatsapp|linkedin|swiggy|zomato)\./i;

// Scripts: Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam.
const REGIONAL_SCRIPT_RE =
  /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/;

/** A plain digit run becomes a number; a suffixed count ("38K") stays verbatim
 *  (expanding it would be inference, so it is never expanded). */
export function countValue(raw: string): number | string {
  const s = String(raw ?? "").trim();
  const plain = s.replace(/,/g, "");
  if (/^\d+$/.test(plain)) return Number(plain);
  return s;
}

function isPlatformUrl(url: string, site?: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    const onSite = SHARECHAT_SITES.some((s) => h === s || h.endsWith(`.${s}`));
    if (!onSite) return false;
    if (site && !(h === site || h.endsWith(`.${site}`))) return false;
    return true;
  } catch {
    return false;
  }
}

export function externalWebsite(text: string): string | undefined {
  for (const u of String(text ?? "").match(/https?:\/\/[^\s"'<>,)]+/gi) ?? []) {
    try {
      const h = new URL(u).hostname;
      if (!PLATFORM_HOST_RE.test(`${h}.`)) return u;
    } catch {
      /* skip malformed */
    }
  }
  return undefined;
}

export function nameFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const first = String(title).split(/[|•·]/)[0].trim();
  const m = first.match(/^(.*?)\s*\(@[^)]+\)/);
  if (m && m[1].trim()) return m[1].trim();
  const stripped = first.replace(/\s*[-–—]\s*(Videos?|Photos?|Posts?|ShareChat|Moj).*$/i, "").trim();
  return stripped || undefined;
}

export function nameFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    const slug = decodeURIComponent(segs[segs.length - 1] ?? "").replace(/^@/, "");
    if (!slug || /^\d+$/.test(slug)) return undefined;
    return slug.replace(/[-_]+/g, " ").trim() || undefined;
  } catch {
    return undefined;
  }
}

// ---- discovery: search snippets -> RawLead ----------------------------------

/** Search-result text -> RawLead[] for one site. Only URLs on that site that are
 *  not platform chrome become leads; the name is copied from the snippet title
 *  (or the URL slug). No name -> no lead (never fabricated). */
export function resultsToLeads(text: string, category: string, limit: number, site?: string): RawLead[] {
  const out: RawLead[] = [];
  for (const r of parseSearchOutput(sanitizeUntrusted(text))) {
    if (out.length >= limit) break;
    if (!isPlatformUrl(r.url, site)) continue;
    try {
      if (NON_PROFILE_PATH_RE.test(new URL(r.url).pathname)) continue;
    } catch {
      continue;
    }
    const name = nameFromTitle(r.title) ?? nameFromUrl(r.url);
    if (!name) continue;
    out.push({ name, category, source: SHARECHAT_CHANNEL_ID, sourceUrl: r.url });
  }
  return out;
}

function browserUnderCap(browser: BrowserReaderLike): boolean {
  try {
    const st = browser.status();
    const cap = st.caps?.[BROWSER_PLATFORM];
    const used = st.usedThisHour?.[BROWSER_PLATFORM] ?? 0;
    if (typeof cap === "number" && used >= cap) return false; // honour the reader's cap
    return true;
  } catch {
    return true;
  }
}

/** Search one site; when the search result is blocked, fall through to the
 *  browser reader (site search) only if one is configured and within its cap. */
async function searchPlatform(deps: ChannelDeps, site: string, query: string): Promise<string> {
  const r = await deps.search(query);
  if (!reachBlocked(r)) return sanitizeUntrusted(r.text);
  if (deps.browser && browserUnderCap(deps.browser)) {
    const b = await deps.browser.search(site, query);
    return sanitizeUntrusted(b.text);
  }
  return "";
}

// ---- page/snippet parser: only exact matches become fields -------------------

export function parseSharechatPage(text: string): SharechatFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ").trim();
  const f: SharechatFields = {};

  // profileName: explicit label, else a markdown heading, else "<name> (@handle)".
  const nameLine = lines.find((l) => /^(?:Name|Profile name|प्रोफ़ाइल नाम)\s*[:：]\s*\S/i.test(l));
  let name = nameLine?.replace(/^[^:：]*[:：]\s*/, "").trim();
  if (!name) {
    const heading = lines.find((l) => /^#\s+\S/.test(l));
    if (heading) name = heading.replace(/^#\s+/, "").trim();
  }
  if (!name) {
    const m = flat.match(/^(.+?)\s*\(@[\w.]+\)/);
    if (m && m[1].trim() && !/https?:/i.test(m[1])) name = m[1].trim();
  }
  if (name && !INJECTION_NEVER_COPY.test(name)) f.profileName = name;

  // followerCount
  const foll = flat.match(/([\d][\d.,]*\s*[KML]?)\s*(?:Followers?|फॉलोअर्स|फ़ॉलोअर्स)/i);
  if (foll) f.followerCount = countValue(foll[1].replace(/\s+/g, ""));

  // postCount
  const posts = flat.match(/([\d][\d.,]*\s*[KML]?)\s*(?:Posts?|पोस्ट)/i);
  if (posts) f.postCount = countValue(posts[1].replace(/\s+/g, ""));

  // lastPostDate: a label line, else "last post ... <n> <unit> ago".
  const dateLabel = lines.find((l) => /^(?:Last post|Posted|Updated|Last active|अंतिम पोस्ट)\s*[:：-]\s*\S/i.test(l));
  if (dateLabel) {
    f.lastPostDate = dateLabel.replace(/^[^:：-]*[:：-]\s*/, "").trim();
  } else {
    const ago = flat.match(/\b(?:last post|last active|posted|updated)\b[^.\n]{0,40}?(\d+\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|yrs?)\s+ago)/i);
    if (ago) f.lastPostDate = ago[1].trim();
  }

  // category: explicit label, else the Moj creator-card "Followers <Category>".
  const catLine = lines.find((l) => /^(?:Category|श्रेणी|वर्ग)\s*[:：]\s*\S/i.test(l));
  if (catLine) {
    f.category = catLine.replace(/^[^:：]*[:：]\s*/, "").trim();
  } else {
    const moj = flat.match(/@[\w.]+\s+[\d.,]+\s*[KML]?\s*Followers?\s+([A-Za-z][A-Za-z&' /-]{2,40})/);
    if (moj) f.category = moj[1].trim();
  }

  // linkedContact: wa.me / email / Indian mobile shown on the page.
  const wa = flat.match(/https?:\/\/(?:wa\.me\/\+?\d+|api\.whatsapp\.com\/send\?phone=\+?\d+)/i);
  const email = flat.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const phone = flat.match(/(?:\+?91[-\s]?)?[6-9]\d{9}\b/);
  const contact = wa?.[0] ?? email?.[0] ?? phone?.[0];
  if (contact) f.linkedContact = contact.trim();

  // linkedWebsite: only an external (non-platform) URL.
  const site = externalWebsite(flat);
  if (site) f.linkedWebsite = site;

  return f;
}

// ---- signals ----------------------------------------------------------------

function hasAudienceActivity(f: SharechatFields, text: string): boolean {
  return f.followerCount !== undefined || f.postCount !== undefined || /ने देखा|\bviews?\b/i.test(text);
}

/** Stable, channel-specific signal ids:
 *  - active-regional-audience-no-web-presence
 *  - inactive-profile
 *  - regional-language-only-needs-vernacular-website */
export function sharechatSignals(f: SharechatFields, text = ""): string[] {
  const t = sanitizeUntrusted(String(text ?? ""));
  const out: string[] = [];
  const hasSite = Boolean(f.linkedWebsite) || Boolean(externalWebsite(t));
  const regional = REGIONAL_SCRIPT_RE.test(t);

  if (regional && hasAudienceActivity(f, t) && !hasSite) {
    out.push("active-regional-audience-no-web-presence");
  }
  if (/no posts yet|\b0 posts\b|\binactive\b|not posted|last (?:post|active)\b[^.\n]{0,40}\b(?:[2-9]|[1-9]\d)\s*(?:years?|yrs?)\s+ago\b|last (?:post|active)\b[^.\n]{0,40}\b(?:1[3-9]|[2-9]\d)\s*months?\s+ago\b/i.test(t)) {
    out.push("inactive-profile");
  }
  if (regional && !hasSite) {
    out.push("regional-language-only-needs-vernacular-website");
  }
  return [...new Set(out)];
}

// ---- status / env gate ------------------------------------------------------

export function sharechatStatus(): { enabled: boolean; why?: string } {
  const v = process.env[SHARECHAT_ENV];
  if (v === "1") return { enabled: true };
  return {
    enabled: false,
    why: `OFF by default: ${SHARECHAT_ENV} is "${String(v ?? "<unset>")}" (set ${SHARECHAT_ENV}=1 to enable); `
      + "ShareChat/Moj pages are read only through the injected search / page / browser transports",
  };
}

// ---- the adapter ------------------------------------------------------------

const leadPlatform = (url: string): { site: string } =>
  /mojapp\.in/i.test(url) ? { site: "mojapp.in" } : { site: "sharechat.com" };

export const sharechat: ChannelAdapter = {
  id: SHARECHAT_CHANNEL_ID,
  name: "ShareChat + Moj",
  tier: "C", // regional social/short-video; off by default, env-gated
  categories: ["any"],
  status: () => sharechatStatus(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? MAX_LIMIT, MAX_LIMIT));
    const loc = [q.area, q.city].filter(Boolean).join(" ");
    const out: RawLead[] = [];
    for (const site of SHARECHAT_SITES) {
      if (out.length >= limit) break;
      const query = `site:${site} "${q.category}"${loc ? ` "${loc}"` : ""}`.trim();
      const text = await searchPlatform(deps, site, query);
      if (!text) continue;
      for (const l of resultsToLeads(text, q.category, limit - out.length, site)) out.push(l);
    }
    return out.slice(0, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    const { site } = leadPlatform(lead.sourceUrl ?? "");
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${site} "${lead.name}"${lead.city ? ` "${lead.city}"` : ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: SHARECHAT_CHANNEL_ID,
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
    const parsed = parseSharechatPage(text);
    const fields: Record<string, string | number | undefined> = { ...parsed };
    const signals = sharechatSignals(parsed, text);
    return {
      channel: SHARECHAT_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => sharechatSignals(parseSharechatPage(text), text),
};

registerChannel(sharechat);
