// src/research-budget-wiring.ts
import type { Enrichment } from "./types.js";
import type { ResearchEvidence } from "./research.js";
import type { StepFinding, BudgetState } from "./research-budget.js";
import { noteStep } from "./research-budget.js";

export type StepSnapshot = {
  evidence: number;
  contacts: number;
  signals: number;
};

export function snapshotOf(
  enrichment: Enrichment | undefined,
  evidence: ResearchEvidence[],
): StepSnapshot {
  if (enrichment === undefined) {
    return { evidence: evidence.length, contacts: 0, signals: 0 };
  }
  return {
    evidence: evidence.length,
    contacts: enrichment.phones.length + enrichment.emails.length,
    signals: enrichment.signals.length,
  };
}

export function findingBetween(
  before: StepSnapshot,
  after: StepSnapshot,
): StepFinding {
  // verifiedContact means a NEW phone or email appeared and real verification happens later in the pipeline
  return {
    verifiedContact: after.contacts > before.contacts,
    citableItems: Math.max(0, after.evidence - before.evidence),
    signals: Math.max(0, after.signals - before.signals),
  };
}

export function closeStepWith(
  budget: BudgetState | undefined,
  before: StepSnapshot,
  after: StepSnapshot,
  callsSpent: number,
  secondsSpent: number,
): void {
  if (budget === undefined) return;
  noteStep(budget, findingBetween(before, after), callsSpent, secondsSpent);
}
