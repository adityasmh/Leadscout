// src/calls-queue-check.ts
// Offline proof for CALL5-queue-order: never-called calling order in callQueue.
// Temp database only (env LEADSCOUT_DB), no server needed, no src/company import.
// Node 24 built-ins only, ES modules with .js suffixes.

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import type { Lead } from "./types.js";
import type { Dossier } from "./types-v2.js";

const dbFile = join(tmpdir(), `leadscout-call5-${randomUUID()}.db`);
process.env.LEADSCOUT_DB = dbFile;

const store = await import("./store.js");
const calls = await import("./calls.js");
const dossier = await import("./dossier.js");

let failures = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function makeLead(
  workspaceId: string,
  name: string,
  score: number,
  address: string | undefined,
  phone: string | undefined
): Lead {
  return store.upsertLead({
    workspaceId,
    name,
    category: "dentist",
    source: "fixture",
    sourceUrl: "https://example.invalid/fake-lead",
    address,
    phone,
    score,
  });
}

function saveRating(workspaceId: string, leadId: string, rating: number, reviewCount: number): void {
  const d = {
    leadId,
    workspaceId,
    bizKey: `fake:${leadId}`,
    level: 0,
    facts: {
      rating: { value: rating, evidence: ["E1"] },
      reviewCount: { value: reviewCount, evidence: ["E1"] },
    },
    gap: null,
    sayThis: null,
    pushback: null,
    offers: [],
    evidence: [],
    callStatus: "not-called",
    dropped: [],
    inputHash: `fake-${leadId}`,
    promptVersion: "fake",
    tokensIn: 0,
    tokensOut: 0,
    createdAt: new Date().toISOString(),
  };
  dossier.saveDossier(d as unknown as Dossier);
}

try {
  // ---------------------------------------------------------------- workspace A
  const wsA = store.createWorkspace({
    name: "Fake Queue Order Workspace",
    offer: { services: ["website"], description: "fake offer for checks only" },
    icp: { categories: ["dentist"], cities: ["Fake City"], countries: ["IN"] },
  });

  // 6 leads with a phone.
  const alpha = makeLead(wsA.id, "Fake Alpha", 90, "12, MG Road, Bengaluru", "+91 90000 00101");
  const beta = makeLead(wsA.id, "Fake Beta", 90, "5, MG Road, Bengaluru", "+91 90000 00102");
  const gamma = makeLead(wsA.id, "Fake Gamma", 80, "9, Park Street, Kolkata", "+91 90000 00103");
  const delta = makeLead(wsA.id, "Fake Delta", 80, "7, Park Street, Kolkata", "+91 90000 00104");
  const epsilon = makeLead(wsA.id, "Fake Epsilon", 70, "2, Second Avenue, Delhi", "+91 90000 00105");
  const zeta = makeLead(wsA.id, "Fake Zeta", 60, "3, Third Avenue, Delhi", "+91 90000 00106");

  saveRating(wsA.id, alpha.id, 4.5, 100);
  saveRating(wsA.id, beta.id, 4.5, 100);
  saveRating(wsA.id, gamma.id, 3.0, 20);
  saveRating(wsA.id, epsilon.id, 4.9, 5);

  // 3 leads without any phone.
  const eta = makeLead(wsA.id, "Fake Eta", 100, "4, MG Road, Bengaluru", undefined);
  const theta = makeLead(wsA.id, "Fake Theta", 20, undefined, undefined);
  const iota = makeLead(wsA.id, "Fake Iota", 10, undefined, undefined);
  saveRating(wsA.id, eta.id, 5.0, 1000);

  const queue = calls.callQueue(wsA.id, new Date());
  const ids = queue.map((entry) => entry.lead.id);
  const indexOf = (id: string): number => ids.indexOf(id);

  console.log(`queue A (${queue.length}): ${queue.map((e) => e.lead.name).join(" | ")}`);

  check("A: first 6 queue items have a phone and last 3 do not", () => {
    assert.equal(queue.length, 9, `expected 9 queue items, got ${queue.length}`);
    const first = queue.slice(0, 6);
    const last = queue.slice(6);
    for (const entry of first) {
      assert.equal(entry.hasPhone, true, `${entry.lead.name} should have hasPhone=true`);
      assert.ok(
        (entry.lead.phone ?? "") !== "" || entry.lead.phones.length > 0,
        `${entry.lead.name} should carry a phone`
      );
    }
    for (const entry of last) {
      assert.equal(entry.hasPhone, false, `${entry.lead.name} should have hasPhone=false`);
    }
  });

  check("A: leads without a number sort last and say 'no number yet'", () => {
    const last = queue.slice(6);
    assert.deepEqual(
      last.map((e) => e.lead.id),
      [eta.id, theta.id, iota.id],
      "the three no-phone leads come last"
    );
    for (const entry of last) {
      assert.equal(entry.reason, "no number yet", `${entry.lead.name} reason`);
    }
  });

  check("A: higher score comes before lower score inside the phone group", () => {
    assert.ok(indexOf(alpha.id) < indexOf(epsilon.id), "score 90 before score 70");
    assert.ok(indexOf(epsilon.id) < indexOf(zeta.id), "score 70 before score 60");
    assert.ok(indexOf(eta.id) < indexOf(theta.id), "score 100 before score 20 without a phone");
  });

  check("A: rated leads come before unrated leads at equal score", () => {
    assert.equal(gamma.score, delta.score, "fixture pair shares a score");
    assert.ok(indexOf(gamma.id) < indexOf(delta.id), "rated Gamma before unrated Delta");
  });

  check("A: two leads in the same locality are adjacent", () => {
    assert.ok(
      Math.abs(indexOf(alpha.id) - indexOf(beta.id)) === 1,
      "MG Road pair should be adjacent"
    );
    assert.ok(
      Math.abs(indexOf(gamma.id) - indexOf(delta.id)) === 1,
      "Park Street pair should be adjacent"
    );
  });

  // ---------------------------------------------------------------- workspace B
  const wsB = store.createWorkspace({
    name: "Fake Queue Follow-up Workspace",
    offer: { services: ["website"], description: "fake offer for checks only" },
    icp: { categories: ["dentist"], cities: ["Fake City"], countries: ["IN"] },
  });
  const overdue = makeLead(wsB.id, "Fake Overdue No Phone", 5, undefined, undefined);
  const queued = makeLead(wsB.id, "Fake Queued With Phone", 99, "1, Some Road, Fake City", "+91 90000 00200");
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await calls.logCall({
    workspaceId: wsB.id,
    leadId: overdue.id,
    channel: "call",
    outcome: "call_back",
    followUpAt: yesterday,
  });

  const queueB = calls.callQueue(wsB.id, new Date());
  console.log(`queue B: ${queueB.map((e) => `${e.lead.name}[${e.kind}]`).join(" | ")}`);

  check("B: overdue follow-up without a phone still comes first", () => {
    assert.ok(queueB.length >= 2, `expected at least 2 items, got ${queueB.length}`);
    assert.equal(queueB[0].lead.id, overdue.id, "overdue follow-up first");
    assert.equal(queueB[0].kind, "follow_up", "kind stays follow_up");
    assert.ok(queueB.some((e) => e.lead.id === queued.id), "the never-called lead is still listed");
  });
} finally {
  store.closeDb();
  rmSync(dbFile, { force: true });
  rmSync(`${dbFile}-journal`, { force: true });
  rmSync(`${dbFile}-wal`, { force: true });
  rmSync(`${dbFile}-shm`, { force: true });
}

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures} check(s))`);
if (failures > 0) process.exitCode = 1;
