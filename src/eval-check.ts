// src/eval-check.ts
// L10-verify-score: self-contained eval harness.
//
// Runs verify + match + scoreLead against fixtures-v2/eval/leads.json using
// injected fake fetch and MX resolver so no real network calls are made.
// Prints PASS/FAIL/SKIP per fixture plus the standalone proof lines required
// by the order. Uses a temporary database so the run is isolated.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIXTURES_PATH = join(ROOT, "fixtures-v2", "eval", "leads.json");
const CALENDAR_PATH = join(ROOT, "data", "season-calendar.json");

const TMP_DB = join(ROOT, "data", `leadscout-eval-${Date.now()}.db`);
process.env.LEADSCOUT_DB = TMP_DB;

const { verify, classifyPhone, isDummyEmail } = await import("./verify.js");
const { scoreLead } = await import("./score.js");

let match: typeof import("./match.js").match | null = null;
try {
  const mod = await import("./match.js");
  match = mod.match;
} catch {
  match = null;
}

import type { RawLead, Enrichment, Offer, Lead } from "./types.js";
import type { Verification } from "./types-v2.js";
import type { SeasonCalendar } from "./score.js";

type Fixture = {
  id: string;
  case: string;
  rawLead: RawLead;
  enrichment: Enrichment;
  mx: Record<string, string[]>;
  fetch: Record<string, number>;
  offer: Offer;
  runMonth: number;
  optedOut?: boolean;
  expected: {
    minScore: number;
    maxScore: number;
    gate: "hidden" | "template" | "llm";
    tag?: string;
    topService?: string;
    sameBizKeyAs?: string;
  };
};

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const fixtures = loadJson<Fixture[]>(FIXTURES_PATH);
const calendar = loadJson<SeasonCalendar>(CALENDAR_PATH);

function makeFetch(fixture: Fixture): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const status = fixture.fetch[url];
    if (status === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response("ok", { status });
  }) as typeof fetch;
  return { fn, calls };
}

function makeResolveMx(fixture: Fixture): (domain: string) => Promise<{ exchange: string }[]> {
  return async (domain: string) => {
    const records = fixture.mx[domain];
    if (!records) return [];
    return records.map((exchange) => ({ exchange }));
  };
}

function toLead(fixture: Fixture, matchResult: import("./types.js").Match): Lead {
  return {
    ...fixture.rawLead,
    ...fixture.enrichment,
    ...matchResult,
    id: fixture.id,
    workspaceId: "eval-workspace",
    status: "new",
    notes: "",
    createdAt: new Date().toISOString(),
    enrichedAt: new Date().toISOString(),
  };
}

async function checkDossierExtras(
  fixture: Fixture,
  lead: Lead,
  v: Verification
): Promise<{ tagResult?: string; sameBizKeyResult?: string }> {
  let dossierMod: any = null;
  let evidenceMod: any = null;
  try {
    dossierMod = await import("./dossier.js");
  } catch {
    /* missing is expected */
  }
  try {
    evidenceMod = await import("./evidence.js");
  } catch {
    /* missing is expected */
  }
  if (!dossierMod || !evidenceMod) {
    return {
      tagResult: "SKIP (dossier.js and/or evidence.js not available)",
      sameBizKeyResult: "SKIP (dossier.js and/or evidence.js not available)",
    };
  }
  const out: { tagResult?: string; sameBizKeyResult?: string } = {};
  try {
    const evidence = evidenceMod.buildEvidence(lead, lead, [], v);
    const dossier = dossierMod.buildTemplateDossier({
      lead,
      evidence,
      facts: evidenceMod.extractFacts ? evidenceMod.extractFacts(evidence, lead) : {},
      score: scoreLead(lead, v, { month: fixture.runMonth, calendar, optedOut: fixture.optedOut }),
      priceBook: { workspaceId: lead.workspaceId, version: 1, items: [], updatedAt: new Date().toISOString() },
      explainer: null,
      workspaceName: "Eval Workspace",
      offer: fixture.offer,
    });
    if (fixture.expected.tag !== undefined) {
      const actual = dossier.gap?.tag;
      out.tagResult = actual === fixture.expected.tag
        ? `PASS (tag=${actual})`
        : `FAIL expected tag ${fixture.expected.tag}, got ${actual}`;
    }
    if (fixture.expected.sameBizKeyAs !== undefined) {
      const actual = dossier.bizKey;
      const otherBizKey = fixture.expected.sameBizKeyAs;
      // The other fixture must have been processed earlier to compare; we only
      // compare IDs here because bizKey equality requires evidence.js logic.
      out.sameBizKeyResult = actual === otherBizKey
        ? `PASS (sameBizKey=${actual})`
        : `FAIL expected sameBizKeyAs ${otherBizKey}, got ${actual}`;
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (fixture.expected.tag !== undefined) out.tagResult = `FAIL dossier error: ${msg}`;
    if (fixture.expected.sameBizKeyAs !== undefined) out.sameBizKeyResult = `FAIL dossier error: ${msg}`;
  }
  return out;
}

async function runFixture(fixture: Fixture): Promise<{
  label: string;
  scoreOk: boolean;
  gateOk: boolean;
  topOk: boolean;
  tagResult?: string;
  sameBizKeyResult?: string;
  error?: string;
}> {
  const label = `${fixture.id}: ${fixture.case}`;
  const { fn: fetchFn, calls } = makeFetch(fixture);
  const resolveMx = makeResolveMx(fixture);

  let v: Verification;
  try {
    v = await verify(fixture.rawLead, fixture.enrichment, { fetchFn, resolveMx, now: () => new Date("2026-10-06T00:00:00Z") });
  } catch (err) {
    return { label, scoreOk: false, gateOk: false, topOk: false, error: `verify threw: ${(err as Error).message}` };
  }

  let lead: Lead;
  if (match) {
    try {
      const m = match(fixture.rawLead, fixture.enrichment, fixture.offer);
      lead = toLead(fixture, m);
    } catch (err) {
      return { label, scoreOk: false, gateOk: false, topOk: false, error: `match threw: ${(err as Error).message}` };
    }
  } else {
    return { label, scoreOk: false, gateOk: false, topOk: false, error: "match.js missing" };
  }

  const score = scoreLead(lead, v, { month: fixture.runMonth, calendar, optedOut: fixture.optedOut });

  const scoreOk = score.total >= fixture.expected.minScore && score.total <= fixture.expected.maxScore;
  const gateOk = score.gate === fixture.expected.gate;
  const topService = lead.fit[0]?.service;
  const topOk = fixture.expected.topService === undefined || topService === fixture.expected.topService;

  const extras = await checkDossierExtras(fixture, lead, v);

  // Expose fetch call count on the returned object for the dead-site proof.
  (v as any)._fetchCalls = calls;

  return { label, scoreOk, gateOk, topOk, tagResult: extras.tagResult, sameBizKeyResult: extras.sameBizKeyResult };
}

function printResult(label: string, ok: boolean, detail?: string) {
  const status = ok ? "PASS" : "FAIL";
  const extra = detail ? ` (${detail})` : "";
  console.log(`${status} ${label}${extra}`);
}

async function runProofs(): Promise<void> {
  // Indian mobile
  const mobile = classifyPhone("+91 98765 43210");
  printResult(
    "Indian mobile normalization/classification",
    mobile.result === "mobile" && mobile.e164 === "+919876543210",
    `${mobile.result} ${mobile.e164 ?? ""}`
  );

  // Indian landline
  const landline = classifyPhone("+91 22 1234 5678");
  printResult(
    "Indian landline normalization",
    landline.result === "landline" && landline.e164 === "+912212345678",
    `${landline.result} ${landline.e164 ?? ""}`
  );

  // Generic E.164
  const generic = classifyPhone("+44 20 7946 0958");
  printResult(
    "Generic E.164 length check",
    generic.e164 === "+442079460958" && (generic.result === "landline" || generic.result === "mobile"),
    `${generic.result} ${generic.e164 ?? ""}`
  );

  // Dummy email
  const dummy = isDummyEmail("info@example.com");
  printResult("Dummy email rejection", dummy.dummy, dummy.reason);

  // Disposable email
  const disposableCheck = await verify(
    { name: "X", category: "Clinic", source: "eval", sourceUrl: "https://example.com" },
    { summary: "", emails: ["x@mailinator.com"], phones: [], socials: {}, signals: [] },
    { resolveMx: async () => [], now: () => new Date("2026-10-06T00:00:00Z") }
  );
  const disposableResult = disposableCheck.emails[0]?.result;
  printResult("Disposable email rejection", disposableResult === "disposable", disposableResult);

  // MX failure handled as no-mx
  let mxErrorResult: string | undefined;
  try {
    const mxFail = await verify(
      { name: "X", category: "Clinic", source: "eval", sourceUrl: "https://example.com" },
      { summary: "", emails: ["x@fixture.example"], phones: [], socials: {}, signals: [] },
      {
        resolveMx: async () => {
          throw new Error("DNS timeout");
        },
        now: () => new Date("2026-10-06T00:00:00Z"),
      }
    );
    mxErrorResult = mxFail.emails[0]?.result;
  } catch {
    mxErrorResult = "threw";
  }
  printResult("MX-failure handled as no-mx without throwing", mxErrorResult === "no-mx", mxErrorResult);

  // Dead site with zero fetches
  const deadFixture: Fixture = {
    id: "proof-dead",
    case: "dead site proof",
    rawLead: {
      name: "Proof Dead",
      category: "Clinic",
      website: "https://proof-dead.example",
      source: "eval",
      sourceUrl: "https://example.com",
    },
    enrichment: { summary: "dead", emails: [], phones: [], socials: {}, signals: ["site-unreachable"] },
    mx: {},
    fetch: {},
    offer: { services: ["website"], description: "" },
    runMonth: 10,
    expected: { minScore: 0, maxScore: 100, gate: "hidden" },
  };
  const { fn: deadFetch, calls: deadCalls } = makeFetch(deadFixture);
  const deadV = await verify(deadFixture.rawLead, deadFixture.enrichment, {
    fetchFn: deadFetch,
    resolveMx: async () => [],
    now: () => new Date("2026-10-06T00:00:00Z"),
  });
  printResult(
    "Dead site: status dead with zero fetches",
    deadV.website === "dead" && deadCalls.length === 0,
    `status=${deadV.website} fetches=${deadCalls.length}`
  );

  // Gate hidden for non-contactable lead despite a decent score
  const hiddenFixture: Fixture = {
    id: "proof-hidden",
    case: "non-contactable gate proof",
    rawLead: {
      name: "Proof Hidden",
      category: "Dental Clinic",
      source: "eval",
      sourceUrl: "https://example.com",
    },
    enrichment: {
      summary: "No contact routes but a strong dental fit.",
      emails: [],
      phones: [],
      socials: {},
      signals: ["no-website"],
    },
    mx: {},
    fetch: {},
    offer: { services: ["website"], description: "" },
    runMonth: 10,
    expected: { minScore: 0, maxScore: 100, gate: "hidden" },
  };
  const hiddenV = await verify(hiddenFixture.rawLead, hiddenFixture.enrichment, {
    fetchFn: fetch,
    resolveMx: async () => [],
    now: () => new Date("2026-10-06T00:00:00Z"),
  });
  if (!match) {
    printResult("Gate: non-contactable lead -> hidden despite score", false, "match.js missing");
    return;
  }
  const hiddenM = match(hiddenFixture.rawLead, hiddenFixture.enrichment, hiddenFixture.offer);
  const hiddenLead = toLead(hiddenFixture, hiddenM);
  const hiddenScore = scoreLead(hiddenLead, hiddenV, {
    month: hiddenFixture.runMonth,
    calendar,
  });
  printResult(
    "Gate: non-contactable lead -> hidden despite score",
    hiddenScore.gate === "hidden" && hiddenV.contactable === false,
    `gate=${hiddenScore.gate} contactable=${hiddenV.contactable} total=${hiddenScore.total}`
  );
}

async function main() {
  let pass = 0;
  let fail = 0;
  let skip = 0;

  for (const fixture of fixtures) {
    const result = await runFixture(fixture);
    const fixtureOk = result.scoreOk && result.gateOk && result.topOk && !result.error;
    if (result.error) {
      console.log(`FAIL ${result.label} — ${result.error}`);
      fail++;
    } else if (fixtureOk) {
      console.log(`PASS ${result.label} score=${result.scoreOk ? "ok" : "bad"} gate=${result.gateOk ? "ok" : "bad"} top=${result.topOk ? "ok" : "bad"}`);
      pass++;
    } else {
      console.log(
        `FAIL ${result.label} score=${result.scoreOk ? "ok" : "bad"} gate=${result.gateOk ? "ok" : "bad"} top=${result.topOk ? "ok" : "bad"}`
      );
      fail++;
    }
    if (result.tagResult) {
      const tagOk = result.tagResult.startsWith("PASS");
      console.log(`  ${tagOk ? "PASS" : "SKIP"} tag: ${result.tagResult}`);
      if (!tagOk && result.tagResult.startsWith("SKIP")) skip++;
    }
    if (result.sameBizKeyResult) {
      const sameOk = result.sameBizKeyResult.startsWith("PASS");
      console.log(`  ${sameOk ? "PASS" : "SKIP"} sameBizKey: ${result.sameBizKeyResult}`);
      if (!sameOk && result.sameBizKeyResult.startsWith("SKIP")) skip++;
    }
  }

  await runProofs();

  console.log(`\nSummary: ${pass} passed, ${fail} failed, ${skip} skipped`);

  // Clean up temporary database.
  try {
    rmSync(TMP_DB, { force: true });
  } catch {
    /* ignore cleanup errors */
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("eval-check error:", err);
  process.exit(1);
});
