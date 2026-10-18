// ChannelAdapter for Naukri, Indeed India and LinkedIn Jobs (Order L49-ch-naukri).
//
// Hiring signals: given a company name and a city, read its job postings on the
// three job boards and surface open roles, titles, posting dates, the count of
// open roles and locations, plus signals that the business is hiring for
// automatable roles (receptionist, telecaller, customer support, data entry,
// accountant, sales executive, social media manager, digital marketing
// executive, IT support) and growth (many open roles, a new branch city).
//
// This adapter has NO discovery of its own: `discover` always returns nothing
// (the order: "no discovery of its own: returns nothing"). It only enriches a
// lead we already have. The exported `resultsToLeads` helper turns fixture /
// search-result text into RawLead(s) so the proof can still show that search
// results map to RawLead with source URLs, without the adapter doing discovery.
//
// Tier C in data/india-sources.json (L41): naukri robots.txt (fetched
// 2026-10-07 and re-checked 2026-10-09) blocks AI crawlers wholesale
// (Claude-User, GPTBot, CCBot, PerplexityBot, Google-Extended …) while the
// generic `User-agent: *` group only disallows recruiter/manager paths, so the
// main listing pages are technically crawlable but the terms were not found;
// in.indeed.com robots.txt Disallows /jobs/IN/ and /viewjob for `User-agent: *`
// (the India-jobs path); linkedin.com robots.txt states plainly that automated
// access without express permission is prohibited. So the adapter is OFF by
// default and is switched on only by the shared tier-C operator override
// (env LEADSCOUT_INDIA_TIER_C=1) or the operator-approved browser-read mode
// (LEADSCOUT_BROWSER=1; the operator's own logged-in browser, allowlisted in
// data/browser-allowlist.json). No new env name is introduced: it reuses the
// sibling tier-C gate (sulekha.ts, justdial.ts, zomato.ts). LEADSCOUT_BROWSER=0
// is a hard kill switch.
//
// Read order per page (registry.readWithFallback): search first -> plain page
// read -> browser reader ONLY when both are blocked (403, 429, captcha, empty
// body). A login wall / captcha inside the browser raises BrowserBlockedError,
// which enrich turns into a needs-human evidence record; it is never solved or
// bypassed. The browser reader enforces its own per-platform hourly caps
// (LinkedIn 15, others 60) and 2-6 s pauses; the adapter never re-reads a
// blocked page or loops.
//
// Rules: every field value is copied verbatim from page text or the search
// URL/snippet with its source URL; a value the page does not show stays missing
// (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted and the evidence is marked untrusted: true. Each
// signal string cites the job-page URL and the posting date.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const NAUKRI_CHANNEL_ID = "naukri"; // matches india-sources.json registry data (L41)
export const NAUKRI_SITES = ["naukri.com", "in.indeed.com", "linkedin.com/jobs"] as const;
/** Shared tier-C gate (no new env name); the operator-approved browser read is
 *  the second switch, enforced in browser.ts. */
export const NAUKRI_ENV = "LEADSCOUT_INDIA_TIER_C";
const MAX_TEXT = 20000;
/** "many open roles" at or above this explicit count (the page must state it). */
export const MANY_OPEN_ROLES_THRESHOLD = 5;

export type NaukriFields = {
  openRoles?: string;
  titles?: string;
  postingDates?: string;
  openRolesCount?: number;
  locations?: string;
  needsHuman?: string;
};

// ---- signals: matched against job titles only -------------------------------

export const NAUKRI_SIGNAL_TITLES: { id: string; label: string; re: RegExp }[] = [
  { id: "hiring-receptionist", label: "Receptionist", re: /receptionist/i },
  { id: "hiring-telecaller", label: "Telecaller", re: /telecaller/i },
  { id: "hiring-customer-support", label: "Customer Support Executive", re: /customer\s+support/i },
  { id: "hiring-data-entry", label: "Data Entry Operator", re: /data\s+entry/i },
  { id: "hiring-accountant", label: "Accountant", re: /accountant/i },
  { id: "hiring-sales-executive", label: "Sales Executive", re: /sales\s+executive/i },
  { id: "hiring-social-media-manager", label: "Social Media Manager", re: /social\s+media\s+manager/i },
  { id: "hiring-digital-marketing-executive", label: "Digital Marketing Executive", re: /digital\s+marketing\s+executive/i },
  { id: "hiring-it-support", label: "IT Support Engineer", re: /it\s+support/i },
];

// ---- page/snippet parser: only exact matches become fields ------------------

const SOURCE_URL_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:naukri\.com|indeed\.com|linkedin\.com)\/[^\s"'<>()[\]，;]+/i;
// Instruction-like lines are never copied into a field.
const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?previous\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b/i;
const TITLE_LABEL_RE = /^(?:Job\s+Title|Title|Role|Position)\s*[:：]\s*(.+)$/i;
const ROLES_LABEL_RE = /^(?:Roles?|Openings?|Open\s+roles?)\s*[:：]\s*(.+)$/i;
const POSTED_LABEL_RE = /^(?:Posted(?:\s+on|\s+date)?|Date\s+posted|Posting\s+date)\s*[:：]\s*(.+)$/i;
const LOCATION_LABEL_RE = /^(?:Location|Job\s+Location|City)\s*[:：]\s*(.+)$/i;
// "8 open roles", "12 openings", "3 vacancies" - an EXPLICIT count only.
const COUNT_RE = /([\d,]{1,7})\s+(?:open\s+(?:roles|positions|jobs)|openings?|vacanc(?:y|ies)|positions?)\b/i;

function cleanValue(s: string): string | undefined {
  const v = String(s ?? "").replace(/\s+/g, " ").replace(/[\s,;|]+$/, "").trim();
  return v || undefined;
}

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** First job-board URL appearing in the text (used to cite the job page). */
export function firstSourceUrl(text: string): string | undefined {
  const m = String(text ?? "").match(SOURCE_URL_RE);
  return m ? m[0].replace(/[.,;:]+$/, "") : undefined;
}

function splitList(value: string): string[] {
  return value
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse a job posting page (or search snippet block) into the listed fields.
 *  Every value is a verbatim copy from the text; anything not shown stays
 *  undefined (never inferred). */
export function parseNaukriPage(text: string): NaukriFields {
  const raw = String(text ?? "");
  const clean = raw
    .split(/\r?\n/)
    .filter((l) => !INJECTION_NEVER_COPY.test(l))
    .join("\n");
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: NaukriFields = {};

  const titles: string[] = [];
  const dates: string[] = [];
  const locations: string[] = [];
  for (const line of lines) {
    const t = line.match(TITLE_LABEL_RE);
    if (t) {
      const v = cleanValue(t[1]);
      if (v) titles.push(v);
    }
    const roles = line.match(ROLES_LABEL_RE);
    if (roles) {
      const v = roles[1];
      if (v) for (const one of splitList(v)) titles.push(one);
    }
    const d = line.match(POSTED_LABEL_RE);
    if (d) {
      const v = cleanValue(d[1]);
      if (v) dates.push(v);
    }
    const l = line.match(LOCATION_LABEL_RE);
    if (l) {
      const v = cleanValue(l[1]);
      if (v) locations.push(v);
    }
  }
  if (titles.length > 0) {
    f.titles = [...new Set(titles)].join(", ");
    f.openRoles = f.titles; // the roles above are the open roles listed
  }
  if (dates.length > 0) f.postingDates = [...new Set(dates)].join("; ");
  if (locations.length > 0) f.locations = [...new Set(locations)].join("; ");

  const count = num(COUNT_RE.exec(clean)?.[1]);
  if (count !== undefined) f.openRolesCount = count;
  return f;
}

function normCity(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

/** True only when the posting names a city different from the queried one.
 *  When the queried city is missing we cannot tell, so it does not fire. */
function hasNewBranchCity(locations: string | undefined, queriedCity?: string): boolean {
  const q = normCity(queriedCity ?? "");
  if (!locations || !q) return false;
  for (const loc of String(locations).split(/;/)) {
    const n = normCity(loc);
    if (!n) continue;
    if (n === q || n.includes(q)) continue; // same city / same metro
    return true;
  }
  return false;
}

/** Stable signal ids over parsed fields; title signals match job titles only. */
export function naukriSignals(text: string, queriedCity?: string): string[] {
  const f = parseNaukriPage(text);
  const out: string[] = [];
  const titleList = splitList(String(f.titles ?? ""));
  for (const sig of NAUKRI_SIGNAL_TITLES) {
    if (titleList.some((t) => sig.re.test(t))) out.push(sig.id);
  }
  if (typeof f.openRolesCount === "number" && f.openRolesCount >= MANY_OPEN_ROLES_THRESHOLD) {
    out.push("many-open-roles");
  }
  if (hasNewBranchCity(f.locations, queriedCity)) out.push("new-branch-city");
  return [...new Set(out)];
}

/** Prefix each signal with its citation (job-page URL and posting date). */
export function citeSignals(base: string[], url: string, postingDates?: string): string[] {
  const posted = postingDates && postingDates.trim() ? postingDates.trim() : "unknown";
  return base.map((id) => `${id} (source: ${url}; posted: ${posted})`);
}

// ---- search results -> RawLead (helper; the adapter does not discover) ------

const NAME_LABEL_RE = /^(?:Company|Name|Employer)\s*[:：]\s*(.+)$/i;

export function nameFromJobUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    const slug = segs[segs.length - 1] ?? "";
    const name = slug
      .replace(/^\d+[-_]/, "")
      .replace(/-/g, " ")
      .replace(/\b(viewjob|job|jobs|listings?|detail|detailpage)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Search-snippet lines -> RawLead[]. A `Company:`/`Name:` line names the next
 *  job-board URL; otherwise the name comes from the URL slug. Lines with no
 *  job-board URL are skipped (a source URL is mandatory). */
export function resultsToLeads(text: string, category: string, city: string | undefined, limit: number): RawLead[] {
  const out: RawLead[] = [];
  let pendingName: string | undefined;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (out.length >= limit) break;
    const line = rawLine.trim();
    if (INJECTION_NEVER_COPY.test(line)) continue;
    const nm = line.match(NAME_LABEL_RE);
    if (nm) {
      pendingName = cleanValue(nm[1]);
      continue;
    }
    const u = line.match(SOURCE_URL_RE);
    if (!u) continue;
    const url = u[0].replace(/[.,;:]+$/, "");
    const name = pendingName ?? nameFromJobUrl(url);
    pendingName = undefined;
    if (!name) continue;
    out.push({
      name,
      category,
      source: NAUKRI_CHANNEL_ID,
      sourceUrl: url,
      ...(city ? { city } : {}),
    });
  }
  return out;
}

// ---- status and env gate -----------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (tierCEnabled()) return { enabled: true };
  if (process.env.LEADSCOUT_BROWSER === "1") return { enabled: true };
  return {
    enabled: false,
    why:
      "tier C (job boards: naukri.com robots.txt blocks AI crawlers wholesale and terms unverified; "
      + "in.indeed.com robots.txt Disallows /jobs/IN/ and /viewjob for User-agent:*; linkedin.com robots.txt "
      + "prohibits automated access without express permission; india-sources.json tier C): "
      + `LEADSCOUT_INDIA_TIER_C is "${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off `
      + "(absent and =0 both mean off); the operator-approved browser-read fallback is also off "
      + "(LEADSCOUT_BROWSER is not 1)",
  };
}

function searchQueryFor(name: string, city?: string): string {
  const sites = NAUKRI_SITES.map((s) => `site:${s}`).join(" OR ");
  const loc = city ? `"${city}"` : "";
  return `(${sites}) "${name}" ${loc}`.trim().replace(/\s+/g, " ");
}

// ---- the adapter ------------------------------------------------------------

export const naukri: ChannelAdapter = {
  id: NAUKRI_CHANNEL_ID,
  name: "Naukri / Indeed India / LinkedIn Jobs",
  tier: "C", // india-sources.json (L41): tier C, robots/terms restrict automated access
  categories: ["jobs", "any"],
  status: () => statusText(),

  // No discovery of its own: this adapter only enriches a lead we already have.
  discover: async (_q: DiscoverQuery, _deps: ChannelDeps): Promise<RawLead[]> => {
    return [];
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: searchQueryFor(lead.name, lead.city),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha / checkpoint: never solved or bypassed.
        return {
          channel: NAUKRI_CHANNEL_ID,
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
    const fields: Record<string, string | number | undefined> = { ...parseNaukriPage(text) };
    const base = naukriSignals(text, lead.city);
    const citedUrl = firstSourceUrl(text) ?? lead.sourceUrl ?? read.url;
    const signals = citeSignals(base, citedUrl, fields.postingDates as string | undefined);
    return {
      channel: NAUKRI_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => naukriSignals(text),
};

registerChannel(naukri);
