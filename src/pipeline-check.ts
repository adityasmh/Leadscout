// src/pipeline-check.ts
// Fake-based PASS/FAIL checks for the L7 pipeline, cost gate and page cache.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RawLead, Enrichment, Match, Offer, Lead } from "./types.js";
import type {
  Evidence,
  Verification,
  LeadScore,
  Dossier,
  PriceBook,
  CategoryExplainer,
  LlmFn,
} from "./types-v2.js";
import type { PipelineDeps } from "./pipeline.js";

const tmpDir = mkdtempSync(join(tmpdir(), "leadscout-pipeline-check-"));
const dbPath = join(tmpDir, "check.db");
process.env.LEADSCOUT_DB = dbPath;

const planPath = new URL("../../../docs/leadgen/PLAN_V2.md", import.meta.url);
const typesV2Path = new URL("./types-v2.ts", import.meta.url);

const { cachedFetch, getCachedPage } = await import("./page-cache.js");
const { DEFAULT_BUDGET, record, spentForJob, callsFor, selectForLlm } = await import("./cost.js");
const { runJob } = await import("./pipeline.js");
const { createWorkspace, createJob, listJobs, getDb } = await import("./store.js");

const getJob = (workspaceId: string, jobId: string) =>
  listJobs(workspaceId).find((j) => j.id === jobId);

const results: { name: string; ok: boolean; detail?: string }[] = [];

function pass(name: string, detail?: string): void {
  results.push({ name, ok: true, detail });
}
function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail });
}

// --------------------------------------------------------------------------- 1. types-v2 matches plan
function testTypesMatch(): void {
  if (!existsSync(planPath)) {
    pass("types-v2 matches plan block", "skipped: plan doc is not part of the open-source tree");
    return;
  }
  const plan = readFileSync(planPath, "utf8");
  const blockStart = plan.indexOf("```ts\n// src/types-v2.ts");
  const blockEnd = plan.indexOf("\n```", blockStart);
  if (blockStart < 0 || blockEnd < 0) {
    fail("types-v2 matches plan block", "could not locate code block in PLAN_V2.md");
    return;
  }
  const expected = plan.slice(blockStart + 6, blockEnd).trimEnd();
  const actual = readFileSync(typesV2Path, "utf8").trimEnd();
  if (expected === actual) {
    pass("types-v2 matches plan block");
  } else {
    fail("types-v2 matches plan block", `length expected=${expected.length} actual=${actual.length}`);
  }
}

// --------------------------------------------------------------------------- 2. cache second GET hits DB
async function testCacheFreshHit(): Promise<void> {
  let calls = 0;
  const fakeFetch = async (): Promise<Response> => {
    calls++;
    return new Response("hello world", { status: 200, headers: { etag: '"abc"' } });
  };
  const fetchFn = cachedFetch({ fetchFn: fakeFetch, now: () => new Date("2026-06-01T00:00:00Z") });
  const url = "https://cache-test.example/fresh";
  const r1 = await fetchFn(url);
  const r2 = await fetchFn(url);
  const text1 = await r1.text();
  const text2 = await r2.text();
  if (calls === 1 && text1 === "hello world" && text2 === "hello world") {
    pass("cache fresh second GET has zero network calls", `calls=${calls}`);
  } else {
    fail("cache fresh second GET has zero network calls", `calls=${calls} text1=${text1} text2=${text2}`);
  }
}

// --------------------------------------------------------------------------- 3. stale entry sends If-None-Match, 304 keeps body
async function testCacheStale304(): Promise<void> {
  let calls = 0;
  let sentConditional = false;
  const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls++;
    const headers = new Headers(init?.headers);
    if (calls > 1) sentConditional = headers.has("if-none-match");
    if (calls === 1) {
      return new Response("hello world", { status: 200, headers: { etag: '"abc"' } });
    }
    return new Response(null, { status: 304, headers: { etag: '"abc"' } });
  };
  const fetchFn = cachedFetch({ fetchFn: fakeFetch, now: () => new Date("2026-06-01T00:00:00Z") });
  const url = "https://cache-test.example/stale";
  await fetchFn(url);
  const old = new Date("2025-01-01T00:00:00Z").toISOString();
  getDb().prepare("UPDATE page_cache SET fetchedAt = ? WHERE url = ?").run(old, url);
  const r2 = await fetchFn(url);
  const cached = getCachedPage(url);
  if (calls === 2 && sentConditional && cached?.body === "hello world" && cached.fetchedAt > old) {
    pass("cache stale 304 keeps body and refreshes fetchedAt", `calls=${calls} fetchedAt=${cached.fetchedAt}`);
  } else {
    fail(
      "cache stale 304 keeps body and refreshes fetchedAt",
      `calls=${calls} conditional=${sentConditional} body=${cached?.body} fetchedAt=${cached?.fetchedAt}`,
    );
  }
}

// --------------------------------------------------------------------------- 4. selectForLlm gate
function testSelectForLlm(): void {
  const cands = Array.from({ length: 30 }, (_, i) => ({
    leadId: `L${i}`,
    total: 90 - i,
    gate: "template" as const,
    richEvidence: 5,
  }));
  const selected = selectForLlm(cands, DEFAULT_BUDGET, 0);
  const top3 = ["L0", "L1", "L2"];
  const ok1 = JSON.stringify(selected) === JSON.stringify(top3);

  const lowScore = [{ leadId: "L", total: 59, gate: "template" as const, richEvidence: 5 }];
  const ok2 = selectForLlm(lowScore, DEFAULT_BUDGET, 0).length === 0;

  const thin = [{ leadId: "L", total: 80, gate: "template" as const, richEvidence: 2 }];
  const ok3 = selectForLlm(thin, DEFAULT_BUDGET, 0).length === 0;

  const many = Array.from({ length: 30 }, (_, i) => ({
    leadId: `M${i}`,
    total: 90,
    gate: "template" as const,
    richEvidence: 5,
  }));
  const selected4 = selectForLlm(many, DEFAULT_BUDGET, 140_000);
  const ok4 = selected4.length === 2;

  if (ok1 && ok2 && ok3 && ok4) {
    pass("selectForLlm honors top percent, minScore, minEvidence and token budget");
  } else {
    fail(
      "selectForLlm honors top percent, minScore, minEvidence and token budget",
      `top3=${JSON.stringify(selected)} low=${ok2} thin=${ok3} budget=${selected4.length}`,
    );
  }
}

// --------------------------------------------------------------------------- fake pipeline helpers
async function setupFakePipeline() {
  const ws = createWorkspace({
    name: "Fake Workspace",
    offer: { services: ["website", "chatbot"], description: "fake offer" } as Offer,
    icp: { categories: ["dental-clinic"], cities: ["Mumbai"], countries: ["IN"] },
  });
  const job = createJob(ws.id, { category: "dental-clinic", city: "Mumbai", limit: 30 });

  const llmCalls: string[] = [];
  const dossierStore = new Map<string, Dossier>();

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

  const fakeInputHashOf: PipelineDeps["inputHashOf"] = (input) =>
    createHash("sha256").update(JSON.stringify(input.evidence.map((e) => e.id))).digest("hex");

  const fakeSaveDossier: PipelineDeps["saveDossier"] = (d) => {
    dossierStore.set(`${d.workspaceId}:${d.leadId}`, d);
  };
  const fakeGetDossier: PipelineDeps["getDossier"] = (wsId, leadId) => dossierStore.get(`${wsId}:${leadId}`);

  const fakeLlm: LlmFn = async () => ({ text: "polished", tokensIn: 1000, tokensOut: 200, model: "fake" });

  const fakePolishDossier: PipelineDeps["polishDossier"] = async (input, draft) => {
    llmCalls.push(input.lead.id);
    const res = await fakeLlm({ system: "s", prompt: "p" });
    return { ...draft, level: 1, tokensIn: res.tokensIn, tokensOut: res.tokensOut, model: res.model } as Dossier;
  };

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
    inputHashOf: fakeInputHashOf,
    saveDossier: fakeSaveDossier,
    getDossier: fakeGetDossier,
    polishDossier: fakePolishDossier,
    getPriceBook: fakeGetPriceBook,
    getExplainer: fakeGetExplainer,
    checkLimit: fakeCheckLimit,
    meter: fakeMeter,
    llm: fakeLlm,
    reach: null,
    researchMode: "off",
    fetchFn: async () => new Response("ok"),
    now: () => new Date(),
  };

  return { ws, job, deps, llmCalls };
}

// --------------------------------------------------------------------------- 5. fake 30-lead job ends done
async function testFakeJobEndToEnd(): Promise<{ ws: any; job: any; llmCalls: string[] } | undefined> {
  const { ws, job, deps, llmCalls } = await setupFakePipeline();
  await runJob(ws.id, job.id, deps);
  const finalJob = getJob(ws.id, job.id);
  if (finalJob?.status === "done") {
    pass("fake 30-lead job ends done", `found=${finalJob.found} enriched=${finalJob.enriched}`);
  } else {
    fail("fake 30-lead job ends done", `status=${finalJob?.status} error=${finalJob?.error}`);
  }
  return { ws, job, llmCalls };
}

// --------------------------------------------------------------------------- 6. only selected leads reach LLM
function testOnlySelectedReachLlm(llmCalls: string[]): void {
  // 30 leads, top 10% rounded up = 3, all high enough to qualify
  if (llmCalls.length === 3) {
    pass("only selected leads reach fake llm", `calls=${llmCalls.length}`);
  } else {
    fail("only selected leads reach fake llm", `expected=3 actual=${llmCalls.length}`);
  }
}

// --------------------------------------------------------------------------- 7. second run with same inputs makes zero LLM calls
async function testSecondRunNoLlm(ws: any, job: any, deps: Partial<PipelineDeps>, llmCalls: string[]): Promise<void> {
  const before = llmCalls.length;
  await runJob(ws.id, job.id, deps);
  const after = llmCalls.length;
  if (after === before) {
    pass("second run with identical inputs makes zero llm calls", `before=${before} after=${after}`);
  } else {
    fail("second run with identical inputs makes zero llm calls", `before=${before} after=${after}`);
  }
}

// --------------------------------------------------------------------------- 8. LEADSCOUT_LLM_OFF=1 skips LLM
async function testLlmOff(): Promise<void> {
  process.env.LEADSCOUT_LLM_OFF = "1";
  try {
    const { ws, job, deps, llmCalls } = await setupFakePipeline();
    await runJob(ws.id, job.id, deps);
    if (llmCalls.length === 0) {
      pass("LEADSCOUT_LLM_OFF=1 makes zero llm calls");
    } else {
      fail("LEADSCOUT_LLM_OFF=1 makes zero llm calls", `calls=${llmCalls.length}`);
    }
  } finally {
    delete process.env.LEADSCOUT_LLM_OFF;
  }
}

// --------------------------------------------------------------------------- 9. missing optional module -> done + skipped note
async function testMissingOptionalModule(): Promise<void> {
  const { ws, job, deps } = await setupFakePipeline();
  // Simulate an optional module that is not installed: `??` in resolveDeps only falls
  // back on null/undefined, so a non-nullish falsy survives and trips the `!d.verify` guard.
  const depsNoVerify = { ...deps, verify: false as unknown as PipelineDeps["verify"] };
  await runJob(ws.id, job.id, depsNoVerify);
  const finalJob = getJob(ws.id, job.id);
  const hasSkipped = finalJob?.error?.includes("stage S3: verify skipped: module not installed");
  if (finalJob?.status === "done" && hasSkipped) {
    pass("missing optional module gives done plus skipped note");
  } else {
    fail("missing optional module gives done plus skipped note", `status=${finalJob?.status} error=${finalJob?.error}`);
  }
}

// --------------------------------------------------------------------------- 10. three consecutive 429s from discover -> failed plain error
async function testDiscover429(): Promise<void> {
  const { ws, job, deps } = await setupFakePipeline();
  const failingDiscover: PipelineDeps["discover"] = async () => {
    throw new Error("Overpass returned HTTP 429");
  };
  await runJob(ws.id, job.id, { ...deps, discover: failingDiscover });
  const finalJob = getJob(ws.id, job.id);
  if (finalJob?.status === "failed" && finalJob?.error?.includes("429")) {
    pass("discover 429 gives failed with plain error", finalJob.error);
  } else {
    fail("discover 429 gives failed with plain error", `status=${finalJob?.status} error=${finalJob?.error}`);
  }
}

// --------------------------------------------------------------------------- 11. ledger totals equal fake usage
function testLedgerTotals(jobId: string, llmCalls: string[]): void {
  const total = spentForJob(jobId);
  const expected = llmCalls.length * (1000 + 200);
  if (total === expected) {
    pass("ledger totals equal sum of fake usage", `total=${total} calls=${llmCalls.length}`);
  } else {
    fail("ledger totals equal sum of fake usage", `expected=${expected} actual=${total}`);
  }
}

// --------------------------------------------------------------------------- main
async function main(): Promise<void> {
  try {
    testTypesMatch();
    await testCacheFreshHit();
    await testCacheStale304();
    testSelectForLlm();

    const endToEnd = await testFakeJobEndToEnd();
    if (endToEnd) {
      testOnlySelectedReachLlm(endToEnd.llmCalls);
      await testSecondRunNoLlm(endToEnd.ws, endToEnd.job, endToEnd.deps, endToEnd.llmCalls);
      testLedgerTotals(endToEnd.job.id, endToEnd.llmCalls);
    } else {
      fail("only selected leads reach fake llm", "end-to-end setup failed");
      fail("second run with identical inputs makes zero llm calls", "end-to-end setup failed");
      fail("ledger totals equal sum of fake usage", "end-to-end setup failed");
    }

    await testLlmOff();
    await testMissingOptionalModule();
    await testDiscover429();
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
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
