// src/seed-plan-check.ts
// Offline PASS/FAIL proof harness for the India seed plan and runner.
// Zero network; uses a temp SQLite database.

import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildSeedPlan, dueJobs, executeSeed, jobKey, type SeedConfig, type SeedJob } from "./seed-plan.js";

const DB_PATH = join(tmpdir(), `leadscout-seed-check-${randomUUID()}.db`);
process.env.LEADSCOUT_DB = DB_PATH;

const { closeDb } = await import("./store.js");

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

const cfg = loadJson<SeedConfig>(fileURLToPath(new URL("../data/seed-india.json", import.meta.url)));
const cityData = loadJson<{ cities: Array<{ name: string }> }>(fileURLToPath(new URL("../data/india-cities.json", import.meta.url)));
const categoriesData = loadJson<{ categories: Array<{ id: string }> }>(fileURLToPath(new URL("../data/categories.json", import.meta.url)));

const allCities = cityData.cities.map((c) => c.name);
const allCategoryIds = new Set(categoriesData.categories.map((c) => c.id));
const citySet = new Set(allCities);

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string): void {
  const label = ok ? "PASS" : "FAIL";
  console.log(`${label}: ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass++; else fail++;
}

// 1. Every pilot + Phase A + Phase B city exists in india-cities.json.
const configCities = new Set([
  ...cfg.pilot.cities,
  ...cfg.phases.flatMap((p) => allCities.slice(0, p.cityCount)),
]);
const missingCities = [...configCities].filter((c) => !citySet.has(c));
report("all pilot/phase cities exist in india-cities.json", missingCities.length === 0, missingCities.join(", "));

// 2. Every pilot + Phase A/B category exists in categories.json.
const configCats = new Set([...cfg.pilot.categories, ...cfg.phases.flatMap((p) => p.categories)]);
const missingCats = [...configCats].filter((c) => !allCategoryIds.has(c));
report("all categories exist in categories.json", missingCats.length === 0, missingCats.join(", "));

// 3. Plan length equals cities x categories per phase.
for (const phase of ["pilot", "A", "B"] as const) {
  const plan = buildSeedPlan(cfg, allCities, { startAt: 0, phase });
  const expectedCities = phase === "pilot" ? cfg.pilot.cities.length : cfg.phases.find((p) => p.name === phase)?.cityCount ?? 0;
  const expectedCats = phase === "pilot" ? cfg.pilot.categories.length : cfg.phases.find((p) => p.name === phase)?.categories.length ?? 0;
  report(`${phase} plan job count = cities x categories`, plan.length === expectedCities * expectedCats, `${plan.length} vs ${expectedCities * expectedCats}`);
}

// 4. notBefore spacing is exact across the full plan.
function checkSpacing(plan: SeedJob[], overpassSeconds: number): boolean {
  if (plan.length === 0) return true;
  const base = plan[0].notBefore;
  for (let i = 0; i < plan.length; i++) {
    if (plan[i].notBefore !== base + i * overpassSeconds * 1000) return false;
  }
  return true;
}
for (const phase of ["pilot", "A", "B"] as const) {
  const plan = buildSeedPlan(cfg, allCities, { startAt: 1_000_000, phase });
  report(`${phase} notBefore spacing exact`, checkSpacing(plan, cfg.spacing.overpassSeconds));
}

// 5. No duplicate keys across the whole plan (and across phases).
for (const phase of ["pilot", "A", "B"] as const) {
  const plan = buildSeedPlan(cfg, allCities, { startAt: 0, phase });
  const keys = new Set(plan.map((j) => j.key));
  report(`${phase} no duplicate keys`, keys.size === plan.length);
}

// 6. Phase A and B city slices are consecutive and non-overlapping.
const planA = buildSeedPlan(cfg, allCities, { startAt: 0, phase: "A" });
const planB = buildSeedPlan(cfg, allCities, { startAt: 0, phase: "B" });
const citiesA = new Set(planA.map((j) => j.city));
const citiesB = new Set(planB.map((j) => j.city));
const sharedCities = [...citiesA].filter((c) => citiesB.has(c));
report("A and B share no cities", sharedCities.length === 0, sharedCities.join(", "));
report("B first city equals 11th city in india-cities.json", planB[0]?.city === allCities[10], planB[0]?.city);
const bCityCount = new Set(planB.map((j) => j.city)).size;
const bCategoryCount = new Set(planB.map((j) => j.category)).size;
report(
  "B plans 40 cities x 12 categories",
  bCityCount === 40 && bCategoryCount === 12 && planB.length === 40 * 12,
  `${bCityCount} cities, ${bCategoryCount} categories, ${planB.length} jobs`
);

// 7. dueJobs respects now, max and doneKeys independently.
function dueJobsCheck(): boolean {
  const plan = buildSeedPlan(cfg, allCities, { startAt: 1_000_000, phase: "pilot" });
  // All due when now is far future, max large.
  const all = dueJobs(plan, 1_000_000_000_000, 1000, new Set());
  if (all.length !== plan.length) return false;
  // Max respected.
  const two = dueJobs(plan, 1_000_000_000_000, 2, new Set());
  if (two.length !== 2 || two[0].key !== plan[0].key || two[1].key !== plan[1].key) return false;
  // now respected: first job not due yet.
  const none = dueJobs(plan, 0, 1000, new Set());
  if (none.length !== 0) return false;
  // doneKeys respected.
  const done = new Set([plan[0].key, plan[2].key]);
  const skipped = dueJobs(plan, 1_000_000_000_000, 1000, done);
  if (skipped.length !== plan.length - 2) return false;
  if (skipped.some((j) => done.has(j.key))) return false;
  return true;
}
report("dueJobs respects now, max and doneKeys", dueJobsCheck());

// 8. Simulated execute via injected fake runJob runs exactly max jobs then returns.
async function executeCheck(): Promise<boolean> {
  const runCalls: Array<{ workspaceId: string; jobId: string }> = [];
  const createdJobs: Array<{ id: string; workspaceId: string; query: Record<string, unknown>; status: string; createdAt: string }> = [];
  let clock = 1_000_000_000_000;

  const fakeCreateJob = (workspaceId: string, query: Record<string, unknown>) => {
    const id = randomUUID();
    clock += 120_000; // each created job 120s apart to satisfy spacing check
    const createdAt = new Date(clock).toISOString();
    const job = { id, workspaceId, query, status: "queued", createdAt };
    createdJobs.push(job);
    return job as any;
  };

  const fakeRunJob = async (workspaceId: string, jobId: string) => {
    runCalls.push({ workspaceId, jobId });
    const job = createdJobs.find((j) => j.id === jobId);
    if (job) job.status = "done";
  };

  const fakeWorkspace = { id: randomUUID(), name: cfg.workspaceName, offer: {}, icp: {}, createdAt: new Date().toISOString() };
  let workspaceCreated = false;

  const fakeStore = {
    findOrCreateWorkspace: () => {
      workspaceCreated = true;
      return fakeWorkspace as any;
    },
    listJobs: () => createdJobs.map((j) => ({ ...j, error: j.error ?? undefined })) as any,
  };

  const fakeNow = () => {
    clock += 120_000;
    return clock;
  };

  const max = 3;
  const result = await executeSeed(
    { cfg, cities: allCities, phase: "pilot", maxJobs: max },
    {
      createJob: fakeCreateJob as any,
      runJob: fakeRunJob,
      store: fakeStore as any,
      now: fakeNow,
      log: () => {},
    }
  );

  return (
    result.ran === max &&
    runCalls.length === max &&
    createdJobs.length === max &&
    workspaceCreated
  );
}
const executeOk = await executeCheck();
report("injected execute path runs exactly max jobs and returns", executeOk);

closeDb();

try {
  unlinkSync(DB_PATH);
} catch {
  // ignore cleanup failure
}

console.log(`${fail === 0 ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
