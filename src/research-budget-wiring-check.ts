import { snapshotOf, findingBetween, closeStepWith, type StepSnapshot } from "./research-budget-wiring.js";
import {
  startBudget,
  shouldContinue,
  STOP_EMPTY_STEPS,
  type BudgetState,
  type LeadBudget,
} from "./research-budget.js";
import type { Enrichment } from "./types.js";
import type { ResearchEvidence } from "./research.js";

const LARGE_MAX_STEPS = 1000;
const LARGE_MAX_CALLS = 100000;
const LARGE_MAX_SECONDS = 100000;

let anyFail = false;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    console.log(`FAIL ${name}`);
    anyFail = true;
  }
}

const evidenceItem = (id: string): ResearchEvidence => ({
  id,
  kind: "page-text",
  url: "https://example.com",
  quote: "quote",
  fetchedAt: "2026-01-01T00:00:00.000Z",
  channel: "web",
  untrusted: true,
});

const enrichmentFixture: Enrichment = {
  summary: "fixture",
  emails: ["a@example.com"],
  phones: ["111", "222"],
  socials: {},
  signals: ["s1", "s2", "s3"],
};

const evidenceFour: ResearchEvidence[] = [
  evidenceItem("E1"),
  evidenceItem("E2"),
  evidenceItem("E3"),
  evidenceItem("E4"),
];

const snap = snapshotOf(enrichmentFixture, evidenceFour);
check("snapshotOf enrichment contacts", snap.contacts === 3);
check("snapshotOf enrichment signals", snap.signals === 3);
check("snapshotOf enrichment evidence", snap.evidence === 4);

const snapZero = snapshotOf(undefined, []);
check("snapshotOf undefined all zero evidence", snapZero.evidence === 0);
check("snapshotOf undefined all zero contacts", snapZero.contacts === 0);
check("snapshotOf undefined all zero signals", snapZero.signals === 0);

const a: StepSnapshot = { evidence: 1, contacts: 1, signals: 1 };
const bContact: StepSnapshot = { evidence: 1, contacts: 2, signals: 1 };
const fContact = findingBetween(a, bContact);
check("findingBetween new contact verifiedContact", fContact.verifiedContact === true);
check("findingBetween new contact citableItems", fContact.citableItems === 0);
check("findingBetween new contact signals", fContact.signals === 0);

const bEvidence: StepSnapshot = { evidence: 3, contacts: 1, signals: 1 };
const fEvidence = findingBetween(a, bEvidence);
check("findingBetween new evidence verifiedContact", fEvidence.verifiedContact === false);
check("findingBetween new evidence citableItems", fEvidence.citableItems === 2);
check("findingBetween new evidence signals", fEvidence.signals === 0);

const bSignal: StepSnapshot = { evidence: 1, contacts: 1, signals: 3 };
const fSignal = findingBetween(a, bSignal);
check("findingBetween new signal verifiedContact", fSignal.verifiedContact === false);
check("findingBetween new signal citableItems", fSignal.citableItems === 0);
check("findingBetween new signal signals", fSignal.signals === 2);

const same: StepSnapshot = { evidence: 2, contacts: 2, signals: 2 };
const fNone = findingBetween(same, same);
check("findingBetween nothing new verifiedContact", fNone.verifiedContact === false);
check("findingBetween nothing new citableItems", fNone.citableItems === 0);
check("findingBetween nothing new signals", fNone.signals === 0);

const beforeBig: StepSnapshot = { evidence: 5, contacts: 5, signals: 5 };
const afterSmall: StepSnapshot = { evidence: 1, contacts: 2, signals: 0 };
const fDec = findingBetween(beforeBig, afterSmall);
check("findingBetween decrease verifiedContact", fDec.verifiedContact === false);
check("findingBetween decrease citableItems no negative", fDec.citableItems === 0);
check("findingBetween decrease signals no negative", fDec.signals === 0);

let threw = false;
try {
  closeStepWith(undefined, a, bContact, 5, 7);
} catch (err) {
  threw = true;
  console.log("unexpected", err);
}
check("closeStepWith undefined does nothing and does not throw", !threw);

const largeBudget: LeadBudget = {
  maxSteps: LARGE_MAX_STEPS,
  maxCalls: LARGE_MAX_CALLS,
  maxSeconds: LARGE_MAX_SECONDS,
  reason: "test",
};
const state = startBudget(largeBudget);
const callsSpent = 3;
const secondsSpent = 5;
closeStepWith(state, snapZero, snapZero, callsSpent, secondsSpent);
check("closeStepWith advances stepsUsed", state.stepsUsed === 1);
check("closeStepWith adds callsUsed", state.callsUsed === callsSpent);
check("closeStepWith adds elapsedSeconds", state.elapsedSeconds === secondsSpent);

const emptyState = startBudget(largeBudget);
closeStepWith(emptyState, snapZero, snapZero, 0, 0);
closeStepWith(emptyState, snapZero, snapZero, 0, 0);
const verdictEmpty = shouldContinue(emptyState);
check("two empty steps continue false", verdictEmpty.continue === false);
check("two empty steps reason empty-steps", verdictEmpty.reason === STOP_EMPTY_STEPS);

const negState = startBudget(largeBudget);
closeStepWith(negState, snapZero, snapZero, 0, 0);
const usefulAfter: StepSnapshot = { evidence: 0, contacts: 1, signals: 0 };
closeStepWith(negState, snapZero, usefulAfter, 1, 1);
check("negative control emptyStepsInRow 0", negState.emptyStepsInRow === 0);
check("negative control shouldContinue true", shouldContinue(negState).continue === true);

if (anyFail) process.exit(1);
