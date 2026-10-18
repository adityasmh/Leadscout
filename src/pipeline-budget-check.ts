// src/pipeline-budget-check.ts
// Offline PASS/FAIL checks for the BDW3 research-budget wiring.


import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawLead, Enrichment, Match, Offer } from "./types.js";
import type {
  Evidence,
  Verification,
  LeadScore,
  Dossier,
  PriceBook,
  CategoryExplainer,
  LlmFn,
} from "./types-v2.js";
import type { PipelineDeps, JobCounts } from "./pipeline.js";
import type { Workspace, Job } from "./types.js";

const tmpDir = mkdtempSync(join(tmpdir(), "leadscout-pipeline-budget-check-"));
const dbPath = join(tmpDir, "check.db");
process.env.LEADSCOUT_DB = dbPath;

const { runJob } = await import("./pipeline.js");
const { createWorkspace, createJob, listJobs, listLeads, closeDb } = await import("./store.js");

const getJob = (workspaceId: string, jobId: string): Job | undefined =>
  listJobs(workspaceId).find((j) => j.id === jobId);

const results: { name: string; ok: boolean; detail?: string }[] = [];
function pass(name: string, detail?: string): void {
  results.push({ name, ok: true, detail });
}
function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail });
}

async function setupFakePipeline(): Promise<{
  ws: Workspace;
  job: Job;
  deps: Partial<PipelineDeps>;
}> {
  const ws = createWorkspace({
    name: "Fake Workspace",
    offer: { services: ["website", "chatbot"], description: "fake offer" } as Offer,
    icp: { categories: ["dental-clinic"], cities: ["Mumbai"], countries: ["IN"] },
  });
  const job = createJob(ws.id, { category: "dental-clinic", city: "Mumbai", limit: 30 });

  const fakeDiscover: PipelineDeps["discover"] = async () =>
    Array.from({ length: 30 }, (_, i) => ({
      name: `Fake Dental ${i}`,
      category: "dental-clinic",
      city: "Mumbai",
      country: "IN",
      phone: "+919876543210",
      website: `https://fake${i}.example.com`,
      source: "osm",
      sourceUrl: `https://osm.org/node/${i}`,
    } as RawLead));

  const fakeEnrich: PipelineDeps["enrich"] = async (lead) =>
    ({
      summary: `Fake summary for ${lead.name}`,
      emails: [],
      phones: [lead.phone ?? ""].filter(Boolean),
      socials: {},
      signals: ["no-website", "no-chat-widget"],
    } as Enrichment);

  const fakeMatch: PipelineDeps["match"] = (lead) => {
    const idx = Number(lead.sourceUrl?.split("/").pop() ?? 0);
    return {
      score: 80 - idx,
      fit: [{ service: "website", score: 80 - idx, reason: "fake signal" }],
      angle: "fake angle",
    } as Match;
  };

  const fakeVerify: PipelineDeps["verify"] = async () =>
    ({
      bizKey: "",
      checkedAt: new Date().toISOString(),
      website: "alive",
      emails: [],
      phones: [],
      whatsapp: false,
      contactable: true,
      reasons: [],
    } as Verification);

  const fakeScoreLead: PipelineDeps["scoreLead"] = (lead, v) =>
    ({
      total: lead.score ?? 0,
      fit: 0,
      reach: v.contactable ? 50 : 0,
      timing: 0,
      gate: (lead.score ?? 0) >= 60 && v.contactable ? "template" : "hidden",
      reasons: [],
    } as LeadScore);

  const fakeBuildEvidence: PipelineDeps["buildEvidence"] = () =>
    [
      { id: "E1", kind: "page-text", url: "https://fake.example.com", quote: "q1", fetchedAt: new Date().toISOString() },
      { id: "E2", kind: "page-text", url: "https://fake.example.com", quote: "q2", fetchedAt: new Date().toISOString() },
      { id: "E3", kind: "page-text", url: "https://fake.example.com", quote: "q3", fetchedAt: new Date().toISOString() },
    ] as Evidence[];

  const fakeBuildTemplateDossier: PipelineDeps["buildTemplateDossier"] = (input) =>
    ({
      leadId: input.lead.id,
      workspaceId: input.lead.workspaceId,
      bizKey: "fake",
      level: 0,
      facts: {},
      gap: null,
      sayThis: null,
      pushback: null,
      offers: [],
      evidence: input.evidence,
      callStatus: "not-called",
      dropped: [],
      inputHash: "",
      promptVersion: "v1",
      tokensIn: 0,
      tokensOut: 0,
      createdAt: new Date().toISOString(),
    } as Dossier);

  const fakeGetPriceBook: PipelineDeps["getPriceBook"] = () =>
    ({ workspaceId: ws.id, version: 1, items: [], updatedAt: new Date().toISOString() } as PriceBook);

  const fakeGetExplainer: PipelineDeps["getExplainer"] = async () => null;
  const fakeCheckLimit: PipelineDeps["checkLimit"] = () => ({ ok: true, remaining: Infinity });
  const fakeMeter: PipelineDeps["meter"] = () => {};

  const deps: Partial<PipelineDeps> = {
    discover: fakeDiscover,
    enrich: fakeEnrich,
    match: fakeMatch,
    verify: fakeVerify,
    scoreLead: fakeScoreLead,
    buildEvidence: fakeBuildEvidence,
    buildTemplateDossier: fakeBuildTemplateDossier,
    getPriceBook: fakeGetPriceBook,
    getExplainer: fakeGetExplainer,
    checkLimit: fakeCheckLimit,
    meter: fakeMeter,
    researchMode: "off",
    fetchFn: async () => new Response("ok"),
    now: () => new Date(),
  };

  return { ws, job, deps };
}

async function main(): Promise<void> {
  const previous = process.env.LEADSCOUT_RESEARCH_BUDGET;
  let assert1Detail = "";
  try {
    // Assertion 1: default (budget on)
    if (previous === "0") delete process.env.LEADSCOUT_RESEARCH_BUDGET;
    const setupOn = await setupFakePipeline();
    const resultOn: JobCounts = await runJob(setupOn.ws.id, setupOn.job.id, setupOn.deps);
    const jobOn = getJob(setupOn.ws.id, setupOn.job.id);
    const budget = resultOn.research?.budget;
    const budgetOk =
      budget !== undefined &&
      typeof budget.savedCalls === "number" &&
      typeof budget.stepsSkipped === "number";
    if (jobOn?.status === "done" && budgetOk) {
      pass("job returns numeric research.budget (savedCalls, stepsSkipped)", `savedCalls=${budget?.savedCalls} stepsSkipped=${budget?.stepsSkipped}`);
    } else {
      fail("job returns numeric research.budget (savedCalls, stepsSkipped)", `status=${jobOn?.status} budget=${JSON.stringify(budget)}`);
    }
    const leadsOn = listLeads({ workspaceId: setupOn.ws.id }).total;

    // Assertion 2: budget off
    process.env.LEADSCOUT_RESEARCH_BUDGET = "0";
    const setupOff = await setupFakePipeline();
    const resultOff: JobCounts = await runJob(setupOff.ws.id, setupOff.job.id, setupOff.deps);
    const jobOff = getJob(setupOff.ws.id, setupOff.job.id);
    const offBudget = resultOff.research?.budget;
    if (jobOff?.status === "done" && offBudget === undefined) {
      pass("with LEADSCOUT_RESEARCH_BUDGET=0 research.budget is undefined");
    } else {
      fail("with LEADSCOUT_RESEARCH_BUDGET=0 research.budget is undefined", `status=${jobOff?.status} budget=${JSON.stringify(offBudget)}`);
    }
    const leadsOff = listLeads({ workspaceId: setupOff.ws.id }).total;

    // Assertion 3: lead count identical
    if (leadsOn === leadsOff && resultOn.found === resultOff.found) {
      pass("lead count identical with and without budget", `on=${leadsOn} off=${leadsOff} foundOn=${resultOn.found} foundOff=${resultOff.found}`);
    } else {
      fail("lead count identical with and without budget", `on=${leadsOn} off=${leadsOff} foundOn=${resultOn.found} foundOff=${resultOff.found}`);
    }
  } finally {
    if (previous === undefined) delete process.env.LEADSCOUT_RESEARCH_BUDGET;
    else process.env.LEADSCOUT_RESEARCH_BUDGET = previous;
    try {
      closeDb();
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  }

  let passed = 0;
  for (const r of results) {
    const label = r.ok ? "PASS" : "FAIL";
    console.log(`${label}: ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
    if (r.ok) passed++;
  }
  const total = results.length;
  console.log(`${passed === total ? "PASS" : "FAIL"} ${passed}/${total}`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error("check crashed:", err);
  process.exit(1);
});
