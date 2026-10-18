// ChannelAdapter for Instagram business profiles (Order L50-ch-instagram).
//
// Instagram business/creator profiles: handle, follower/following/post counts,
// bio, link in bio, contact buttons (call, email, directions), category label,
// last post date, posting cadence, highlights, and reel/story activity when the
// page text shows it. Read order per the contract (registry.readWithFallback):
// search first (site:instagram.com ...), then the plain page read, then the
// operator's own logged-in browser reader ONLY when both returned a blocked
// result (403 / 429 / captcha / empty body). No adapter-level retry or loop.
//
// Source & terms verified this run (2026-10-09):
//  - https://www.instagram.com/robots.txt (fetched through web search/fetch):
//    opens with a notice that automated collection of data is prohibited
//    without express written permission and ends with "User-agent: * Disallow: /".
//  - Meta Terms of Service (eff. 2025-01-01): "you may not access or collect
//    data from our Products using automated means (without our prior
//    permission)". Instagram Terms of Use carry the same prohibition. So this
//    adapter is Tier C in india-sources.json (L41) and OFF by default.
//  - Public profile page structure (verified from search-engine page text for
//    several real profiles): "<handle>'s profile picture", a "* <N> followers"
//    and "* <N> following" pair, the display name, the handle repeated, then
//    the bio, the bio link (a bare domain/path line), highlight rows rendered
//    as "* <handle>'s highlight story picture <title>", and post rows rendered
//    as "Photo by ... on <Month DD, YYYY>." / "Video by ... on <date>". Post
//    count, contact buttons and the category label are professional-account
//    fields and are NOT present in logged-out page text (unverified for the
//    logged-in browser path; when the text does not show them they stay
//    missing, never inferred).
//
// Every value is a verbatim copy from page text, the profile URL slug, or a
// search snippet, with its source URL on the evidence. All fetched text is
// sanitised (reach.sanitizeUntrusted) and evidence is untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const INSTAGRAM_CHANNEL_ID = "instagram-business"; // matches india-sources.json (L41)
export const INSTAGRAM_SITE = "instagram.com";
const MAX_TEXT = 20000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const INACTIVE_DAYS = 30;
export const MANY_FOLLOWERS_THRESHOLD = 1000;
export const LOW_ENGAGEMENT_RATIO = 0.01; // < 1% of followers engaging per post

export type InstagramFields = {
  handle?: string;
  followers?: number | string;
  following?: number | string;
  posts?: number | string;
  bio?: string;
  linkInBio?: string;
  contactCall?: string;
  contactEmail?: string;
  contactDirections?: string;
  categoryLabel?: string;
  lastPostDate?: string;
  postingFrequency30d?: number;
  highlights?: string;
  reels?: string;
  stories?: string;
};

// ---- small parsers -----------------------------------------------------------

const INJECTION_NEVER_COPY =
  /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)/i;

const RESERVED_SLUGS =
  /^(p|reel|reels|tv|explore|stories|accounts|directory|about|legal|nametag|locations|web|developer|privacy|terms)$/i;

const IG_PROFILE_URL_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})(?:[/?#]|\s|$|["'<>])/i;
const PROFILE_PIC_RE = /^([A-Za-z0-9._]{1,30})'s profile picture$/i;
const FOLLOWER_RE = /([\d][\d,.]*\s?[KMB]?)\s+followers?\b/i;
const FOLLOWING_RE = /([\d][\d,.]*\s?[KMB]?)\s+following\b/i;
const POSTS_RE = /([\d][\d,.]*\s?[KMB]?)\s+posts?\b/i;
const HIGHLIGHT_RE = /'?s highlight story picture\s+(.+?)\s*$/i;
const HIGHLIGHT_LABEL_RE = /^(?:highlight|highlights)\s*[:：]\s*(.+)$/i;
const POST_DATE_RE = /(?:Photo|Video)\s+by\s+[^\n]*?\s+on\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/g;
const LIKES_RE = /([\d][\d,.]*\s?[KMB]?)\s+likes\b/gi;
const REELS_COUNT_RE = /([\d,]+)\s+reels?\b/i;
const LINK_LABEL_RE = /^(?:link in bio|bio link|website|link)\s*[:：]\s*(\S+)$/i;
const BIO_LABEL_RE = /^(?:bio|biography)\s*[:：]\s*(.+)$/i;
const CALL_LABEL_RE = /^(?:call|phone|call button|contact call)\s*[:：]\s*(.+)$/i;
const EMAIL_LABEL_RE = /^(?:email|e-mail|contact email|email button)\s*[:：]\s*(.+)$/i;
const DIRECTIONS_LABEL_RE = /^(?:directions|get directions|contact directions|address)\s*[:：]\s*(.+)$/i;
const CATEGORY_LABEL_RE = /^(?:category|category label|business category)\s*[:：]\s*(.+)$/i;
const NAV_LINE_RE = /^(?:log in|sign up|instagram|meta|follow|message|see photos, videos and more)/i;

function countToken(raw: string | undefined): number | string | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/\s+/g, "").replace(/[,.]$/, "");
  if (/^\d[\d,]*(?:\.\d+)?$/.test(s)) {
    const n = Number(s.replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  if (/^\d[\d,]*(?:\.\d+)?[KMB]$/i.test(s)) return s; // verbatim, e.g. "95.2K"
  return undefined;
}

/** Expand a count token ("95.2K" -> 95200) ONLY for signal thresholds. Never
 *  written back as a field value. */
function expandCount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^([\d,]+(?:\.\d+)?)\s?([KMB]?)$/i.exec(raw.replace(/\s+/g, ""));
  if (!m) return undefined;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return undefined;
  const mult = m[2].toUpperCase() === "K" ? 1e3 : m[2].toUpperCase() === "M" ? 1e6 : m[2].toUpperCase() === "B" ? 1e9 : 1;
  return base * mult;
}

function profileHandleFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (!seg || RESERVED_SLUGS.test(seg)) return undefined;
    return seg;
  } catch {
    return undefined;
  }
}

function looksLikeExternalLink(line: string): string | undefined {
  const t = line.trim();
  if (!t || /\s/.test(t)) return undefined;
  const withScheme = /^(https?:\/\/)([^\s"'<>]+)$/i.exec(t);
  const host = withScheme ? withScheme[2] : t;
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(\/\S*)?$/i.test(host)) return undefined;
  const bare = host.toLowerCase();
  if (/(^|\.)(instagram\.com|facebook\.com|fb\.com|wa\.me|api\.whatsapp\.com|x\.com|twitter\.com)(\/|$)/.test(bare)) {
    return undefined;
  }
  return t;
}

function hasExternalSite(text: string): boolean {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (looksLikeExternalLink(line)) return true;
  }
  return false;
}

function hasBookingMarker(text: string): boolean {
  return /\b(book|booking|bookings|reserve|reservation|appointment\s*now|schedule|book\s*a?\s*table)\b/i.test(text);
}

function hasWhatsapp(text: string): boolean {
  return /whatsapp|wa\.me|api\.whatsapp/i.test(text);
}

// ---- page / snippet parser ---------------------------------------------------

/** Parse Instagram page text (or a search snippet block) into fields. Every
 *  value is a verbatim copy from the text/URL; anything unmatched stays
 *  undefined. `nowMs` is used only for the derived posting-cadence field. */
export function parseInstagramPage(text: string, nowMs: number = Date.now()): InstagramFields {
  const raw = String(text ?? "");
  const clean = raw
    .split(/\r?\n/)
    .filter((l) => !INJECTION_NEVER_COPY.test(l))
    .join("\n");
  const lines = clean.split(/\r?\n/).map((l) => l.trim());
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const f: InstagramFields = {};

  // handle: explicit label, then the verified "<handle>'s profile picture" row
  // (verbatim), then the profile URL slug (verbatim), then a bare @handle line.
  const handleLabel = lines.find((l) => /^(?:handle|username)\s*[:：]\s*\S/i.test(l));
  if (handleLabel) f.handle = handleLabel.replace(/^(?:handle|username)\s*[:：]\s*/i, "").replace(/^@/, "").trim();
  if (!f.handle) {
    const pic = lines.map((l) => PROFILE_PIC_RE.exec(l)?.[1]).find((x): x is string => Boolean(x));
    if (pic) f.handle = pic;
  }
  if (!f.handle) {
    const firstUrl = String(text ?? "").match(IG_PROFILE_URL_RE);
    if (firstUrl) f.handle = profileHandleFromUrl(firstUrl[0]);
  }
  if (!f.handle) {
    const at = lines.map((l) => /^@([A-Za-z0-9._]{1,30})$/.exec(l)?.[1]).find((x): x is string => Boolean(x));
    if (at) f.handle = at;
  }

  // counts — plain digits become numbers, abbreviated tokens stay verbatim.
  const followers = countToken(FOLLOWER_RE.exec(flat)?.[1]);
  if (followers !== undefined) f.followers = followers;
  const following = countToken(FOLLOWING_RE.exec(flat)?.[1]);
  if (following !== undefined) f.following = following;
  const posts = countToken(POSTS_RE.exec(flat)?.[1]);
  if (posts !== undefined) f.posts = posts;

  // link in bio: explicit label, else a bare external domain/path line.
  const linkLabel = lines.find((l) => LINK_LABEL_RE.test(l));
  if (linkLabel) f.linkInBio = (LINK_LABEL_RE.exec(linkLabel)?.[1] ?? "").trim();
  if (!f.linkInBio) {
    const ext = lines.map((l) => looksLikeExternalLink(l)).find((x): x is string => Boolean(x));
    if (ext) f.linkInBio = ext;
  }

  // bio: explicit label, else the line after the handle's second occurrence
  // (the handle is repeated just before the bio on the real page).
  const bioLabel = lines.find((l) => BIO_LABEL_RE.test(l));
  if (bioLabel) f.bio = (BIO_LABEL_RE.exec(bioLabel)?.[1] ?? "").trim() || undefined;
  if (!f.bio && f.handle) {
    const handleIdx: number[] = [];
    lines.forEach((l, i) => {
      if (l === f.handle) handleIdx.push(i);
    });
    const countsLine = Math.max(
      lines.findIndex((l) => FOLLOWER_RE.test(l)),
      lines.findIndex((l) => FOLLOWING_RE.test(l)),
      lines.findIndex((l) => POSTS_RE.test(l)),
    );
    const after = handleIdx.filter((i) => i > countsLine);
    const from = after.length ? after[after.length - 1] : -1;
    if (from >= 0) {
      const candidate = lines[from + 1] ?? "";
      if (candidate && !NAV_LINE_RE.test(candidate) && !looksLikeExternalLink(candidate) && !HIGHLIGHT_RE.test(candidate)) {
        f.bio = candidate;
      }
    }
  }

  // contact buttons (professional-account fields): explicit labels only.
  const callLine = lines.find((l) => CALL_LABEL_RE.test(l));
  if (callLine) f.contactCall = (CALL_LABEL_RE.exec(callLine)?.[1] ?? "").trim() || undefined;
  const emailLine = lines.find((l) => EMAIL_LABEL_RE.test(l));
  if (emailLine) f.contactEmail = (EMAIL_LABEL_RE.exec(emailLine)?.[1] ?? "").trim() || undefined;
  const dirLine = lines.find((l) => DIRECTIONS_LABEL_RE.test(l));
  if (dirLine) f.contactDirections = (DIRECTIONS_LABEL_RE.exec(dirLine)?.[1] ?? "").trim() || undefined;

  // category label (professional-account field): explicit label only.
  const catLine = lines.find((l) => CATEGORY_LABEL_RE.test(l));
  if (catLine) f.categoryLabel = (CATEGORY_LABEL_RE.exec(catLine)?.[1] ?? "").trim() || undefined;

  // post dates: "Photo by ... on <Month DD, YYYY>" rows. Newest first on the
  // page; take the most recent by parsed timestamp, store the verbatim date.
  const dates: { raw: string; ts: number }[] = [];
  for (const m of clean.matchAll(POST_DATE_RE)) {
    const rawDate = m[1];
    const ts = Date.parse(rawDate);
    if (Number.isFinite(ts)) dates.push({ raw: rawDate, ts });
  }
  if (dates.length) {
    dates.sort((a, b) => b.ts - a.ts);
    f.lastPostDate = dates[0].raw;
    f.postingFrequency30d = dates.filter((d) => d.ts <= nowMs && nowMs - d.ts <= INACTIVE_DAYS * DAY_MS).length;
  }

  // highlights: verified "<handle>'s highlight story picture <title>" rows.
  const highlightTitles: string[] = [];
  for (const l of lines) {
    const m = HIGHLIGHT_RE.exec(l) ?? HIGHLIGHT_LABEL_RE.exec(l);
    const title = (m?.[1] ?? "").trim();
    if (title) highlightTitles.push(title);
  }
  if (highlightTitles.length) f.highlights = [...new Set(highlightTitles)].join(" | ");

  // reels: a "Reels" tab label, or a "N reels" count.
  const reelsCount = REELS_COUNT_RE.exec(flat)?.[1];
  if (reelsCount) f.reels = reelsCount;
  else if (lines.some((l) => /^reels$/i.test(l))) f.reels = "yes";

  // stories: only an explicit activity marker (never inferred from a ring).
  if (/\b(?:has story|story available|active story|stories\s*[:：])\b/i.test(flat)) f.stories = "yes";

  return f;
}

// ---- signals -----------------------------------------------------------------

function bioHasPhone(bio: string | undefined): boolean {
  if (!bio) return false;
  return /(?:\+?\d[\d\s()-]{7,15}\d)/.test(bio);
}

function bioHasEmail(bio: string | undefined): boolean {
  return Boolean(bio && /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(bio));
}

function bioHasLink(bio: string | undefined): boolean {
  if (!bio) return false;
  if (/https?:\/\//i.test(bio)) return true;
  return /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i.test(bio);
}

/** Stable signal ids over parsed fields + raw page text. Never fires a signal
 *  the page does not support: an unknown last-post date is not "inactive", an
 *  unknown engagement is not "low engagement". */
export function instagramSignals(
  f: InstagramFields,
  text: string = "",
  opts: { nowMs?: number } = {},
): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  const nowMs = opts.nowMs ?? Date.now();

  // inactive-30d: only when a post date is actually visible and older than 30 d.
  if (f.lastPostDate) {
    const ts = Date.parse(f.lastPostDate);
    if (Number.isFinite(ts) && nowMs - ts >= INACTIVE_DAYS * DAY_MS) out.push("inactive-30d");
  }

  // no-link-in-bio: the page shows the profile but no bio link.
  if (!f.linkInBio) out.push("no-link-in-bio");

  // no-booking-or-whatsapp: neither a booking marker nor a WhatsApp link.
  if (!hasBookingMarker(t) && !hasWhatsapp(t)) out.push("no-booking-or-whatsapp");

  // many-followers-low-engagement: both numbers must be visible.
  const followersNum = typeof f.followers === "number" ? f.followers : expandCount(String(f.followers ?? ""));
  const likes: number[] = [];
  for (const m of t.matchAll(LIKES_RE)) {
    const n = expandCount(m[1]);
    if (n !== undefined) likes.push(n);
  }
  if (followersNum !== undefined && followersNum >= MANY_FOLLOWERS_THRESHOLD && likes.length) {
    const best = Math.max(...likes);
    if (best / followersNum < LOW_ENGAGEMENT_RATIO) out.push("many-followers-low-engagement");
  }

  // active-no-website: posted within 30 d but no bio link and no external site.
  const active = (f.postingFrequency30d ?? 0) > 0
    || (f.lastPostDate ? (nowMs - Date.parse(f.lastPostDate) < INACTIVE_DAYS * DAY_MS) : false);
  if (active && !f.linkInBio && !hasExternalSite(t)) out.push("active-no-website");

  // bio-phone-only: the bio carries a phone and nothing else to reach them.
  if (bioHasPhone(f.bio) && !bioHasEmail(f.bio) && !bioHasLink(f.bio)) out.push("bio-phone-only");

  return [...new Set(out)];
}

// ---- discovery ---------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. Only profile URLs become leads; the name
 *  is the handle copied from the URL slug. Post/reel/explore URLs are skipped. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const m = IG_PROFILE_URL_RE.exec(line);
    if (!m) continue;
    const url = m[0].replace(/[\s"'>]+$/, "");
    const handle = profileHandleFromUrl(url) ?? m[1];
    if (!handle || RESERVED_SLUGS.test(handle)) continue;
    leads.push({ name: handle, category, source: INSTAGRAM_CHANNEL_ID, sourceUrl: url });
  }
  return leads;
}

// ---- status and env gate -----------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (tierCEnabled()) return { enabled: true };
  if (process.env.LEADSCOUT_BROWSER === "1") return { enabled: true }; // operator's own logged-in browser
  return {
    enabled: false,
    why: "tier C: instagram.com/robots.txt prohibits automated collection without express written "
      + "permission and Meta's Terms (eff. 2025-01-01) ban collecting data \"using automated means\"; "
      + `LEADSCOUT_INDIA_TIER_C is "${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off `
      + "(absent and =0 both mean off); the operator-approved browser-read mode is also off "
      + "(LEADSCOUT_BROWSER is not 1). Browser reads respect Instagram's 30/hour cap.",
  };
}

// ---- the adapter -------------------------------------------------------------

export const instagram: ChannelAdapter = {
  id: INSTAGRAM_CHANNEL_ID,
  name: "Instagram business profiles",
  tier: "C", // india-sources.json (L41): tier C, Meta automated-collection regime
  categories: ["salon", "restaurant", "gym", "retail", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    // read order: search first (cheapest); matches the L41 query template.
    const read = await readWithFallback(deps, {
      searchQuery: `site:${INSTAGRAM_SITE} "${q.category}" "${loc}"`.trim(),
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked;
      // browser caps / pauses / one-page-at-a-time are enforced by browser.ts.
      read = await readWithFallback(deps, {
        searchQuery: `site:${INSTAGRAM_SITE} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha / checkpoint after browser escalation: never
        // solved or bypassed -> needs-human evidence, no fields.
        return {
          channel: INSTAGRAM_CHANNEL_ID,
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
    const nowMs = (deps.now ?? Date.now)();
    const fields: Record<string, string | number | undefined> = { ...parseInstagramPage(text, nowMs) };
    const signals = instagramSignals(fields as InstagramFields, text, { nowMs });
    return {
      channel: INSTAGRAM_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date(nowMs).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => {
    const clean = sanitizeUntrusted(text);
    return instagramSignals(parseInstagramPage(clean), clean);
  },
};

registerChannel(instagram);
