// src/pipeline-timing-wiring-check.ts
// PASS/FAIL checks for timing signals wired into the pipeline.


import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawLead, Enrichment, Match, Offer } from "./types.js";
import type { Verification, LeadScore, Evidence } from "./types-v2.js";
import type { PipelineDeps } from "./pipeline.js";
import { createWorkspace, createJob, listJobs, listLeads, getDb } from "./store.js";
import { timingForLead, mergeSignals } from "./pipeline-timing.js";
import type { TimingObservation } from "./timing.js";
import { runJob } from "./pipeline.js";

const tmpDir = mkdtempSync(join(tmpdir(), "leadscout-timing-wiring-check-"));
const dbPath = join(tmpDir, "check.db");
process.env.LEADSCOUT_DB = dbPath;

const results: { name: string; ok: boolean; detail?: string }[] = [];

function pass(name: string, detail?: string): void {
  results.push({ name, ok: true, detail });
}
function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail });
}

const FIXED_NOW = new Date("2026-10-01T12:00:00Z"); // Peak for dental-clinic/India starts Nov 1 (31 days away)
const SEASON_LOOKAHEAD_DAYS = 45;
const NEW_LISTING_DAYS = 60;

async function setupTimingPipeline(overrides: Partial<PipelineDeps> = {}) {
  const ws = createWorkspace({
    name: "Timing Test Workspace",
    offer: { services: ["website"], description: "test offer" } as Offer,
    icp: { categories: ["dental-clinic"], cities: ["Mumbai"], countries: ["IN"] },
  });
  const job = createJob(ws.id, { category: "dental-clinic", city: "Mumbai", country: "India", limit: 1 });

  const fakeDiscover: PipelineDeps["discover"] = async () => [
    {
      name: "Test Dental Clinic",
      category: "dental-clinic",
      city: "Mumbai",
      country: "India",
      phone: "+919876543210",
      website: "https://test-dental.example.com",
      source: "osm",
      sourceUrl: "https://osm.org/node/1",
    } as RawLead,
  ];

  const fakeEnrich: PipelineDeps["enrich"] = async (lead) =>
    ({
      summary: `Fake summary for ${lead.name}`,
      emails: [],
      phones: [lead.phone ?? ""].filter(Boolean),
      socials: {},
      signals: ["no-website", "no-chat-widget"],
    } as Enrichment);

  const fakeMatch: PipelineDeps["match"] = (lead) => ({
    score: 80,
    fit: [{ service: "website", score: 80, reason: "fake signal" }],
    angle: "fake angle",
  } as Match);

  const fakeVerify: PipelineDeps["verify"] = async () =>
    ({
      bizKey: "test-dental",
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
      total: 80,
      fit: 80,
      reach: v.contactable ? 50 : 0,
      timing: 0,
      gate: "template",
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
    } as any);

  const fakeInputHashOf: PipelineDeps["inputHashOf"] = (input) =>
    "hash";

  const fakeGetPriceBook: PipelineDeps["getPriceBook"] = () =>
    ({ workspaceId: ws.id, version: 1, items: [], updatedAt: new Date().toISOString() } as any);

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
    inputHashOf: fakeInputHashOf,
    getPriceBook: fakeGetPriceBook,
    getExplainer: fakeGetExplainer,
    checkLimit: fakeCheckLimit,
    meter: fakeMeter,
    fetchFn: async () => new Response("ok"),
    now: () => FIXED_NOW,
    ...overrides,
  };

  return { ws, job, deps };
}

async function testSeasonWindowFlag(): Promise<void> {
  const { ws, job, deps } = await setupTimingPipeline();
  const result = await runJob(ws.id, job.id, deps);

  const finalJob = listJobs(ws.id).find((j) => j.id === job.id);
  const leads = listLeads({ workspaceId: ws.id }).leads;
  const lead = leads[0];

  const hasSeasonWindow = lead.signals.includes("timing:season-window");
  const timingFlagged = result.timing?.flagged === 1;

  if (hasSeasonWindow && timingFlagged) {
    pass("season-window flag added and timing.flagged=1", `signals=${JSON.stringify(lead.signals)} timing=${JSON.stringify(result.timing)}`);
  } else {
    fail("season-window flag added and timing.flagged=1", `seasonWindow=${hasSeasonWindow} flagged=${timingFlagged} signals=${JSON.stringify(lead.signals)} timing=${JSON.stringify(result.timing)}`);
  }
}

async function testTimingDisabled(): Promise<void> {
  process.env.LEADSCOUT_TIMING = "0";
  try {
    const { ws, job, deps } = await setupTimingPipeline();
    const result = await runJob(ws.id, job.id, deps);

    const leads = listLeads({ workspaceId: ws.id }).leads;
    const lead = leads[0];

    const hasTimingSignal = lead.signals.some((s) => s.startsWith("timing:"));
    const hasTimingField = result.timing !== undefined;

    if (!hasTimingSignal && !hasTimingField) {
      pass("LEADSCOUT_TIMING=0 disables timing signals and result field");
    } else {
      fail("LEADSCOUT_TIMING=0 disables timing signals and result field", `hasTimingSignal=${hasTimingSignal} hasTimingField=${hasTimingField} signals=${JSON.stringify(lead.signals)} timing=${JSON.stringify(result.timing)}`);
    }
  } finally {
    delete process.env.LEADSCOUT_TIMING;
  }
}

async function testJobStillScores(): Promise<void> {
  const { ws, job, deps } = await setupTimingPipeline();
  const result = await runJob(ws.id, job.id, deps);

  const finalJob = listJobs(ws.id).find((j) => j.id === job.id);
  const leads = listLeads({ workspaceId: ws.id }).leads;
  const lead = leads[0];

  if (finalJob?.status === "done" && typeof lead.score === "number" && !isNaN(lead.score) && result.timing !== undefined) {
    pass("job still scores without error", `status=${finalJob.status} score=${lead.score} timing=${JSON.stringify(result.timing)}`);
  } else {
    fail("job still scores without error", `status=${finalJob?.status} score=${lead.score} timing=${JSON.stringify(result.timing)}`);
  }
}

async function testNewListingFlag(): Promise<void> {
  const tenDaysAgo = new Date(FIXED_NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const obsFn: (raw: RawLead) => TimingObservation[] = (raw) => [
    { kind: "first-seen", url: "https://example.com/listing/1", date: tenDaysAgo },
  ];

  const { ws, job, deps } = await setupTimingPipeline({ timingObservations: obsFn });
  const result = await runJob(ws.id, job.id, deps);

  const leads = listLeads({ workspaceId: ws.id }).leads;
  const lead = leads[0];

  const hasNewListing = lead.signals.includes("timing:new-listing");

  if (hasNewListing) {
    pass("first-seen observation 10 days old adds timing:new-listing", `signals=${JSON.stringify(lead.signals)} timing=${JSON.stringify(result.timing)}`);
  } else {
    fail("first-seen observation 10 days old adds timing:new-listing", `signals=${JSON.stringify(lead.signals)} timing=${JSON.stringify(result.timing)}`);
  }
}

async function main(): Promise<void> {
  try {
    await testSeasonWindowFlag();
    await testTimingDisabled();
    await testJobStillScores();
    await testNewListingFlag();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
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