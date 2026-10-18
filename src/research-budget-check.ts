// src/research-budget-check.ts
// L30-wiring-3 offline proof for research-budget.ts. No network, no database, no env.
// Run from the repo root:
//   npx tsx src/research-budget-check.ts
// Prints PASS/FAIL per check; exit code is 1 when any check fails.

import {
  BUDGET_PERCENTILE,
  CALLS_PER_STEP,
  DEFAULT_STEPS,
  EMPTY_STEPS_TO_STOP,
  FULL_DEPTH_STEPS,
  MAX_CALLS,
  MAX_SECONDS,
  MIN_STEPS,
  calibrate,
  noteStep,
  planBudget,
  shouldContinue,
  startBudget,
  summarize,
} from "./research-budget.js";

function report(name: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: ${detail}`}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

function run(): void {
  // (1) Constants match the order: default 4 steps, 2 empty steps stop, 0.8
  // percentile, floor 1 step, cap 12 calls / 60 seconds.
  report(
    "constants match the order",
    DEFAULT_STEPS === 4 &&
      EMPTY_STEPS_TO_STOP === 2 &&
      BUDGET_PERCENTILE === 0.8 &&
      MIN_STEPS === 1 &&
      MAX_CALLS === 12 &&
      MAX_SECONDS === 60,
    JSON.stringify({ DEFAULT_STEPS, EMPTY_STEPS_TO_STOP, BUDGET_PERCENTILE, MIN_STEPS, MAX_CALLS, MAX_SECONDS }),
  );

  // (2) A high-value lead gets a bigger budget than a low-value one.
  const high = planBudget(
    { category: "dental-clinic", score: 85, website: "https://high.example/", phone: "+919876543210" },
    { priority: "high" },
    {},
  );
  const low = planBudget({ category: "dental-clinic", score: 20 }, { priority: "low" }, {});
  report(
    "high-value lead gets a bigger budget than a low-value lead",
    high.maxSteps > low.maxSteps && high.maxCalls > low.maxCalls && high.maxSeconds > low.maxSeconds,
    JSON.stringify({ high, low }),
  );

  // (3) Floor and cap: the richest lead never exceeds 12 calls / 60 seconds,
  // the poorest never drops below 1 step.
  const richest = planBudget(
    {
      category: "dental-clinic",
      score: 100,
      fit: [{ score: 100 }],
      website: "https://rich.example/",
      phone: "+919876543210",
      email: "owner@rich.example",
    },
    { priority: "high" },
    {},
  );
  const poorest = planBudget({ category: "salon", score: 0 }, { priority: "low" }, {});
  report(
    "budget floor 1 step and cap 12 calls / 60 seconds",
    richest.maxCalls === MAX_CALLS &&
      richest.maxSeconds === MAX_SECONDS &&
      poorest.maxSteps >= MIN_STEPS &&
      low.maxCalls <= MAX_CALLS &&
      low.maxSeconds <= MAX_SECONDS,
    JSON.stringify({ richest, poorest }),
  );

  // (4) Two consecutive empty steps (no verified contact, no citable item, no
  // signal) stop research; one empty step does not; a useful step resets the run.
  const watch = startBudget(planBudget({ category: "salon", score: 60 }, {}, {}));
  noteStep(watch, { verifiedContact: false, citableItems: 0, signals: 0 }, 1, 5);
  const afterOne = shouldContinue(watch);
  report(
    "one empty step does not stop",
    afterOne.continue === true && watch.emptyStepsInRow === 1,
    JSON.stringify(afterOne),
  );
  noteStep(watch, { verifiedContact: false, citableItems: 0, signals: 0 }, 1, 5);
  const afterTwo = shouldContinue(watch);
  report(
    "two consecutive empty steps stop",
    afterTwo.continue === false &&
      afterTwo.reason === "empty-steps" &&
      watch.emptyStepsInRow === EMPTY_STEPS_TO_STOP,
    JSON.stringify(afterTwo),
  );
  noteStep(watch, { verifiedContact: true, citableItems: 1, signals: 1 }, 1, 5);
  const afterUseful = shouldContinue(watch);
  report(
    "a useful step resets the empty run",
    afterUseful.continue === true && watch.emptyStepsInRow === 0,
    JSON.stringify(afterUseful),
  );

  // (5) A spent step, call, or time budget stops research even when every step
  // was useful.
  const tiny = planBudget({ category: "salon", score: 10 }, { priority: "low" }, {});
  const spentSteps = startBudget(tiny);
  for (let i = 0; i < tiny.maxSteps; i += 1) {
    noteStep(spentSteps, { verifiedContact: true, citableItems: 1, signals: 0 }, 1, 1);
  }
  const stepVerdict = shouldContinue(spentSteps);
  const spentCalls = startBudget(tiny);
  spentCalls.callsUsed = tiny.maxCalls;
  const callVerdict = shouldContinue(spentCalls);
  const spentTime = startBudget(tiny);
  spentTime.elapsedSeconds = tiny.maxSeconds;
  const timeVerdict = shouldContinue(spentTime);
  report(
    "spent step/call/time budget stops",
    stepVerdict.continue === false &&
      stepVerdict.reason === "budget-spent" &&
      callVerdict.continue === false &&
      callVerdict.reason === "budget-spent" &&
      timeVerdict.continue === false &&
      timeVerdict.reason === "budget-spent",
    JSON.stringify({ stepVerdict, callVerdict, timeVerdict }),
  );

  // (6) Calibration on a fixture history: per-category averages plus the 80th
  // percentile default (sorted [2,4,6,6,6,8], rank ceil(0.8*6)-1 = 4 -> 6);
  // no history means the default of 4 steps.
  const history = [
    { category: "dental-clinic", lastUsefulStep: 2 },
    { category: "dental-clinic", lastUsefulStep: 4 },
    { category: "salon", lastUsefulStep: 6 },
    { category: "salon", lastUsefulStep: 6 },
    { category: "salon", lastUsefulStep: 6 },
    { category: "restaurant", lastUsefulStep: 8 },
  ];
  const cal = calibrate(history);
  report(
    "fixture calibration gives the expected depth",
    cal.defaultSteps === 6 &&
      cal.byCategory["dental-clinic"] === 3 &&
      cal.byCategory["salon"] === 6 &&
      cal.byCategory["restaurant"] === 8,
    JSON.stringify(cal),
  );
  const empty = calibrate([]);
  report(
    "no history means the default 4 steps",
    empty.defaultSteps === DEFAULT_STEPS && Object.keys(empty.byCategory).length === 0,
    JSON.stringify(empty),
  );

  // (7) Saving arithmetic: 2 steps / 5 calls used against the full depth of 12
  // steps leaves 10 steps and (12 - 5) calls saved, with the stop reason kept.
  const lead = startBudget(
    planBudget({ category: "dental-clinic", score: 90, website: "https://save.example/" }, { priority: "high" }, {}),
  );
  noteStep(lead, { verifiedContact: true, citableItems: 2, signals: 1 }, 3, 10);
  noteStep(lead, { verifiedContact: false, citableItems: 0, signals: 0 }, 2, 7);
  const summary = summarize(lead, FULL_DEPTH_STEPS);
  const fullCalls = Math.min(MAX_CALLS, FULL_DEPTH_STEPS * CALLS_PER_STEP);
  report(
    "saving figure arithmetic",
    summary.callsUsed === 5 &&
      summary.stepsUsed === 2 &&
      summary.stepsSkipped === FULL_DEPTH_STEPS - 2 &&
      summary.savedCalls === fullCalls - 5 &&
      summary.reason === shouldContinue(lead).reason,
    JSON.stringify(summary),
  );
}

try {
  run();
} catch (err) {
  console.log(`FAIL research-budget-check crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
