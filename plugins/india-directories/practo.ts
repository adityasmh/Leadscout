// ChannelAdapter for Practo (Order L46-ch-practo).
//
// Doctor and clinic listings: doctors' profiles, clinic and hospital pages.
// Tier B in india-sources.json (L41, robots.txt verified: /search disallowed;
// clinic and doctor pages crawlable; official sitemaps published), but
// Practo's own terms of use (help.practo.com terms, section 5.2, fetched
// 2026-10-07) prohibit navigating or searching the site with "any engine,
// software, tool, agent or other device or mechanism (such as spiders,
// robots, avatars or intelligent agents)". The India terms page itself did
// not render that clause this run (nav-only page; unverified), so the
// adapter is OFF by default and is switched on ONLY by env LEADSCOUT_PRACTO=1
// (operator override; not a legal permission). The injected browser reader
// (operator's own logged-in browser; data/browser-allowlist.json lists
// practo.com) is reached only through the registry's readWithFallback AFTER
// search and plain page read return blocked results (403/429/captcha/empty),
// and its per-platform hourly caps and pauses are enforced by browser.ts
// itself - the adapter never loops or re-reads a blocked page.
//
// Verified page structure (fetched 2026-10-07):
//  - doctor page (/city/doctor/slug): "<Name>", degrees, "<Speciality>,
//    <Speciality>", "<N> Years Experience Overall (N years as specialist)",
//    "<P>% (<N> patients)", clinic block "<Clinic name>", street address,
//    "<Day> time - time" timings, "₹<N>" fee, "Pick a time slot" /
//    "Clinic Appointment" booking widget, "Patient Stories" sections.
//  - clinic page (/city/clinic/slug): "<Name>, <Locality>", "<type> Clinic",
//    "<R>(<N> patient stories)", "Overview Doctors(<N>) Stories(<N>)",
//    "<Day> time - time" timings, specialists with "<N> years experience
//    overall" and "₹<N>", street address on the line above "Get Directions".
//
// Rules: every field value is copied verbatim from page text or the URL /
// search snippet with its source URL; a value the page does not show stays
// missing (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted and evidence is marked untrusted: true. The
// lead-website booking-join ("listed on Practo but own site has no booking
// widget") runs only when the enrich.ts path is available (injected fetchFn)
// and reuses enrich.ts detectSignals on the lead's own site.
import { sanitizeUntrusted } from "../../src/reach.js";
import { detectSignals } from "../../src/enrich.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const PRACTO_CHANNEL_ID = "practo"; // matches india-sources.json registry data (L41)
export const PRACTO_SITE = "practo.com";
const MAX_TEXT = 20000;
/** "<N> patient stories" at or above this is "many" (real pages verified range
 *  from a handful to several thousand; the fixture sets the bar). */
export const MANY_STORIES_THRESHOLD = 100;
export const PRACTO_ENV = "LEADSCOUT_PRACTO";

export type PractoFields = {
  name?: string;
  specialities?: string;
  experienceYears?: number;
  clinicName?: string;
  clinicAddress?: string;
  consultationFee?: number;
  rating?: number;
  patientStories?: number;
  onlineBooking?: string;
  videoConsult?: string;
  timings?: string;
};

// ---- page/snippet parser: only exact matches become fields ------------------

const PRACTO_URL_RE = /https?:\/\/(?:www\.)?practo\.com\/[^\s"'<>*]+/i;
// robots.txt disallows /search*, /share/*, /wave/*, /cerebro/*, /health/search?,
// /health/api*, /marketplace-api/*, /client-api/*, /malaysia* and appointments.
const NON_BUSINESS_PATH_RE =
  /\/(search|share|wave|cerebro|health\/|appointment|consult|marketplace-api|client-api|malaysia|kuala-lumpur)/i;
const BUSINESS_PATH_RE = /practo\.com\/[a-z-]+\/(doctor|clinic)\/|practo\.com\/c\//i;
const INJECTION_NEVER_COPY =
  /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)/i;
const FEE_RE = /₹\s?([\d,]{1,12})/;
const STORIES_RE = /([\d,]{1,12})\s+patient stories/i;
const STORIES_IN_PAREN_RE = /([\d,]{1,12})\s+patients?\s*\)/i;
const STORIES_TAB_RE = /\bStories\s*\(([\d,]{1,12})\)/i;
const RATING_WITH_STORIES_RE = /\b([0-5](?:\.\d{1,2})?)\s*\((?:[\d,]+)\s*(?:patient stories|patients)\)/i;
const EXPERIENCE_RE = /\b(\d{1,3})\s+years experience overall/i;
const EXPERIENCE_CAPS_RE = /\b(\d{1,3})\s+Years Experience Overall\b/i;
const DOCTOR_COUNT_RE = /\bDoctors\s*\((\d{1,4})\)/i;
const SPECIALIST_COUNT_RE = /\bSpecialists?\s*\((\d{1,4})\)/i;
const DOCTOR_PAGE_URL_RE = /https?:\/\/(?:www\.)?practo\.com\/[a-z-]+\/doctor\//i;
const SOCIAL_PRESENCE_RE =
  /https?:\/\/(?!.*?practo\.com)|facebook\.com|instagram\.com|linkedin\.com|twitter\.com|\bx\.com\/|youtube\.com|wa\.me/i;
const TIMING_SPAN_RE =
  /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Daily)[A-Za-z\s\-–,()]{0,40}?\d{1,2}[.:]\d{2}\s*[–-]\s*\d{1,2}[.:]\d{2}(?:\s*,\s*\d{1,2}[.:]\d{2}\s*[–-]\s*\d{1,2}[.:]\d{2})*/g;

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function firstPractoUrl(text: string): string | undefined {
  const m = String(text ?? "").match(PRACTO_URL_RE);
  return m ? m[0].replace(/[\s,.;]+$/, "") : undefined;
}

function nameFromPractoUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    if (segs.length < 2) return undefined;
    if (!["doctor", "clinic", "c"].includes(segs[1])) return undefined;
    const slug = segs[segs.length - 1];
    const name = slug.replace(/-\d+$/, "").replace(/-/g, " ").trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Parse a Practo doctor/clinic page (or a search snippet block) into
 *  fields. Every value is a verbatim copy from the text or the URL; anything
 *  unmatched stays undefined (never inferred). */
export function parsePractoPage(text: string): PractoFields {
  const raw = String(text ?? "");
  const clean = raw.split(/\r?\n/).filter((l) => !INJECTION_NEVER_COPY.test(l)).join("\n");
  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ");
  const f: PractoFields = {};

  // name: "Name:" label first, else the listing URL slug (verbatim from URL).
  const nameLine = clean.split(/\r?\n/).map((l) => l.trim())
    .find((l) => /^Name\s*[:：]\s*\S/.test(l));
  f.name = nameLine?.replace(/^Name\s*[:：]/, "").trim() ?? undefined;
  if (f.name === undefined) f.name = nameFromPractoUrl(firstPractoUrl(clean));

  // specialities: only an explicit label line, never guessed from nearby text.
  const specLine = clean.split(/\r?\n/).map((l) => l.trim())
    .find((l) => /^Specialit(?:ies|isations)\s*[:：]\s*\S/i.test(l));
  if (specLine) f.specialities = specLine.replace(/^Specialit(?:ies|isations)\s*[:：]\s*/i, "").trim();

  // experience years: "34 years experience overall" / "43 Years Experience Overall".
  const years = num(EXPERIENCE_RE.exec(flat)?.[1]) ?? num(EXPERIENCE_CAPS_RE.exec(flat)?.[1]);
  if (years !== undefined) f.experienceYears = years;

  // clinic name: doctor-page Q&A ("practices at <Clinic> - <Area>"), a
  // "Clinic:" label line, else the slug of a clinic page URL.
  const practices = flat.match(/\bpractices at\s+([^-–\n]{2,80}?)\s+(?:[-–])\s/);
  if (practices) f.clinicName = practices[1].trim();
  const clinicLine = clean.split(/\r?\n/).map((l) => l.trim())
    .find((l) => /^Clinic\s*[:：]\s*\S/i.test(l));
  if (clinicLine) f.clinicName = clinicLine.replace(/^Clinic\s*[:：]\s*/i, "").trim();
  if (f.clinicName === undefined) {
    const url = firstPractoUrl(clean);
    if (url && /(clinic|\/c\/)/i.test(url)) f.clinicName = nameFromPractoUrl(url);
  }

  // clinic address: "Address:" label, else the line right before "Get
  // Directions" (the verified real-page style) when it looks like an address.
  const addrLine = clean.split(/\r?\n/).map((l) => l.trim())
    .find((l) => /^Address\s*[:：]\s*\S/i.test(l));
  if (addrLine) {
    f.clinicAddress = addrLine.replace(/^Address\s*[:：]\s*/i, "").trim();
  } else {
    const lines = clean.split(/\r?\n/).map((l) => l.trim());
    for (let i = 1; i < lines.length; i++) {
      if (/^Get\s*Directions\b/i.test(lines[i])) {
        const prev = lines[i - 1];
        if (/\d|Landmark/i.test(prev) && prev.includes(",") && !/https?:/.test(prev)) {
          f.clinicAddress = prev;
          break;
        }
      }
    }
  }

  // consultation fee: "₹<N>" / "₹ <N>" — the rupee sign is part of the page.
  const fee = num(FEE_RE.exec(flat)?.[1]);
  if (fee !== undefined) f.consultationFee = fee;

  // rating: a 0-5 star value shown right next to the patient-story count
  // ("4.0(1687 patient stories)"). A bare "72% (25 patients)" is a
  // recommendation percentage, not a star rating - rating stays missing.
  const rating = RATING_WITH_STORIES_RE.exec(flat)?.[1];
  if (rating !== undefined) {
    const n = Number(rating);
    if (Number.isFinite(n) && n > 0 && n <= 5) f.rating = n;
  }

  // patient stories count, in any of the verified styles.
  const stories =
    num(STORIES_RE.exec(flat)?.[1])
    ?? num(STORIES_TAB_RE.exec(flat)?.[1])
    ?? num(STORIES_IN_PAREN_RE.exec(flat)?.[1]);
  if (stories !== undefined) f.patientStories = stories;

  // online booking / video consult: explicit page markers only.
  if (/\bbook appointment online\b|\bbook clinic visit\b|\bbook online\b|\bbook appointment\b|\bpick a time slot\b|\binstant[\s-]?book\b|\bonline booking\b/i.test(flat)) {
    f.onlineBooking = "yes";
  }
  if (/video consult/i.test(flat)) f.videoConsult = "yes";

  // timings: "<Day> ... HH:MM - HH:MM" spans, verbatim; joined when several.
  const spans = [...flat.matchAll(TIMING_SPAN_RE)].map((m) => m[0].trim()).filter(Boolean);
  if (spans.length) f.timings = spans.join(" | ");
  return f;
}

// ---- practice size and signals ---------------------------------------------

/** "solo-practitioner" vs "multi-doctor-clinic" from the verified count
 *  markers only: a "<N> doctors" establishment marker, the "Doctors(<N>)" /
 *  "Specialists(<N>)" tab count, or a doctor-profile URL (one practitioner's
 *  own page). Never inferred from names or photos. */
export function practiceSize(text: string, sourceUrl?: string): string | undefined {
  const m = DOCTOR_COUNT_RE.exec(String(text ?? ""))
    ?? SPECIALIST_COUNT_RE.exec(String(text ?? ""));
  const n = num(m?.[1]);
  if (n !== undefined) return n >= 2 ? "multi-doctor-clinic" : "solo-practitioner";
  if (sourceUrl && DOCTOR_PAGE_URL_RE.test(sourceUrl)) return "solo-practitioner";
  return undefined; // clinic page without a doctor count: never inferred
}

function lowOnlinePresence(text: string): boolean {
  return !SOCIAL_PRESENCE_RE.test(String(text ?? ""));
}

/** Stable signal ids over parsed fields + raw text + (when the enrich.ts
 *  path is available) the lead's own-site enrich.ts signals. Signal ids:
 *  practo-no-own-booking, many-stories-low-presence, solo-practitioner,
 *  multi-doctor-clinic, no-whatsapp-contact. */
export function practoSignals(
  f: PractoFields,
  text: string = "",
  opts: { siteSignalIds?: string[]; sourceUrl?: string } = {},
): string[] {
  const out: string[] = [];
  const size = practiceSize(text, opts.sourceUrl);
  if (size === "solo-practitioner") out.push("solo-practitioner");
  if (size === "multi-doctor-clinic") out.push("multi-doctor-clinic");
  // fired ONLY when enrich.ts results exist (the lead-site join is fed by
  // enrich.ts detectSignals through the injected fetchFn transport).
  if (opts.siteSignalIds?.includes("no-online-booking")) out.push("practo-no-own-booking");
  if (
    typeof f.patientStories === "number" && f.patientStories >= MANY_STORIES_THRESHOLD
    && lowOnlinePresence(text)
  ) out.push("many-stories-low-presence");
  if (!/whatsapp|wa\.me|api\.whatsapp/i.test(String(text ?? ""))) out.push("no-whatsapp-contact");
  return [...new Set(out)];
}

// ---- discovery ---------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. Name comes from the listing URL slug;
 *  lines with no Practo listing URL (or non-business paths) skip. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const url = firstPractoUrl(line);
    if (!url || NON_BUSINESS_PATH_RE.test(url) || !BUSINESS_PATH_RE.test(url)) continue;
    const name = nameFromPractoUrl(url);
    if (!name) continue;
    leads.push({
      name,
      category,
      source: PRACTO_CHANNEL_ID,
      sourceUrl: url,
    });
  }
  return leads;
}

// ---- status and env gate -----------------------------------------------------

export function practoEnabled(): boolean {
  return process.env[PRACTO_ENV] === "1";
}

function statusText(): { enabled: boolean; why?: string } {
  if (practoEnabled()) return { enabled: true };
  return {
    enabled: false,
    why: "Practo's terms of use (help.practo.com, 5.2, fetched 2026-10-07) prohibit navigating or "
      + "searching the site with agents/robots; this adapter stays OFF by default. LEADSCOUT_PRACTO is "
      + `"${String(process.env[PRACTO_ENV] ?? "")}" (absent and 0 both mean off); set LEADSCOUT_PRACTO=1 `
      + "for the operator override (not a legal permission)",
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

export const practo: ChannelAdapter = {
  id: PRACTO_CHANNEL_ID,
  name: "Practo",
  tier: "B", // india-sources.json (L41): tier B, robots verified; terms gate the default off
  categories: ["dentist", "clinic", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    // read order, per the contract: search first (cheapest). Query matches
    // the india-sources.json (L41) template: site:practo.com "cat" "loc".
    const read = await readWithFallback(deps, {
      searchQuery: `site:${PRACTO_SITE} "${q.category}" "${loc}"`,
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
        searchQuery: `site:${PRACTO_SITE} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: PRACTO_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = { ...parsePractoPage(text) };
    const siteSignalIds = await leadSiteSignalIds(lead, deps);
    const signals = practoSignals(fields as PractoFields, text, { siteSignalIds, sourceUrl: lead.sourceUrl });
    return {
      channel: PRACTO_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => practoSignals(parsePractoPage(text), text),
};

registerChannel(practo);
