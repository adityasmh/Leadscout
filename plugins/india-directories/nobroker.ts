// ChannelAdapter for NoBroker and Housing.com (Order L59-ch-nobroker-housing).
//
// One adapter covers both platforms (real estate and rentals). Tier C in
// india-sources.json (order L41): OFF by default, enabled only by env
// LEADSCOUT_INDIA_TIER_C=1, or by the operator-approved browser-read mode
// (LEADSCOUT_BROWSER=1) after the operator added nobroker.in and housing.com
// to data/browser-allowlist.json. The browser reader is injected in deps and
// only reached by the registry's readWithFallback AFTER search and plain page
// read return blocked results (403/429/captcha/empty).
//
// Verified with web search + robots.txt fetch on 2026-10-09:
//  - nobroker.in robots.txt: User-agent:* disallows /property/listing/, /api/,
//    /profile/, /user/, /v1/, /static/ ... but public listing/detail pages like
//    /property/<slug>/<hash>/detail are not disallowed.
//  - housing.com robots.txt: HTTP 406 (unreadable) again this run -> unverified.
//  - NoBroker page text (search snippets of listing and locality pages):
//    "<locality> has <N>+ 2 BHK rental properties available", society names
//    ("Axis Vistas", "Sandhya Nilayam"), "Contact Owner" (phone hidden until
//    reveal), "Listed by Broker", "Top Societies in your Search", and services
//    "Packers and Movers", "Rental Agreement", "Legal Services".
//  - Housing.com page text: society/locality overview pages
//    "<society>, <locality>, <city>", "<N> Properties for Sale", "No Brokerage
//    (<N> properties)", "Posted By Agents/Owners/Developers".
//  - Terms clauses for both could NOT be fetched this run -> recorded as
//    unverified in the report; policy default stays tier C.
//
// Rules: every field value is copied verbatim from page text or the search
// snippet with its source URL; anything the page does not show stays missing
// (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const NOBROKER_CHANNEL_ID = "nobroker"; // matches india-sources.json registry data (L41)
export const NOBROKER_SITES = ["nobroker.in", "housing.com"] as const;
const MAX_TEXT = 20000;
// "many rental listings" bar: a locality/society page showing at least this
// many rentals is treated as high-volume (fixtures set the bar).
export const MANY_RENTAL_LISTINGS_THRESHOLD = 10;

export type NobrokerFields = {
  name?: string;
  locality?: string;
  societyNames?: string;
  listingCount?: number;
  ownerAssistedListings?: number;
  agentAssistedListings?: number;
  services?: string;
  phone?: string;
};

// ---- parser: only exact matches become fields --------------------------------

const URL_RE = /https?:\/\/(?:www\.)?(?:nobroker\.in|housing\.com)\/[^\s"'<>]+/i;
const PHONE_RE = /(?:\+91[-\s]?)?(?:[6-9]\d{9}|[6-9]\d{4}[-\s]?\d{5})\b/;
const INJECTION_NEVER_COPY = /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)/i;
// NoBroker robots.txt disallows these paths for User-agent:*; skip them.
const NON_BUSINESS_PATH_RE = /nobroker\.in\/(?:property\/listing\/|api|profile|user|v1|static|search-hs|support)/i;
// Phone reveal controls: the page hides the number behind these, so it is missing.
const PHONE_HIDDEN_RE = /\bContact (?:Owner|Seller|Agent|Builder)\b|\bShow (?:Number|Contact|Phone)\b|Log ?in to (?:view|see|contact)|View (?:Number|Contact)/i;

function num(s?: string): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(String(s).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a NoBroker / Housing.com listing, society or locality page (or a
 *  search snippet block) into fields. Every value is a verbatim copy from the
 *  text; anything unmatched stays undefined (never inferred). */
export function parseNobrokerPage(text: string): NobrokerFields {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const kept = lines.filter((l) => !INJECTION_NEVER_COPY.test(l));
  const clean = kept.join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const f: NobrokerFields = {};

  const label = (re: RegExp): string | undefined => {
    const line = kept.find((l) => re.test(l));
    return line?.replace(re, "").trim() || undefined;
  };

  f.name = label(/^Name\s*[:：]\s*/);
  f.locality = label(/^(?:Localit(?:y|ies)|Area)\s*[:：]\s*/);
  f.societyNames = label(/^(?:Societ(?:y|ies)|Society\s+Name)\s*[:：]\s*/);

  // listing count: "<N>+ ... properties/listings/rentals".
  f.listingCount = num(flat.match(/([\d,]{1,9})\+?\s+(?:properties|rental properties|rentals|listings|apartments|flats)\b/i)?.[1]);

  // owner-assisted listing count: explicit label, or the "No Brokerage (<N> properties)" marker.
  const ownerRaw =
    flat.match(/Owner[- ]assisted listings?\s*[:：]?\s*([\d,]{1,9})/i)?.[1] ??
    flat.match(/No Brokerage\s*\(([\d,]{1,9})\s*properties?\b/i)?.[1];
  f.ownerAssistedListings = num(ownerRaw);

  // agent-assisted listing count: explicit label, or the "Posted By Agent...(N properties)" marker.
  const agentRaw =
    flat.match(/Agent[- ]assisted listings?\s*[:：]?\s*([\d,]{1,9})/i)?.[1] ??
    flat.match(/Posted By Agents?[^.\n]{0,40}\(([\d,]{1,9})\s*properties?\b/i)?.[1];
  f.agentAssistedListings = num(agentRaw);

  // services offered: an explicit "Services:" label, else the literal service names.
  const svcLine = kept.find((l) => /^Services?\s*[:：]\s*\S/i.test(l));
  if (svcLine) {
    f.services = svcLine.replace(/^Services?\s*[:：]\s*/i, "").trim();
  } else {
    const found: string[] = [];
    if (/Packers?\s*(?:and|&)\s*Movers/i.test(clean)) found.push("Packers and Movers");
    if (/\bLegal Services?\b/i.test(clean)) found.push("Legal Services");
    if (/\b(?:Rental|Rent) Agreement\b/i.test(clean)) found.push("Rental Agreement");
    if (found.length) f.services = found.join(", ");
  }

  // phone: only when the page actually shows digits (a reveal control means hidden).
  if (!PHONE_HIDDEN_RE.test(clean)) {
    const phoneLine = kept.find((l) => /^(?:Phone|Mobile|Contact Number)\s*[:：]\s*\+?\d/.test(l));
    const phone = phoneLine?.replace(/^(?:Phone|Mobile|Contact Number)\s*[:：]\s*/, "").trim() ?? flat.match(PHONE_RE)?.[0];
    if (phone) f.phone = phone.replace(/[,;]$/, "").trim();
  }
  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids over parsed fields + raw text (CONTRACT.md SIGNALS):
 *  independent-broker, thin-online-presence, many-rentals-no-followup. */
export function nobrokerSignals(f: NobrokerFields, text: string = ""): string[] {
  const out: string[] = [];
  const clean = String(text ?? "");

  // an independent broker/agent competing with the platform (or an agent-assisted listing).
  if (
    /\bindependent (?:broker|agent)\b|\bListed by Broker\b|posted by (?:a )?broker|\bbroker\b/i.test(clean) ||
    f.agentAssistedListings !== undefined
  ) {
    out.push("independent-broker");
  }

  // thin online presence: no external website link anywhere (nobroker/housing links do not count).
  if (!/https?:\/\/(?![^\s"'<>,)]*(?:nobroker\.in|housing\.com))[^\s"'<>,)]+/i.test(clean)) {
    out.push("thin-online-presence");
  }

  // many rental listings with no lead follow-up system.
  const rental = /\brent(?:al|als|ing)?\b/i.test(clean);
  const count = f.listingCount ?? f.ownerAssistedListings ?? f.agentAssistedListings;
  const hasFollowup =
    /\b(?:enquire now|enquiry now|contact now|call now|book (?:a )?(?:visit|site visit)|schedule (?:a )?(?:visit|site visit)|responds? (?:in|within)|response rate|lead(?:s)? (?:management|follow)|follow[- ]?up)\b/i.test(clean);
  if (rental && typeof count === "number" && count >= MANY_RENTAL_LISTINGS_THRESHOLD && !hasFollowup) {
    out.push("many-rentals-no-followup");
  }

  return [...new Set(out)];
}

// ---- helpers ----------------------------------------------------------------

/** Which platform a URL belongs to ("nobroker" | "housing"). */
export function platformFromUrl(url: string): string {
  return /housing\.com/i.test(String(url ?? "")) ? "housing" : NOBROKER_CHANNEL_ID;
}

/** Search-snippet lines -> RawLead[]. A `Name: <business>` line names the next
 *  listing URL (verbatim); otherwise the name comes from the URL slug. Lines
 *  with no platform URL, or robots-disallowed paths, skip. */
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
    const m = line.match(URL_RE);
    if (!m) continue;
    const url = m[0].replace(/[\s,.;]+$/, "");
    if (NON_BUSINESS_PATH_RE.test(url)) continue;
    const name = pendingName ?? nameFromUrl(url);
    pendingName = undefined;
    if (!name) continue;
    leads.push({
      name,
      category,
      source: platformFromUrl(url),
      sourceUrl: url,
      ...(line.match(PHONE_RE) ? { phone: line.match(PHONE_RE)![0].trim() } : {}),
    });
  }
  return leads;
}

function nameFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
    let seg: string;
    if (/housing\.com/i.test(url)) {
      // housing society URL: "<society>-<locality>-<city>-overview-P<hash>"
      seg = path.split("/")[0];
      seg = seg.replace(/-overview-[A-Za-z0-9]+$/i, "");
    } else {
      // nobroker listing URL: "/property/<slug>/<hash>/detail"
      const parts = path.split("/");
      seg = parts[0] === "property" ? (parts[1] ?? parts[0]) : parts[0];
    }
    const name = seg.replace(/-/g, " ").replace(/\s+/g, " ").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

function statusText(): { enabled: boolean; why?: string } {
  if (tierCEnabled()) return { enabled: true };
  if (process.env.LEADSCOUT_BROWSER === "1") {
    return { enabled: true }; // operator-approved read mode on the operator's own browser
  }
  return {
    enabled: false,
    why: "tier C (NoBroker robots.txt disallows /property/listing/, /api/, /profile/, /user/; "
      + "Housing.com robots.txt GET returned HTTP 406 on 2026-10-09 and terms are unverified; "
      + `both tier C in india-sources.json): LEADSCOUT_INDIA_TIER_C is `
      + `"${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off (absent and =0 both mean off); `
      + "the operator-approved browser-read fallback is also off (LEADSCOUT_BROWSER is not 1)",
  };
}

// ---- the adapter ------------------------------------------------------------

export const nobroker: ChannelAdapter = {
  id: NOBROKER_CHANNEL_ID,
  name: "NoBroker / Housing.com",
  tier: "C", // india-sources.json (L41): both channels tier C
  categories: ["real-estate", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    const leads: RawLead[] = [];
    // One search per platform, read order per the contract: search first.
    for (const site of NOBROKER_SITES) {
      if (leads.length >= limit) break;
      const read = await readWithFallback(deps, {
        searchQuery: `site:${site} "${q.category}" ${loc}`.trim(),
      });
      const text = sanitizeUntrusted(read.text);
      leads.push(...resultsToLeads(text, q.category, limit - leads.length));
    }
    return leads;
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    const site = platformFromUrl(lead.sourceUrl) === "housing" ? "housing.com" : "nobroker.in";
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `site:${site} "${lead.name}" ${lead.city ?? ""}`.trim(),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: NOBROKER_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = parseNobrokerPage(text);
    return {
      channel: NOBROKER_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals: nobrokerSignals(fields as NobrokerFields, text),
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => nobrokerSignals(parseNobrokerPage(text), text),
};

registerChannel(nobroker);
