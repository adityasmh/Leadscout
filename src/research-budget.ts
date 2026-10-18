// src/research-budget.ts
// L30-wiring-3: budgeted research depth for Leadscout.
// Assigns each lead a call/time budget from its value (planBudget), stops a lead's
// research when the next lookup adds little (shouldContinue: two consecutive steps with
// no new verified contact, no new citable item and no new signal, or the step/call/time
// budget spent), reports the job result (summarize: calls used, steps skipped, reason,
// saving versus the full depth), and tunes the default depth from history (calibrate:
// per-category average steps before the last useful finding, default at the 80th
// percentile, DEFAULT_STEPS when there is no history).
//
// Context (read-only): docs/PITFALLS.md, docs/leadgen/CONTRACT.md,
// docs/leadgen/PLAN_V2.md; shapes of RawLead/Match/LeadScore in src/
// (types.ts, types-v2.ts, store.ts, tenant.ts, pipeline.ts, dossier.ts) were read via
// grep. The lead/brief shapes below are local and structural so this module stays
// dependency-free: Node 24 built-ins only, ES module, no local imports.

export const DEFAULT_STEPS = 4;
export const EMPTY_STEPS_TO_STOP = 2;
export const BUDGET_PERCENTILE = 0.8;
export const MIN_STEPS = 1;
export const MAX_CALLS = 12;
export const MAX_SECONDS = 60;
export const CALLS_PER_STEP = 3;
export const SECONDS_PER_STEP = 15;
export const FULL_DEPTH_STEPS = 12;
export const HIGH_VALUE_SCORE = 70;
export const MID_VALUE_SCORE = 50;
export const LOW_VALUE_SCORE = 35;
export const HIGH_VALUE_BONUS_STEPS = 2;
export const MID_VALUE_BONUS_STEPS = 1;
export const LOW_VALUE_PENALTY_STEPS = 1;
export const PRIORITY_BONUS_STEPS = 2;
export const PRIORITY_PENALTY_STEPS = 1;
export const WEBSITE_BONUS_STEPS = 1;
export const CONTACT_BONUS_STEPS = 1;

export const STOP_EMPTY_STEPS = "empty-steps";
export const STOP_BUDGET_SPENT = "budget-spent";
export const GO_CONTINUE = "continue";

// Structural subset of a lead: fit/score so far (match), category, reachability.
// A full Lead (types.ts) or RawLead satisfies this shape.
export type BudgetLead = {
  category: string;
  score?: number;
  fit?: Array<{ score: number }>;
  website?: string;
  phone?: string;
  email?: string;
  phones?: string[];
  emails?: string[];
};

export type BriefPriority = "low" | "normal" | "high";

export type BudgetBrief = {
  priority?: BriefPriority;
  maxCalls?: number;
  maxSeconds?: number;
};

export type JobBudget = {
  maxCalls?: number;
  maxSeconds?: number;
  maxSteps?: number;
};

export type LeadBudget = {
  maxSteps: number;
  maxCalls: number;
  maxSeconds: number;
  reason: string;
};

function isUsefulNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function bestScore(lead: BudgetLead): number {
  let best = 0;
  if (isUsefulNumber(lead.score)) best = lead.score;
  for (const item of lead.fit ?? []) {
    if (isUsefulNumber(item.score) && item.score > best) best = item.score;
  }
  return best;
}

function hasContact(lead: BudgetLead): boolean {
  const phones = [...(lead.phones ?? [])];
  if (nonEmpty(lead.phone)) phones.push(lead.phone);
  const emails = [...(lead.emails ?? [])];
  if (nonEmpty(lead.email)) emails.push(lead.email);
  return phones.some(nonEmpty) || emails.some(nonEmpty);
}

// Plan one lead's budget from its value: fit/score so far, brief priority,
// reachability (a website to read, a contact route worth verifying). Steps are
// clamped to [MIN_STEPS, FULL_DEPTH_STEPS]; calls/seconds follow from the steps
// (CALLS_PER_STEP / SECONDS_PER_STEP per step) capped at MAX_CALLS / MAX_SECONDS,
// further capped by the brief and job budgets. High-value leads get more steps,
// so more calls and seconds, than low-value ones.
export function planBudget(lead: BudgetLead, brief: BudgetBrief = {}, jobBudget: JobBudget = {}): LeadBudget {
  const value = bestScore(lead);
  let steps = DEFAULT_STEPS;
  const reasons: string[] = [];
  if (value >= HIGH_VALUE_SCORE) {
    steps += HIGH_VALUE_BONUS_STEPS;
    reasons.push(`high value score ${value}`);
  } else if (value >= MID_VALUE_SCORE) {
    steps += MID_VALUE_BONUS_STEPS;
    reasons.push(`mid value score ${value}`);
  } else if (value < LOW_VALUE_SCORE) {
    steps -= LOW_VALUE_PENALTY_STEPS;
    reasons.push(`low value score ${value}`);
  }
  if (brief.priority === "high") {
    steps += PRIORITY_BONUS_STEPS;
    reasons.push("high brief priority");
  } else if (brief.priority === "low") {
    steps -= PRIORITY_PENALTY_STEPS;
    reasons.push("low brief priority");
  }
  if (nonEmpty(lead.website)) {
    steps += WEBSITE_BONUS_STEPS;
    reasons.push("website to read");
  }
  if (hasContact(lead)) {
    steps += CONTACT_BONUS_STEPS;
    reasons.push("reachable contact");
  }
  if (isUsefulNumber(jobBudget.maxSteps)) {
    steps = Math.min(steps, Math.max(Math.floor(jobBudget.maxSteps), MIN_STEPS));
  }
  steps = Math.min(Math.max(steps, MIN_STEPS), FULL_DEPTH_STEPS);
  let maxCalls = Math.min(MAX_CALLS, steps * CALLS_PER_STEP);
  let maxSeconds = Math.min(MAX_SECONDS, steps * SECONDS_PER_STEP);
  if (isUsefulNumber(brief.maxCalls)) maxCalls = Math.min(maxCalls, Math.max(0, Math.floor(brief.maxCalls)));
  if (isUsefulNumber(brief.maxSeconds)) maxSeconds = Math.min(maxSeconds, Math.max(0, Math.floor(brief.maxSeconds)));
  if (isUsefulNumber(jobBudget.maxCalls)) maxCalls = Math.min(maxCalls, Math.max(0, Math.floor(jobBudget.maxCalls)));
  if (isUsefulNumber(jobBudget.maxSeconds)) {
    maxSeconds = Math.min(maxSeconds, Math.max(0, Math.floor(jobBudget.maxSeconds)));
  }
  const head = reasons.length > 0 ? reasons.join("; ") : "default depth";
  return { maxSteps: steps, maxCalls, maxSeconds, reason: `${head}; steps ${steps}` };
}

// Live per-lead state threaded through the research steps. ResearchBudget is the
// handle research.ts carries as its optional deps.budget field.
export type StepFinding = {
  verifiedContact: boolean;
  citableItems: number;
  signals: number;
};

export type BudgetState = {
  budget: LeadBudget;
  stepsUsed: number;
  callsUsed: number;
  elapsedSeconds: number;
  emptyStepsInRow: number;
};

export type ResearchBudget = BudgetState;

export function startBudget(budget: LeadBudget): BudgetState {
  return { budget, stepsUsed: 0, callsUsed: 0, elapsedSeconds: 0, emptyStepsInRow: 0 };
}

// Record one finished research step. A step is useful when it added a new verified
// contact, a new citable item, or a new signal; otherwise the empty run grows.
export function noteStep(
  state: BudgetState,
  finding: StepFinding,
  callsSpent: number,
  secondsSpent: number,
): BudgetState {
  state.stepsUsed += 1;
  state.callsUsed += Math.max(0, callsSpent);
  state.elapsedSeconds += Math.max(0, secondsSpent);
  const useful = finding.verifiedContact || finding.citableItems > 0 || finding.signals > 0;
  state.emptyStepsInRow = useful ? 0 : state.emptyStepsInRow + 1;
  return state;
}

export type ContinueVerdict = { continue: boolean; reason: string };

// Value-of-information rule: stop after EMPTY_STEPS_TO_STOP consecutive empty steps,
// or when the step, call, or time budget is spent.
export function shouldContinue(state: BudgetState): ContinueVerdict {
  if (state.emptyStepsInRow >= EMPTY_STEPS_TO_STOP) return { continue: false, reason: STOP_EMPTY_STEPS };
  if (state.stepsUsed >= state.budget.maxSteps) return { continue: false, reason: STOP_BUDGET_SPENT };
  if (state.callsUsed >= state.budget.maxCalls) return { continue: false, reason: STOP_BUDGET_SPENT };
  if (state.elapsedSeconds >= state.budget.maxSeconds) return { continue: false, reason: STOP_BUDGET_SPENT };
  return { continue: true, reason: GO_CONTINUE };
}

export type BudgetSummary = {
  callsUsed: number;
  stepsUsed: number;
  stepsSkipped: number;
  savedCalls: number;
  reason: string;
};

// Job result for one lead: what was spent, what was skipped versus the full depth,
// how many calls that saved, and why research stopped.
export function summarize(state: BudgetState, fullDepthSteps: number = FULL_DEPTH_STEPS): BudgetSummary {
  const full = Math.max(MIN_STEPS, Math.floor(fullDepthSteps));
  const fullCalls = Math.min(MAX_CALLS, full * CALLS_PER_STEP);
  const verdict = shouldContinue(state);
  return {
    callsUsed: state.callsUsed,
    stepsUsed: state.stepsUsed,
    stepsSkipped: Math.max(0, full - state.stepsUsed),
    savedCalls: Math.max(0, fullCalls - state.callsUsed),
    reason: verdict.reason,
  };
}

export type HistoryEntry = { category: string; lastUsefulStep: number };

export type Calibration = { byCategory: Record<string, number>; defaultSteps: number };

function clampStep(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_STEPS;
  return Math.min(MAX_CALLS, Math.max(MIN_STEPS, Math.floor(value)));
}

// Tune depths from history: per-category average steps before the last useful
// finding, default depth at the BUDGET_PERCENTILE percentile of all entries.
// No history means DEFAULT_STEPS.
export function calibrate(history: HistoryEntry[]): Calibration {
  const byCategory: Record<string, number> = {};
  if (history.length === 0) return { byCategory, defaultSteps: DEFAULT_STEPS };
  const groups = new Map<string, number[]>();
  const all: number[] = [];
  for (const entry of history) {
    const step = clampStep(entry.lastUsefulStep);
    all.push(step);
    const list = groups.get(entry.category);
    if (list) list.push(step);
    else groups.set(entry.category, [step]);
  }
  for (const [category, list] of groups) {
    const total = list.reduce((sum, value) => sum + value, 0);
    byCategory[category] = Math.max(MIN_STEPS, Math.round(total / list.length));
  }
  const sorted = [...all].sort((a, b) => a - b);
  const rank = Math.ceil(BUDGET_PERCENTILE * sorted.length) - 1;
  const picked: number = sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] ?? DEFAULT_STEPS;
  return { byCategory, defaultSteps: clampStep(picked) };
}
