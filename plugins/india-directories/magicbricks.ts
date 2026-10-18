// ChannelAdapter for MagicBricks real-estate agents and projects
// (Order L57-ch-magicbricks).
//
// Tier C channel: OFF by default. `data/india-sources.json` (L41) lists
// MagicBricks as tier C: robots.txt disallows /property/, /property-agent-details,
// /featuredagent/, /profile/ for `User-agent: *`. It is switched on ONLY by
// env LEADSCOUT_INDIA_TIER_C=1 (india-sources.ts `tierCEnabled()`, the same
// convention as the sibling JustDial/Sulekha adapters), EXCEPT the
// operator-approved browser-read mode on the operator's own logged-in browser
// (LEADSCOUT_BROWSER=1; data/browser-allowlist.json already lists
// magicbricks.com). The browser reader is injected in deps and only reached by
// the registry's readWithFallback AFTER search and plain page read return
// blocked results (403/429/captcha/empty). LEADSCOUT_BROWSER=0 is a hard kill
// switch and still disables.
//
// Verified with web search + a robots.txt fetch on 2026-10-09 (see the report):
//  - robots.txt `User-agent: *` Disallow: /property/, /property-agent-details,
//    /featuredagent/, /profile/, /images/, /*proptype=, ... Named AI crawlers
//    (ClaudeBot etc.) are Allow: /, but generic readers are not -> tier C.
//  - Locality/overview pages show "N Properties for Sale in <locality>",
//    "Agent:<name>", "Builder:<name>", "Since<year>",
//    "Total projects : N Projects Ongoing : N Projects completed : N",
//    "RERA" mentions and "Agent (Local Guide)".
//  - The agent detail template could NOT be fetched this run (MagicBricks
//    served a maintenance page to the plain fetch); its exact labels are
//    recorded as unverified in the report. The parser is explicit-match-only,
//    so an off assumption degrades to "field missing", never to an invented
//    value.
//
// Rules: every field value is copied verbatim from page text or the URL /
// search snippet with its source URL; a value the page does not show stays
// missing (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted (injected instruction lines dropped) and evidence is
// marked untrusted: true. Browser reads respect the reader's per-platform caps
// because enrich reads at most one page through the injected reader.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const MAGICBRICKS_CHANNEL_ID = "magicbricks"; // matches india-sources.json registry data (L41)
export const MAGICBRICKS_SITE = "magicbricks.com";
const MAX_TEXT = 20000;
// "many active listings" at or above this count (fixtures set the bar; the page
// shows the exact count and it is copied verbatim).
export const MANY_LISTINGS_THRESHOLD = 10;
// "thin" photos at or below this count.
export const THIN_PHOTOS_THRESHOLD = 3;

export type MagicbricksFields = {
  name?: string;
  agencyName?: string;
  areasServed?: string;
  listingCount?: number;
  years?: number;
  sinceYear?: number;
  reraNumber?: string;
  phone?: string;
  projectNames?: string;
  builders?: string;
  photoCount?: number;
};

// Lines that are instructions, never data (defence in depth; reach.sanitizeUntrusted
// also strips these before parsing).
const INJECTION_NEVER_COPY =
  /ignore (all )?(the )?previous|disregard (all )?(the )?(above|previous|prior|earlier)|system prompt|you are now|<\/?(tool|function|invoke)\b/i;

const MB_URL_IN_SNIPPET_RE = /https?:\/\/(?:www\.)?magicbricks\.com\/[^\s"'<>,)]+/i;
// A visible external (non-MagicBricks) website link.
const EXTERNAL_URL_RE = /https?:\/\/(?!.*?magicbricks\.com)[^\s"'<>,)]+/i;
const CRM_RE = /\b(?:crm|customer relationship management|salesforce|zoho|hubspot|property management software)\b/i;
const PHONE_RE = /\+\d{1,3}[-\s]?\d{7,14}/;

function firstLabel(text: string, patterns: RegExp[]): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    for (const re of patterns) {
      const m = t.match(re);
      if (m && m[1] && m[1].trim()) return m[1].trim();
    }
  }
  return undefined;
}

function labelsAll(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(re);
    if (m && m[1] && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

/** Parse a MagicBricks agent/project/listing page (or a search snippet block)
 *  into fields. Every value is a verbatim copy from the text; anything
 *  unmatched stays undefined (never inferred). */
export function parseMagicbricksPage(text: string): MagicbricksFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ").trim();
  const f: MagicbricksFields = {};

  // agent name: explicit labels only ("Name:" / "Agent:" / "Agent:<name> (Local Guide)").
  const rawName = firstLabel(clean, [/^Name\s*[:：]\s*(.+)$/i, /^Agent\s*[:：]\s*(.+)$/i]);
  if (rawName) {
    const stripped = rawName.replace(/\s*\((?:Local\s+Guide|Owner|Builder)\)\s*$/i, "").trim();
    if (stripped) f.name = stripped;
  }

  // agency / brokerage name: explicit label only.
  f.agencyName = firstLabel(clean, [
    /^Agency\s*[:：]\s*(.+)$/i,
    /^(?:Company|Firm|Brokerage)\s*[:：]\s*(.+)$/i,
  ]);

  // areas served: explicit label only.
  f.areasServed = firstLabel(clean, [
    /^Areas?\s*(?:served|covered|of operation)\s*[:：]\s*(.+)$/i,
    /^Deals?\s+in\s*[:：]\s*(.+)$/i,
  ]);

  // listing count: "120 Properties for Sale", "12 Active Listings", "Total Listings: 120".
  const lc =
    flat.match(/([\d,]{1,12})\s+(?:active\s+)?(?:properties|listings?)\b/i) ??
    flat.match(/(?:total\s+)?(?:properties|listings?)\s*[:：]\s*([\d,]{1,12})/i);
  if (lc) {
    const n = Number(lc[1].replace(/,/g, ""));
    if (Number.isFinite(n)) f.listingCount = n;
  }

  // years: "12 Years in Business" / "12 Years of experience" (verbatim count, never computed).
  const ym = flat.match(/\b(\d{1,3})\s*\+?\s*years?\b(?:\s+(?:of\s+)?(?:experience|in business))?/i);
  if (ym) {
    const n = Number(ym[1]);
    if (Number.isFinite(n)) f.years = n;
  }
  // since year: "Since 2012" / "Since2003" (verbatim).
  const sm = flat.match(/\bsince\s*((?:19|20)\d{2})\b/i);
  if (sm) f.sinceYear = Number(sm[1]);

  // RERA number: explicit label; the captured token must contain a long digit run
  // so a state name ("RERA Haryana 2025") is never mistaken for a number.
  const rm = flat.match(
    /\b(?:MahaRERA|TNRERA|RERA)\s*(?:no\.?|number|reg(?:istration)?(?:\s*no\.?)?)?\s*[:：.]?\s*([A-Z]\d{6,}[A-Z0-9/]*)/i,
  );
  if (rm) f.reraNumber = rm[1].replace(/[.,;]+$/, "");

  // phone: only when the page actually shows a Phone label or an explicit +NN span.
  const phoneLabel = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^Phone\s*[:：]\s*\+?\d/.test(l));
  const phone = phoneLabel?.replace(/^Phone\s*[:：]\s*/, "").trim() ?? flat.match(PHONE_RE)?.[0];
  if (phone) f.phone = phone.replace(/[,;]+$/, "").trim();

  // project names + builders: explicit per-line labels only.
  const projects = labelsAll(clean, /^Project\s*[:：]\s*(.+)$/i);
  if (projects.length) f.projectNames = [...new Set(projects)].slice(0, 5).join(", ");
  const builders = labelsAll(clean, /^Builder\s*[:：]\s*(.+)$/i);
  if (builders.length) f.builders = [...new Set(builders)].slice(0, 5).join(", ");

  // photos: "<N> Photos" or "+ N More" gallery overflow.
  const pm = flat.match(/([\d,]{1,12})\s*photos?\b/i) ?? flat.match(/\+\s*([\d,]{1,12})\s+more\b/i);
  if (pm) {
    const n = Number(pm[1].replace(/,/g, ""));
    if (Number.isFinite(n)) f.photoCount = n;
  }

  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids over parsed fields + raw text (CONTRACT.md SIGNALS). */
export function magicbricksSignals(f: MagicbricksFields, text = ""): string[] {
  const t = String(text ?? "");
  const out: string[] = [];
  const hasWebsite = EXTERNAL_URL_RE.test(t);
  const hasCrm = CRM_RE.test(t);
  const manyListings =
    typeof f.listingCount === "number" && f.listingCount >= MANY_LISTINGS_THRESHOLD;

  // many active listings but no own website or CRM.
  if (manyListings && !hasWebsite && !hasCrm) out.push("many-listings-no-website-or-crm");

  // thin listing photos/descriptions.
  const thin =
    (typeof f.photoCount === "number" && f.photoCount <= THIN_PHOTOS_THRESHOLD) ||
    /\bno (?:photos?|images?|pictures?|description)\b|description not available|details not available/i.test(t);
  if (thin) out.push("thin-listing-content");

  // slow enquiry response mentioned.
  const slowFirst =
    /(?:slow|delayed?|late|never|no|not)[^.?!\n]{0,60}(?:respon(?:d|se|ses)|repl(?:y|ies|ied))[^.?!\n]{0,40}(?:enquir|inquir|lead|call)/i;
  const slowSecond = /(?:enquir|inquir|lead)[^.?!\n]{0,60}(?:slow|delay|no response|not respond|never respond)/i;
  if (slowFirst.test(t) || slowSecond.test(t)) out.push("slow-enquiry-response");

  // RERA-registered agent with no web presence.
  if (f.reraNumber && !hasWebsite) out.push("rera-no-web-presence");

  return out;
}

// ---- discovery --------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. Each line must carry a magicbricks.com URL;
 *  the name is the text before the URL on that line (else the URL slug). */
export function resultsToLeads(text: string, category: string, city: string | undefined, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  const seen = new Set<string>();
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const m = rawLine.match(MB_URL_IN_SNIPPET_RE);
    if (!m || m.index === undefined) continue;
    const url = m[0].replace(/[\s,.;)]+$/, "");
    if (seen.has(url)) continue;
    const before = rawLine
      .slice(0, m.index)
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
      .replace(/^(?:Title|Name)\s*[:：]\s*/i, "")
      .replace(/[\s|·—–-]+$/, "")
      .trim();
    const name = before || urlSlugName(url);
    if (!name) continue;
    seen.add(url);
    const phone = rawLine.match(PHONE_RE);
    leads.push({
      name,
      category,
      ...(city ? { city } : {}),
      source: MAGICBRICKS_CHANNEL_ID,
      sourceUrl: url,
      ...(phone ? { phone: phone[0].trim() } : {}),
    });
  }
  return leads;
}

function urlSlugName(url: string): string {
  try {
    const segs = url.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    const slug = segs[segs.length - 1] ?? "";
    return slug
      .replace(/\.(?:html?|php)$/i, "")
      .replace(/-?\d{4,}$/, "")
      .replace(/[-_]+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

// ---- status -----------------------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (tierCEnabled()) return { enabled: true };
  if (process.env.LEADSCOUT_BROWSER === "1") {
    return { enabled: true }; // operator-approved read mode on the operator's own browser
  }
  return {
    enabled: false,
    why: "tier C (magicbricks robots.txt disallows /property/ and agent paths for User-agent:*; "
      + "india-sources.json tier C): LEADSCOUT_INDIA_TIER_C is "
      + `"${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off (absent and =0 both mean off); `
      + "the operator-approved browser-read fallback is also off (LEADSCOUT_BROWSER is not 1)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const magicbricks: ChannelAdapter = {
  id: MAGICBRICKS_CHANNEL_ID,
  name: "MagicBricks",
  tier: "C", // india-sources.json (L41): tier C, robots.txt bans agent/property paths for generic readers
  categories: ["real-estate"],

  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    const read = await readWithFallback(deps, {
      searchQuery: `site:${MAGICBRICKS_SITE} "${q.category}" ${loc}`.trim(),
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, q.city, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${MAGICBRICKS_SITE} "${lead.name}" ${lead.city ?? ""}`.trim(),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha / checkpoint after browser escalation: never
        // solved or bypassed -> needs-human evidence, no fields.
        return {
          channel: MAGICBRICKS_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = parseMagicbricksPage(text);
    const signals = magicbricksSignals(fields as MagicbricksFields, text);
    return {
      channel: MAGICBRICKS_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => magicbricksSignals(parseMagicbricksPage(text), text),
};

registerChannel(magicbricks);
