// ChannelAdapter for LinkedIn company pages and decision makers
// (Order L52-ch-linkedin).
//
// LinkedIn is the most aggressive platform about automated access, so this
// adapter is OFF by default (registry Tier C, plus the browser kill switch) and
// every outside read goes through the registry's read chain:
//   1. search first (deps.search),
//   2. then a plain page read (deps.readPage),
//   3. then the operator's logged-in browser reader (deps.browser) ONLY when
//      both returned a blocked result (403 / 429 / captcha / empty body).
// The browser reader enforces its own per-platform hourly cap (LinkedIn 15 by
// default), the 2-6 s pause, one page at a time per platform, the needs-human
// lockout and the kill switch; this adapter adds an 8 s minimum spacing between
// its own page reads and never retries a blocked page.
//
// Hard rules obeyed here:
//   * never send a connection request or a message, never type/submit/click;
//   * never read a private profile - only company pages and public /in/ URLs
//     that appear in a search snippet or on the page itself;
//   * every value is copied verbatim from page text or a URL in a snippet with
//     its source URL; a field the page does not show stays missing (never
//     inferred);
//   * all fetched text is neutralised with reach.ts sanitizeUntrusted (injected
//     instruction lines dropped) and marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const LINKEDIN_CHANNEL_ID = "linkedin-company"; // matches data/india-sources.json (L41)
const MAX_TEXT = 20000;
const MIN_PAGE_INTERVAL_MS = 8000; // one page per 8 s, per the order
const DEFAULT_LIMIT = 20;

// Target band for the "company size band fits the target brief" signal. An
// engineering default (SME: automations/websites/AI), documented in the report;
// not a fact about any company.
export const TARGET_EMPLOYEE_MIN = 10;
export const TARGET_EMPLOYEE_MAX = 200;

const LINKEDIN_URL_RE =
  /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(company|in)\/([A-Za-z0-9_\-%.]+)/gi;

export type LinkedinFields = {
  name?: string;
  industry?: string;
  employeeRange?: string;
  headquarters?: string;
  about?: string;
  website?: string;
  followers?: number;
  recentPostDates?: string;
  hiringPosts?: string; // internal marker ("yes") set from post text, not an evidence field
  owner?: string; ownerUrl?: string;
  founder?: string; founderUrl?: string;
  managingDirector?: string; managingDirectorUrl?: string;
  marketingHead?: string; marketingHeadUrl?: string;
  operationsHead?: string; operationsHeadUrl?: string;
};

// Publicly shown role titles -> the two field keys that carry name and profile URL.
type PersonKey =
  | "owner" | "ownerUrl" | "founder" | "founderUrl"
  | "managingDirector" | "managingDirectorUrl"
  | "marketingHead" | "marketingHeadUrl" | "operationsHead" | "operationsHeadUrl";
const ROLES: { label: string; nameKey: PersonKey; urlKey: PersonKey }[] = [
  { label: "owner", nameKey: "owner", urlKey: "ownerUrl" },
  { label: "founder", nameKey: "founder", urlKey: "founderUrl" },
  { label: "managing director", nameKey: "managingDirector", urlKey: "managingDirectorUrl" },
  { label: "marketing head", nameKey: "marketingHead", urlKey: "marketingHeadUrl" },
  { label: "operations head", nameKey: "operationsHead", urlKey: "operationsHeadUrl" },
];

const DATE_RE =
  /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/i;
const HIRING_RE = /\b(we(’|')?re hiring|now hiring|we are hiring|join our team|job opening|vacanc|recruit|hiring)\b/i;

const POST_PREFIX_RE = /^(?:recent\s+post|post|update|activity)\s*[:\-]\s*(.+)$/i;

function labelled(lines: string[], label: string): string | undefined {
  const re = new RegExp(`^${label}\\s*[:：]\\s*(.+)$`, "i");
  const hit = lines.find((l) => re.test(l));
  const m = hit?.match(re);
  const v = m?.[1]?.trim();
  return v || undefined;
}

// LinkedIn renders many company-page fields as "<Label> <value>" with no colon
// (confirmed on public pages: "Industry Advertising Services",
// "Company size 11-50 employees", "Headquarters Los Angeles, California",
// "Website https://…"). This matches those, then a bare heading with the value
// on the next line. Strict "Label: value" is tried first.
function fieldValue(lines: string[], label: string): string | undefined {
  const strict = labelled(lines, label);
  if (strict) return strict;
  const loose = new RegExp(`^${label}\\s+(.+)$`, "i");
  const l = lines.find((x) => loose.test(x));
  if (l) {
    const v = l.match(loose)![1].trim();
    if (v) return v;
  }
  const eq = lines.findIndex((x) => x.toLowerCase() === label.toLowerCase());
  if (eq >= 0 && lines[eq + 1] && !/^[A-Za-z][A-Za-z /]{1,30}[:：]/.test(lines[eq + 1])) return lines[eq + 1];
  return undefined;
}

// "About us" / "About" as a bare heading, with the text on the following line
// (the confirmed public-page layout).
function afterHeading(lines: string[], headings: string[]): string | undefined {
  const set = new Set(headings.map((h) => h.toLowerCase()));
  const idx = lines.findIndex((l) => set.has(l.toLowerCase()));
  return idx >= 0 ? lines[idx + 1] : undefined;
}

function firstNameLine(lines: string[]): string | undefined {
  for (const l of lines) {
    if (!l) continue;
    if (/^https?:\/\//i.test(l)) continue;
    if (/^[A-Za-z][A-Za-z /]{1,30}[:：]/.test(l)) continue; // a "Label: value" line
    return l;
  }
  return undefined;
}

function parseFollowers(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.match(/([\d,]{1,15})/);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a LinkedIn company-page text (or a search snippet block) into fields.
 *  Every value is a verbatim copy from the text; anything unmatched stays
 *  undefined. Injected instruction lines are dropped before parsing. */
export function parseLinkedinPage(text: string): LinkedinFields {
  const clean = sanitizeUntrusted(String(text ?? ""));
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: LinkedinFields = {};

  // name: a "Name:"/"Company name:" label, else the first plain line (the page
  // title, e.g. "Fixture Manufacturing Co 01" as LinkedIn renders it).
  const nm = labelled(lines, "Name") ?? labelled(lines, "Company name") ?? firstNameLine(lines);
  if (nm) f.name = nm;

  const set = (key: keyof LinkedinFields, val: string | undefined): void => {
    if (val !== undefined && val !== "") (f as Record<string, unknown>)[key] = val;
  };
  set("industry", fieldValue(lines, "Industry") ?? fieldValue(lines, "Sector"));
  set("employeeRange", fieldValue(lines, "Company size")
    ?? fieldValue(lines, "Employee range") ?? fieldValue(lines, "Employees"));
  set("headquarters", fieldValue(lines, "Headquarters")
    ?? fieldValue(lines, "Head office") ?? fieldValue(lines, "Location"));
  set("about", labelled(lines, "About") ?? afterHeading(lines, ["About us", "About"]));
  set("website", fieldValue(lines, "Website"));
  const followers = parseFollowers(labelled(lines, "Followers"))
    ?? parseFollowers(clean.match(/([\d,]+)\s+followers/i)?.[1]);
  if (followers !== undefined) f.followers = followers;

  // recent posts: the date token of every "Recent post: <date> ..." style line,
  // joined. Hiring is read from the same post text.
  const dates: string[] = [];
  let hiring = false;
  for (const l of lines) {
    const m = l.match(POST_PREFIX_RE);
    if (!m) continue;
    const body = m[1].trim();
    if (HIRING_RE.test(body)) hiring = true;
    const d = body.match(DATE_RE);
    if (d) dates.push(d[1]);
  }
  if (dates.length > 0) f.recentPostDates = dates.join("; ");
  if (hiring) f.hiringPosts = "yes";

  // publicly shown people: "Owner: Ravi Kumar | https://www.linkedin.com/in/..."
  for (const role of ROLES) {
    const re = new RegExp(`^${role.label}\\s*[:\\-]\\s*(.+)$`, "i");
    const hit = lines.find((l) => re.test(l));
    const m = hit?.match(re);
    if (!m) continue;
    const rest = m[1].trim();
    const url = rest.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s|,]+/i)?.[0];
    const name = rest.replace(/https?:\/\/\S+/i, "").replace(/[|,\-–]\s*$/g, "").replace(/[|,\-–]\s+/g, " ").trim();
    if (name) f[role.nameKey] = name;
    if (url) f[role.urlKey] = url;
  }

  return f;
}

/** Employee-range text -> [min, max] (max = min for a single number; a trailing
 *  "+" means unbounded above). Returns undefined when no number is shown. */
export function parseEmployeeBand(range: string | undefined): [number, number] | undefined {
  if (!range) return undefined;
  const nums = (range.match(/[\d,]+/g) ?? []).map((s) => Number(s.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return undefined;
  const min = Math.min(...nums);
  const max = nums.length >= 2 ? Math.max(...nums) : min;
  const open = /\+/.test(range);
  return open ? [min, Infinity] : [min, max];
}

/** Stable signal ids over parsed fields. `inactive-page` means the page shows no
 *  activity overview evidence at all (no post dates), never an inferred fact. */
export function linkedinSignals(f: LinkedinFields): string[] {
  const out: string[] = [];
  const decisionMaker = ROLES.some((r) => typeof f[r.nameKey] === "string" && f[r.nameKey]);
  if (decisionMaker) out.push("decision-maker-identifiable");

  const band = parseEmployeeBand(f.employeeRange);
  if (band && band[1] >= TARGET_EMPLOYEE_MIN && band[0] <= TARGET_EMPLOYEE_MAX) {
    out.push("company-size-fits-brief");
  }

  if (!f.recentPostDates) out.push("inactive-page");
  if (f.hiringPosts === "yes") out.push("hiring-posts-present");
  return out;
}

// ---- per-adapter pacing (8 s between our own page reads) --------------------

let lastPageAt = 0;
async function pace(deps: ChannelDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const wait = MIN_PAGE_INTERVAL_MS - (now - lastPageAt);
  if (wait > 0 && deps.limiter?.sleep) await deps.limiter.sleep(wait);
  lastPageAt = (deps.now ?? Date.now)();
}

/** Discovery: parse site:linkedin.com/company (and /in/) search URLs into
 *  RawLeads. The name comes verbatim from the URL slug; lines with no LinkedIn
 *  URL are skipped. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const clean = sanitizeUntrusted(String(text ?? ""));
  const leads: RawLead[] = [];
  const seen = new Set<string>();
  LINKEDIN_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINKEDIN_URL_RE.exec(clean)) !== null) {
    if (leads.length >= limit) break;
    const url = m[0];
    if (seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    let name = "";
    try {
      name = decodeURIComponent(m[2]).replace(/[-_]+/g, " ").trim();
    } catch { name = ""; }
    if (!name) continue;
    leads.push({ name, category, source: LINKEDIN_CHANNEL_ID, sourceUrl: url });
  }
  return leads;
}

function statusText(): { enabled: boolean; why?: string } {
  if (tierCEnabled()) return { enabled: true };
  if (process.env.LEADSCOUT_BROWSER === "1") return { enabled: true }; // operator-approved read via own browser
  return {
    enabled: false,
    why: "off by default: LinkedIn blocks robots/automated access (india-sources.json tier C) so "
      + `LEADSCOUT_INDIA_TIER_C is "${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" (absent and 0 both mean off), `
      + "and the operator-approved browser-read path (LEADSCOUT_BROWSER=1) is also off",
  };
}

// ---- the adapter -------------------------------------------------------------

export const linkedinCompany: ChannelAdapter = {
  id: LINKEDIN_CHANNEL_ID,
  name: "LinkedIn company pages",
  tier: "C", // india-sources.json (L41) lists linkedin-company as Tier C
  categories: ["manufacturing", "retail", "legal-and-accounting", "b2b-suppliers", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT));
    await pace(deps);
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    const read = await readWithFallback(deps, {
      searchQuery: `site:linkedin.com/company "${q.category}" "${loc}"`.trim(),
    });
    return resultsToLeads(read.text, q.category, limit).map((l) => ({ ...l, sourceUrl: l.sourceUrl }));
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      await pace(deps);
      read = await readWithFallback(deps, {
        searchQuery: `site:linkedin.com/company "${lead.name}" ${lead.city ?? ""}`.trim(),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha / checkpoint after browser escalation: never
        // solved or bypassed -> needs-human evidence, no fields, no retry.
        return {
          channel: LINKEDIN_CHANNEL_ID,
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
    const parsed = parseLinkedinPage(text);
    const fields: Record<string, string | number | undefined> = { ...parsed };
    delete fields.hiringPosts; // internal marker only, never a field value
    return {
      channel: LINKEDIN_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals: linkedinSignals(parsed),
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => linkedinSignals(parseLinkedinPage(text)),
};

registerChannel(linkedinCompany);
