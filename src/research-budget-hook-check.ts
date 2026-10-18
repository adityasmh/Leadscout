// src/research-budget-hook-check.ts
// BDW2: offline proof that research.ts reports consumption to deps.budget.
// Fakes only; no real network, no .env read.

import { researchBusiness, type ReachApi, type ResearchDeps } from "./research.js";
import type { RawLead } from "./types.js";
import type { Enrichment } from "./types.js";
import { planBudget, startBudget, type BudgetState, EMPTY_STEPS_TO_STOP } from "./research-budget.js";
import type { ReachResult, ReachStatus } from "./reach.js";

const FIXED = Date.parse("2026-03-04T05:06:07Z");

const lead: RawLead = {
  name: "Fake Biz", category: "x", city: "Pune", country: "IN",
  website: "https://plain.example/", source: "fake", sourceUrl: "https://osm.example/node/1",
};

const PLAIN_ENRICHMENT = (name: string): Enrichment => ({
  summary: `Plain summary for ${name}`, emails: [], phones: [], socials: {}, signals: [],
});

type Log = string[];

function reachResult(channel: string, text: string): ReachResult {
  return { ok: text.trim().length > 0, channel, text, untrusted: true, trace: [] };
}

function makeFakeReach(
  log: Log,
  opts: { pageText?: string; searchText?: string; feedText?: string; socialText?: string; status?: ReachStatus } = {},
): ReachApi {
  const status: ReachStatus = opts.status ?? { available: true, channels: { twitter: { ok: true } } };
  const pageText = opts.pageText ?? "Title: Fake Biz Pune\n\nMarkdown Content:\nFake Biz is a dental studio.";
  const searchText = opts.searchText ?? "Search results mention Fake Biz Pune.";
  const feedText = opts.feedText ?? "Recent news: Fake Biz Pune opened.";
  const socialText = opts.socialText ?? "Fake Biz Pune posted new photos.";
  return {
    reachStatus: async () => { log.push("reach.reachStatus"); return status; },
    readPage: async (url) => { log.push(`reach.readPage ${url}`); return reachResult("web", pageText); },
    searchWeb: async (q) => { log.push(`reach.searchWeb ${q}`); return reachResult("exa_search", searchText); },
    readFeed: async (url) => { log.push(`reach.readFeed ${url}`); return reachResult("rss", feedText); },
    socialSearch: async (channel, q) => { log.push(`reach.socialSearch ${channel} ${q}`); return reachResult(channel, socialText); },
  };
}

function makeFetch(log: Log): typeof fetch {
  return (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as { url?: string }).url ?? "");
    log.push(`fetch ${url}`);
    return Promise.resolve(new Response("<html><body>plain</body></html>", { status: 200 }));
  };
}

function makeEnrich(fetchFn: typeof fetch): { enrich: ResearchDeps["enrich"] } {
  const enrich: ResearchDeps["enrich"] = async (l, d) => {
    const f = d?.fetchFn ?? fetchFn;
    if (f && l.website) await f(l.website);
    return PLAIN_ENRICHMENT(l.name);
  };
  return { enrich };
}

type Part = [ok: boolean, reason: string];

// Measure the no-budget baseline once, then reuse the named constant.
const __baselineLog: Log = [];
const __baselineFetch = makeFetch(__baselineLog);
const __baselineEnrich = makeEnrich(__baselineFetch).enrich;
const __baselineResult = await researchBusiness(lead, {}, {
  enrich: __baselineEnrich,
  fetchFn: __baselineFetch,
  reach: makeFakeReach(__baselineLog, { pageText: "", searchText: "" }),
  now: () => new Date(FIXED),
});
const BASELINE_NO_BUDGET_CALL_COUNT: number = __baselineResult.callsUsed;

async function nothingNewRun(useBudget: boolean): Promise<{ calls: number; stepsUsed: number; result: Awaited<ReturnType<typeof researchBusiness>>; budget?: BudgetState }> {
  const log: Log = [];
  const fetchFn = makeFetch(log);
  const { enrich } = makeEnrich(fetchFn);
  const budget = useBudget ? startBudget(planBudget(lead, {}, {})) : undefined;
  const res = await researchBusiness(lead, {}, {
    enrich, fetchFn, reach: makeFakeReach(log, { pageText: "", searchText: "" }), now: () => new Date(FIXED), budget,
  });
  return { calls: res.callsUsed, stepsUsed: budget ? budget.stepsUsed : 0, result: res, budget };
}

async function allNewRun(useBudget: boolean): Promise<{ calls: number; stepsUsed: number; result: Awaited<ReturnType<typeof researchBusiness>>; budget?: BudgetState }> {
  const log: Log = [];
  const fetchFn = makeFetch(log);
  const { enrich } = makeEnrich(fetchFn);
  const budget = useBudget ? startBudget(planBudget(lead, {}, {})) : undefined;
  const res = await researchBusiness(lead, {}, {
    enrich, fetchFn,
    reach: makeFakeReach(log, {
      pageText: "Title: Fake Biz Pune\n\nMarkdown Content:\nFake Biz is a family-run dental studio.",
      searchText: "Search results mention Fake Biz Pune contact details.",
      feedText: "Recent news: Fake Biz Pune opened a second studio.",
      socialText: "Fake Biz Pune posted new photos this week.",
    }),
    now: () => new Date(FIXED), budget,
  });
  return { calls: res.callsUsed, stepsUsed: budget ? budget.stepsUsed : 0, result: res, budget };
}

// --------------------------------------------------------------------------- checks

async function check1Parts(): Promise<Part[]> {
  const b = await nothingNewRun(true);
  const n = await nothingNewRun(false);
  return [
    [b.calls < n.calls, `budgetCalls=${b.calls} noBudgetCalls=${n.calls}`],
    [b.stepsUsed > 0, `stepsUsed=${b.stepsUsed}`],
  ];
}

async function check2Parts(): Promise<Part[]> {
  const n1 = await nothingNewRun(false);
  const n2 = await nothingNewRun(false);
  return [
    [n1.calls === BASELINE_NO_BUDGET_CALL_COUNT, `measured=${n1.calls} baseline=${BASELINE_NO_BUDGET_CALL_COUNT}`],
    [n2.calls === BASELINE_NO_BUDGET_CALL_COUNT, `secondRun=${n2.calls} baseline=${BASELINE_NO_BUDGET_CALL_COUNT}`],
  ];
}

async function check3Parts(): Promise<Part[]> {
  const b = await allNewRun(true);
  const n = await allNewRun(false);
  return [
    [b.result.stoppedBecause !== "call-budget", `stoppedBecause=${String(b.result.stoppedBecause)}`],
    [b.calls === n.calls, `budgetCalls=${b.calls} noBudgetCalls=${n.calls}`],
    [b.stepsUsed >= 4, `stepsUsed=${b.stepsUsed}`],
  ];
}

const checks: Array<{ name: string; run: () => Promise<Part[]> }> = [
  { name: "budget run (nothing new) makes fewer calls and stepsUsed>0", run: check1Parts },
  { name: "no-budget run makes the recorded baseline call count", run: check2Parts },
  { name: "all steps find something new: no early budget stop", run: check3Parts },
];

let anyFail = false;
for (const c of checks) {
  let parts: Part[];
  try {
    parts = await c.run();
  } catch (err) {
    parts = [[false, `crashed: ${(err as Error)?.message ?? String(err)}`]];
  }
  const bad = parts.find(([ok]) => !ok);
  console.log(`${bad ? "FAIL" : "PASS"} ${c.name}${bad ? `: ${bad[1]}` : ""}`);
  if (bad) { anyFail = true; process.exitCode = 1; }
}

// done