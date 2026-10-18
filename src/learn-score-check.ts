// src/learn-score-check.ts
// Offline proof for learn-score.ts. Sets LEADSCOUT_DB to a temp file BEFORE any module that
// opens the database is imported (all DB-touching modules are imported dynamically below).
// No src/company import, no network, no real data.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FitService, Lead } from "./types.js";
import type { Verification } from "./types-v2.js";

const dir = mkdtempSync(join(tmpdir(), "leadscout-learn-"));
process.env.LEADSCOUT_DB = join(dir, "check.db");

const store = await import("./store.js");
const learn = await import("./learn-score.js");
const scoreMod = await import("./score.js");

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log("PASS " + label);
  } else {
    failed++;
    console.log("FAIL " + label);
  }
}

function makeLead(o: Partial<Lead> & { id: string; workspaceId: string }): Lead {
  return {
    name: "Fixture Co " + o.id,
    category: "clinic",
    source: "fixture",
    sourceUrl: "https://" + o.id + ".fixture.example",
    summary: "A clearly fake fixture business.",
    emails: [],
    phones: [],
    socials: {},
    signals: [],
    score: 0,
    fit: [],
    angle: "",
    status: "new",
    notes: "",
    createdAt: new Date().toISOString(),
    ...o,
  };
}

const offer = { services: ["website", "automation"], description: "fixture offer" };
const icp = { categories: ["clinic"], cities: [], countries: [] };
const wsA = store.createWorkspace({ name: "Fixture A", offer, icp });
const wsB = store.createWorkspace({ name: "Fixture B", offer, icp });
const wsC = store.createWorkspace({ name: "Fixture C (empty)", offer, icp });

const fitWebsite: FitService[] = [{ service: "website", score: 60, reason: "fixture signal" }];
const fitAutomation: FitService[] = [{ service: "automation", score: 50, reason: "fixture signal" }];

// ---------------------------------------------------------------- 1. cold start: 10 outcomes
for (let i = 0; i < 10; i++) {
  const lead = makeLead({
    id: `a${i}`,
    workspaceId: wsA.id,
    signals: i % 3 === 0 ? ["no-website"] : ["wordpress"],
    fit: fitWebsite,
    score: 60,
  });
  learn.recordStatusChange(wsA.id, lead, i % 2 === 0 ? "won" : "rejected");
}
// A non-label status must not become a training label.
learn.recordStatusChange(
  wsA.id,
  makeLead({ id: "a-contact", workspaceId: wsA.id, signals: ["no-website"] }),
  "contacted"
);

const qA = makeLead({ id: "qa", workspaceId: wsA.id, signals: ["no-website"], fit: [{ service: "website", score: 70, reason: "fixture signal" }], score: 70 });
const rA = learn.learnedScore(wsA.id, qA, 63);
assert(rA.outcomes === 10, "cold start: only the 10 labelled outcomes are counted (contacted ignored)");
assert(rA.source === "rules", "cold start: source is rules");
assert(rA.score === 63, "cold start: score equals the rule score exactly");
assert(rA.topReasons.length === 0, "cold start: no learned reasons");

// ------------------------------------------------- 2. learning: 120 outcomes, one driving signal
const evts: { signals: string[]; fit: FitService[]; won: boolean }[] = [];
for (let i = 0; i < 120; i++) {
  const driving = i % 5 !== 0;             // no-online-booking present 96/120
  const noise = i % 2 === 0;               // wordpress present 60/120
  const won = driving ? i % 6 !== 0 : i % 4 === 0;
  const signals: string[] = [];
  if (driving) signals.push("no-online-booking");
  if (noise) signals.push("wordpress");
  const lead = makeLead({ id: `b${i}`, workspaceId: wsB.id, signals, fit: fitAutomation, score: 50 });
  learn.recordStatusChange(wsB.id, lead, won ? "won" : "rejected");
  evts.push({ signals, fit: fitAutomation, won });
}

const snapB = learn.learnedWeights(wsB.id);
assert(snapB.outcomes === 120, "learning: 120 labelled outcomes in workspace B");
const wDrive = snapB.weights["sig:no-online-booking"] ?? 0;
const wNoise = snapB.weights["sig:wordpress"] ?? 0;
assert(wDrive > 0.1, `learning: driving signal weight rose (${wDrive.toFixed(3)})`);
assert(wDrive > wNoise, `learning: driving weight ${wDrive.toFixed(3)} exceeds noise weight ${wNoise.toFixed(3)}`);

const qB = makeLead({ id: "qb", workspaceId: wsB.id, signals: ["no-online-booking"], fit: fitAutomation, score: 50 });
const rB = learn.learnedScore(wsB.id, qB, 50);
assert(rB.source === "blend", "learning: source is blend at 120 outcomes");
assert(rB.score !== 50, `learning: blend moved the score (50 -> ${rB.score})`);
assert(rB.score > 50, "learning: the driving signal moved the score up");
assert(rB.topReasons.length > 0, "learning: topReasons present");
assert(rB.topReasons[0].includes("booking"), "learning: topReasons names the driving signal");
assert(rB.topReasons[0].includes("for this workspace"), "learning: reason uses the workspace phrasing");

const qB0 = makeLead({ id: "qb0", workspaceId: wsB.id, signals: [], fit: fitAutomation, score: 50 });
const rB0 = learn.learnedScore(wsB.id, qB0, 50);
assert(rB0.score < rB.score, `learning: lead without the signal scores lower (${rB0.score} < ${rB.score})`);

// ----------------------------------------------------- 3. calibration arithmetic (120-event snapshot)
// Recompute the buckets from the fixtures and compare to calibration()'s own numbers.
const cal = learn.calibration(wsB.id);
assert(cal.length > 0, "calibration: returns non-empty buckets");
const totalN = cal.reduce((s, b) => s + b.n, 0);
assert(totalN === 120, "calibration: buckets cover every labelled outcome");
const lo = [0, 20, 40, 60, 80];
const hi = [20, 40, 60, 80, 100];
const ref = new Map<string, { n: number; sum: number; wins: number }>();
for (const ev of evts) {
  const p = learn.predictProbability(wsB.id, { signals: ev.signals, fit: ev.fit });
  const idx = Math.min(4, Math.max(0, Math.floor(p * 5)));
  const key = `${lo[idx]}-${hi[idx]}`;
  const b = ref.get(key) ?? { n: 0, sum: 0, wins: 0 };
  b.n++;
  b.sum += p;
  if (ev.won) b.wins++;
  ref.set(key, b);
}
let calOk = true;
for (const b of cal) {
  const rr = ref.get(b.bucket);
  if (!rr) { calOk = false; break; }
  const mean = Math.round((rr.sum / rr.n) * 1000) / 10;
  const rate = Math.round((rr.wins / rr.n) * 1000) / 1000;
  if (b.n !== rr.n || Math.abs(b.meanPredicted - mean) > 1e-9 || Math.abs(b.actualRate - rate) > 1e-9) {
    calOk = false;
    break;
  }
}
assert(calOk, "calibration: bucket n/meanPredicted/actualRate match an independent recompute");

// More than 200 outcomes -> 70% learned.
for (let i = 120; i < 260; i++) {
  const driving = i % 5 !== 0;
  const won = driving ? i % 6 !== 0 : i % 4 === 0;
  const signals = driving ? ["no-online-booking"] : [];
  learn.recordStatusChange(wsB.id, makeLead({ id: `b${i}`, workspaceId: wsB.id, signals, fit: fitAutomation, score: 50 }), won ? "won" : "rejected");
}
const rB260 = learn.learnedScore(wsB.id, qB, 50);
assert(rB260.outcomes === 260, "learning: outcome count grows past 200");
assert(rB260.source === "learned", "learning: source is learned above 200 outcomes");
assert(rB260.weight === 0.7, "learning: weight caps at 0.7 above 200 outcomes");

// ------------------------------------------------------------- 4. workspace isolation
const snapA = learn.learnedWeights(wsA.id);
assert(snapA.outcomes === 10, "isolation: workspace A keeps only its own 10 outcomes");
assert((snapA.weights["sig:no-online-booking"] ?? 0) === 0, "isolation: workspace B's driving signal never leaks into workspace A");
const calA = learn.calibration(wsA.id);
assert(calA.reduce((s, b) => s + b.n, 0) === 10, "isolation: workspace A calibration covers only its 10 outcomes");
assert(learn.learnedWeights(wsB.id).outcomes === 260, "isolation: workspace B is unaffected by workspace A");

// ----------------------------------------------------- 5. the score.ts hook, end to end
const v: Verification = {
  bizKey: "fixture",
  checkedAt: new Date().toISOString(),
  website: "alive",
  emails: [{ value: "a@fixture.example", result: "ok" }],
  phones: [{ value: "+911234567890", e164: "+911234567890", result: "mobile" }],
  whatsapp: false,
  contactable: true,
  reasons: [],
};
const hookB = makeLead({ id: "hook", workspaceId: wsB.id, signals: ["no-online-booking"], fit: fitAutomation, score: 50 });
const hookC = makeLead({ id: "hook", workspaceId: wsC.id, signals: ["no-online-booking"], fit: fitAutomation, score: 50 });
const sB = scoreMod.scoreLead(hookB, v);
const sC = scoreMod.scoreLead(hookC, v);
assert(sC.total !== sB.total, `hook: score.ts blended the learned score (${sC.total} -> ${sB.total})`);
assert(sB.total > sC.total, "hook: the driving signal raised the total");

const hookA = makeLead({ id: "hookA", workspaceId: wsA.id, signals: ["no-website"], fit: fitWebsite, score: 60 });
const hookA0 = makeLead({ id: "hookA", workspaceId: wsC.id, signals: ["no-website"], fit: fitWebsite, score: 60 });
const sA = scoreMod.scoreLead(hookA, v);
const sA0 = scoreMod.scoreLead(hookA0, v);
assert(sA.total === sA0.total, "hook: with 10 outcomes the rule score is unchanged");

store.closeDb();
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* temp cleanup is best-effort */
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} learn-score-check: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
