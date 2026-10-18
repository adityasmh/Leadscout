// ChannelAdapter for Zomato (restaurants and cafes), Order L47-ch-zomato.
//
// Tier C channel: OFF by default. Enabled only by env LEADSCOUT_INDIA_TIER_C=1
// (matches india-sources.json, order L41: Zomato tier C) OR the
// operator-approved browser-read mode on the operator's own logged-in browser
// (data/browser-allowlist.json lists zomato.com), gated by LEADSCOUT_BROWSER=1.
// No new env name is introduced; LEADSCOUT_BROWSER=0 is a hard kill switch.
//
// Read order per page comes from registry.readWithFallback: search first, then a
// plain page read, then the browser reader ONLY when both are blocked
// (403, 429, captcha, empty body). The browser reader enforces its own
// per-platform hourly caps and its 2-6 s pause; this adapter never re-reads a
// blocked page and never bypasses needs-human.
//
// Verified 2026-10-09 by web search + a plain page fetch:
//  - robots.txt (https://www.zomato.com/robots.txt) has a catch-all
//    "User-agent: * / Disallow: /" plus an AI-crawler group that only allows
//    /llms.txt and /mcp-tools.md; sitemaps are published. It does not fetch a
//    terms-of-use clause about automated access, so the conservative tier C
//    default from india-sources.json (L41) stands.
//  - A restaurant page (https://www.zomato.com/ncr/golden-fiesta-lajpat-nagar-2-new-delhi)
//    fetched successfully and confirms the page structure: the business name,
//    "<rating>star-fill<votes>Dining Ratings" and "<rating>...<votes>Delivery
//    Ratings", a comma-separated cuisine line, the address line, "Open now
//    <hours> (Today)" / "Closed Opens at <time>", "&#8377;<N> for two", the phone
//    "+91...", "Book a table"/"Book a Table" (reservation), "Home delivery" /
//    "Takeaway available", and offers incl. "Zomato Gold".
//  - The exact page markup for a "Zomato Gold" badge on a restaurant page, and
//    the cross-platform hours comparison (it needs a second source such as
//    Swiggy/Dineout), stay UNVERIFIED; both signals are heuristics over the
//    text with a clear threshold and are reported as unverified in the report.
//
// Rules: every field value is copied verbatim from page text or the URL / search
// snippet with its source URL; a value the page does not show stays missing
// (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const ZOMATO_CHANNEL_ID = "zomato"; // matches india-sources.json registry data (L41)
export const ZOMATO_SITE = "zomato.com";
const MAX_TEXT = 20000;
/** "high votes" >= this many (Zomato shows the exact count next to a rating). */
export const HIGH_VOTES_THRESHOLD = 100;
/** "low rating" <= this (only paired with a complaint it becomes a signal). */
export const LOW_RATING_THRESHOLD = 2.5;

export type ZomatoFields = {
  name?: string; cuisines?: string; costForTwo?: string; rating?: number;
  votes?: number; address?: string; hours?: string; dineIn?: string;
  delivery?: string; zomatoGold?: string; phone?: string;
};

// ---- page/snippet parser: only exact matches become fields ------------------

const ZOMATO_URL_RE = /https?:\/\/(?:www\.)?zomato\.com\/[^\s"'<>*]+/i;
const URL_IN_SNIPPET_RE = /https?:\/\/(?:www\.)?zomato\.com\/[^\s"'<>]+/i;
// robots.txt disallows /admin/, /users/, /downloads/, /nonsvn/, /webview/,
// /support/agent/, /*/tag-*, /*?*q= ; plus obvious non-business paths.
const NON_BUSINESS_PATH_RE =
  /\/(users|admin|login|signup|gold|sitemap|sale|downloads?|nonsvn|webview|support|clients|voicephp)\b|restaurant[s]?\/?$|delivery\b|collections\b|order-food-online\b|tag-/i;
const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?previous\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b/i;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
const MOBILE_RE = /\b(?:\+?91[-\s]?)?[6-9]\d{9}\b/;
// a cuisine line: two or more comma-separated word groups, no digits/currency.
const CUISINE_LINE_RE = /^[A-Za-z][A-Za-z&'\-\. ]+(?:,\s*[A-Za-z][A-Za-z&'\-\. ]+)+$/;
// aggregator / platform hosts that never count as the business's own website.
const AGGREGATOR_HOST_RE =
  /(?:^|\.)(?:zomato|swiggy|dineout|eazydiner|zmtcdn|google|googleapis|facebook|fbcdn|instagram|twitter|justdial|sulekha|practo|youtube|whatsapp)\./i;

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function nameFromZomatoUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!/(^|\.)zomato\.com$/i.test(u.hostname)) return undefined;
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    const slug = (segs[segs.length - 1] ?? "").replace(/-order$/i, "");
    if (!slug || /^\d+$/.test(slug)) return undefined;
    return slug.replace(/-/g, " ").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Parse a Zomato restaurant page (or a search-snippet block) into fields.
 *  Every value is a verbatim copy from the text or the URL; anything unmatched
 *  stays undefined (never inferred). */
export function parseZomatoPage(text: string): ZomatoFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ").trim();
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: ZomatoFields = {};

  // name: explicit "Name:" label, else the page title before the first comma.
  const nameLine = lines.find((l) => /^Name\s*[:：]\s*\S/.test(l));
  let name = nameLine?.replace(/^Name\s*[:：]\s*/, "").trim();
  if (!name) {
    const title = clean.split(/[|\n]/)[0]?.trim() ?? "";
    if (title && !/https?:/i.test(title) && title.includes(",")) name = title.split(",")[0].trim();
  }
  if (!name) name = nameFromZomatoUrl(flat.match(ZOMATO_URL_RE)?.[0]);
  if (name) f.name = name;

  // cuisines: "Cuisines:" label, else a comma-separated word line (no digits).
  const cuisineLine = lines.find((l) => /^Cuisines\s*[:：]\s*\S/i.test(l));
  if (cuisineLine) {
    f.cuisines = cuisineLine.replace(/^Cuisines\s*[:：]\s*/i, "").trim() || undefined;
  } else {
    const guess = lines.find((l) => CUISINE_LINE_RE.test(l) && !/^Name\b/i.test(l));
    if (guess) f.cuisines = guess;
  }

  // cost for two: the verbatim "&#8377;<N> for two" phrase, else a "Cost for two:" label.
  const cost = flat.match(/[₹]\s*[\d,]+\s*for two\b/i)?.[0];
  if (cost) f.costForTwo = cost;
  else {
    const costLine = lines.find((l) => /^(?:Cost for two|Average cost)\s*[:：]\s*\S/i.test(l));
    if (costLine) f.costForTwo = costLine.replace(/^(?:Cost for two|Average cost)\s*[:：]\s*/i, "").trim() || undefined;
  }

  // rating + votes: an explicit label, else the real "<rating>star-fill<votes> RATINGS" run.
  const ratingLine = lines.find((l) => /^Rating\s*[:：]\s*[0-5]/.test(l));
  const votesLine = lines.find((l) => /^(?:Votes|Ratings)\s*[:：]\s*[\d,]/.test(l));
  if (ratingLine) {
    const r = num(ratingLine.replace(/^Rating\s*[:：]\s*/, "").trim());
    if (r !== undefined && r > 0 && r <= 5) f.rating = r;
  }
  if (votesLine) {
    const v = num(votesLine.replace(/^(?:Votes|Ratings)\s*[:：]\s*/, "").trim());
    if (v !== undefined) f.votes = v;
  }
  if (f.rating === undefined || f.votes === undefined) {
    const m = flat.match(/([0-5](?:\.\d{1,2})?)\s*(?:star-fill)?\s*([\d,]{1,12})\s*(?:Dining|Delivery)\s+Ratings/i);
    if (m) {
      if (f.rating === undefined) {
        const r = num(m[1]);
        if (r !== undefined && r > 0 && r <= 5) f.rating = r;
      }
      if (f.votes === undefined) f.votes = num(m[2]);
    }
  }

  // address: "Address:" label, else an address-looking line (commas + a digit).
  const addrLine = lines.find((l) => /^Address\s*[:：]\s*\S/i.test(l));
  if (addrLine) f.address = addrLine.replace(/^Address\s*[:：]\s*/i, "").trim() || undefined;
  else {
    const guess = lines.find((l) => !/^Name\b|^Cuisines\b|https?:/i.test(l)
      && /\d/.test(l) && (l.match(/,/g) ?? []).length >= 2);
    if (guess) f.address = guess;
  }

  // hours: "Hours:"/"Timings:" label, else the real "Open now/Closed Opens at ..." copy.
  const hoursLine = lines.find((l) => /^(?:Hours|Timings|Opening hours|Open hours)\s*[:：]\s*\S/i.test(l));
  if (hoursLine) f.hours = hoursLine.replace(/^(?:Hours|Timings|Opening hours|Open hours)\s*[:：]\s*/i, "").trim() || undefined;
  else {
    const h = flat.match(/(?:Open now|Closed Opens? at|Opens at)\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?\s*[–-]\s*[0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?(?:\s*\(Today\))?)/i);
    if (h) f.hours = h[1].trim();
  }

  // flags: explicit on-page words only.
  if (/dine[-\s]?in\b|\bdining\b/i.test(clean)) f.dineIn = "yes";
  if (/home delivery|\bdelivery\b|order online|takeaway available/i.test(clean)) f.delivery = "yes";
  if (/zomato\s+gold|\bGOLD\b/i.test(clean)) f.zomatoGold = "yes";

  // phone: only when the page actually shows digits.
  const phoneLine = lines.find((l) => /^(?:Phone|Mobile|Contact(?:\s+Number)?)\s*[:：]\s*\+?\d/.test(l));
  const shown = phoneLine?.replace(/^(?:Phone|Mobile|Contact(?:\s+Number)?)\s*[:：]\s*/, "").trim();
  const phone = shown ?? flat.match(PHONE_RE)?.[0] ?? flat.match(MOBILE_RE)?.[0];
  if (phone) f.phone = phone.trim().replace(/[,;]$/, "");

  return f;
}

// ---- signal helpers ---------------------------------------------------------

/** Links to domains that are not aggregator/platform hosts (a business's own site). */
export function externalLinks(text: string): string[] {
  const urls = String(text ?? "").match(/https?:\/\/[^\s"'<>,)]+/gi) ?? [];
  return urls.filter((u) => {
    try {
      const h = new URL(u).hostname;
      return !AGGREGATOR_HOST_RE.test(`${h}.`);
    } catch {
      return false;
    }
  });
}

function hasOwnWebsite(text: string): boolean {
  return externalLinks(text).length > 0 || /^Website\s*[:：]\s*\S/im.test(text);
}

function hasDirectOrdering(text: string): boolean {
  return externalLinks(text).some((u) => /order|book|reserve|menu|delivery/i.test(u))
    || /(?:order online|order now|order direct|book a table)\D{0,30}https?:\/\//i.test(text);
}

function hoursInconsistent(text: string): boolean {
  const found = [...String(text ?? "").matchAll(/(?:Hours|Timings|Opening hours|Open hours)\s*[:：]\s*([^\n]+)/gi)]
    .map((m) => m[1].trim().toLowerCase());
  const distinct = new Set(found);
  if (distinct.size >= 2) return true;
  return /(?:hours|timings)[^.\n]{0,40}(?:inconsistent|differ|mismatch|contradict)|(?:inconsistent|differ|mismatch|contradict)[^.\n]{0,20}(?:hours|timings)/i.test(String(text ?? ""));
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids (CONTRACT.md SIGNALS vocabulary, channel-specific names):
 *  high-votes-no-website-or-ordering, aggregator-only-no-direct-ordering,
 *  low-rating-recent-complaints, no-reservation, hours-inconsistent-cross-platform. */
export function zomatoSignals(f: ZomatoFields, text: string = ""): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  const votes = typeof f.votes === "number" ? f.votes : undefined;
  const hasSite = hasOwnWebsite(t);
  const hasDirect = hasDirectOrdering(t);

  if (votes !== undefined && votes >= HIGH_VOTES_THRESHOLD && !hasSite && !hasDirect) {
    out.push("high-votes-no-website-or-ordering");
  }
  if (/zomato|swiggy|dineout/i.test(t) && !hasDirect) {
    out.push("aggregator-only-no-direct-ordering");
  }
  if (typeof f.rating === "number" && f.rating <= LOW_RATING_THRESHOLD
    && /(delay|late|wrong order|incorrect order|missing item|order (?:was )?wrong|not delivered|never arrived)/i.test(t)) {
    out.push("low-rating-recent-complaints");
  }
  if (!/(?:book a table|book table|table reservation|reserve a table|reservation|book now)/i.test(t)) {
    out.push("no-reservation");
  }
  if (hoursInconsistent(t)) out.push("hours-inconsistent-cross-platform");
  return [...new Set(out)];
}

// ---- discovery ---------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. A "Name: <business>" line names the next
 *  Zomato URL (verbatim); otherwise the name comes from the URL slug. Lines with
 *  no Zomato URL, or robots-disallowed / non-business paths, skip. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  let pendingName: string | undefined;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const line = rawLine.trim();
    const nameLabel = line.match(/^Name\s*[:：]\s*(.+)$/i);
    if (nameLabel) {
      pendingName = nameLabel[1].trim();
      continue;
    }
    const title = line.match(/^(.+?),\s*[^,]+(?:,\s*[^,]+)*\s*\|\s*Zomato\b/i);
    if (title && !URL_IN_SNIPPET_RE.test(line)) {
      pendingName = title[1].trim();
      continue;
    }
    const m = line.match(URL_IN_SNIPPET_RE);
    if (!m) continue;
    const url = m[0].replace(/[\s,.;]+$/, "");
    if (NON_BUSINESS_PATH_RE.test(url)) continue;
    const name = pendingName ?? nameFromZomatoUrl(url);
    pendingName = undefined;
    if (!name) continue;
    leads.push({
      name,
      category,
      source: ZOMATO_CHANNEL_ID,
      sourceUrl: url,
      ...(line.match(PHONE_RE) ? { phone: line.match(PHONE_RE)![0].trim() } : {}),
    });
  }
  return leads;
}

// ---- status and env gate -----------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (tierCEnabled()) return { enabled: true };
  if (process.env.LEADSCOUT_BROWSER === "1") {
    return { enabled: true }; // operator-approved read mode on the operator's own browser
  }
  return {
    enabled: false,
    why: "tier C (zomato.com robots.txt has catch-all \"User-agent: * / Disallow: /\" and allows only "
      + "/llms.txt, /mcp-tools.md for AI crawlers; terms not fetched; india-sources.json tier C): "
      + `LEADSCOUT_INDIA_TIER_C is "${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off `
      + "(absent and =0 both mean off); the operator-approved browser-read fallback is also off "
      + "(LEADSCOUT_BROWSER is not 1)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const zomato: ChannelAdapter = {
  id: ZOMATO_CHANNEL_ID,
  name: "Zomato",
  tier: "C", // india-sources.json (L41): tier C, catch-all robots Disallow
  categories: ["restaurant", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    // read order, per the contract: search first (cheapest).
    const read = await readWithFallback(deps, {
      searchQuery: `site:${ZOMATO_SITE} "${q.category}" "${loc}"`.trim(),
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${ZOMATO_SITE} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: ZOMATO_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = { ...parseZomatoPage(text) };
    const signals = zomatoSignals(fields as ZomatoFields, text);
    return {
      channel: ZOMATO_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => zomatoSignals(parseZomatoPage(text), text),
};

registerChannel(zomato);
