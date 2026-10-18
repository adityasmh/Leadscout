// ChannelAdapter for BookMyShow and event venue listings (Order L72-ch-bookmyshow).
//
// Entertainment, gym and activity venues whose events are ticketed on
// in.bookmyshow.com. Tier C channel: OFF by default, enabled only by env
// CHANNEL_BOOKMYSHOW=1 (named by this order). No new dependencies.
//
// Read order per page comes from registry.readWithFallback: search first, then
// a plain page read, then the browser reader ONLY when both are blocked
// (403, 429, captcha, empty body). The browser reader enforces its own
// per-platform hourly caps and its 2-6 s pause; this adapter never re-reads a
// blocked page and never bypasses needs-human.
//
// Verified 2026-10-13 by direct fetch:
//  - https://in.bookmyshow.com/mumbai/venues returns HTTP 403 to a plain
//    fetch (bot protection), so the browser fallback is the realistic path.
//  - https://in.bookmyshow.com/robots.txt has NO catch-all "User-agent: *
//    Disallow: /" for listing pages (it disallows booking/payment paths such
//    as /payment/, /order-summary*, /booking-details*); sitemaps are
//    published for movies, plays, events, activities and cinemas.
// UNVERIFIED (recorded in the report): the exact venue/activity page markup
// (name / rating / ticket-button selectors) and the BookMyShow terms-of-use
// text about automated access — web search was rate-limited (429) this run,
// so the parser below is a heuristic over search snippets and page text with
// explicit labels, and the channel stays OFF by default.
//
// Rules: every field value is copied verbatim from page text or the URL /
// search snippet with its source URL; a value the page does not show stays
// missing (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const BOOKMYSHOW_CHANNEL_ID = "bookmyshow";
export const BOOKMYSHOW_SITE = "in.bookmyshow.com";
const MAX_TEXT = 20000;

export type BookmyshowFields = {
  name?: string; type?: string; address?: string; rating?: number;
  eventsCount?: number; ticketing?: string; phone?: string;
};

// ---- page/snippet parser: only exact matches become fields ------------------

const BMS_URL_IN_SNIPPET_RE = /https?:\/\/(?:www\.)?in\.bookmyshow\.com\/[^\s"'<>]+/i;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?previous\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b/i;
// Directory / account / support pages are not one venue.
const NON_BUSINESS_PATH_RE =
  /\/(login|signup|sign-in|sign-up|giftcards|gift-cards|offers|corporates|careers|help|support|faq|terms|privacy|sitemap)(\/|$|\?|#)/i;
// Platform / aggregator hosts that never count as the venue's own booking site.
const AGGREGATOR_HOST_RE =
  /(?:^|\.)(?:bookmyshow|bmscdn|google|googleapis|facebook|fbcdn|instagram|twitter|justdial|sulekha|zomato|youtube|whatsapp)\./i;

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function nameFromBmsUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!/(^|\.)in\.bookmyshow\.com$/i.test(u.hostname)) return undefined;
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    const slug = segs[segs.length - 1] ?? "";
    if (!slug || /^\d+$/.test(slug)) return undefined;
    return slug.replace(/-/g, " ").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Parse a BookMyShow venue/activity page (or a search-snippet block) into
 *  fields. Every value is a verbatim copy from the text or the URL; anything
 *  unmatched stays undefined (never inferred). */
export function parseBookmyshowPage(text: string): BookmyshowFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ").trim();
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: BookmyshowFields = {};

  // name: explicit "Name:" label, else the page title before the first comma.
  const nameLine = lines.find((l) => /^Name\s*[:：]\s*\S/.test(l));
  let name = nameLine?.replace(/^Name\s*[:：]\s*/, "").trim();
  if (!name) {
    const title = clean.split(/[|\n]/)[0]?.trim() ?? "";
    if (title && !/https?:/i.test(title) && title.includes(",")) name = title.split(",")[0].trim();
  }
  if (!name) name = nameFromBmsUrl(flat.match(BMS_URL_IN_SNIPPET_RE)?.[0]);
  if (name) f.name = name;

  // type: "Type:" label only (event venue, activity centre, gym, ...).
  const typeLine = lines.find((l) => /^(?:Type|Venue type|Category)\s*[:：]\s*\S/i.test(l));
  if (typeLine) f.type = typeLine.replace(/^(?:Type|Venue type|Category)\s*[:：]\s*/i, "").trim() || undefined;

  // address: "Address:" label, else an address-looking line (commas + a digit).
  const addrLine = lines.find((l) => /^Address\s*[:：]\s*\S/i.test(l));
  if (addrLine) f.address = addrLine.replace(/^Address\s*[:：]\s*/i, "").trim() || undefined;
  else {
    const guess = lines.find((l) => !/^Name\b|^Type\b|https?:/i.test(l)
      && /\d/.test(l) && (l.match(/,/g) ?? []).length >= 2);
    if (guess) f.address = guess;
  }

  // rating: "Rating:" label, else "<n.n>/5" or "<n.n> star(s)" copy.
  const ratingLine = lines.find((l) => /^Rating\s*[:：]\s*[0-5]/.test(l));
  if (ratingLine) {
    const r = num(ratingLine.replace(/^Rating\s*[:：]\s*/, "").trim().split(/[\s/]/)[0]);
    if (r !== undefined && r > 0 && r <= 5) f.rating = r;
  }
  if (f.rating === undefined) {
    const m = flat.match(/\b([0-5](?:\.\d{1,2})?)\s*(?:\/\s*5|stars?\b|ratings?\b)/i);
    if (m) {
      const r = num(m[1]);
      if (r !== undefined && r > 0 && r <= 5) f.rating = r;
    }
  }

  // upcoming events count: "Upcoming events: <N>" label, else "<N> upcoming events".
  const eventsLine = lines.find((l) => /^(?:Upcoming events|Events)\s*[:：]\s*[\d,]/i.test(l));
  if (eventsLine) {
    const v = num(eventsLine.replace(/^(?:Upcoming events|Events)\s*[:：]\s*/i, "").trim().split(/\s/)[0]);
    if (v !== undefined) f.eventsCount = v;
  }
  if (f.eventsCount === undefined) {
    const m = flat.match(/([\d,]{1,7})\s+upcoming\s+events?\b/i);
    if (m) {
      const v = num(m[1]);
      if (v !== undefined) f.eventsCount = v;
    }
  }

  // ticketing availability: "Ticketing:" label, else explicit on-page copy.
  const ticketLine = lines.find((l) => /^(?:Ticketing|Tickets|Availability)\s*[:：]\s*\S/i.test(l));
  if (ticketLine) f.ticketing = ticketLine.replace(/^(?:Ticketing|Tickets|Availability)\s*[:：]\s*/i, "").trim() || undefined;
  else {
    const m = flat.match(/(tickets available|book now|sold out|tickets? (?:selling|on sale)|housefull|booking (?:open|closed))/i);
    if (m) f.ticketing = m[1];
  }

  // phone: only when the page actually shows digits.
  const phoneLine = lines.find((l) => /^(?:Phone|Mobile|Contact(?:\s+Number)?)\s*[:：]\s*\+?\d/.test(l));
  const shown = phoneLine?.replace(/^(?:Phone|Mobile|Contact(?:\s+Number)?)\s*[:：]\s*/, "").trim();
  const phone = shown ?? flat.match(PHONE_RE)?.[0];
  if (phone) f.phone = phone.trim().replace(/[,;]$/, "");

  return f;
}

// ---- signal helpers ---------------------------------------------------------

/** Links to domains that are not the platform or other aggregators
 *  (a venue's own booking site). */
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

function listsEvents(text: string): boolean {
  return /(?:upcoming events|events listed|events at|shows at|activities at|events?:\s*\d|book (?:tickets|now)|tickets available)/i.test(text);
}

function hasEmailListOrCrm(text: string): boolean {
  return /(?:newsletter|subscribe|mailing list|email list|email signup|join our|stay updated|stay in touch|CRM|hubspot|zoho|salesforce|mailchimp)/i.test(text);
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids:
 *  platform-only-ticketing (events listed, sold only through the platform),
 *  no-own-booking-site, events-no-email-list (events listed, no email list/CRM). */
export function bookmyshowSignals(f: BookmyshowFields, text: string = ""): string[] {
  const out: string[] = [];
  const t = String(text ?? "");
  const ownSite = hasOwnWebsite(t);
  const events = listsEvents(t) || (typeof f.eventsCount === "number" && f.eventsCount > 0);

  if (events && !ownSite) out.push("platform-only-ticketing");
  if (!ownSite) out.push("no-own-booking-site");
  if (events && !hasEmailListOrCrm(t)) out.push("events-no-email-list");
  return [...new Set(out)];
}

// ---- discovery ---------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. A "Name: <venue>" line names the next
 *  BookMyShow URL (verbatim); otherwise the name comes from the URL slug.
 *  Lines with no BookMyShow URL, or non-business paths, skip. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  let pendingName: string | undefined;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const line = rawLine.trim();
    if (INJECTION_NEVER_COPY.test(line)) {
      pendingName = undefined;
      continue;
    }
    const nameLabel = line.match(/^Name\s*[:：]\s*(.+)$/i);
    if (nameLabel) {
      pendingName = nameLabel[1].trim();
      continue;
    }
    const m = line.match(BMS_URL_IN_SNIPPET_RE);
    if (!m) continue;
    const url = m[0].replace(/[\s,.;]+$/, "");
    if (NON_BUSINESS_PATH_RE.test(url)) {
      pendingName = undefined;
      continue;
    }
    const name = pendingName ?? nameFromBmsUrl(url);
    pendingName = undefined;
    if (!name) continue;
    leads.push({
      name,
      category,
      source: BOOKMYSHOW_CHANNEL_ID,
      sourceUrl: url,
      ...(line.match(PHONE_RE) ? { phone: line.match(PHONE_RE)![0].trim() } : {}),
    });
  }
  return leads;
}

// ---- status and env gate -----------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (process.env.CHANNEL_BOOKMYSHOW === "1") return { enabled: true };
  return {
    enabled: false,
    why: "bookmyshow is OFF by default (BookMyShow and event venue listings; tier C): "
      + `CHANNEL_BOOKMYSHOW is "${String(process.env.CHANNEL_BOOKMYSHOW ?? "")}" `
      + "(absent and any value other than 1 both mean off; the operator sets CHANNEL_BOOKMYSHOW=1 to switch it on)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const bookmyshow: ChannelAdapter = {
  id: BOOKMYSHOW_CHANNEL_ID,
  name: "BookMyShow",
  tier: "C",
  categories: ["event-company", "gym", "entertainment", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    // read order, per the contract: search first (cheapest).
    const read = await readWithFallback(deps, {
      searchQuery: `site:${BOOKMYSHOW_SITE} "${q.category}" "${loc}"`.trim(),
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${BOOKMYSHOW_SITE} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: BOOKMYSHOW_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = { ...parseBookmyshowPage(text) };
    const signals = bookmyshowSignals(fields as BookmyshowFields, text);
    return {
      channel: BOOKMYSHOW_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => bookmyshowSignals(parseBookmyshowPage(text), text),
};

registerChannel(bookmyshow);
