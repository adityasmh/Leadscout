// ChannelAdapter for 99acres (Order L58-ch-99acres).
//
// India real-estate portal (agents, builders, projects). Tier C in
// india-sources.json (L41, registry id "ninenine-acres"): its robots.txt GET
// returned HTTP 403 on 2026-10-07 and no terms text could be fetched, so the
// source stays unverified. OFF by default; enabled only by an env var already
// named elsewhere in the codebase (this order names none, so none is invented):
//   - LEADSCOUT_INDIA_TIER_C=1 (india-sources.ts, L41 tier-C gate), or
//   - LEADSCOUT_BROWSER=1 (browser.ts, L43 operator-approved read mode; the
//     allowlist data/browser-allowlist.json lists 99acres.com).
//
// Read order per page (registry.readWithFallback): search first -> plain page
// read -> browser reader ONLY when both are blocked (403, 429, captcha, empty
// body). A login wall on the browser surfaces as needs-human.
//
// Page structure confirmed 2026-10-09 (search + fetch; see REPORT):
//  - Project page URL shape: /<project-slug>-npxid-r<digits>
//    e.g. /sattva-aeropolis-devanahalli-bangalore-north-npxid-r391738.
//  - Confirmed page text: "Project Details", the "Home › Projects in <City> ›
//    <Locality> › <Project>" breadcrumb, "Brought to you by <builder>",
//    "DEVELOPED BY <builder>", "The project builder is <builder>.", "About
//    <builder>", "Construction Status Under Construction / New Launch / Ready
//    To Move", a "₹ <a> - <b> L/Cr" price band or "Price on Request",
//    "PRICE RANGE <n> BHK Apartment", "All Photos <n>" / "All Photos & Videos
//    <n>", "RERA | <number>" and "The RERA registration number of this project
//    is <number>" (e.g. PRM/KA/RERA/1251/308/PR/310322/004804), and "View
//    Number" (the phone is gated behind login -> phone stays missing).
//  - A third-party scraper's field list (dealer_name, rera_id, project_name,
//    listed_by, locality, city, price) corroborates the fields; it states phone
//    numbers are gated behind login on 99acres.
//  - Agent/dealer profile page markup could NOT be fetched (pages 403) and
//    stays UNVERIFIED; labelled "Agent:"/"Builder:"/"Posted by" forms are
//    supported but only tested against fixtures.
//
// Rules: every field value is copied verbatim from the page text or the URL /
// search snippet with its source URL; a value the page does not show stays
// missing (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true. Browsing
// respects browser.ts per-platform caps; a blocked page is never re-read here.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const ACRES99_CHANNEL_ID = "ninenine-acres"; // matches india-sources.json registry data (L41)
export const ACRES99_SITE = "99acres.com";
const MAX_TEXT = 20000;
/** "many listings" >= this many (registry fields: listing counts). */
export const MANY_LISTINGS_THRESHOLD = 5;
/** "thin listing content" when fewer photos than this are shown. */
export const FEW_PHOTOS_THRESHOLD = 5;

export type Acres99Fields = {
  name?: string;
  agentOrBuilderName?: string;
  listingCount?: number;
  localities?: string;
  reraNumber?: string;
  projectStatus?: string;
  priceBand?: string;
  photoCount?: number;
  phone?: string;
};

// ---- page/snippet parser: only exact matches become fields ------------------

const ACRES_URL_RE = /https?:\/\/(?:www\.)?99acres\.com\/[^\s"'<>*]+/i;
const URL_IN_SNIPPET_RE = /https?:\/\/(?:www\.)?99acres\.com\/[^\s"'<>]+/i;
// robots.txt unverified (GET 403); these are non-lead surfaces confirmed from
// fetched pages: dashboard, info pages, insight/tool pages, mailers.
const NON_LEAD_PATH_RE =
  /\/(dashboard|info|mailers|area-converter|apply-for-home-loan|property-rates|property-registry|real-estate-reviews|real-estate-city-insights|articles|news|faq|login|register)\b/i;
// aggregate search/category pages, not one business (confirmed "-ffid" suffix).
const AGGREGATE_PATH_RE = /-(?:ffid|npffid|srffid|wrffid|prffid|lrffid|utyp|hlpg)(?:[?#]|$)/i;
const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?previous\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b/i;
const PHONE_RE = /\+\d{1,3}[-\s]?\d(?:[\d\s()-]{6,}\d)/;
// the page hides the number behind a reveal control until login (confirmed "View Number").
const PHONE_HIDDEN_RE = /\bView Number\b|\bContact to view\b|\bGet (?:Phone )?Number\b|\bView Phone\b|\bShow Number\b/i;
// confirmed shape: PRM/KA/RERA/1251/308/PR/310322/004804
const RERA_NUMBER_RE = /\b([A-Z]{2,5}\/[A-Z]{2,4}\/RERA\/[A-Z0-9\/]+)\b/;
const PORTAL_HOST_RE = /(?:^|\.)(?:99acres|magicbricks|nobroker|housing)\.com(?:$|\/)/i;

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function nameFromAcresUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!/(^|\.)99acres\.com$/i.test(u.hostname)) return undefined;
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    let slug = segs[segs.length - 1] ?? "";
    slug = slug.replace(/-npxid-[a-z0-9]+$/i, "").replace(/-\d+-npffid$/i, "").replace(/-ffid$/i, "");
    const name = decodeURIComponent(slug).replace(/[-_]+/g, " ").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Parse a 99acres project/agent page (or a search snippet block) into fields.
 *  Every value is a verbatim copy from the text or the URL; anything unmatched
 *  stays undefined (never inferred). */
export function parseAcres99Page(text: string): Acres99Fields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const lines = clean.split(/\r?\n/).map((l) => l.trim());
  const f: Acres99Fields = {};

  const labelled = (re: RegExp): string | undefined => {
    const hit = lines.find((l) => re.test(l));
    const v = hit?.match(re)?.[1]?.trim();
    return v || undefined;
  };

  // name: an explicit "Name:" label, else the project-page URL slug (verbatim).
  f.name = labelled(/^Name\s*[:：]\s*(.+)$/i) ?? nameFromAcresUrl(flat.match(ACRES_URL_RE)?.[0]);

  // agent or builder name: explicit labels, then the confirmed page phrasings.
  const devIdx = lines.findIndex((l) => /^DEVELOPED BY$/i.test(l));
  const devName = devIdx >= 0 ? lines[devIdx + 1]?.trim() : undefined;
  f.agentOrBuilderName =
    labelled(/^(?:Agent|Builder|Dealer)\s*[:：]\s*(.+)$/i)
    ?? labelled(/^Posted by\s*[:：]?\s*(.+)$/i)
    ?? flat.match(/Brought to you by ([^,.\n]{2,80})/i)?.[1]?.trim()
    ?? devName
    ?? flat.match(/The project builder is ([^.\n]{2,80})/i)?.[1]?.trim()
    ?? labelled(/^About (?!Project\b|Us\b|This\b)([^:\n]{2,80})$/i);

  // listing count: an explicit label, else "N projects of this builder".
  f.listingCount =
    num(labelled(/^Listings?\s*[:：]\s*([\d,]{1,7})$/i))
    ?? num(labelled(/^Projects?\s*[:：]\s*([\d,]{1,7})$/i))
    ?? num(flat.match(/\b([\d,]{1,7})\s+projects?\s+of\s+this\s+builder\b/i)?.[1]);

  // localities: an explicit label, else the confirmed breadcrumb, else "<x>, <city>".
  const locLabel = labelled(/^Localit(?:y|ies)\s*[:：]\s*(.+)$/i) ?? labelled(/^Location\s*[:：]\s*(.+)$/i);
  const crumb = flat.match(/Projects in ([^›\n]{2,40}?)\s*›\s*([^›\n]{2,60}?)(?:\s*›|$)/);
  const inForm = flat.match(/\bin\s+([^,\n]{2,60}),\s*([A-Z][A-Za-z .'-]{1,40})\b/);
  f.localities = locLabel
    ?? (crumb ? `${crumb[2].trim()}, ${crumb[1].trim()}` : undefined)
    ?? (inForm ? `${inForm[1].trim()}, ${inForm[2].trim()}` : undefined);

  // RERA number: confirmed "RERA | <number>" / "...registration number... is <number>".
  f.reraNumber =
    flat.match(/RERA registration number of this project is\s*([A-Z0-9\/]+)/i)?.[1]
    ?? flat.match(/\bRERA\s*\|\s*([A-Z0-9\/]+)/)?.[1]
    ?? flat.match(/RERA number is\s*([A-Z0-9\/]+)/i)?.[1]
    ?? flat.match(RERA_NUMBER_RE)?.[1];

  // project status: the confirmed status words, from "Construction Status <x>".
  f.projectStatus =
    flat.match(/Construction Status\s+(Under Construction|New Launch|Ready To Move|Ready to Move|Under-construction)/i)?.[1]
    ?? lines.find((l) => /^(Under Construction|New Launch|Ready To Move)$/i.test(l))
    ?? flat.match(/\b(Under Construction|New Launch|Ready To Move)\b/i)?.[1];

  // price band: the confirmed "₹ <a> - <b> L/Cr" span, else a labelled price, else
  // the literal "Price on Request".
  const priceRange = flat.match(/(?:₹|Rs\.?)\s*[\d.,]+\s*(?:L|Lakh|Cr|Crore)?\s*[-–]\s*(?:₹|Rs\.?)?\s*[\d.,]+\s*(?:L|Lakh|Cr|Crore)/i);
  const priceLabel = labelled(/^Price(?:\s+Band|\s+Range)?\s*[:：]\s*(.+)$/i);
  const priceSingle = flat.match(/(?:₹|Rs\.?)\s*[\d.,]+\s*(?:L|Lakh|Cr|Crore)\b/i);
  f.priceBand = priceRange?.[0]?.trim()
    ?? priceLabel
    ?? (/\bPrice on Request\b/i.test(clean) ? "Price on Request" : undefined)
    ?? priceSingle?.[0]?.trim();

  // photo count: confirmed "All Photos <n>" / "All Photos & Videos <n>".
  f.photoCount = num(flat.match(/All Photos(?:\s*&?\s*Videos)?\s+([\d,]{1,6})/i)?.[1]);

  // phone: only when the page actually shows digits; a reveal control means hidden.
  const shown = labelled(/^(?:Phone|Mobile|Contact(?:\s+Number)?)\s*[:：]\s*(\+?\d[\d\s()-]*)$/);
  if (shown) {
    if (!PHONE_HIDDEN_RE.test(clean)) f.phone = shown.replace(/[,;]$/, "");
  } else if (!PHONE_HIDDEN_RE.test(clean)) {
    const bare = flat.match(PHONE_RE)?.[0];
    if (bare) f.phone = bare.trim().replace(/[,;]$/, "");
  }

  // a field the page did not show stays missing: drop undefined keys entirely.
  for (const k of Object.keys(f) as (keyof Acres99Fields)[]) {
    if (f[k] === undefined) delete f[k];
  }
  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids over parsed fields + raw text. Real-estate signals (same
 *  set as MagicBricks) plus cross-listing: many-listings-no-website,
 *  thin-listing-content, slow-response-on-enquiries, rera-registered-no-web,
 *  cross-listed-portals. */
export function acres99Signals(f: Acres99Fields, text: string = ""): string[] {
  const out: string[] = [];
  const urls = String(text ?? "").match(/https?:\/\/[^\s"'<>,)]+/gi) ?? [];
  const hasOwnWebsite = urls.some((u) => !PORTAL_HOST_RE.test(u.replace(/^https?:\/\//, "")));
  // many active listings but no own website (portal links do not count)
  if (typeof f.listingCount === "number" && f.listingCount >= MANY_LISTINGS_THRESHOLD && !hasOwnWebsite) {
    out.push("many-listings-no-website");
  }
  // listing photos or descriptions thin (explicit page text only)
  const thinPhotos = typeof f.photoCount === "number" && f.photoCount >= 0 && f.photoCount < FEW_PHOTOS_THRESHOLD;
  if (thinPhotos || /\bNo (?:photos|images)\b|\bdescription (?:not|un)available\b/i.test(text)) {
    out.push("thin-listing-content");
  }
  // slow or absent response on enquiries mentioned in the page text
  if (/\b(?:slow|no|never|not)\s+(?:to\s+)?(?:respond|respon|repl|answer|reply)\b|\bresponse time\b|\bunresponsive\b/i.test(text)) {
    out.push("slow-response-on-enquiries");
  }
  // RERA-registered agent/builder with no own web presence
  if (f.reraNumber && !hasOwnWebsite) out.push("rera-registered-no-web");
  // the same agent on several portals (manual duplicate entry to remove)
  if (/(?:magicbricks|nobroker|housing)\.com/i.test(text) || /(?:also|additionally)\s+(?:listed|available)\s+on/i.test(text)) {
    out.push("cross-listed-portals");
  }
  return [...new Set(out)];
}

// ---- discovery --------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. A `Name: <business>` or markdown
 *  `[Title](url)` names the next 99acres URL; otherwise the name comes from the
 *  project-page URL slug. Aggregate and non-lead paths are skipped. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  let pendingName: string | undefined;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const line = rawLine.trim();
    if (!line || INJECTION_NEVER_COPY.test(line)) continue;
    const nameLabel = line.match(/^Name\s*[:：]\s*(.+)$/i);
    if (nameLabel) {
      pendingName = nameLabel[1].trim();
      continue;
    }
    const m = line.match(URL_IN_SNIPPET_RE);
    if (!m) continue;
    const url = m[0].replace(/[\s,.;]+$/, "");
    if (NON_LEAD_PATH_RE.test(url) || AGGREGATE_PATH_RE.test(url)) continue;
    const md = line.match(/\[([^\]]{0,120})\]\((https?:\/\/[^\s)]*99acres\.com[^\s)]*)\)/i);
    const name = pendingName ?? md?.[1]?.trim() ?? nameFromAcresUrl(url);
    pendingName = undefined;
    if (!name) continue;
    const phoneMatch = line.match(PHONE_RE);
    leads.push({
      name,
      category,
      source: ACRES99_CHANNEL_ID,
      sourceUrl: url,
      ...(phoneMatch && !PHONE_HIDDEN_RE.test(line) ? { phone: phoneMatch[0].trim() } : {}),
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
    why: "tier C (99acres robots.txt GET 403 on 2026-10-07, terms unverified; india-sources.json "
      + "id \"ninenine-acres\" tier C): LEADSCOUT_INDIA_TIER_C is "
      + `"${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off (absent and =0 both mean off); `
      + "the operator-approved browser-read fallback is also off (LEADSCOUT_BROWSER is not 1)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const acres99: ChannelAdapter = {
  id: ACRES99_CHANNEL_ID,
  name: "99acres",
  tier: "C", // india-sources.json (L41): tier C, robots/terms unverified
  categories: ["real-estate", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    // read order, per the contract: search first (cheapest).
    const read = await readWithFallback(deps, {
      searchQuery: `site:${ACRES99_SITE} "${q.category}" "${loc}"`.trim(),
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${ACRES99_SITE} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: ACRES99_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = { ...parseAcres99Page(text) };
    const signals = acres99Signals(fields as Acres99Fields, text);
    return {
      channel: ACRES99_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => acres99Signals(parseAcres99Page(text), text),
};

registerChannel(acres99);
