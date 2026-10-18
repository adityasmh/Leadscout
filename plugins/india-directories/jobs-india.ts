// ChannelAdapter for four Indian job portals — Apna (apna.co), WorkIndia
// (workindia.in), foundit (foundit.in) and Shine (shine.com) — Order
// L63-ch-jobs-india.
//
// Hiring signals: given a company name and a city, read its postings on the four
// boards and surface open roles, titles, posting dates, the salary band and the
// count of open roles, plus signals that the business hires for blue/grey-collar
// roles automation can reduce (telecaller, receptionist, data entry operator,
// delivery coordinator, back-office), that it reposts the same role (churn) and
// that it is hiring many roles at once (growth).
//
// Signal names are reused from naukri.ts (read-only reference; this module
// imports its exported constants, it never edits naukri.ts) so scoring stays
// consistent across the hiring-signal adapters: hiring-telecaller,
// hiring-receptionist, hiring-data-entry, many-open-roles. The two roles naukri
// does not name (delivery coordinator, back-office) follow the same
// `hiring-<role>` convention; churn is `reposting-same-role`.
//
// Tier C in data/india-sources.json (L41) for the tiered job-board family: OFF
// by default. Enabled only by env LEADSCOUT_INDIA_TIER_C=1 (the shared tier-C
// operator override the sibling adapters sulekha.ts / justdial.ts / urbancompany.ts
// already use; no new env name is introduced) or the operator-approved browser
// read mode (LEADSCOUT_BROWSER=1; the operator's own logged-in browser,
// allowlisted in data/browser-allowlist.json, which lists apna.co, workindia.in,
// foundit.in and shine.com). LEADSCOUT_BROWSER=0 is a hard kill switch.
//
// Read order per page (registry.readWithFallback): search first -> plain page
// read -> browser reader ONLY when both are blocked (403, 429, captcha, empty
// body). A login wall / captcha inside the browser raises BrowserBlockedError,
// which enrich turns into a needs-human evidence record; it is never solved or
// bypassed. The browser reader enforces its own per-platform hourly caps
// (browser.ts DEFAULT_CAPS: "other" = 60, overridable per platform) and its
// random 2-6 s pause; the adapter never re-reads a blocked page or loops, so it
// respects those caps by construction.
//
// Robots/terms checked 2026-10-09 (see REPORT_L63-ch-jobs-india.md):
//  - apna.co/robots.txt: `User-agent: *` only Disallows `/*.infra.apna.co/`;
//    the /jobs/ listing paths are not disallowed (terms not read).
//  - workindia.in/robots.txt: an AI-crawler block (GPTBot, ClaudeBot, CCBot,
//    Bytespider, PerplexityBot …) and `User-agent: *` both `Disallow: /*?*` and
//    `/*&*`, so query-string URLs are out; path job pages are not disallowed.
//  - foundit.in/robots.txt: `User-agent: *` disallows several utility paths;
//    the GPTBot/ClaudeBot/CCBot/Bytespider/Meta-ExternalAgent/Google-Extended
//    group adds `Disallow: /jobs/` and `Disallow: /search/` — the listing paths.
//  - shine.com/robots.txt: `User-agent: *` disallows /jobs/jobs/,
//    /job-search/simple/, /jobs/1*, /jobs/9* and others.
//  The portal terms of use were NOT read this run, so the whole group stays OFF
//  by default (tier C) and every confirmed/unverified item is recorded in the
//  report.
//
// Rules: every field value is a verbatim copy from page text or the search
// URL/snippet with its source URL; a value the page does not show stays missing
// (never inferred or invented). All fetched text is neutralised via
// reach.sanitizeUntrusted (injection-like lines dropped) and evidence is marked
// untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { tierCEnabled } from "../../src/india-sources.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";
import { NAUKRI_SIGNAL_TITLES, MANY_OPEN_ROLES_THRESHOLD } from "./naukri.js";

export const JOBS_INDIA_CHANNEL_ID = "jobs-india";
export const JOBS_INDIA_SITES = ["apna.co", "workindia.in", "foundit.in", "shine.com"] as const;
/** Shared tier-C gate (no new env name); the operator-approved browser read is
 *  the second switch, enforced in browser.ts. */
export const JOBS_INDIA_ENV = "LEADSCOUT_INDIA_TIER_C";
const MAX_TEXT = 20000;

export const MANY_OPEN_ROLES_SIGNAL = "many-open-roles"; // reused from naukri.ts
export const REPOSTING_SIGNAL = "reposting-same-role"; // churn

export type JobsIndiaFields = {
  openRoles?: string;
  titles?: string;
  postingDates?: string;
  salaryBand?: string;
  openRolesCount?: number;
  needsHuman?: string;
};

// ---- signals: role ids reuse naukri.ts names where they exist ----------------

// The blue/grey-collar roles naukri.ts already names, filtered to the subset the
// order lists so the ids are byte-identical (imported, not retyped).
const REUSED_NAUKRI_IDS = new Set(["hiring-telecaller", "hiring-receptionist", "hiring-data-entry"]);

export const JOBS_INDIA_SIGNAL_TITLES: { id: string; label: string; re: RegExp }[] = [
  ...NAUKRI_SIGNAL_TITLES.filter((s) => REUSED_NAUKRI_IDS.has(s.id)),
  { id: "hiring-delivery-coordinator", label: "Delivery Coordinator", re: /delivery[\s-]*(?:coordinator|executive|associate|boy|partner|manager)/i },
  { id: "hiring-back-office", label: "Back Office Executive", re: /back[\s-]*office/i },
];

// ---- page/snippet parser: only exact matches become fields ------------------

const SOURCE_URL_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:apna\.co|workindia\.in|foundit\.in|shine\.com)\/[^\s"'<>()[\]，;]+/i;
// Instruction-like lines are never copied into a field.
const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?previous\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b/i;
const NAME_LABEL_RE = /^(?:Company|Name|Employer)\s*[:：]\s*(.+)$/i;
const TITLE_LABEL_RE = /^(?:Job\s+Title|Title|Role|Position|Designation)\s*[:：]\s*(.+)$/i;
const ROLES_LABEL_RE = /^(?:Roles?|Openings?|Open\s+roles?|Vacancies)\s*[:：]\s*(.+)$/i;
const POSTED_LABEL_RE = /^(?:Posted(?:\s+on|\s+date)?|Date\s+posted|Posting\s+date)\s*[:：]\s*(.+)$/i;
const SALARY_LABEL_RE = /^(?:Salary|Salary\s+band|Pay|Compensation|CTC)\s*[:：]\s*(.+)$/i;
// A job-card heading such as apna's "## Delivery Associate"; page chrome is excluded.
const HEADING_TITLE_RE = /^#{1,6}\s+(.+)$/;
const HEADING_STOP_RE =
  /^(?:jobs?|filters?|search(?:\s+jobs)?|login|register|degree|resume tools|skills?|salary|locations?|experience|company|companies|date posted|work mode|work type|work shift|department|sort by|results?|candidates?|overview|about|benefits|description|responsibilities|requirements|how to apply|top companies|related jobs|popular categories)$/i;
// An EXPLICIT count only: "8 open roles", "15440 Verified Vacancies", "146 Jobs",
// "Showing 4 results".
const COUNT_RE =
  /([\d,]{1,9})\s*(?:\+)?\s*(?:open\s+(?:roles|positions|jobs)|openings?|vacanc(?:y|ies)|positions?|verified\s+vacanc(?:y|ies)|job\s+vacanc(?:y|ies)|jobs|results?)\b/i;
// "₹50,000 - ₹1,00,000", "Rs. 15000 - Rs. 20000", "₹ 3 - 5 LPA".
const SALARY_RE =
  /(?:₹|Rs\.?|INR)\s?[\d,]+(?:\.\d+)?(?:\s*(?:-|–|to)\s*(?:₹|Rs\.?|INR)?\s?[\d,]+(?:\.\d+)?)?(?:\s*(?:per\s+)?(?:month|monthly|lpa|per\s+annum|annually|\/\s*month|\/\s*year))?/i;
// The verbatim relative/absolute posting phrases the portals show.
const POSTED_INLINE_RE =
  /\bposted\s+(?:on\s+)?[:\-]?\s*((?:a|an|\d+)\s+(?:hour|day|week|month|year)s?\s+ago|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i;

function cleanValue(s: string): string | undefined {
  const v = String(s ?? "").replace(/\s+/g, " ").replace(/[\s,;|]+$/, "").trim();
  return v || undefined;
}

function num(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function splitList(value: string): string[] {
  return value
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripInjection(text: string): string {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => !INJECTION_NEVER_COPY.test(l))
    .join("\n");
}

/** All title strings (duplicates kept, so churn can count reposts). */
function rawTitles(clean: string): string[] {
  const out: string[] = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const t = line.match(TITLE_LABEL_RE);
    if (t) {
      const v = cleanValue(t[1]);
      if (v) out.push(v);
      continue;
    }
    const roles = line.match(ROLES_LABEL_RE);
    if (roles) {
      for (const one of splitList(roles[1])) out.push(one);
      continue;
    }
    const h = line.match(HEADING_TITLE_RE);
    if (h) {
      const v = cleanValue(h[1]);
      if (v && v.length >= 3 && v.length <= 60 && /[A-Za-z]/.test(v) && !v.endsWith(":") && !HEADING_STOP_RE.test(v)) {
        out.push(v);
      }
    }
  }
  return out;
}

/** First job-portal URL appearing in the text (used to cite the job page). */
export function firstSourceUrl(text: string): string | undefined {
  const m = String(text ?? "").match(SOURCE_URL_RE);
  return m ? m[0].replace(/[.,;:]+$/, "") : undefined;
}

/** Parse a job posting page (or search snippet block) into the listed fields.
 *  Every value is a verbatim copy from the text or the URL; anything not shown
 *  stays undefined (never inferred). */
export function parseJobsIndiaPage(text: string): JobsIndiaFields {
  const clean = stripInjection(String(text ?? ""));
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: JobsIndiaFields = {};

  const titles = rawTitles(clean);
  const deduped = [...new Set(titles)];
  if (deduped.length > 0) {
    f.titles = deduped.join(", ");
    f.openRoles = f.titles; // the roles above are the open roles listed
  }

  const dates: string[] = [];
  for (const line of lines) {
    const d = line.match(POSTED_LABEL_RE);
    if (!d) continue;
    const v = cleanValue(d[1]);
    if (v) dates.push(v);
  }
  if (dates.length > 0) {
    f.postingDates = [...new Set(dates)].join("; ");
  } else {
    const inline = clean.match(POSTED_INLINE_RE);
    if (inline) f.postingDates = cleanValue(inline[1]);
  }

  const flat = clean.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ").trim();
  const salaryLine = lines.find((l) => SALARY_LABEL_RE.test(l));
  if (salaryLine) {
    f.salaryBand = cleanValue(salaryLine.replace(SALARY_LABEL_RE, "$1"));
  } else {
    const s = flat.match(SALARY_RE);
    if (s) f.salaryBand = s[0].trim();
  }

  const count = num(COUNT_RE.exec(flat)?.[1]);
  if (count !== undefined) f.openRolesCount = count;
  return f;
}

// ---- signals ----------------------------------------------------------------

function normalizedTitle(t: string): string {
  return String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Churn: an explicit "reposted" marker, or the same role title appearing 2+ times. */
export function hasReposting(text: string, titles: string[]): boolean {
  if (/\bre[- ]?posted\b/i.test(String(text ?? ""))) return true;
  const counts = new Map<string, number>();
  for (const title of titles) {
    const k = normalizedTitle(title);
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.values()].some((n) => n >= 2);
}

/** Stable signal ids over parsed fields; role signals match job titles only. */
export function jobsIndiaSignals(text: string, _queriedCity?: string): string[] {
  const clean = stripInjection(String(text ?? ""));
  const f = parseJobsIndiaPage(clean);
  const titles = splitList(String(f.titles ?? ""));
  const out: string[] = [];
  for (const sig of JOBS_INDIA_SIGNAL_TITLES) {
    if (titles.some((t) => sig.re.test(t))) out.push(sig.id);
  }
  if (typeof f.openRolesCount === "number" && f.openRolesCount >= MANY_OPEN_ROLES_THRESHOLD) {
    out.push(MANY_OPEN_ROLES_SIGNAL);
  }
  if (hasReposting(clean, rawTitles(clean))) out.push(REPOSTING_SIGNAL);
  return [...new Set(out)];
}

/** Prefix each signal with its citation (job-page URL and posting date). */
export function citeSignals(base: string[], url: string, postingDates?: string): string[] {
  const posted = postingDates && postingDates.trim() ? postingDates.trim() : "unknown";
  return base.map((id) => `${id} (source: ${url}; posted: ${posted})`);
}

// ---- search results -> RawLead (discovery helper) ---------------------------

const GENERIC_SLUG_RE = /^(?:jobs?|job|job-search|search|jobs-in|jobs-by-company|full_time-jobs|part_time-jobs)$/i;

export function nameFromJobUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const segs = u.pathname.replace(/[?&#].*$/, "").split("/").filter(Boolean);
    const slug = segs[segs.length - 1] ?? "";
    const name = slug
      .replace(/^\d+[-_]/, "")
      .replace(/-/g, " ")
      .replace(/\b(viewjob|job|jobs|listings?|detail|detailpage|search|jobs in|jobs by company)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!name || GENERIC_SLUG_RE.test(name.replace(/\s+/g, "-"))) return undefined;
    return name;
  } catch {
    return undefined;
  }
}

/** Search-snippet lines -> RawLead[]. A `Company:`/`Name:` line names the next
 *  portal URL; otherwise the name comes from the URL slug. Lines with no portal
 *  URL are skipped (a source URL is mandatory). */
export function resultsToLeads(text: string, category: string, city: string | undefined, limit: number): RawLead[] {
  const out: RawLead[] = [];
  let pendingName: string | undefined;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (out.length >= limit) break;
    const line = rawLine.trim();
    if (!line) continue;
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
      source: JOBS_INDIA_CHANNEL_ID,
      sourceUrl: url,
      ...(city ? { city } : {}),
    });
  }
  return out;
}

// ---- status and env gate ----------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (tierCEnabled()) return { enabled: true };
  if (process.env.LEADSCOUT_BROWSER === "1") {
    return { enabled: true }; // operator-approved read mode on the operator's own browser
  }
  return {
    enabled: false,
    why:
      "tier C job boards (robots/terms restrict automated access; checked 2026-10-09: foundit.in robots.txt "
      + "Disallows /jobs/ and /search/ for GPTBot/ClaudeBot/CCBot/Bytespider/Meta-ExternalAgent/Google-Extended; "
      + "workindia.in Disallows /*?* and /*&* for AI crawlers and User-agent:*; shine.com Disallows utility job "
      + "paths; apna.co only Disallows /*.infra.apna.co/ but its terms were not read): "
      + `LEADSCOUT_INDIA_TIER_C is "${String(process.env.LEADSCOUT_INDIA_TIER_C ?? "")}" so tier C is off `
      + "(absent and =0 both mean off); the operator-approved browser-read fallback is also off "
      + "(LEADSCOUT_BROWSER is not 1)",
  };
}

export function searchQueryFor(name: string, city?: string): string {
  const sites = JOBS_INDIA_SITES.map((s) => `site:${s}`).join(" OR ");
  const loc = city ? `"${city}"` : "";
  return `(${sites}) "${name}" ${loc}`.trim().replace(/\s+/g, " ");
}

function discoveryQuery(category: string, city: string, area?: string): string {
  const sites = JOBS_INDIA_SITES.map((s) => `site:${s}`).join(" OR ");
  const loc = [area, city].filter(Boolean).join(", ");
  return `(${sites}) "${category}" "${loc}"`.trim().replace(/\s+/g, " ");
}

function needsHumanEvidence(url: string, now: () => number): ChannelEvidence {
  return {
    channel: JOBS_INDIA_CHANNEL_ID,
    url,
    fetchedAt: new Date(now()).toISOString(),
    via: "browser",
    fields: { needsHuman: "true" },
    signals: ["needs-human"],
    text: "",
    untrusted: true,
  };
}

// ---- the adapter ------------------------------------------------------------

export const jobsIndia: ChannelAdapter = {
  id: JOBS_INDIA_CHANNEL_ID,
  name: "Apna / WorkIndia / foundit / Shine",
  tier: "C", // india-sources.json family: job boards, robots/terms restrict automated access
  categories: ["jobs", "any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    let read: FallbackRead;
    try {
      // read order, per the contract: search first (cheapest).
      read = await readWithFallback(deps, { searchQuery: discoveryQuery(q.category, q.city, q.area) });
    } catch {
      return [];
    }
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, q.city, limit);
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
        return needsHumanEvidence(lead.sourceUrl, deps.now ?? Date.now);
      }
      throw err;
    }
    const text = sanitizeUntrusted(read.text);
    const fields: Record<string, string | number | undefined> = { ...parseJobsIndiaPage(text) };
    const base = jobsIndiaSignals(text, lead.city);
    const citedUrl = firstSourceUrl(text) ?? lead.sourceUrl ?? read.url;
    const signals = citeSignals(base, citedUrl, fields.postingDates as string | undefined);
    return {
      channel: JOBS_INDIA_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => jobsIndiaSignals(text),
};

registerChannel(jobsIndia);
