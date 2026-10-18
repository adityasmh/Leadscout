// src/trust-shared-prior-check.ts
// Order XCW-trust-prior-wiring: offline proof that the shared cross-customer
// prior is wired into source-trust.ts exactly as ordered.
//
// No network, no live DB, no real data file: LEADSCOUT_SOURCE_TRUST_PATH points
// at a temp file under os.tmpdir() and every case gets its own fresh store,
// following the pattern of source-trust-check.ts. Prints PASS/FAIL per item and
// a summary. Run (once, foreground):
//   npx tsx src/trust-shared-prior-check.ts
//
// This script imports nothing from src/company/, so the sandbox-company-root
// first import (PITFALLS #1) is not needed.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "trust-shared-prior-check-"));
const storeFile = join(tmpRoot, "data", "source-trust.json");
process.env.LEADSCOUT_SOURCE_TRUST_PATH = storeFile;

const st = await import("./source-trust.js");
const tsp = await import("./trust-shared-prior.js");

// Each isolated block gets its own temp store file, so persisted outcomes from
// one block never leak into another.
let storeSeq = 0;
function freshStore(): void {
  storeSeq += 1;
  process.env.LEADSCOUT_SOURCE_TRUST_PATH = join(tmpRoot, "data", `source-trust-${storeSeq}.json`);
  st.resetSourceTrust();
}

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes += 1;
    console.log(`PASS ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

// ----------------------------------------------------------------- constants

/** Channel used throughout: has a channel prior and no category override. */
const CHANNEL = "justdial";
const CATEGORY = "dentist";

/** data/source-trust-seed.json: prior for CHANNEL (also its default prior). */
const SEED_CHANNEL_PRIOR = 0.5;
/** data/source-trust-seed.json: no per-category override for CHANNEL. */
const SEED_CATEGORY_PRIOR = 0.5;

/** Injected published lesson value used by the "higher and halfway" case. */
const SHARED_VALUE = 0.9;
/** Halfway blend between the shared value and the local seed. */
const SHARED_PRIOR_WEIGHT = 0.5;
/** Values the lookup layer must treat as "nothing published". */
const IGNORED_ZERO = 0;
const IGNORED_ONE = 1;
const EPS = 1e-9;

const NOW = new Date("2026-10-12T00:00:00Z");

/** Prior weight (pseudo-observations) from the seed file, not a literal. */
const PRIOR_WEIGHT = st.pseudoObservations();

/** Score the module must return for a given category prior mean when nothing
 * is observed for the channel: priorBeta(mean, weight) plus the shrinkage term
 * toward the (unobserved) channel average. */
function scoreAtZeroObservations(priorMean: number): number {
  const alpha = PRIOR_WEIGHT * priorMean + PRIOR_WEIGHT * SEED_CHANNEL_PRIOR;
  const beta = PRIOR_WEIGHT * (1 - priorMean) + PRIOR_WEIGHT * (1 - SEED_CHANNEL_PRIOR);
  return alpha / (alpha + beta);
}

const SEED_SCORE = scoreAtZeroObservations(SEED_CATEGORY_PRIOR);

/** A lookup that counts how many times it was invoked. */
function countingLookup(value: number): { lookup: () => number; calls: () => number } {
  let calls = 0;
  return {
    lookup: () => {
      calls += 1;
      return value;
    },
    calls: () => calls,
  };
}

// ------------------------------------- case 1: undefined == omitted == seed
{
  freshStore();
  tsp.clearSharedPriorCache();
  const omitted = st.trust(CHANNEL, CATEGORY, { now: NOW });
  const undefinedShared = st.trust(CHANNEL, CATEGORY, {
    now: NOW,
    sharedPrior: () => undefined,
  });
  check(
    "undefined lookup: same score as the option omitted",
    near(omitted.score, undefinedShared.score, EPS),
    `omitted=${omitted.score.toFixed(6)} undefined=${undefinedShared.score.toFixed(6)}`
  );
  check(
    "undefined lookup: score equals the seed-computed value",
    near(undefinedShared.score, SEED_SCORE, EPS),
    `score=${undefinedShared.score.toFixed(6)} seed=${SEED_SCORE.toFixed(6)}`
  );
  check(
    "undefined lookup: hasData stays false",
    omitted.hasData === false && undefinedShared.hasData === false
  );
}

// ------------------------- case 2: 0.9 raises and blends exactly halfway
{
  freshStore();
  tsp.clearSharedPriorCache();
  const seedOnly = st.trust(CHANNEL, CATEGORY, { now: NOW });
  const injected = countingLookup(SHARED_VALUE);
  const shared = st.trust(CHANNEL, CATEGORY, { now: NOW, sharedPrior: injected.lookup });

  const blendedPrior =
    SHARED_PRIOR_WEIGHT * SHARED_VALUE + (1 - SHARED_PRIOR_WEIGHT) * SEED_CATEGORY_PRIOR;
  const expectedScore = scoreAtZeroObservations(blendedPrior);

  check(
    "lookup 0.9: score is higher than the seed-only score",
    shared.score > seedOnly.score,
    `shared=${shared.score.toFixed(6)} seed=${seedOnly.score.toFixed(6)}`
  );
  check(
    "lookup 0.9: at zero observations the blend is exactly halfway",
    near(shared.score, expectedScore, EPS),
    `score=${shared.score.toFixed(6)} expected=${expectedScore.toFixed(6)} blendedPrior=${blendedPrior}`
  );
  tsp.clearSharedPriorCache();
  const direct = countingLookup(SHARED_VALUE);
  check(
    "lookup 0.9: sharedTrustPrior returns the usable value",
    tsp.sharedTrustPrior(CHANNEL, CATEGORY, direct.lookup) === SHARED_VALUE && direct.calls() === 1,
    `calls=${direct.calls()}`
  );
}

// ------------------------------------- case 3: 0, 1 and NaN are ignored
{
  const ignored: number[] = [IGNORED_ZERO, IGNORED_ONE, Number.NaN];
  for (const value of ignored) {
    // Through the wiring: the lookup layer turns the value into undefined and
    // trust() then keeps its seed prior exactly.
    freshStore();
    tsp.clearSharedPriorCache();
    const score = st.trust(CHANNEL, CATEGORY, {
      now: NOW,
      sharedPrior: (ch: string, cat: string) => tsp.sharedTrustPrior(ch, cat, () => value),
    });
    check(
      `lookup ${String(value)}: ignored, score equals the seed-only score`,
      near(score.score, SEED_SCORE, EPS),
      `score=${score.score.toFixed(6)} seed=${SEED_SCORE.toFixed(6)}`
    );
    // And at the lookup layer itself.
    tsp.clearSharedPriorCache();
    const prior = tsp.sharedTrustPrior(CHANNEL, CATEGORY, () => value);
    check(
      `lookup ${String(value)}: sharedTrustPrior returns undefined`,
      prior === undefined,
      `prior=${String(prior)}`
    );
  }
}

// ------------------------------------------ case 4: a throwing lookup is ignored
{
  freshStore();
  tsp.clearSharedPriorCache();
  const boom = (): number => {
    throw new Error("simulated lesson lookup failure");
  };
  let score: number;
  let threw = false;
  try {
    score = st.trust(CHANNEL, CATEGORY, {
      now: NOW,
      sharedPrior: (ch: string, cat: string) => tsp.sharedTrustPrior(ch, cat, boom),
    }).score;
  } catch {
    threw = true;
    score = Number.NaN;
  }
  check("throwing lookup: trust() does not throw", !threw);
  check(
    "throwing lookup: ignored, score equals the seed-only score",
    near(score, SEED_SCORE, EPS),
    `score=${score.toFixed(6)} seed=${SEED_SCORE.toFixed(6)}`
  );
  tsp.clearSharedPriorCache();
  let priorThrew = false;
  let prior: number | undefined;
  try {
    prior = tsp.sharedTrustPrior(CHANNEL, CATEGORY, boom);
  } catch {
    priorThrew = true;
  }
  check("throwing lookup: sharedTrustPrior does not throw", !priorThrew);
  check(
    "throwing lookup: sharedTrustPrior returns undefined",
    priorThrew === false && prior === undefined
  );
}

// ------------------------------------------------- case 5: the pair cache
{
  check("cache: CACHE_MS is 60000", tsp.CACHE_MS === 60000, `CACHE_MS=${tsp.CACHE_MS}`);

  freshStore();
  tsp.clearSharedPriorCache();
  const counting = countingLookup(SHARED_VALUE);
  const first = tsp.sharedTrustPrior(CHANNEL, CATEGORY, counting.lookup);
  const second = tsp.sharedTrustPrior(CHANNEL, CATEGORY, counting.lookup);
  check(
    "cache: two reads call the lookup once",
    counting.calls() === 1 && first === SHARED_VALUE && second === first,
    `calls=${counting.calls()} first=${String(first)} second=${String(second)}`
  );

  // A different pair is a different cache entry.
  const other = countingLookup(SHARED_VALUE);
  const otherValue = tsp.sharedTrustPrior(CHANNEL, "restaurant", other.lookup);
  check(
    "cache: a different category is a separate entry",
    otherValue === SHARED_VALUE && other.calls() === 1,
    `calls=${other.calls()} value=${String(otherValue)}`
  );

  tsp.clearSharedPriorCache();
  const third = tsp.sharedTrustPrior(CHANNEL, CATEGORY, counting.lookup);
  check(
    "cache: clearSharedPriorCache() forces a fresh lookup",
    counting.calls() === 2 && third === SHARED_VALUE,
    `calls=${counting.calls()} value=${String(third)}`
  );

  // Undefined results are cached too: a lookup that flips after the first
  // call must not be consulted again inside the TTL.
  freshStore();
  tsp.clearSharedPriorCache();
  let flips = 0;
  const flipping = (): number | undefined => {
    flips += 1;
    return flips === 1 ? undefined : SHARED_VALUE;
  };
  const flipFirst = tsp.sharedTrustPrior(CHANNEL, CATEGORY, flipping);
  const flipSecond = tsp.sharedTrustPrior(CHANNEL, CATEGORY, flipping);
  check(
    "cache: an undefined result is cached",
    flipFirst === undefined && flipSecond === undefined && flips === 1,
    `calls=${flips} first=${String(flipFirst)} second=${String(flipSecond)}`
  );
}

console.log("");
console.log(`Summary: ${passes} passed, ${failures} failed`);
if (failures === 0) {
  console.log("PASS trust-shared-prior-check (Order XCW-trust-prior-wiring)");
} else {
  console.log(`FAIL trust-shared-prior-check (Order XCW-trust-prior-wiring): ${failures} item(s) failed`);
  process.exitCode = 1;
}
