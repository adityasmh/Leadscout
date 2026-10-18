// Order SH1 proof: offline canary check with fake adapters. No network.
// Run once: npx tsx src/canary-check.ts
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DRIFT_REASON,
  detectDrift,
  disableReason,
  evaluate,
  isChannelDisabled,
  loadState,
  recordResult,
  resetCanaryFlags,
  runAll,
  runCanary,
} from "./canary.js";
import type { CanaryDef, CanaryResult } from "./canary.js";
import type { ChannelAdapter, ChannelDeps } from "./channels/types.js";

let n = 0;
function pass(name: string): void {
  n += 1;
  console.log(`PASS ${n} ${name}`);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "canary-check-"));
const statePath = path.join(tmp, "canary-state.json");
const proposalsDir = path.join(tmp, "proposals");
const nowMs = Date.parse("2026-10-12T00:00:00.000Z");

function lead(name: string, withPhone: boolean) {
  return {
    name,
    category: "restaurant",
    city: "Fixture City",
    source: "fixture",
    sourceUrl: "https://fixture.example/leads/1",
    ...(withPhone ? { phone: "+91 90000 11111" } : {}),
  };
}

function fakeAdapter(id: string, withPhone: boolean): ChannelAdapter {
  return {
    id,
    name: `Fixture ${id}`,
    tier: "B",
    categories: ["any"],
    status: () => ({ enabled: true }),
    discover: async () => [lead("Fixture Dosa House 01", withPhone)],
    enrich: async (l) => ({
      channel: id,
      url: "https://fixture.example/leads/1",
      fetchedAt: "2026-10-12T00:00:00.000Z",
      via: "page",
      fields: { name: l.name, ...(withPhone ? { phone: "+91 90000 11111" } : {}) },
      signals: [],
      text: "fixture page text",
      untrusted: true,
    }),
    signals: () => [],
  };
}

const deps = {
  search: async () => ({ ok: true, channel: "fixture", text: "fixture search text", untrusted: true, trace: [] }),
  readPage: async () => ({ ok: true, channel: "fixture", text: "fixture page text", untrusted: true, trace: [] }),
  limiter: {},
  now: () => nowMs,
} as unknown as ChannelDeps & { now: () => number };

const canary: CanaryDef = {
  id: "fixture-1",
  adapterId: "fixture-chan",
  kind: "discover",
  category: "restaurant",
  city: "Fixture City",
  expected: { fields: ["name", "phone"], minLeads: 1 },
  enabled: true,
};

resetCanaryFlags();

// 1. healthy channel passes
{
  const r = await runCanary(fakeAdapter("fixture-chan", true), canary, deps);
  assert.equal(r.ok, true);
  assert.equal(r.ratio, 1);
  assert.deepEqual(r.missingFields, []);
  pass("healthy channel passes (ok, ratio 1)");
}

// 2. evaluate: phone pattern mismatch reported with ratio
{
  const ev = evaluate({ name: "x", phone: "nope" }, { fields: ["name", "phone"], patterns: { phone: "^\\+91" } });
  assert.equal(ev.ok, false);
  assert.deepEqual(ev.missingFields, ["phone"]);
  assert.equal(ev.ratio, 0.5);
  pass("evaluate reports missing phone with ratio 0.5");
}

// 3. baseline: two good runs establish which fields are normally present
{
  for (const dt of ["2026-10-09T00:00:00.000Z", "2026-10-09T01:00:00.000Z"]) {
    const good = await runCanary(fakeAdapter("fixture-chan", true), canary, deps);
    const out = await recordResult({ ...good, at: dt }, { statePath, proposalsDir });
    assert.equal(out.drifted, false);
  }
  assert.equal(isChannelDisabled("fixture-chan"), false);
  pass("two good baseline runs establish the field baseline");
}

// 4. one bad run (phone disappears) fails WITHOUT disabling, no proposal
{
  const bad = await runCanary(fakeAdapter("fixture-chan", false), canary, deps);
  assert.equal(bad.ok, false);
  assert.ok(bad.missingFields.includes("phone"));
  const out = await recordResult({ ...bad, at: "2026-10-10T00:00:00.000Z" }, { statePath, proposalsDir });
  assert.equal(out.drifted, false);
  assert.equal(isChannelDisabled("fixture-chan"), false);
  const files = await fs.readdir(proposalsDir).catch(() => []);
  assert.equal(files.length, 0);
  pass("first failure does not disable and writes no proposal");
}

// 5. second consecutive failure disables with the exact reason + one proposal
{
  const bad2 = await runCanary(fakeAdapter("fixture-chan", false), { ...canary }, deps);
  const out = await recordResult({ ...bad2, at: "2026-10-11T00:00:00.000Z" }, { statePath, proposalsDir });
  assert.equal(out.drifted, true);
  assert.equal(isChannelDisabled("fixture-chan"), true);
  assert.equal(disableReason("fixture-chan"), DRIFT_REASON);
  assert.equal(DRIFT_REASON, "layout drift suspected (canary)");
  const files = await fs.readdir(proposalsDir);
  assert.deepEqual(files, ["canary-fixture-chan.md"]);
  const body = await fs.readFile(path.join(proposalsDir, files[0]), "utf8");
  assert.ok(body.includes("phone"));
  assert.ok(body.includes("Fetched text size"));
  assert.ok(body.includes("Draft fix order"));
  assert.ok(body.includes("2026-10-11"));
  pass("second failure disables with reason and writes exactly one proposal");
}

// 5. further bad runs write no second proposal
{
  const bad3 = await runCanary(fakeAdapter("fixture-chan", false), canary, deps);
  const out = await recordResult({ ...bad3, at: new Date(nowMs + 2000).toISOString() }, { statePath, proposalsDir });
  assert.equal(out.drifted, false); // already disabled: no new episode
  assert.equal(out.proposalWritten, false);
  const files = await fs.readdir(proposalsDir);
  assert.equal(files.length, 1);
  pass("no duplicate proposal within one drift episode");
}

// 6. two good runs re-enable automatically
{
  const good1 = await runCanary(fakeAdapter("fixture-chan", true), canary, deps);
  const o1 = await recordResult({ ...good1, at: new Date(nowMs + 3000).toISOString() }, { statePath, proposalsDir });
  assert.equal(o1.reEnabled, false);
  assert.equal(isChannelDisabled("fixture-chan"), true);
  const good2 = await runCanary(fakeAdapter("fixture-chan", true), canary, deps);
  const o2 = await recordResult({ ...good2, at: new Date(nowMs + 4000).toISOString() }, { statePath, proposalsDir });
  assert.equal(o2.reEnabled, true);
  assert.equal(isChannelDisabled("fixture-chan"), false);
  pass("two good runs re-enable the channel");
}

// 7. detectDrift: ratio < 0.5 twice in a row
{
  const mk = (ratio: number, ok: boolean, at: string): CanaryResult => ({
    adapterId: "x", canaryId: "x", at, ok, missingFields: ok ? [] : ["a", "b", "c"], ratio, foundFields: ok ? ["a", "b", "c"] : [], textSize: 10,
  });
  assert.equal(detectDrift([mk(0.2, false, "2026-10-10T00:00:00.000Z"), mk(0.1, false, "2026-10-11T00:00:00.000Z")]).drift, true);
  assert.equal(detectDrift([mk(1, true, "2026-10-10T00:00:00.000Z"), mk(0.1, false, "2026-10-11T00:00:00.000Z")]).drift, false);
  pass("detectDrift fires on two consecutive ratios below 0.5 only");
}

// 8. 20-hour rate limit + one-request-per-second gap via runAll
{
  resetCanaryFlags();
  const state2 = path.join(tmp, "state2.json");
  const props2 = path.join(tmp, "props2");
  const sleepCalls: number[] = [];
  const adapters = [fakeAdapter("a-chan", true), fakeAdapter("b-chan", true)];
  const cans: CanaryDef[] = [
    { id: "a-1", adapterId: "a-chan", kind: "discover", category: "restaurant", city: "Fixture City", expected: { fields: ["name"], minLeads: 1 }, enabled: true },
    { id: "b-1", adapterId: "b-chan", kind: "discover", category: "restaurant", city: "Fixture City", expected: { fields: ["name"], minLeads: 1 }, enabled: true },
  ];
  const s1 = await runAll({ ...(deps as object), adapters, canaries: cans, statePath: state2, proposalsDir: props2, sleep: async (ms: number) => { sleepCalls.push(ms); } } as never);
  assert.deepEqual([...s1.ran].sort(), ["a-chan", "b-chan"]);
  assert.deepEqual(sleepCalls, [1000]);
  const s2 = await runAll({ ...(deps as object), adapters, canaries: cans, statePath: state2, proposalsDir: props2, sleep: async (ms: number) => { sleepCalls.push(ms); } } as never);
  assert.deepEqual([...s2.skippedRateLimit].sort(), ["a-chan", "b-chan"]);
  assert.equal(sleepCalls.length, 1); // no further requests while rate-limited
  pass("runAll honors the 20-hour rate limit and 1 req/s gap");
}

// 9. per-platform cap respected (browser hourly cap reached -> skip, no read)
{
  resetCanaryFlags();
  const state3 = path.join(tmp, "state3.json");
  const props3 = path.join(tmp, "props3");
  let reads = 0;
  const cappedBrowser = {
    read: async () => { reads += 1; return { text: "x", url: "https://fixture.example/" }; },
    search: async () => ({ text: "x", url: "https://fixture.example/" }),
    status: () => ({ enabled: true, killSwitch: false, backends: { opencli: { ok: false }, cdp: { ok: false, url: "" } }, caps: { other: 1 }, usedThisHour: { other: 1 }, lockedPlatforms: [], pageLog: [] }),
  };
  const s = await runAll({
    ...(deps as object),
    browser: cappedBrowser,
    adapters: [fakeAdapter("c-chan", true)],
    canaries: [{ id: "c-1", adapterId: "c-chan", kind: "discover", category: "restaurant", city: "Fixture City", expected: { fields: ["name"], minLeads: 1 }, enabled: true }],
    statePath: state3,
    proposalsDir: props3,
    sleep: async () => {},
  } as never);
  assert.deepEqual(s.skippedCap, ["c-chan"]);
  assert.equal(reads, 0);
  pass("runAll respects the per-platform hourly cap");
}

// 10. corrupt state file ignored without a throw
{
  const corrupt = path.join(tmp, "corrupt.json");
  await fs.writeFile(corrupt, "{not json!!!", "utf8");
  const st = await loadState(corrupt);
  assert.deepEqual(st, { channels: {} });
  const good = await runCanary(fakeAdapter("z-chan", true), { ...canary, adapterId: "z-chan" }, deps);
  const out = await recordResult(good, { statePath: corrupt, proposalsDir });
  assert.equal(out.drifted, false);
  pass("corrupt state file is ignored without a throw");
}

console.log(`\ncanary-check: all ${n} checks passed`);
