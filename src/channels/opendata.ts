// ChannelAdapter for official and open data (Order L70-ch-opendata).
//
// Covers: data.gov.in Udyam MSME datasets (CSV download / dataset API),
// public MCA company master data pages, FSSAI FoSCoS licence lookup, state
// shops-and-establishments / trade licence lists, and chamber / trade
// association member directories. OFF by default; enabled ONLY by env
// LEADSCOUT_OPENDATA_ENABLED=1.
//
// Verification done by web search/fetch on 2026-10-13 (see report):
//  - CONFIRMED: data.gov.in "UDYAM Registration (MSME Registration)" catalog
//    page exists (district-wise CSV downloads, Data API, updated 25/09/2026)
//    and content is under the Government Open Data License - India.
//    Whether the Data API works with NO key is UNVERIFIED (examples carry an
//    api-key param), so the adapter reads via search/page/browser only.
//  - CONFIRMED: udyamregistration.gov.in has public product/activity MSME unit
//    search pages (SearchRegistration.aspx / SearchRegDetail.aspx).
//  - CONFIRMED: FoSCoS FBO/licence search forms (foscos.fssai.gov.in) carry a
//    Captcha on every search -> never solved or bypassed; needs-human.
//  - UNVERIFIED live: exact MCA master-data page structure and terms, GST
//    portal captcha wording, any single national shops/trade-licence search
//    domain, chamber directory coverage. Recorded as unverified in the report.
//
// Rules: every field value is copied verbatim from page text or a search
// snippet with its source URL; a value the page does not show stays missing
// (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted plus a local injection-line filter, and evidence is
// marked untrusted: true. Read order per page is search -> plain page read ->
// browser reader only when both are blocked (403/429/captcha/empty body);
// a login wall / captcha becomes needs-human evidence and is never solved.
// GST taxpayer search is captcha-gated: the adapter never attempts it beyond
// the normal read chain and returns needs-human with the portal URL; an
// operator-pasted result is accepted via verifyBusiness(lead, deps, { pastedText }).
// Per-platform browser caps/pauses are enforced inside browser.ts; the adapter
// performs a bounded number of reads (one search per source site in discovery,
// a single readWithFallback in enrich) and never re-reads a blocked page.
import { sanitizeUntrusted } from "../reach.js";
import { BrowserBlockedError } from "./types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "./types.js";
import type { RawLead } from "../types.js";
import { readWithFallback, registerChannel } from "./registry.js";
import type { FallbackRead } from "./registry.js";

export const OPENDATA_CHANNEL_ID = "opendata";
export const OPENDATA_ENV = "LEADSCOUT_OPENDATA_ENABLED";
export const GST_PORTAL_URL = "https://www.gst.gov.in/";
const MAX_TEXT = 20000;

export type OpenDataSource = { id: string; label: string; site: string; url: string };

export const OPENDATA_SOURCES: OpenDataSource[] = [
  {
    id: "udyam-data-gov-in",
    label: "Udyam MSME registered units (data.gov.in open dataset, GODL-India)",
    site: "data.gov.in",
    url: "https://www.data.gov.in/catalog/udyam-registration-msme-registration",
  },
  {
    id: "udyam-portal",
    label: "Udyam Registration portal MSME unit search",
    site: "udyamregistration.gov.in",
    url: "https://udyamregistration.gov.in/SearchRegistration.aspx",
  },
  {
    id: "mca",
    label: "MCA company master data (public pages; structure/terms unverified)",
    site: "mca.gov.in",
    url: "https://www.mca.gov.in/",
  },
  {
    id: "fssai",
    label: "FSSAI FoSCoS licence lookup (search forms are captcha-gated)",
    site: "foscos.fssai.gov.in",
    url: "https://foscos.fssai.gov.in/",
  },
  {
    id: "shops-trade-licence",
    label: "State shops-and-establishments / trade licence lists (no single national search; unverified scope)",
    site: "",
    url: "search:state shops establishment trade licence",
  },
  {
    id: "chamber",
    label: "Chamber / trade association member directories (unverified coverage)",
    site: "",
    url: "search:chamber trade association member directory",
  },
  {
    id: "gst",
    label: "GST taxpayer search (captcha-gated; needs-human, never solved)",
    site: "gst.gov.in",
    url: GST_PORTAL_URL,
  },
];

/** Source sites with a real searchable domain (used for `site:` discovery). */
export const OPENDATA_SEARCH_SITES = OPENDATA_SOURCES.filter((s) => s.site !== "").map((s) => s.site);

export type OpenDataFields = {
  registeredName?: string;
  registrationNumber?: string;
  state?: string;
  district?: string;
  activityCode?: string;
  registrationDate?: string;
  sizeBand?: string;
  address?: string;
};

export type OpenDataSourceCheck = {
  source: string;
  label: string;
  listed: boolean;
  url: string;
  evidence?: string;
  note?: string;
  untrusted: true;
};

// ---- helpers ---------------------------------------------------------------

const INJECTION_NEVER_COPY =
  /ignore (all )?(the )?previous|system prompt|you are now|disregard (all )?(the )?(above|previous)|reveal your|new instructions/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Trimmed non-empty lines with instruction-like text removed (injected text
 *  is data, never instructions; reach.sanitizeUntrusted already strips most). */
function cleanLines(text: string): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !INJECTION_NEVER_COPY.test(l));
}

function labelValue(lines: string[], labels: string[]): string | undefined {
  for (const label of labels) {
    const esc = escapeRegExp(label);
    const re = new RegExp(`^${esc}\\s*[:\uFF1A]\\s*\\S`, "i");
    const strip = new RegExp(`^${esc}\\s*[:\uFF1A]\\s*`, "i");
    const line = lines.find((l) => re.test(l));
    if (line) {
      const v = line.replace(strip, "").trim();
      if (v) return v;
    }
  }
  return undefined;
}

function registrationYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = String(raw).match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : undefined;
}

function evidenceLine(text: string, name: string, maxLen = 300): string | undefined {
  const low = String(name).toLowerCase();
  for (const l of String(text ?? "").split(/\r?\n/)) {
    if (l.toLowerCase().includes(low) && l.trim() !== "") return l.trim().slice(0, maxLen);
  }
  return undefined;
}

// ---- page / snippet parser -------------------------------------------------

/** Parse an official-record page (or snippet block) into fields. Every value
 *  is a verbatim copy from a labelled line; anything unmatched stays
 *  undefined (the key is left absent, never invented). */
export function parseOpenDataPage(text: string): OpenDataFields {
  const lines = cleanLines(sanitizeUntrusted(text));
  const f: OpenDataFields = {};
  const v = (labels: string[]): string | undefined => labelValue(lines, labels);
  const registeredName = v(["Registered Name", "Enterprise Name", "Unit Name", "Company Name", "Name of Enterprise", "Trade Name", "FBO Name"]);
  if (registeredName !== undefined) f.registeredName = registeredName;
  const registrationNumber = v([
    "Udyam Registration Number",
    "Registration Number",
    "URN",
    "CIN",
    "FSSAI Lic No",
    "Licence No",
    "License No",
    "Certificate No",
    "Registration No",
  ]);
  if (registrationNumber !== undefined) f.registrationNumber = registrationNumber;
  const state = v(["State"]);
  if (state !== undefined) f.state = state;
  const district = v(["District"]);
  if (district !== undefined) f.district = district;
  const activityCode = v([
    "NIC Code",
    "Activity Code",
    "Activity / NIC",
    "National Industrial Classification",
    "Product/Activity",
    "Kind of Business",
    "NIC",
  ]);
  if (activityCode !== undefined) f.activityCode = activityCode;
  const registrationDate = v(["Registration Date", "Date of Registration", "Date of Incorporation", "Incorporated On", "Registered On"]);
  if (registrationDate !== undefined) f.registrationDate = registrationDate;
  const sizeBand = v(["Size Band", "Enterprise Category", "Enterprise Type", "Enterprise Class"]);
  if (sizeBand !== undefined) f.sizeBand = sizeBand;
  const address = v(["Registered Address", "Unit Address", "Official Address", "Premises Address", "Address"]);
  if (address !== undefined) f.address = address;
  return f;
}

// ---- signals ---------------------------------------------------------------

export type OpenDataSignalOpts = { now?: () => number };

/** Stable signal ids over parsed fields + raw text:
 *  - registered-recently: registration year within the last 2 calendar years.
 *  - registered-no-web-presence: a registration exists AND the text says no
 *    web presence/website was found AND no URL appears in the text.
 *  - activity-code-match: an activity/NIC code is present AND the text
 *    explicitly records that it matches the brief (operator/brief note). A
 *    bare NIC code never counts as a match.
 *  - size-band-fit: a size band is present AND the text explicitly records
 *    that it fits the brief. A bare size band never counts as a fit. */
export function opendataSignals(fields: OpenDataFields, text: string, opts: OpenDataSignalOpts = {}): string[] {
  const out: string[] = [];
  const t = sanitizeUntrusted(text);
  const fullYear = new Date((opts.now ?? Date.now)()).getFullYear();
  const year = registrationYear(fields.registrationDate);
  if (year !== undefined && year >= fullYear - 2) out.push("registered-recently");
  const hasReg = fields.registeredName !== undefined || fields.registrationNumber !== undefined;
  const saysNoWeb = /no (web ?presence|website)( found)?|website\s*:\s*(none|not found|absent|nil|n\/a|not available)/i.test(t);
  if (hasReg && saysNoWeb && !/https?:\/\//i.test(t)) out.push("registered-no-web-presence");
  if (fields.activityCode !== undefined && /activity[^\n]{0,100}matches brief/i.test(t)) out.push("activity-code-match");
  if (fields.sizeBand !== undefined && /size band[^\n]{0,100}fits brief/i.test(t)) out.push("size-band-fit");
  return [...new Set(out)];
}

// ---- discovery ---------------------------------------------------------------

function hostOf(url: string): string {
  return String(url).replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
}

function onKnownSite(url: string): boolean {
  const h = hostOf(url);
  return OPENDATA_SEARCH_SITES.some((d) => h === d || h.endsWith(`.${d}`));
}

function nameFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length === 0) return undefined;
    const slug = segs[segs.length - 1].replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
    return slug || undefined;
  } catch {
    return undefined;
  }
}

const URL_RE = /https?:\/\/[^\s"'<>),\]]+/gi;
const NAME_LABELS = ["Registered Name", "Enterprise Name", "Unit Name", "Company Name", "Trade Name", "FBO Name"];

/** Search-snippet text -> RawLead[]. The registered name is copied from the
 *  nearest labelled name line above each source URL (verbatim); when no label
 *  is present the URL slug is used. GST portal URLs are skipped: GST search
 *  is captcha-gated and only an operator-pasted result may verify it. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const clean = sanitizeUntrusted(text);
  const lines = clean.split(/\r?\n/);
  const leads: RawLead[] = [];
  const seen = new Set<string>();
  const nameRe = new RegExp(`^(?:${NAME_LABELS.map(escapeRegExp).join("|")})\\s*[:\uFF1A]\\s*(\\S.*)$`, "i");
  for (let i = 0; i < lines.length && leads.length < limit; i++) {
    for (const m of lines[i].matchAll(URL_RE)) {
      if (leads.length >= limit) break;
      const url = m[0].replace(/[\s,.;]+$/, "");
      if (/gst\.gov\.in/i.test(url)) continue; // captcha-gated: never auto-listed
      if (!onKnownSite(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      let name: string | undefined;
      for (let j = i; j >= Math.max(0, i - 6); j--) {
        const nm = lines[j].match(nameRe);
        if (nm && nm[1].trim()) {
          name = nm[1].trim();
          break;
        }
      }
      name = name ?? nameFromUrl(url);
      if (!name || INJECTION_NEVER_COPY.test(name)) continue;
      leads.push({ name, category, source: OPENDATA_CHANNEL_ID, sourceUrl: url });
    }
  }
  return leads;
}

// ---- verifyBusiness ----------------------------------------------------------

/** Which official sources list the business, as labelled evidence. Search
 *  text is sanitised and every check is marked untrusted. GST is always
 *  needs-human (captcha-gated, never solved): it is listed only when the
 *  operator pastes a result via opts.pastedText. State shops/trade-licence
 *  lists and chamber directories have no single national search domain, so
 *  they use a general web search and are labelled unverified scope. */
export async function verifyBusiness(
  lead: RawLead,
  deps?: ChannelDeps,
  opts: { pastedText?: string } = {},
): Promise<OpenDataSourceCheck[]> {
  const out: OpenDataSourceCheck[] = [];
  const name = String(lead.name ?? "").trim();
  const pasted = opts.pastedText !== undefined ? sanitizeUntrusted(opts.pastedText) : "";
  for (const src of OPENDATA_SOURCES) {
    if (src.id === "gst") {
      const listed = name !== "" && pasted.toLowerCase().includes(name.toLowerCase());
      out.push({
        source: src.id,
        label: src.label,
        listed,
        url: listed ? "operator-pasted" : GST_PORTAL_URL,
        ...(listed ? { evidence: evidenceLine(pasted, name) } : {}),
        note:
          "GST taxpayer search is captcha-gated; never solved or bypassed (needs-human). " +
          (listed ? "Operator pasted this result." : `Open ${GST_PORTAL_URL} and paste the result to verify.`),
        untrusted: true,
      });
      continue;
    }
    if (!deps) {
      out.push({ source: src.id, label: src.label, listed: false, url: src.url, note: "not checked: no search transport injected", untrusted: true });
      continue;
    }
    const query =
      src.site !== "" ? `site:${src.site} "${name}"` : `"${name}" ${lead.city ?? ""} ${src.id === "chamber" ? "chamber association members" : "shops establishment trade licence"}`.trim();
    try {
      const r = await deps.search(query);
      const clean = sanitizeUntrusted(r.text);
      const listed = r.ok && name !== "" && clean.toLowerCase().includes(name.toLowerCase());
      out.push({
        source: src.id,
        label: src.label,
        listed,
        url: `search:${query}`,
        ...(listed ? { evidence: evidenceLine(clean, name) } : {}),
        ...(src.site === "" ? { note: "No single national search domain for this source; general web result only (unverified scope)." } : {}),
        untrusted: true,
      });
    } catch (err) {
      out.push({ source: src.id, label: src.label, listed: false, url: `search:${query}`, note: `search failed: ${(err as Error).message}`, untrusted: true });
    }
  }
  return out;
}

// ---- status ------------------------------------------------------------------

export function opendataEnabled(): boolean {
  return process.env[OPENDATA_ENV] === "1";
}

function statusText(): { enabled: boolean; why?: string } {
  if (opendataEnabled()) return { enabled: true };
  return {
    enabled: false,
    why:
      "official and open data is OFF by default (integrations are off unless switched on). " +
      `Set ${OPENDATA_ENV}=1 to read data.gov.in Udyam datasets, the Udyam portal, public MCA pages, ` +
      `FoSCoS licence lookups, state shops/trade-licence lists and chamber directories; ` +
      `${OPENDATA_ENV} is "${String(process.env[OPENDATA_ENV] ?? "")}" (absent and 0 both mean off). ` +
      "GST and FoSCoS searches are captcha-gated and always needs-human (never solved); " +
      "browser reads obey the per-platform caps in browser.ts.",
  };
}

function needsHumanEvidence(lead: RawLead, deps: ChannelDeps, note: string): ChannelEvidence {
  return {
    channel: OPENDATA_CHANNEL_ID,
    url: lead.sourceUrl,
    fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    via: "browser",
    fields: { needsHuman: "true", note },
    signals: ["needs-human"],
    text: "",
    untrusted: true,
  };
}

// ---- the adapter ---------------------------------------------------------------

export const opendata: ChannelAdapter = {
  id: OPENDATA_CHANNEL_ID,
  name: "Official and open data",
  tier: "C",
  categories: ["any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    const leads: RawLead[] = [];
    const seen = new Set<string>();
    for (const site of OPENDATA_SEARCH_SITES) {
      if (leads.length >= limit) break;
      const query = `site:${site} "${q.category}" ${loc}`.trim();
      const read = await readWithFallback(deps, { searchQuery: query });
      const text = sanitizeUntrusted(read.text);
      for (const lead of resultsToLeads(text, q.category, limit - leads.length)) {
        if (leads.length >= limit) break;
        if (seen.has(lead.sourceUrl)) continue;
        seen.add(lead.sourceUrl);
        leads.push(lead);
      }
    }
    return leads;
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked
      // (403 / 429 / captcha / empty); browser caps enforced by browser.ts.
      const host = (() => {
        try {
          return new URL(lead.sourceUrl).hostname.replace(/^www\./, "");
        } catch {
          return "data.gov.in";
        }
      })();
      read = await readWithFallback(deps, {
        searchQuery: `site:${host} "${lead.name}" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation (includes GST and
        // FoSCoS captcha gates): never solved or bypassed -> needs-human.
        const gst = /gst\.gov\.in/i.test(lead.sourceUrl);
        return needsHumanEvidence(
          lead,
          deps,
          gst
            ? `GST taxpayer search is captcha-gated; never solved. Portal: ${GST_PORTAL_URL} . An operator may paste a result (see verifyBusiness pastedText).`
            : "Page looks like a login wall / captcha; needs-human. Never solved or bypassed.",
        );
      }
      throw err;
    }
    const text = sanitizeUntrusted(read.text);
    if (/gst\.gov\.in/i.test(lead.sourceUrl) && /captcha/i.test(text)) {
      // A GST captcha page that came back as normal text (e.g. a browser that
      // did not throw): still needs-human, never solved.
      return needsHumanEvidence(
        lead,
        deps,
        `GST taxpayer search is captcha-gated; never solved. Portal: ${GST_PORTAL_URL} . An operator may paste a result (see verifyBusiness pastedText).`,
      );
    }
    const parsed = parseOpenDataPage(text);
    const fields: Record<string, string | number | undefined> = {};
    if (parsed.registeredName !== undefined) fields.registeredName = parsed.registeredName;
    if (parsed.registrationNumber !== undefined) fields.registrationNumber = parsed.registrationNumber;
    if (parsed.state !== undefined) fields.state = parsed.state;
    if (parsed.district !== undefined) fields.district = parsed.district;
    if (parsed.activityCode !== undefined) fields.activityCode = parsed.activityCode;
    if (parsed.registrationDate !== undefined) fields.registrationDate = parsed.registrationDate;
    if (parsed.sizeBand !== undefined) fields.sizeBand = parsed.sizeBand;
    if (parsed.address !== undefined) fields.address = parsed.address;
    return {
      channel: OPENDATA_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals: opendataSignals(parsed, text),
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => opendataSignals(parseOpenDataPage(text), text),
};

registerChannel(opendata);
