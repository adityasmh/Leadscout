// src/trust-shared-prior.ts
// Order XCW-trust-prior-wiring: published cross-customer lessons as a shared
// prior for source trust.
//
// A thin, cached, never-throwing wrapper over shared-lessons' priorForTrust
// (order XC1). While data/shared-lessons.json is unpublished (the real case
// today) every lookup returns undefined, so the caller keeps behaving exactly
// as before. Results live in a module-level Map for CACHE_MS milliseconds per
// channel + category pair, including undefined results, so a published lesson
// cannot make lookup costs grow with the number of trust() calls.
//
// Node 24 built-ins only; ES modules with .js import suffixes; no network.

import { priorForTrust } from "./shared-lessons.js";

/** How long one channel + category answer stays cached, in milliseconds. */
export const CACHE_MS = 60000;

/** Cache keys carry channel and category; the NUL byte cannot occur in
 * either value, so the pair cannot collide with a different pair. */
const KEY_SEPARATOR = "\u0000";

export type SharedPriorLookup = (channel: string, category: string) => number | undefined;

/** Same shape under the name source-trust.ts imports it by. */
export type PriorLookup = SharedPriorLookup;

type CacheEntry = { at: number; value: number | undefined };

const cache = new Map<string, CacheEntry>();

/** Test hook: forget every cached pair so the next lookup runs again. */
export function clearSharedPriorCache(): void {
  cache.clear();
}

/** Published verified-contact rate (0..1) for one channel in one category, or
 * undefined when nothing usable is published for that pair.
 *
 * Never throws. A lookup that throws yields undefined and is not cached, so a
 * transient failure is retried on the next call. A value is returned only when
 * it is finite and strictly inside (0, 1); 0, 1, NaN and non-numbers are
 * ignored, which leaves the caller on its own seed prior. */
export function sharedTrustPrior(
  channel: string,
  category: string,
  lookup: SharedPriorLookup = priorForTrust
): number | undefined {
  const key = `${channel}${KEY_SEPARATOR}${category}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;

  let value: number | undefined;
  try {
    value = lookup(channel, category);
  } catch {
    return undefined; // a failed lookup is not cached; the next call retries
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    value = undefined;
  }
  cache.set(key, { at: now, value });
  return value;
}
