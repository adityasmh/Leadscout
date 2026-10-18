// src/timing.ts
// Dated timing flags from dated observations only. Every flag needs a dated
// source; nothing is inferred without one. Pure, except loadSeasonCalendar.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Lead } from "./types.js";

export type TimingObservationKind = "first-seen" | "job-posting" | "ad-start" | "review-count";

export type TimingObservation = {
  kind: TimingObservationKind;
  url: string;
  date: string;
  count?: number;
  previousCount?: number;
  previousDate?: string;
};

export type TimingFlagName =
  | "new-listing"
  | "hiring-spree"
  | "new-ad-campaign"
  | "reviews-momentum"
  | "season-window";

export type TimingFlag = {
  flag: TimingFlagName;
  url: string;
  dates: string[];
  sentence: string;
  basis?: string;
};

export type TimingLead = Pick<Lead, "category" | "country">;

export type SeasonCalendarEntry = {
  category: string;
  country: string;
  peakMonths: number[];
  note: string;
  basis: string;
};

export type SeasonCalendar = {
  version: number;
  note: string;
  entries: SeasonCalendarEntry[];
};

export const NEW_LISTING_DAYS = 60;
export const HIRING_MIN_ROLES = 3;
export const HIRING_DAYS = 30;
export const AD_DAYS = 30;
export const REVIEW_JUMP_MIN = 10;
export const REVIEW_JUMP_RATIO = 0.25;
export const SEASON_LOOKAHEAD_DAYS = 45;
export const FLAG_WEIGHT = 10;

const MS_PER_DAY = 86400000;
const MONTH_INDEX_OFFSET = 1;
const FIRST_MONTH = 1;
const LAST_MONTH = 12;
const FIRST_DAY_OF_MONTH = 1;
const ISO_DATE_LENGTH = 10;
const REACH_SCORE_CAP = 40;
const SEASON_CALENDAR_URL = "season-calendar.json";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CALENDAR_PATH = join(HERE, "..", "data", "season-calendar.json");

const OBSERVATION_KINDS: ReadonlySet<string> = new Set([
  "first-seen",
  "job-posting",
  "ad-start",
  "review-count",
]);

function parseWhen(value: string): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function toNowMs(now: Date | string): number {
  const ms = now instanceof Date ? now.getTime() : parseWhen(now);
  return ms !== undefined && Number.isFinite(ms) ? ms : Date.now();
}

function withinDaysBefore(whenMs: number, nowMsValue: number, windowDays: number): boolean {
  const diffDays = (nowMsValue - whenMs) / MS_PER_DAY;
  return diffDays >= 0 && diffDays <= windowDays;
}

function normaliseCategory(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function isKnownKind(kind: string): kind is TimingObservationKind {
  return OBSERVATION_KINDS.has(kind);
}

function usable(observation: TimingObservation): boolean {
  if (observation === null || typeof observation !== "object") return false;
  if (!isKnownKind(observation.kind)) return false;
  if (typeof observation.url !== "string" || observation.url.length === 0) return false;
  return parseWhen(observation.date) !== undefined;
}

function mostRecentInWindow(
  list: TimingObservation[],
  kind: TimingObservationKind,
  nowMsValue: number,
  windowDays: number,
): TimingObservation | undefined {
  let best: TimingObservation | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const observation of list) {
    if (!usable(observation) || observation.kind !== kind) continue;
    const ms = parseWhen(observation.date) ?? Number.NEGATIVE_INFINITY;
    if (withinDaysBefore(ms, nowMsValue, windowDays) && ms > bestMs) {
      best = observation;
      bestMs = ms;
    }
  }
  return best;
}

function hiringSpreeFlag(list: TimingObservation[], nowMsValue: number): TimingFlag | undefined {
  const recent: TimingObservation[] = [];
  for (const observation of list) {
    if (!usable(observation) || observation.kind !== "job-posting") continue;
    const ms = parseWhen(observation.date) ?? Number.NaN;
    if (withinDaysBefore(ms, nowMsValue, HIRING_DAYS)) recent.push(observation);
  }
  const distinctUrls: string[] = [];
  for (const observation of recent) {
    if (!distinctUrls.includes(observation.url)) distinctUrls.push(observation.url);
  }
  if (distinctUrls.length < HIRING_MIN_ROLES) return undefined;
  const firstUrl = distinctUrls[0];
  if (firstUrl === undefined || firstUrl.length === 0) return undefined;
  return {
    flag: "hiring-spree",
    url: firstUrl,
    dates: recent.map((observation) => observation.date),
    sentence: `${distinctUrls.length} open roles posted in the last ${HIRING_DAYS} days.`,
  };
}

function reviewsMomentumFlag(list: TimingObservation[]): TimingFlag | undefined {
  for (const observation of list) {
    if (!usable(observation) || observation.kind !== "review-count") continue;
    if (typeof observation.count !== "number" || typeof observation.previousCount !== "number") continue;
    if (!Number.isFinite(observation.count) || !Number.isFinite(observation.previousCount)) continue;
    if (typeof observation.previousDate !== "string") continue;
    if (parseWhen(observation.previousDate) === undefined) continue;
    const growth = observation.count - observation.previousCount;
    if (growth < REVIEW_JUMP_MIN) continue;
    if (observation.previousCount > 0 && growth < observation.previousCount * REVIEW_JUMP_RATIO) continue;
    return {
      flag: "reviews-momentum",
      url: observation.url,
      dates: [observation.date, observation.previousDate],
      sentence: `Reviews up from ${observation.previousCount} to ${observation.count} since ${observation.previousDate}.`,
    };
  }
  return undefined;
}

function startOfUtcDay(ms: number): number {
  const day = new Date(ms);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

function peakStartInDays(
  peakMonth: number,
  nowMsValue: number,
): { diffDays: number; iso: string } | undefined {
  if (!Number.isInteger(peakMonth) || peakMonth < FIRST_MONTH || peakMonth > LAST_MONTH) {
    return undefined;
  }
  const base = startOfUtcDay(nowMsValue);
  const year = new Date(nowMsValue).getUTCFullYear();
  let candidate = Date.UTC(year, peakMonth - MONTH_INDEX_OFFSET, FIRST_DAY_OF_MONTH);
  if (candidate < base) {
    candidate = Date.UTC(year + MONTH_INDEX_OFFSET, peakMonth - MONTH_INDEX_OFFSET, FIRST_DAY_OF_MONTH);
  }
  return {
    diffDays: (candidate - base) / MS_PER_DAY,
    iso: new Date(candidate).toISOString().slice(0, ISO_DATE_LENGTH),
  };
}

function seasonFlagForEntry(entry: SeasonCalendarEntry, nowMsValue: number): TimingFlag | undefined {
  if (typeof entry.note !== "string" || entry.note.length === 0) return undefined;
  if (!Array.isArray(entry.peakMonths) || entry.peakMonths.length === 0) return undefined;
  let bestDiff: number | undefined;
  let bestIso = "";
  for (const month of entry.peakMonths) {
    if (typeof month !== "number") continue;
    const next = peakStartInDays(month, nowMsValue);
    if (next === undefined) continue;
    if (bestDiff === undefined || next.diffDays < bestDiff) {
      bestDiff = next.diffDays;
      bestIso = next.iso;
    }
  }
  if (bestDiff === undefined || bestIso.length === 0) return undefined;
  if (bestDiff < 0 || bestDiff > SEASON_LOOKAHEAD_DAYS) return undefined;
  return {
    flag: "season-window",
    url: SEASON_CALENDAR_URL,
    dates: [bestIso],
    sentence: entry.note,
    basis: entry.basis,
  };
}

function toSeasonEntry(value: unknown): SeasonCalendarEntry | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const category = record["category"];
  const note = record["note"];
  const basis = record["basis"];
  const peakMonths = record["peakMonths"];
  const country = record["country"];
  if (typeof category !== "string" || category.length === 0) return undefined;
  if (typeof note !== "string" || note.length === 0) return undefined;
  if (typeof basis !== "string") return undefined;
  if (!Array.isArray(peakMonths) || peakMonths.length === 0) return undefined;
  const rawMonths: unknown[] = peakMonths;
  const months: number[] = [];
  for (const month of rawMonths) {
    if (typeof month === "number" && Number.isInteger(month) && month >= FIRST_MONTH && month <= LAST_MONTH) {
      months.push(month);
    }
  }
  if (months.length === 0) return undefined;
  return {
    category,
    country: typeof country === "string" ? country : "",
    peakMonths: months,
    note,
    basis,
  };
}

function entriesOf(calendar: SeasonCalendar | SeasonCalendarEntry[] | undefined): SeasonCalendarEntry[] {
  const out: SeasonCalendarEntry[] = [];
  if (calendar === undefined) return out;
  const items: unknown[] = Array.isArray(calendar) ? calendar : [];
  if (Array.isArray(calendar)) {
    for (const item of items) {
      const entry = toSeasonEntry(item);
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }
  if (typeof calendar === "object" && calendar !== null) {
    const record = calendar as Record<string, unknown>;
    const raw: unknown = record["entries"];
    if (Array.isArray(raw)) {
      const rawItems: unknown[] = raw;
      for (const item of rawItems) {
        const entry = toSeasonEntry(item);
        if (entry !== undefined) out.push(entry);
      }
    }
  }
  return out;
}

function parseCalendarText(raw: string): SeasonCalendarEntry[] {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const rawEntries: unknown = record["entries"];
  if (!Array.isArray(rawEntries)) return [];
  const items: unknown[] = rawEntries;
  const out: SeasonCalendarEntry[] = [];
  for (const item of items) {
    const entry = toSeasonEntry(item);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

export function loadSeasonCalendar(path?: string): SeasonCalendarEntry[] {
  const file = typeof path === "string" && path.length > 0 ? path : DEFAULT_CALENDAR_PATH;
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  try {
    return parseCalendarText(raw);
  } catch {
    return [];
  }
}

export function timingSignals(
  lead: TimingLead,
  observations: TimingObservation[],
  now: Date | string,
  calendar?: SeasonCalendar | SeasonCalendarEntry[],
): TimingFlag[] {
  const flags: TimingFlag[] = [];
  const nowMsValue = toNowMs(now);
  const list: TimingObservation[] = Array.isArray(observations) ? observations : [];

  const listing = mostRecentInWindow(list, "first-seen", nowMsValue, NEW_LISTING_DAYS);
  if (listing !== undefined) {
    flags.push({
      flag: "new-listing",
      url: listing.url,
      dates: [listing.date],
      sentence: `First seen on ${listing.date}; a new listing within the last ${NEW_LISTING_DAYS} days.`,
    });
  }

  const hiring = hiringSpreeFlag(list, nowMsValue);
  if (hiring !== undefined) flags.push(hiring);

  const ad = mostRecentInWindow(list, "ad-start", nowMsValue, AD_DAYS);
  if (ad !== undefined) {
    flags.push({
      flag: "new-ad-campaign",
      url: ad.url,
      dates: [ad.date],
      sentence: `New ad campaign started on ${ad.date}.`,
    });
  }

  const reviews = reviewsMomentumFlag(list);
  if (reviews !== undefined) flags.push(reviews);

  const leadCategory = typeof lead.category === "string" ? lead.category : "";
  const leadCountry = typeof lead.country === "string" ? lead.country : "";
  const wanted = normaliseCategory(leadCategory);
  if (wanted.length > 0) {
    const leadCountryNorm = leadCountry.trim().toLowerCase();
    for (const entry of entriesOf(calendar)) {
      if (normaliseCategory(entry.category) !== wanted) continue;
      if (leadCountryNorm.length > 0) {
        const entryCountry = entry.country.trim().toLowerCase();
        if (entryCountry.length > 0 && entryCountry !== leadCountryNorm) continue;
      }
      const season = seasonFlagForEntry(entry, nowMsValue);
      if (season !== undefined) flags.push(season);
    }
  }

  return flags;
}

export function reachOutNow(
  _lead: TimingLead,
  flags: TimingFlag[],
): { now: boolean; why: string[]; score: number } {
  const list: TimingFlag[] = Array.isArray(flags) ? flags : [];
  const distinct = new Set<string>();
  const why: string[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    if (typeof item.flag !== "string" || typeof item.sentence !== "string") continue;
    distinct.add(item.flag);
    why.push(item.sentence);
  }
  const score = Math.min(distinct.size * FLAG_WEIGHT, REACH_SCORE_CAP);
  return { now: distinct.size > 0, why, score };
}
