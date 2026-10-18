// src/pipeline-timing.ts
// Pipeline-side wrapper over ./timing.js: turns dated timing flags into stable
// "timing:<flag>" signal ids that can be merged into a lead's signal list.
// Pure, offline, and it never throws: a caller that passes bad input or a broken
// season calendar gets empty results instead of a failed pipeline stage.

import { loadSeasonCalendar, reachOutNow, timingSignals } from "./timing.js";
import type {
  SeasonCalendar,
  SeasonCalendarEntry,
  TimingFlag,
  TimingLead,
  TimingObservation,
} from "./timing.js";

// Re-exported so pipeline callers compare against the same window the flag uses.
export { SEASON_LOOKAHEAD_DAYS } from "./timing.js";

export type PipelineTimingLead = { category?: string; country?: string };

export type PipelineTiming = {
  signals: string[];
  flags: TimingFlag[];
  reachOutNow: boolean;
  why: string[];
};

export const TIMING_SIGNAL_PREFIX = "timing:";

let cachedEntries: SeasonCalendarEntry[] | undefined;

function calendarFor(calendar: SeasonCalendar | SeasonCalendarEntry[] | undefined): SeasonCalendar | SeasonCalendarEntry[] {
  if (calendar !== undefined) return calendar;
  if (cachedEntries === undefined) cachedEntries = loadSeasonCalendar();
  return cachedEntries;
}

function toTimingLead(lead: PipelineTimingLead): TimingLead {
  const category = typeof lead?.category === "string" ? lead.category : "";
  const country = typeof lead?.country === "string" ? lead.country : "";
  return country.length > 0 ? { category, country } : { category };
}

function observedList(observations: TimingObservation[] | undefined): TimingObservation[] {
  return Array.isArray(observations) ? observations : [];
}

function signalsFor(flags: TimingFlag[]): string[] {
  const seen = new Set<string>();
  const signals: string[] = [];
  for (const item of flags) {
    if (item === null || typeof item !== "object") continue;
    const name = typeof item.flag === "string" ? item.flag : "";
    if (name.length === 0) continue;
    const signal = `${TIMING_SIGNAL_PREFIX}${name}`;
    if (seen.has(signal)) continue;
    seen.add(signal);
    signals.push(signal);
  }
  return signals;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

/**
 * Timing for one lead: dated flags, the "timing:" signal ids they map to,
 * whether to reach out now, and the sentences explaining why.
 * The season calendar is loaded once and cached when `calendar` is omitted.
 */
export function timingForLead(
  lead: PipelineTimingLead,
  observations: TimingObservation[],
  now: Date | string,
  calendar?: SeasonCalendar | SeasonCalendarEntry[],
): PipelineTiming {
  try {
    const flags = timingSignals(toTimingLead(lead), observedList(observations), now, calendarFor(calendar));
    const reach = reachOutNow(toTimingLead(lead), flags);
    return {
      signals: signalsFor(flags),
      flags,
      reachOutNow: reach.now,
      why: Array.isArray(reach.why) ? [...reach.why] : [],
    };
  } catch (error) {
    return { signals: [], flags: [], reachOutNow: false, why: [`timing unavailable: ${messageOf(error)}`] };
  }
}

/**
 * Union of two signal lists: `existing` order first, then new ids from `extra`,
 * no duplicates in either direction. Neither input is mutated.
 */
export function mergeSignals(existing: string[] | undefined, extra: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const add = (item: unknown): void => {
    if (typeof item !== "string" || item.length === 0) return;
    if (seen.has(item)) return;
    seen.add(item);
    merged.push(item);
  };
  if (Array.isArray(existing)) for (const item of existing) add(item);
  if (Array.isArray(extra)) for (const item of extra) add(item);
  return merged;
}
