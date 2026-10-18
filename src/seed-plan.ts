// src/seed-plan.ts
// India seed run config and one-shot runner. No timers, no self-scheduling.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Job, JobQuery, Offer, Workspace } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export type SeedConfig = {
  version: number;
  workspaceName: string;
  pilot: { cities: string[]; categories: string[]; limit: number };
  phases: Array<{ name: string; cityCount: number; categories: string[]; limit: number }>;
  spacing: { overpassSeconds: number; maxJobsPerRun: number };
  budget: { maxTokensPerJob: number };
};

export type SeedJob = {
  key: string;
  category: string;
  city: string;
  country: string;
  limit: number;
  notBefore: number; // epoch milliseconds
};

export type SeedPhase = "pilot" | "A" | "B";

export const SEED_PHASES: SeedPhase[] = ["pilot", "A", "B"];

/** Key format: "phase:category:city". Documented in REPORT_L13-india-seed.md. */
export function jobKey(phase: SeedPhase, category: string, city: string): string {
  return `${phase}:${category}:${city}`;
}

function parsePhase(value: string | undefined): SeedPhase | undefined {
  if (value === "pilot" || value === "A" || value === "B") return value;
  return undefined;
}

function pickCities(cfg: SeedConfig, phase: SeedPhase, allCities: string[]): string[] {
  if (phase === "pilot") return cfg.pilot.cities;
  let startIdx = 0;
  for (const p of cfg.phases) {
    if (p.name === phase) {
      return allCities.slice(startIdx, startIdx + p.cityCount);
    }
    startIdx += p.cityCount;
  }
  return [];
}

function pickCategories(cfg: SeedConfig, phase: SeedPhase): string[] {
  if (phase === "pilot") return cfg.pilot.categories;
  const phaseCfg = cfg.phases.find((p) => p.name === phase);
  return phaseCfg?.categories ?? [];
}

function pickLimit(cfg: SeedConfig, phase: SeedPhase): number {
  if (phase === "pilot") return cfg.pilot.limit;
  const phaseCfg = cfg.phases.find((p) => p.name === phase);
  return phaseCfg?.limit ?? 0;
}

/**
 * Pure planner. No I/O, no Date.now().
 * @param startAt - epoch milliseconds injected by caller.
 */
export function buildSeedPlan(
  cfg: SeedConfig,
  cities: string[],
  opts: { startAt: number; phase?: SeedPhase } = { startAt: 0 }
): SeedJob[] {
  const phase = opts.phase ?? "pilot";
  const startAt = opts.startAt;
  const citySet = new Set(cities);
  const selectedCities = pickCities(cfg, phase, cities).filter((c) => citySet.has(c));
  const categories = pickCategories(cfg, phase);
  const limit = pickLimit(cfg, phase);
  const jobs: SeedJob[] = [];
  for (let cityIdx = 0; cityIdx < selectedCities.length; cityIdx++) {
    const city = selectedCities[cityIdx];
    for (let catIdx = 0; catIdx < categories.length; catIdx++) {
      const category = categories[catIdx];
      const i = cityIdx * categories.length + catIdx;
      jobs.push({
        key: jobKey(phase, category, city),
        category,
        city,
        country: "India",
        limit,
        notBefore: startAt + i * cfg.spacing.overpassSeconds * 1000,
      });
    }
  }
  return jobs;
}

/**
 * Returns jobs that are due at `now`, not already done, up to `max`, preserving plan order.
 * @param now - epoch milliseconds.
 * @param doneKeys - any iterable of finished job keys; normalized to a Set internally.
 */
export function dueJobs(
  plan: SeedJob[],
  now: number,
  max: number,
  doneKeys: Iterable<string> | Set<string> = new Set<string>()
): SeedJob[] {
  const done = doneKeys instanceof Set ? doneKeys : new Set(doneKeys);
  const out: SeedJob[] = [];
  for (const job of plan) {
    if (out.length >= max) break;
    if (done.has(job.key)) continue;
    if (job.notBefore <= now) out.push(job);
  }
  return out;
}

export type SeedStore = {
  findOrCreateWorkspace(input: { name: string; offer: Offer; icp: { categories: string[]; cities: string[]; countries: string[] } }): Workspace;
  listJobs(workspaceId: string): Job[];
};

export type ExecuteDeps = {
  createJob: (workspaceId: string, query: JobQuery & { seedKey: string }) => Job;
  runJob: (workspaceId: string, jobId: string) => Promise<void>;
  store: SeedStore;
  now: () => number;
  log?: (msg: string) => void;
};

export type ExecuteResult = {
  planned: number;
  due: number;
  ran: number;
  skipped: number;
  stopped?: boolean;
  nextDue?: number;
  reason?: string;
  lastStart?: number;
};

function latestSeedStart(jobs: Job[], planKeys: Set<string>): number | undefined {
  let latest: number | undefined;
  for (const job of jobs) {
    const seedKey = (job.query as Record<string, unknown>).seedKey;
    if (typeof seedKey !== "string" || !planKeys.has(seedKey)) continue;
    const t = new Date(job.createdAt).getTime();
    if (latest === undefined || t > latest) latest = t;
  }
  return latest;
}

/**
 * One-shot executor. Runs at most `opts.maxJobs` due jobs sequentially, gated by spacing.
 * No timers, no self-scheduling.
 */
export async function executeSeed(
  opts: { cfg: SeedConfig; cities: string[]; phase?: SeedPhase; maxJobs?: number },
  deps: ExecuteDeps
): Promise<ExecuteResult> {
  const cfg = opts.cfg;
  const phase = opts.phase ?? "pilot";
  const maxJobs = opts.maxJobs ?? cfg.spacing.maxJobsPerRun;
  const log = deps.log ?? ((msg: string) => console.log(msg));

  const now = deps.now();
  // Seed plan baseline is 0 so that, at any real now, all un-run jobs are due
  // and the spacing gate paces them within the run.
  const plan = buildSeedPlan(cfg, opts.cities, { startAt: 0, phase });
  const planKeys = new Set(plan.map((j) => j.key));

  const workspace = deps.store.findOrCreateWorkspace({
    name: cfg.workspaceName,
    offer: { services: [], description: "" },
    icp: { categories: [], cities: [], countries: ["India"] },
  });

  const storeJobs = deps.store.listJobs(workspace.id);
  const doneKeys = new Set<string>();
  for (const job of storeJobs) {
    const seedKey = (job.query as Record<string, unknown>).seedKey;
    if (typeof seedKey === "string" && planKeys.has(seedKey) && (job.status === "done" || job.status === "failed")) {
      doneKeys.add(seedKey);
    }
  }

  const due = dueJobs(plan, now, maxJobs, doneKeys);
  let ran = 0;
  let skipped = 0;
  let lastStart = latestSeedStart(storeJobs, planKeys);

  for (const seedJob of due) {
    const checkNow = deps.now();
    if (lastStart !== undefined) {
      const elapsed = checkNow - lastStart;
      if (elapsed < cfg.spacing.overpassSeconds * 1000) {
        const nextDue = lastStart + cfg.spacing.overpassSeconds * 1000;
        return {
          planned: plan.length,
          due: due.length,
          ran,
          skipped,
          stopped: true,
          nextDue,
          reason: `next job due at ${new Date(nextDue).toISOString()} (${Math.ceil((cfg.spacing.overpassSeconds * 1000 - elapsed) / 1000)}s remaining)`,
          lastStart,
        };
      }
    }

    const job = deps.createJob(workspace.id, {
      category: seedJob.category,
      city: seedJob.city,
      country: seedJob.country,
      limit: seedJob.limit,
      seedKey: seedJob.key,
    });
    lastStart = new Date(job.createdAt).getTime();

    await deps.runJob(workspace.id, job.id);
    ran++;
  }

  skipped = due.length - ran;
  return { planned: plan.length, due: due.length, ran, skipped, lastStart };
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function printPlan(plan: SeedJob[]): void {
  console.log("| key | category | city | limit | notBefore |");
  console.log("|---|---|---|---|---|");
  for (const job of plan) {
    console.log(`| ${job.key} | ${job.category} | ${job.city} | ${job.limit} | ${job.notBefore} |`);
  }
}

function showUsage(): void {
  console.log("Usage: tsx src/seed-plan.ts --dry-run [--phase pilot|A|B]");
  console.log("       tsx src/seed-plan.ts --execute --max-jobs N [--phase pilot|A|B]");
}

function showPhaseError(): void {
  console.log("Invalid --phase. Valid options: pilot, A, B");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    showUsage();
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  const execute = args.includes("--execute");
  const phaseIdx = args.indexOf("--phase");
  const phaseArg = phaseIdx >= 0 ? args[phaseIdx + 1] : undefined;
  const phase = parsePhase(phaseArg);
  if (phaseArg !== undefined && phase === undefined) {
    showPhaseError();
    process.exit(1);
  }

  const maxJobsIdx = args.indexOf("--max-jobs");
  const maxJobsArg = maxJobsIdx >= 0 ? args[maxJobsIdx + 1] : undefined;
  const maxJobs = maxJobsArg !== undefined ? Number(maxJobsArg) : undefined;

  const cfg = loadJson<SeedConfig>(`${HERE}/../data/seed-india.json`);
  const cityData = loadJson<{ cities: Array<{ name: string }> }>(`${HERE}/../data/india-cities.json`);
  const cities = cityData.cities.map((c) => c.name);

  if (dryRun) {
    const plan = buildSeedPlan(cfg, cities, { startAt: 0, phase });
    printPlan(plan);
    console.log(`Jobs: ${plan.length}`);
    process.exit(0);
  }

  if (execute) {
    let pipeline;
    try {
      pipeline = await import("./pipeline.js");
    } catch {
      console.log("pipeline runner not available: could not import ./pipeline.js");
      process.exit(1);
    }
    if (typeof pipeline.runJob !== "function") {
      console.log("pipeline runner not available: ./pipeline.js must export runJob");
      process.exit(1);
    }
    const store = await import("./store.js");
    try {
      const result = await executeSeed(
        { cfg, cities, phase, maxJobs },
        {
          createJob: store.createJob as ExecuteDeps["createJob"],
          runJob: pipeline.runJob as unknown as ExecuteDeps["runJob"],
          store: {
            findOrCreateWorkspace: (input) => {
              const existing = store.listWorkspaces().find((w) => w.name === input.name);
              return existing ?? store.createWorkspace(input);
            },
            listJobs: store.listJobs,
          },
          now: () => Date.now(),
          log: console.log,
        }
      );
      console.log(`Seed run complete: planned=${result.planned} due=${result.due} ran=${result.ran} skipped=${result.skipped}`);
      if (result.stopped) {
        console.log(`Stopped: ${result.reason}`);
      } else if (result.due === 0) {
        console.log("0 jobs due");
      }
      if (result.lastStart !== undefined) {
        console.log(`Last seed job start: ${new Date(result.lastStart).toISOString()}`);
      }
      process.exit(0);
    } catch (err) {
      console.log(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }
  }

  showUsage();
  process.exit(1);
}

function isEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((err) => {
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
