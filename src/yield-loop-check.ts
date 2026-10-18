// src/yield-loop-check.ts
// Order LL2-yield-loop proof. Offline: temp database (env LEADSCOUT_DB set BEFORE
// any leadscout module is imported), seeded random, synthetic 3 sources x 3 cities
// world with one rich arm and one dead arm. No network, no model, no service.
// Run: npx tsx src/yield-loop-check.ts
//
// No src/company import is used, so the company sandbox import is not needed.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "leadscout-yield-"));
process.env.LEADSCOUT_DB = join(dir, "check.db");

const store = await import("./store.js");
const yl = await import("./yield-loop.js");

// ------------------------------------------------------------------ harness

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err: unknown) {
    failed += 1;
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    console.log(`FAIL ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

// ------------------------------------------------------------- deterministic

/** mulberry32: a tiny seedable PRNG so allocation is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-01-01T00:00:00Z");
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY);
}

type T = { source: string; category: string; city: string; area: string };
function arm(source: string, city: string): T {
  return { source, category: "clinic", city, area: "" };
}

const MAIN = "feed-main";
const mainTargets: T[] = [];
for (const source of ["s1", "s2", "s3"]) {
  for (const city of ["c1", "c2", "c3"]) mainTargets.push(arm(source, city));
}
let mainNow = NOW;

// ---------------------------------------------------------- synthetic world

/** gate-passed leads per run: rich arm 3, normal 1, dead 0. */
function nature(a: T): { raw: number; nl: number; gp: number } {
  if (a.source === "s1" && a.city === "c1") return { raw: 10, nl: 4, gp: 3 };
  if (a.source === "s3" && a.city === "c3") return { raw: 0, nl: 0, gp: 0 };
  return { raw: 5, nl: 2, gp: 1 };
}

function simulate(feedId: string, targets: T[], runs: number, budget: number, seed: number): Map<string, number> {
  const credits = new Map<string, number>();
  const rand = mulberry32(seed);
  let now = new Date("2026-02-01T00:00:00Z");
  for (let run = 0; run < runs; run++) {
    const alloc = yl.allocate(feedId, targets, budget, rand, now);
    for (const a of alloc) {
      if (a.credits <= 0) continue;
      const k = a.source + a.city;
      credits.set(k, (credits.get(k) ?? 0) + a.credits);
      const w = nature(a);
      yl.recordRun(
        { feedId, source: a.source, category: a.category, city: a.city, area: a.area, rawFound: w.raw, newLeads: w.nl, gatePassed: w.gp },
        now
      );
    }
    now = addDays(now, 1);
  }
  mainNow = now;
  return credits;
}

// ------------------------------------------------------------------ tests

check("no-history order preserved", () => {
  const targets = [arm("s1", "c1"), arm("s2", "c2"), arm("s3", "c3")];
  const alloc = yl.allocate("feed-cold", targets, 9, mulberry32(11), NOW);
  assert.equal(alloc.length, 3, "every target is returned");
  assert.deepEqual(
    alloc.map((a) => a.source + a.city),
    ["s1c1", "s2c2", "s3c3"],
    "targets keep the given order"
  );
  assert.ok(alloc.every((a) => a.reason === "no history yet"), "cold-start reason");
});

check("most budget to the rich arm", () => {
  const credits = simulate(MAIN, mainTargets, 30, 10, 42);
  const rich = credits.get("s1c1") ?? 0;
  const others = [...credits.entries()].filter(([k]) => k !== "s1c1").map(([, v]) => v);
  const bestOther = others.length > 0 ? Math.max(...others) : 0;
  assert.ok(rich > 0, "rich arm received budget");
  assert.ok(rich > bestOther, `rich arm ${rich} should beat the best other arm ${bestOther}`);
});

check("exploration continues", () => {
  const fresh = arm("s-new", "c-new");
  const alloc = yl.allocate(MAIN, [arm("s1", "c1"), fresh], 10, mulberry32(7), mainNow);
  const f = alloc.find((a) => a.source === "s-new");
  assert.ok(f && f.credits > 0, "an arm with fewer than 3 runs still receives exploration credits");
});

check("dead arm paused after 5 empty runs and un-paused after the pause window", () => {
  const dead = arm("dead", "nowhere");
  const alive = arm("alive", "nowhere");
  let t = new Date("2026-03-01T00:00:00Z");
  for (let i = 0; i < 5; i++) {
    yl.recordRun({ feedId: "feed-pause", source: dead.source, category: dead.category, city: dead.city, area: dead.area, rawFound: 0, newLeads: 0, gatePassed: 0 }, t);
    t = addDays(t, 1);
  }
  yl.recordRun({ feedId: "feed-pause", source: alive.source, category: alive.category, city: alive.city, area: alive.area, rawFound: 5, newLeads: 2, gatePassed: 5 }, t);

  const before = yl.allocate("feed-pause", [dead, alive], 10, mulberry32(3), t);
  const deadBefore = before.find((a) => a.source === "dead");
  assert.ok(deadBefore && deadBefore.credits === 0, "paused arm gets no credits");
  assert.ok(deadBefore && /paused/i.test(deadBefore.reason), "paused arm is listed with a reason");

  const txt = yl.explain("feed-pause", t);
  assert.ok(txt.includes("dead"), "explain names the paused arm");
  assert.ok(/paused/i.test(txt), "explain shows the pause");

  const after = yl.allocate("feed-pause", [dead, alive], 10, mulberry32(3), addDays(t, 15));
  const deadAfter = after.find((a) => a.source === "dead");
  assert.ok(deadAfter && !/paused/i.test(deadAfter.reason), "arm is eligible again after the 14 day window");
});

check("call outcomes shift ranking once 20 calls exist", () => {
  const X = arm("sx", "cx");
  const Y = arm("sy", "cy");
  for (let i = 0; i < 20; i++) {
    yl.recordRun({ feedId: "feed-calls", source: X.source, category: X.category, city: X.city, area: X.area, rawFound: 5, newLeads: 2, gatePassed: 2 }, NOW);
    yl.recordRun({ feedId: "feed-calls", source: Y.source, category: Y.category, city: Y.city, area: Y.area, rawFound: 5, newLeads: 2, gatePassed: 3 }, NOW);
  }

  // A lead stored on X, resolved by recordCallOutcome through its source fields.
  store.getDb()
    .prepare("INSERT OR REPLACE INTO leads (id, workspaceId, name, category, city, source, sourceUrl, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("lead-x", "ws-fixture", "Fixture X", X.category, X.city, X.source, "https://x.fixture.example", NOW.toISOString());

  const before = yl.allocate("feed-calls", [X, Y], 100, mulberry32(5), NOW);
  const bx = before.find((a) => a.source === "sx")?.credits ?? 0;
  const by = before.find((a) => a.source === "sy")?.credits ?? 0;
  assert.ok(by > bx, `yield-only ranking keeps Y ahead: Y ${by} > X ${bx}`);

  for (let i = 0; i < 19; i++) yl.recordCallOutcome({ leadId: "lead-x", outcome: "interested" });
  const at19 = yl.allocate("feed-calls", [X, Y], 100, mulberry32(5), NOW);
  const x19 = at19.find((a) => a.source === "sx")?.credits ?? 0;
  const y19 = at19.find((a) => a.source === "sy")?.credits ?? 0;
  assert.ok(y19 > x19, `under 20 calls the blend is off: Y ${y19} > X ${x19}`);

  yl.recordCallOutcome({ leadId: "lead-x", outcome: "interested" }); // 20th call
  const after = yl.allocate("feed-calls", [X, Y], 100, mulberry32(5), NOW);
  const ax = after.find((a) => a.source === "sx")?.credits ?? 0;
  const ay = after.find((a) => a.source === "sy")?.credits ?? 0;
  assert.ok(ax > ay, `downstream reward flips the ranking once 20 calls exist: X ${ax} > Y ${ay}`);

  // An unknown lead is a safe no-op.
  assert.doesNotThrow(() => yl.recordCallOutcome({ leadId: "does-not-exist", outcome: "interested" }));
});

check("explain names the right arms", () => {
  const txt = yl.explain(MAIN, mainNow);
  assert.ok(txt.includes("s1"), "explain names the best arm's source");
  assert.ok(txt.includes("c1"), "explain names the best arm's city");
  assert.ok(/run \d+:/.test(txt), "explain prints the run N learning summary line");
});

check("corrupt row does not throw", () => {
  store.getDb()
    .prepare(
      `INSERT OR REPLACE INTO yield_stats
        (feedId, source, category, city, area, runs, rawFound, newLeads, gatePassed,
         called, answered, interested, won, consecutiveEmpty, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run("feed-corrupt", "src", "cat", "city", "", "abc", "abc", "abc", "abc", "abc", "abc", "abc", "abc", "abc", "abc");

  assert.doesNotThrow(() => {
    yl.allocate("feed-corrupt", [{ source: "src", category: "cat", city: "city", area: "" }], 10, mulberry32(1), NOW);
    yl.explain("feed-corrupt", NOW);
  });
});

check("missing table does not throw", () => {
  store.getDb().exec("DROP TABLE IF EXISTS yield_stats");
  assert.doesNotThrow(() => yl.explain(MAIN, NOW));
  assert.doesNotThrow(() => yl.allocate(MAIN, [{ source: "a", category: "b", city: "c", area: "" }], 5, mulberry32(2), NOW));
  assert.doesNotThrow(() => yl.recordRun({ feedId: MAIN, source: "a", category: "b", city: "c", gatePassed: 1 }, NOW));
});

// ------------------------------------------------------------------ summary

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
