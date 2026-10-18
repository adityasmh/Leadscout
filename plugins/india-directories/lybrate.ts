// ChannelAdapter for Lybrate (Order L61-ch-lybrate).
//
// Doctor and clinic listings: doctors' profiles and clinic pages.
// Tier C in india-sources.json (L41): robots.txt fetched 2026-10-07 disallows
// /search* and /w-api/* (plus /t/*, /hs/*, /json/*, /goodkart/*, /cgi-bin/,
// /admin/, /consult-privately/doctor/*), while doctor and clinic profile pages
// are crawlable; the terms page was not found this run, so the adapter is OFF
// by default and switched on ONLY by env LEADSCOUT_LYBRATE=1 (operator
// override; not a legal permission). The injected browser reader (operator's
// own logged-in browser; data/browser-allowlist.json lists lybrate.com) is
// reached only through the registry's readWithFallback AFTER search and the
// plain page read return blocked results (403/429/captcha/empty), and its
// per-platform hourly caps and pauses are enforced by browser.ts itself - the
// adapter never loops or re-reads a blocked page.
//
// Verified page structure (fetched 2026-10-07):
//  - clinic page (/<city>/clinic/<slug>): "<Clinic name>", clinic type line
//    ("Dental Clinic"), street address with "Landmark:", rating + "<N> Doctor"
//    (e.g. "4.3" then "1 Doctor"), "<₹ 200 at clinic>", "Book Appointment",
//    "No Booking Fee", "Call Clinic", "Clinic Timing", "Doctor in <clinic>",
//    "<Doctor name>", "<speciality>", "Submit Feedback".
//  - doctor page (/<city>/doctor/<slug>): "<Dr. name>", "<speciality>",
//    "<city>", "₹ 200 at clinic", "Doctor Information", "Speciality",
//    "Other treatment areas", "Languages spoken", "Clinic Location <address>",
//    "Clinic of <doctor>", "Clinic's Name", "Fees", "<clinic name>", "₹ 200",
//    "Book Clinic Appointment with <doctor>".
//  - experience years were not rendered on the two pages fetched this run
//    (recorded as unverified; the parser only extracts an explicit
//    "N years experience" / "Experience: N years" marker).
//
// Rules: every field value is copied verbatim from page text or the URL /
// search snippet with its source URL; a value the page does not show stays
// missing (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { detectSignals } from "../../src/enrich.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const LYBRATE_CHANNEL_ID = "lybrate"; // matches india-sources.json registry data (L41)
export const LYBRATE_SITE = "lybrate.com";
export const LYBRATE_ENV = "LEADSCOUT_LYBRATE";
const MAX_TEXT = 20000;

export type LybrateFields = {
  name?: string;
  speciality?: string;
  experienceYears?: number;
  clinicName?: string;
  clinicAddress?: string;
  fee?: number;
  rating?: number;
  reviews?: number;
  phone?: string;
  onlineConsult?: string;
};

export type CrossPlatformInfo = { phone?: string; address?: string };

// ---- page/snippet parser: only exact matches become fields ------------------

const LYBRATE_URL_RE = /https?:\/\/(?:www\.)?lybrate\.com\/[^\s"'<>*]+/i;
// robots.txt disallows /search*, /w-api/*, /t/*, /hs/*, /json/*, /goodkart/*,
// /cgi-bin/, /admin/, /icons/ and /consult-privately/doctor/*.
const NON_BUSINESS_PATH_RE =
  /\/(search|w-api|t|hs|json|goodkart|cgi-bin|admin|icons|health-feed|consult-privately)\b/i;
// doctor and clinic profile pages: /<city>/doctor|clinic/<slug>, plus legacy /doctor/<slug>.
const BUSINESS_PATH_RE = /lybrate\.com\/(?:[a-z0-9-]+\/)?(?:doctor|clinic)\//i;
const DOCTOR_PAGE_URL_RE = /lybrate\.com\/(?:[a-z0-9-]+\/)?doctor\//i;
const INJECTION_NEVER_COPY =
  /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)/i;

const FEE_RE = /₹\s?([\d,]{1,12})/;
const REVIEWS_RE = /([\d,]{1,9})\s*(?:reviews?|feedbacks?|patient stories|ratings?)\b/i;
const REVIEWS_LABEL_RE = /\b(?:Reviews?|Feedbacks?|Ratings?)\s*[:：]\s*([\d,]{1,9})\b/i;
const RATING_LABEL_RE = /\bRating\s*[:：]\s*([0-5](?:\.\d{1,2})?)/i;
const RATING_WITH_COUNT_RE = /\b([0-5]\.\d{1,2})\s*\(?\s*[\d,]{1,9}\s*(?:reviews?|feedbacks?|patient stories|ratings?)/i;
const RATING_BARE_RE = /\b([0-5]\.\d{1,2})\b(?=\s*(?:₹|\d+\s*Doctors?\b))/i;
const EXPERIENCE_RE = /\b(\d{1,3})\s*\+?\s*(?:years?|yrs?)[ .]*(?:of\s+)?experience\b/i;
const EXPERIENCE_LABEL_RE = /\bExperience\s*[:：]\s*(\d{1,3})\s*(?:years?|yrs?)?/i;
const PHONE_LABEL_RE = /\b(?:Phone|Contact|Mobile|Call)\s*[:：]?\s*(\+?\d[\d\s()-]{7,15}\d)/i;
const SPECIALITY_LABEL_RE = /\bSpecialit(?:y|ies)\s*[:：]\s*([^\n]{1,80})/i;
const SPECIALITY_GENERIC_RE =
  /\bSpecialit(?:y|ies)\s*[:：]?\s*([A-Z][A-Za-z &/-]{2,60}?)(?=\s*(?:Other treatment|Languages spoken|Clinic Location|Clinic of|Clinic's Name|Fees|Doctor Information|₹|$))/i;
const CLINIC_NAME_LABEL_RE = /\bClinic(?:'s)?\s*Name\s*[:：]\s*([^\n]{2,80})/i;
const CLINIC_NAME_SHORT_RE = /\bClinic\s*[:：]\s*([^\n]{2,80})/i;
const ADDRESS_LOCATION_RE =
  /\bClinic Location\s*[:：]?\s*([^\n]{5,140}?)(?=\s*(?:Clinic of|Clinic's Name|Get Help|Book |Fees|Services|Submit|$))/i;
const TIMING_SPAN_RE =
  /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Daily)[a-z\s\-–,()]{0,40}?\d{1,2}(?:[:.]\d{2})?\s*(?:AM|PM)?\s*[-–]\s*\d{1,2}(?:[:.]\d{2})?\s*(?:AM|PM)?/gi;

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function firstLybrateUrl(text: string): string | undefined {
  const m = String(text ?? "").match(LYBRATE_URL_RE);
  return m ? m[0].replace(/[\s,.;]+$/, "") : undefined;
}

function nameFromLybrateUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    if (segs.length < 2) return undefined;
    if (!["doctor", "clinic"].includes(segs[1]) && !["doctor", "clinic"].includes(segs[0])) return undefined;
    const slug = segs[segs.length - 1];
    const name = slug.replace(/-\d+$/, "").replace(/-/g, " ").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Parse a Lybrate doctor/clinic page (or a search snippet block) into fields.
 *  Every value is a verbatim copy from the text or the URL; anything unmatched
 *  stays undefined (never inferred). */
export function parseLybratePage(text: string): LybrateFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const lines = clean.split(/\r?\n/).map((l) => l.trim());
  const f: LybrateFields = {};

  // name: "Name:" label first, else the listing URL slug (verbatim from URL).
  const nameLine = lines.find((l) => /^Name\s*[:：]\s*\S/.test(l));
  f.name = nameLine?.replace(/^Name\s*[:：]\s*/, "").trim() ?? undefined;
  if (f.name === undefined) f.name = nameFromLybrateUrl(firstLybrateUrl(clean));

  // speciality: explicit label, else the flattened "Speciality<Value>" marker.
  const specLine = lines.find((l) => /^Specialit(?:y|ies)\s*[:：]\s*\S/i.test(l));
  if (specLine) f.speciality = specLine.replace(/^Specialit(?:y|ies)\s*[:：]\s*/i, "").trim();
  if (f.speciality === undefined) {
    const m = SPECIALITY_LABEL_RE.exec(flat) ?? SPECIALITY_GENERIC_RE.exec(flat);
    if (m) f.speciality = m[1].trim();
  }

  // experience years: only an explicit "N years experience" marker.
  const years = num(EXPERIENCE_RE.exec(flat)?.[1]) ?? num(EXPERIENCE_LABEL_RE.exec(flat)?.[1]);
  if (years !== undefined) f.experienceYears = years;

  // clinic name: "Clinic's Name:" / "Clinic:" label, else a flattened "Clinic's Name".
  const clinicLine = lines.find((l) => /^Clinic(?:'s)?\s*Name\s*[:：]\s*\S/i.test(l))
    ?? lines.find((l) => /^Clinic\s*[:：]\s*\S/i.test(l));
  if (clinicLine) f.clinicName = clinicLine.replace(/^Clinic(?:'s)?\s*(?:Name)?\s*[:：]\s*/i, "").trim();
  if (f.clinicName === undefined) {
    const m = CLINIC_NAME_LABEL_RE.exec(flat) ?? CLINIC_NAME_SHORT_RE.exec(flat);
    if (m) f.clinicName = m[1].trim();
  }
  if (f.clinicName === undefined) {
    const url = firstLybrateUrl(clean);
    if (url && /\/clinic\//i.test(url)) f.clinicName = nameFromLybrateUrl(url);
  }

  // clinic address: "Address:" label, else the "Clinic Location <address>" marker.
  const addrLine = lines.find((l) => /^Address\s*[:：]\s*\S/i.test(l));
  if (addrLine) {
    f.clinicAddress = addrLine.replace(/^Address\s*[:：]\s*/i, "").trim();
  } else {
    const m = ADDRESS_LOCATION_RE.exec(flat);
    if (m) f.clinicAddress = m[1].trim();
  }

  // fee: "₹<N>" / "₹ <N>" — the rupee sign is part of the page.
  const fee = num(FEE_RE.exec(flat)?.[1]);
  if (fee !== undefined) f.fee = fee;

  // rating: "Rating: 4.3", "4.3(120 reviews)", or "4.3" next to a doctor/fee slot.
  const rating = RATING_LABEL_RE.exec(flat)?.[1]
    ?? RATING_WITH_COUNT_RE.exec(flat)?.[1]
    ?? RATING_BARE_RE.exec(flat)?.[1];
  if (rating !== undefined) {
    const n = Number(rating);
    if (Number.isFinite(n) && n > 0 && n <= 5) f.rating = n;
  }

  // review count: "120 reviews" / "Reviews: 120".
  const reviews = num(REVIEWS_RE.exec(flat)?.[1]) ?? num(REVIEWS_LABEL_RE.exec(flat)?.[1]);
  if (reviews !== undefined) f.reviews = reviews;

  // phone: explicit Phone/Contact/Mobile/Call label only (never guessed).
  const phone = PHONE_LABEL_RE.exec(flat)?.[1];
  if (phone) f.phone = phone.trim();

  // online consult flag: explicit page/heading marker only.
  if (/\bonline consult(?:ation)?\b|\bconsult online\b|\bvideo consultation\b/i.test(flat)) {
    f.onlineConsult = "yes";
  }
  return f;
}

// ---- signals ----------------------------------------------------------------

function normPhone(s: string | undefined): string {
  return String(s ?? "").replace(/\D/g, "");
}
function normAddress(s: string | undefined): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when both platforms actually show the value and they disagree: different
 *  phone digits or different normalised addresses. A value missing on either
 *  side is not a mismatch (it stays unproven). */
export function crossPlatformMismatch(a: CrossPlatformInfo, b: CrossPlatformInfo): boolean {
  const phoneDiffers =
    normPhone(a.phone) !== "" && normPhone(b.phone) !== "" && normPhone(a.phone) !== normPhone(b.phone);
  const addrDiffers =
    normAddress(a.address) !== "" && normAddress(b.address) !== "" && normAddress(a.address) !== normAddress(b.address);
  return phoneDiffers || addrDiffers;
}

export type LybrateSignalOpts = {
  siteSignalIds?: string[];
  hasWebsite?: boolean;
  practo?: CrossPlatformInfo;
  sourceUrl?: string;
};

/** Stable signal ids. Order-signals:
 *  - "lybrate-practo-mismatch": the business is on Lybrate AND Practo and the
 *    two show a different phone number or address (cross-platform data
 *    inconsistency). Fires only when both sides carry the value.
 *  - "no-own-site": the lead has no website of its own.
 *  - "no-booking-route": neither the Lybrate page nor the lead's own site
 *    (when checked through enrich.ts) offers a booking route. */
export function lybrateSignals(
  f: LybrateFields,
  text: string = "",
  opts: LybrateSignalOpts = {},
): string[] {
  const out: string[] = [];
  const flat = String(text ?? "").replace(/\r?\n/g, " ");

  const bookingHere =
    /\bbook (?:an )?appointment\b|\bbook clinic appointment\b|\bbook online\b|\bonline booking\b|\bpick a time slot\b/i.test(flat);
  // undefined = own site not checked; true = own site shows booking; false = own site has none.
  const siteBooks = opts.siteSignalIds ? !opts.siteSignalIds.includes("no-online-booking") : undefined;
  if (!bookingHere && siteBooks !== true) out.push("no-booking-route");

  if (opts.hasWebsite === false || opts.siteSignalIds?.includes("no-website")) out.push("no-own-site");

  if (opts.practo && crossPlatformMismatch({ phone: f.phone, address: f.clinicAddress }, opts.practo)) {
    out.push("lybrate-practo-mismatch");
  }
  return [...new Set(out)];
}

// ---- discovery ---------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. Name comes from the listing URL slug;
 *  lines with no Lybrate listing URL (or non-business paths) skip. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const url = firstLybrateUrl(line);
    if (!url || NON_BUSINESS_PATH_RE.test(url) || !BUSINESS_PATH_RE.test(url)) continue;
    const name = nameFromLybrateUrl(url);
    if (!name) continue;
    leads.push({
      name,
      category,
      source: LYBRATE_CHANNEL_ID,
      sourceUrl: url,
    });
  }
  return leads;
}

// ---- status and env gate -----------------------------------------------------

export function lybrateEnabled(): boolean {
  return process.env[LYBRATE_ENV] === "1";
}

function statusText(): { enabled: boolean; why?: string } {
  if (lybrateEnabled()) return { enabled: true };
  return {
    enabled: false,
    why: "Lybrate is Tier C in data/india-sources.json (L41): robots.txt fetched 2026-10-07 disallows /search* "
      + "and /w-api/* and the terms page was not found this run, so this adapter stays OFF by default. "
      + `LEADSCOUT_LYBRATE is "${String(process.env[LYBRATE_ENV] ?? "")}" (absent and 0 both mean off); set `
      + "LEADSCOUT_LYBRATE=1 for the operator override (not a legal permission)",
  };
}

// ---- lead-site join (only with the enrich.ts path, i.e. injected fetchFn) ----

/** Fetch the lead's own site through the injected fetchFn (the same transport
 *  enrich.ts takes websites through) and reuse enrich.ts detectSignals on it.
 *  Returns undefined unless enrich results are actually produced - never a
 *  guess: an unreachable site proves nothing about a booking widget. */
export async function leadSiteSignalIds(lead: RawLead, deps: ChannelDeps): Promise<string[] | undefined> {
  if (!deps.fetchFn || !lead.website) return undefined;
  try {
    const u = new URL(String(lead.website).trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    const res = await deps.fetchFn(u.toString());
    if (!res.ok) return undefined;
    const html = sanitizeUntrusted(await res.text());
    return detectSignals(html, undefined, u.toString());
  } catch {
    return undefined;
  }
}

// ---- the adapter ------------------------------------------------------------

export const lybrate: ChannelAdapter = {
  id: LYBRATE_CHANNEL_ID,
  name: "Lybrate",
  tier: "C", // india-sources.json (L41): tier C, robots verified, terms not found
  categories: ["dentist", "clinic", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    // read order, per the contract: search first (cheapest). Query matches the
    // india-sources.json (L41) template: site:lybrate.com "cat" "loc".
    const read = await readWithFallback(deps, {
      searchQuery: `site:${LYBRATE_SITE} "${q.category}" "${loc}"`,
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked
      // (403/429/captcha/empty); browser caps enforced by browser.ts.
      read = await readWithFallback(deps, {
        searchQuery: `site:${LYBRATE_SITE} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: LYBRATE_CHANNEL_ID,
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
    const parsed = parseLybratePage(text);
    const fields: Record<string, string | number | undefined> = { ...parsed };
    const siteSignalIds = await leadSiteSignalIds(lead, deps);
    const signals = lybrateSignals(parsed, text, {
      siteSignalIds,
      hasWebsite: lead.website !== undefined && lead.website !== null && String(lead.website).trim() !== "",
      sourceUrl: lead.sourceUrl,
    });
    return {
      channel: LYBRATE_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => lybrateSignals(parseLybratePage(text), text),
};

registerChannel(lybrate);
