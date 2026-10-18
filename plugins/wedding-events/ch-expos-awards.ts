// ChannelAdapter for bridal expos, wedding fairs and wedding award lists
// (Order WE6-ch-expos-awards). Tier B.
//
// Harvests prospect businesses from public exhibitor lists, sponsor pages and
// award winner / nominee pages of Indian wedding expos, fairs and award
// programmes. A business that pays to exhibit or enters awards is actively
// spending on marketing -> the strongest buying signal for video.
//
// OFF by default; the operator switches it on with CHANNEL_CH_EXPOS_AWARDS=1.
// The adapter never talks to the network directly: it uses the injected
// `deps.search` and `deps.readPage` (src/reach.ts) so checks run offline, and
// it pages through results politely through `deps.limiter`.
//
// Real structures confirmed 2026-10-12 with web search + fetch:
//  - Expo / trade-show pages (tradeindia.com/tradeshows, showbride.com
//    confirmed-exhibitors) list exhibitors and their product profile ("bridal
//    wear, jewellery, caterers, photographers ...").
//  - Award pages (worldspaawards.com/nominees/2025/asia/india confirmed) run a
//    category heading then one nominee per line, e.g.
//      "India's Best Hotel Spa  2025"
//      "Spa by L'OCCITANE at JW Marriott Goa"
//      "Bangalore Spa The Ritz Carlton, Bangalore"
//  - Listing pages mix freely, so the parser accepts the normalised label-block
//    form the sibling adapters use ("Name:", "City:", "Website:", ...) plus role
//    section headings ("Exhibitors", "Sponsors", "Nominees", "Winners") and a
//    bare-name-under-a-role line. Every value is a verbatim copy; anything the
//    page does not show stays missing and is never inferred.
//
// Rules: public pages only; every fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true; only BUSINESS
// contact data is stored (never the couple or any private individual).
import { sanitizeUntrusted } from "../../src/reach.js";
import type { ReachResult } from "../../src/reach.js";
import { reachBlocked, BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const EXPOS_AWARDS_CHANNEL_ID = "ch-expos-awards";
export const MAX_TEXT = 20000;

// Canonical category ids this source really lists (Order WE6).
export const EXPOS_AWARDS_CATEGORIES: string[] = [
  "wedding-planner", "event-company", "banquet-hall", "wedding-decorator",
  "caterer", "bridal-wear", "makeup-artist", "photographer", "dj-entertainer",
  "florist", "invitation-designer", "destination-wedding-agent", "jewellery-store",
];

// Default page pause between listing reads (2-6 s is the browser contract; the
// limiter sleep is injected and a no-op in checks).
const PAGE_PAUSE_MS = 2500;

export type ExposRole = "exhibitor" | "sponsor" | "nominee" | "winner";

// RawLead does not carry `reason`, so the event name + year ride on it as an
// extra optional field (documented in REPORT_WE6-ch-expos-awards.md). The value
// is still a RawLead, so registry typing is unchanged.
export type ExposLead = RawLead & {
  reason?: string;
  instagram?: string; facebook?: string; youtube?: string; whatsapp?: string;
};

export type ExposListingEntry = {
  name: string; category: string; area?: string; city?: string;
  phone?: string; website?: string;
  instagram?: string; facebook?: string; youtube?: string; whatsapp?: string;
  event?: string; year?: string; role?: ExposRole;
};

export type ExposProfileFields = {
  name?: string; event?: string; year?: string; role?: string; city?: string; category?: string;
  portfolioPhotoCount?: number; video?: string; videoUrl?: string;
  reviewCount?: number; rating?: number; priceBand?: string;
  services?: string; yearsInBusiness?: number;
  website?: string; instagram?: string; facebook?: string; youtube?: string; whatsapp?: string;
};

// ---- category guess: text -> canonical id (never invented) -----------------

const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/\bflorist\b|\bflower boutique\b|\bflower shop\b/i, "florist"],
  [/\bmakeup|make-up|hair stylist|beauty artist|bridal makeup/i, "makeup-artist"],
  [/\bphotograph|photography|portrait|videograph/i, "photographer"],
  [/\bcater|food service|cuisine|bhojan/i, "caterer"],
  [/\binvitation|wedding card|stationery|save the date/i, "invitation-designer"],
  [/\bdestination wedding|honeymoon|travel agent|tour operator/i, "destination-wedding-agent"],
  [/\bjewel|jewellery|jewelry|gold|diamond|polki|kundan/i, "jewellery-store"],
  [/\bdecor|floral design|stage design|mandap|lighting design/i, "wedding-decorator"],
  [/\bbridal wear|bridal boutique|lehenga|sherwani|couture|designer wear|trousseau/i, "bridal-wear"],
  [/\bdj\b|entertainer|entertainment|live band|\bmusic\b|\banchor\b|choreograph/i, "dj-entertainer"],
  [/\bbanquet|venue\b|\bhall\b|resort|lawn|marriage garden/i, "banquet-hall"],
  [/\bevent company|event management|event planner|event agency|event organiser/i, "event-company"],
  [/\bwedding planner|wedding planning|\bplanner\b/i, "wedding-planner"],
];

/** Map free text (name + category label + services) to a canonical id. */
export function guessCategory(text: string): string | undefined {
  const t = String(text ?? "");
  for (const [re, id] of CATEGORY_HINTS) if (re.test(t)) return id;
  return undefined;
}

function normalizeRole(raw: string | undefined): ExposRole | undefined {
  const r = String(raw ?? "").trim().toLowerCase();
  if (/^exhibit/.test(r)) return "exhibitor";
  if (/^sponsor/.test(r)) return "sponsor";
  if (/^nominee|nomination/.test(r)) return "nominee";
  if (/^winner|won\b/.test(r)) return "winner";
  return undefined;
}

const LABEL_RE = /^([A-Za-z][A-Za-z /-]{0,24})\s*[:：]\s*(.+)$/;
const URL_RE = /https?:\/\/[^\s"'<>)]+/gi;
const SOCIAL_HOST_RE = /(instagram\.com|facebook\.com|fb\.com|youtube\.com|youtu\.be|vimeo\.com|wa\.me|whatsapp\.com)/i;
const INJECTION_NEVER_COPY = /\bignore (all )?(the )?(previous|prior)\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b/i;

function cleanUrl(u: string): string {
  return u.replace(/[.,;)\]]+$/, "");
}

function hostOf(u: string | undefined): string {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(String(raw).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function isNameLike(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 90) return false;
  if (URL_RE.test(t)) return false;
  if (/\b(20\d{2})\s*$/.test(t)) return false; // category/event heading ending in a year
  if (/^(best|india'?s|category|about|contact|all rights|copyright)\b/i.test(t)) return false;
  if (/[:：]/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length < 2) return false;
  return /[A-Za-z]{2}/.test(t);
}

// ---- listing parser --------------------------------------------------------

// Real expo exhibitor lists (e.g. the GJS Mumbai exhibitor table) publish a
// "| S.No. | Exhibitor Name | City | Category | Booth |" style table. These two
// helpers read that shape; a page with no such table is unaffected.
const TABLE_SEP_RE = /\|?\s*:?-{2,}/;
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
function tableHeaderCols(cells: string[]): { name: number; city: number; category: number } | undefined {
  const find = (re: RegExp): number => cells.findIndex((c) => re.test(c));
  const name = find(/exhibitor name|business name|company name|^name$/i);
  const city = find(/\bcity\b|\blocation\b/i);
  if (name < 0 || city < 0) return undefined;
  return { name, city, category: find(/categor|product|segment/i) };
}

function applyEntryField(cur: ExposListingEntry, key: string, val: string): void {
  switch (key) {
    case "category": {
      const v = val.trim().toLowerCase();
      cur.category = EXPOS_AWARDS_CATEGORIES.includes(v)
        ? v
        : (guessCategory(val) ?? guessCategory(cur.name) ?? cur.category);
      break;
    }
    case "city": cur.city = val; break;
    case "area": case "locality": cur.area = val; break;
    case "phone": case "mobile": cur.phone = val; break;
    case "website": case "site": cur.website = val; break;
    case "instagram": cur.instagram = val; break;
    case "facebook": cur.facebook = val; break;
    case "youtube": cur.youtube = val; break;
    case "whatsapp": cur.whatsapp = val; break;
    default: break;
  }
}

/** Parse one listing page into business entries. Only labelled / role-scoped
 *  values are copied; unmatched lines are ignored (never inferred). */
export function parseListingPage(text: string, url: string, defaultCategory: string): ExposListingEntry[] {
  const clean = String(text ?? "").split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const out: ExposListingEntry[] = [];
  let event: string | undefined;
  let year: string | undefined;
  let role: ExposRole | undefined;
  let cur: ExposListingEntry | null = null;
  let tableCols: { name: number; city: number; category: number } | undefined;

  const flush = (): void => {
    if (cur && cur.name) {
      const finalCategory = cur.category || guessCategory(`${cur.name}`) || defaultCategory;
      out.push({ ...cur, category: finalCategory, ...(event ? { event } : {}), ...(year ? { year } : {}), ...(cur.role ?? role ? { role: cur.role ?? role } : {}) });
    }
    cur = null;
  };

  for (const rawLine of clean.split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t) continue;

    // event heading: a line naming a wedding expo/fair/awards with a year
    if (!/\bName\s*[:：]/i.test(t) && /expo|exhibition|wedding fair|bridal show|wedding show|awards?\b/i.test(t)) {
      const y = t.match(/\b(20\d{2})\b/);
      if (y && !LABEL_RE.test(t)) {
        year = y[1];
        event = t.replace(/\s*\b20\d{2}\b\s*$/, "").trim();
        continue;
      }
    }

    // role section heading: "Exhibitors", "Sponsors", "Nominees", "Winners"
    const rm = t.match(/^(winners?|nominees?|exhibitors?|sponsors?)\b[^:]*$/i);
    if (rm) {
      flush();
      role = normalizeRole(rm[1]);
      continue;
    }

    // pipe-delimited exhibitor table row (real expo list shape)
    if (t.includes("|")) {
      const cells = splitTableRow(t);
      const header = tableHeaderCols(cells);
      if (header) { flush(); tableCols = header; continue; }
      if (!tableCols || TABLE_SEP_RE.test(t)) continue;
      const name = cells[tableCols.name] ?? "";
      if (!isNameLike(name)) continue;
      const city = cells[tableCols.city];
      const categoryRaw = tableCols.category >= 0 ? (cells[tableCols.category] ?? "") : "";
      flush();
      cur = {
        name,
        category: guessCategory(categoryRaw) ?? guessCategory(name) ?? "",
        ...(city ? { city } : {}),
        ...(role ? { role } : {}),
      };
      flush();
      continue;
    }

    const kv = t.match(LABEL_RE);
    if (kv) {
      const key = kv[1].trim().toLowerCase();
      const val = kv[2].trim();
      if (key === "name") {
        flush();
        cur = { name: val, category: "" };
        if (event) cur.event = event;
        if (year) cur.year = year;
        if (role) cur.role = role;
        continue;
      }
      if (key === "event") { event = val; if (cur) cur.event = val; continue; }
      if (key === "year") { year = val; if (cur) cur.year = val; continue; }
      if (key === "role") { role = normalizeRole(val) ?? role; if (cur) cur.role = role; continue; }
      if (cur) applyEntryField(cur, key, val);
      continue;
    }

    // bare business name under an active role section (real award-page style)
    if (role && isNameLike(t)) {
      flush();
      cur = { name: t, category: "", role, ...(event ? { event } : {}), ...(year ? { year } : {}) };
      continue;
    }
  }
  flush();
  return out;
}

// ---- profile parser --------------------------------------------------------

function findUrl(text: string, test: RegExp): string | undefined {
  const urls = text.match(URL_RE) ?? [];
  for (const u of urls) {
    const c = cleanUrl(u);
    if (test.test(c)) return c;
  }
  return undefined;
}

/** Parse a vendor profile / site into evidence fields. Verbatim copies only. */
export function parseExposAwardsProfile(text: string): ExposProfileFields {
  const clean = String(text ?? "").split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: ExposProfileFields = {};

  const label = (name: RegExp): string | undefined => {
    const m = lines.map((l) => l.match(LABEL_RE)).find((x) => x !== null && name.test(x[1].trim()));
    return m ? m[2].trim() : undefined;
  };

  f.name = label(/^name$/i);
  if (!f.name) {
    const titleLine = lines.find((l) => /\b(?:Pvt|LLP|Ltd|LLC|Studio|Events|Photography|Designs|Creations|Invitations|Jewell?ers|Boutique|Caterers|Decorators|Planners|Weddings)\b/.test(l) && !LABEL_RE.test(l));
    if (titleLine && isNameLike(titleLine)) f.name = titleLine;
  }
  f.event = label(/^event$/i);
  f.year = label(/^year$/i);
  f.role = normalizeRole(label(/^role$/i)) ?? undefined;
  f.city = label(/^city$/i);
  const catLabel = label(/^category$/i);
  const catLower = String(catLabel ?? "").trim().toLowerCase();
  f.category = EXPOS_AWARDS_CATEGORIES.includes(catLower)
    ? catLower
    : (catLabel ? (guessCategory(catLabel) ?? catLabel) : guessCategory(`${f.name ?? ""} ${label(/^services$/i) ?? ""}`));

  // portfolio photos
  const photoLabel = label(/^(?:portfolio\s+photos?|photos?|gallery|portfolio)$/i);
  const photoBare = flat.match(/([\d,]{1,6})\s+photos?\b/i)?.[1];
  const photoCount = num(photoLabel ?? photoBare);
  if (photoCount !== undefined) f.portfolioPhotoCount = photoCount;

  // video presence (a video/film/reel or youtube/vimeo link)
  const videoUrl = findUrl(clean, /(youtube\.com|youtu\.be|vimeo\.com)/i);
  const hasVideoText = /\b(?:videos?|films?|reels?|showreel|watch (?:our|the) (?:film|video))\b/i.test(clean);
  if (videoUrl || hasVideoText) {
    f.video = "yes";
    if (videoUrl) f.videoUrl = videoUrl;
  }

  // reviews + rating
  const reviewLabel = label(/^(?:reviews?|ratings?|review count)$/i);
  const reviewBare = flat.match(/([\d,]{1,9})\s+(?:reviews?|ratings?)\b/i)?.[1];
  const reviewCount = num(reviewLabel ?? reviewBare);
  if (reviewCount !== undefined) f.reviewCount = reviewCount;
  const rating = num(flat.match(/\b([0-5](?:\.\d{1,2})?)\s*\/\s*5\b/)?.[1] ?? label(/^rating$/i));
  if (rating !== undefined && rating > 0 && rating <= 5) f.rating = rating;

  // price / starting price
  const price = label(/^(?:starting price|price|price band|starts? at|starting at)$/i)
    ?? flat.match(/(?:starting\s+(?:price|at|from)|price\s+band|starts?\s+at)\s*[:：]?\s*([^\n|]{1,40})/i)?.[1]?.trim();
  if (price) f.priceBand = price;

  // services, years
  f.services = label(/^services(?:\s+offered)?$/i);
  const years = num(label(/^years?\s+in\s+business$/i) ?? flat.match(/\b(\d{1,3})\+?\s+years?\s+in\s+business\b/i)?.[1]);
  if (years !== undefined) f.yearsInBusiness = years;

  // links: website + socials
  f.website = label(/^(?:website|site|web)$/i) ?? findUrl(clean, /^(?!.*(instagram|facebook|fb\.com|youtube|youtu\.be|vimeo|wa\.me|whatsapp))/i);
  f.instagram = label(/^instagram$/i) ?? findUrl(clean, /instagram\.com/i);
  f.facebook = label(/^facebook$/i) ?? findUrl(clean, /facebook\.com|fb\.com/i);
  f.youtube = label(/^youtube$/i) ?? findUrl(clean, /youtube\.com|youtu\.be/i);
  f.whatsapp = label(/^whatsapp$/i) ?? findUrl(clean, /wa\.me|whatsapp\.com/i);

  return f;
}

// ---- signals ---------------------------------------------------------------

/** "posted N days ago" style recency, in days. */
function socialAgeDays(text: string): number | undefined {
  const t = String(text ?? "");
  if (/\b(?:posted|updated)\s+(?:today|just now)\b|\bposted\s+yesterday\b/i.test(t)) return 0;
  const d = t.match(/(?:posted|published|reel|video|film|post|updated|latest)[^.\n]{0,30}?(\d{1,3})\s*days?\s*ago/i);
  if (d) return Number(d[1]);
  const w = t.match(/(?:posted|published|reel|video|film|post|updated|latest)[^.\n]{0,30}?(\d{1,2})\s*weeks?\s*ago/i);
  if (w) return Number(w[1]) * 7;
  const mo = t.match(/(?:posted|published|reel|video|film|post|updated|latest)[^.\n]{0,30}?(\d{1,2})\s*months?\s*ago/i);
  if (mo) return Number(mo[1]) * 30;
  return undefined;
}

function maxReviewCount(text: string): number | undefined {
  const t = String(text ?? "");
  const nums: number[] = [];
  const re = /([\d,]{1,9})\s+(?:reviews?|ratings?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const n = num(m[1]);
    if (n !== undefined) nums.push(n);
  }
  if (!nums.length) return undefined;
  return Math.max(...nums);
}

/** Shared wedding/event signal ids (Order WE6, weighted by WE1). Fires only on
 *  matching text; positive and negative fixtures both covered in the check. */
export function exposAwardsSignals(text: string): string[] {
  const t = String(text ?? "");
  const out: string[] = [];

  const hasVideo = /\b(?:videos?|films?|reels?|showreel|youtube|vimeo)\b/i.test(t)
    || /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com)\/\S+/i.test(t);
  const hasPhotos = /\b(?:photos?|photographs?|gallery|galleries|portfolio|images?|albums?)\b/i.test(t);
  if (hasPhotos && !hasVideo) out.push("portfolio-no-video");
  if (hasVideo) out.push("has-video-portfolio");

  const age = socialAgeDays(t);
  if (age !== undefined && age <= 30) out.push("social-video-active");
  if (age !== undefined && age > 90) out.push("social-inactive");
  if (/\bno (?:posts?|activity|updates?)[^.\n]{0,30}(?:last|past)\s*(?:9\d|[1-9]\d{2})\s*days/i.test(t)) out.push("social-inactive");

  const rc = maxReviewCount(t);
  if (rc !== undefined && rc >= 50) out.push("high-review-count");

  if (/\b(?:featured|verified[-\s]?plus|premium|paid tier|sponsored|elite|gold partner|platinum)\b/i.test(t)) {
    out.push("premium-listing");
  }

  if (/\bmulti[-\s]?city\b|\bmultiple cities\b|\bcities across\b|\bserves [^.\n]{0,60},|\bavailable in [^.\n]{0,60},/i.test(t)) {
    out.push("multi-city");
  }

  if (/(?:starting\s+(?:price|at|from)|price\s+band|starts?\s+at|₹\s?\d|rs\.?\s?\d|inr\s?\d|\bper plate\b|\bper day\b)/i.test(t)) {
    out.push("price-band-known");
  }
  return [...new Set(out)];
}

// ---- search + discovery ----------------------------------------------------

function categoryLabel(category: string): string {
  return String(category ?? "").replace(/-/g, " ").trim();
}

/** Niche search phrases for this source (expos + awards). */
export function buildQueries(category: string, city: string, area: string): string[] {
  const loc = [area, city].filter(Boolean).join(" ").trim();
  const cat = categoryLabel(category);
  return [
    `"wedding expo exhibitors" ${loc} ${cat}`.replace(/\s+/g, " ").trim(),
    `"wedding awards winners" ${loc} ${cat}`.replace(/\s+/g, " ").trim(),
  ];
}

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const c = cleanUrl(u);
    if (!/^https?:\/\//i.test(c)) continue;
    const key = hostOf(c) + new URL(c).pathname.replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function urlsFromResult(text: string, results: unknown): string[] {
  const found: string[] = [];
  const re = new RegExp(URL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text ?? ""))) !== null) found.push(m[0]);
  if (Array.isArray(results)) {
    for (const r of results) {
      const u = (r as { url?: unknown })?.url;
      if (typeof u === "string") found.push(u);
    }
  }
  return uniqueUrls(found);
}

/** One listing entry -> a RawLead (business contact data only). */
export function entryToLead(e: ExposListingEntry, sourceUrl: string, fallbackCategory: string): ExposLead {
  const reason = [e.event, e.year].filter(Boolean).join(" ").trim()
    || (e.role ? e.role : "");
  return {
    name: e.name,
    category: e.category || fallbackCategory,
    ...(e.area ? { address: e.area } : {}),
    ...(e.city ? { city: e.city } : {}),
    ...(e.phone ? { phone: e.phone } : {}),
    ...(e.website ? { website: e.website } : {}),
    source: EXPOS_AWARDS_CHANNEL_ID,
    sourceUrl,
    ...(reason ? { reason } : {}),
    ...(e.instagram ? { instagram: e.instagram } : {}),
    ...(e.facebook ? { facebook: e.facebook } : {}),
    ...(e.youtube ? { youtube: e.youtube } : {}),
    ...(e.whatsapp ? { whatsapp: e.whatsapp } : {}),
  };
}

// ---- status and env gate ---------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (process.env.CHANNEL_CH_EXPOS_AWARDS === "1") return { enabled: true };
  return {
    enabled: false,
    why: "channel ch-expos-awards is off by default; set CHANNEL_CH_EXPOS_AWARDS=\"1\" to enable it",
  };
}

// ---- the adapter -----------------------------------------------------------

export const exposAwards: ChannelAdapter = {
  id: EXPOS_AWARDS_CHANNEL_ID,
  name: "Wedding Expos & Awards",
  tier: "B",
  categories: EXPOS_AWARDS_CATEGORIES,
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 100));
    const leads: ExposLead[] = [];

    // 1. search for listing pages with the niche phrases
    const urls: string[] = [];
    for (const query of buildQueries(q.category, q.city ?? "", q.area ?? "")) {
      let res;
      try {
        res = await deps.search(query);
      } catch {
        continue;
      }
      if (reachBlocked(res)) continue;
      urls.push(...urlsFromResult(res.text, res.results));
      if (urls.length) break;
    }

    // 2. page through the listing pages politely, stop at limit
    let page = 0;
    for (const url of uniqueUrls(urls)) {
      if (leads.length >= limit) break;
      if (page > 0) await deps.limiter.sleep?.(PAGE_PAUSE_MS); // polite pause between pages
      page += 1;
      let read;
      try {
        read = await deps.readPage(url);
      } catch {
        continue; // changed / unreachable page: skip, never throw
      }
      if (reachBlocked(read)) continue; // blocked or empty page: skip
      const text = sanitizeUntrusted(read.text);
      const entries = parseListingPage(text, url, q.category);
      for (const e of entries) {
        if (leads.length >= limit) break;
        leads.push(entryToLead(e, url, q.category));
      }
    }
    return leads;
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      read = await readWithFallback(deps, {
        searchQuery: `"${lead.name}" wedding expo OR awards ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        return {
          channel: EXPOS_AWARDS_CHANNEL_ID,
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
    const parsed = parseExposAwardsProfile(text);
    const fields: Record<string, string | number | undefined> = { ...parsed };
    const signals = exposAwardsSignals(text);
    // sponsors and exhibitors pay for their place -> premium-listing
    if (parsed.role === "exhibitor" || parsed.role === "sponsor") {
      if (!signals.includes("premium-listing")) signals.push("premium-listing");
    }
    return {
      channel: EXPOS_AWARDS_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => exposAwardsSignals(text),
};

registerChannel(exposAwards);
