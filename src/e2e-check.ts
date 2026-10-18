// src/e2e-check.ts
// ORDER_I1 end-to-end check: the real HTTP server, a temp database and offline fixtures.
// Proves search -> score -> dossier works through the real routes and that the pipeline's
// usage-field coverage (access.ts) no longer throws "no limit for usage field: enriched".
//
// Fully offline: injected fake search (discover), fake page fetch (fetchFn) and fake model
// (llm). Live integrations stay off; only the injected fixtures are used.

import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Temp database and fixture switch must be set BEFORE importing store/access/server.
const tmpDb = join(tmpdir(), `leadscout-e2e-${randomBytes(8).toString("hex")}.db`);
process.env.LEADSCOUT_DB = tmpDb;
process.env.LEADSCOUT_TEST_FIXTURES = "1";
delete process.env.LEADSCOUT_RESOLVE_LIVE;
delete process.env.LEADSCOUT_REQUIRE_KEYS;
delete process.env.LEADSCOUT_LLM_URL;
delete process.env.LEADSCOUT_REACH;

const serverMod = await import("./server.js");
const store = await import("./store.js");
const access = await import("./access.js");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let failed = 0;
let passed = 0;
function check(name: string, cond: unknown, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${detail ? `: ${detail}` : ""}`);
  }
}

// --------------------------------------------------------------------------- fixtures

// One sentence, no viewport / form / chat / booking / analytics / email / phone on the
// page, so the real enricher yields a summary from the fixture text and several absence
// signals. 2019 copyright makes the OUTDATED gap fire. Clearly fake.
const FIXTURE_SUMMARY =
  "Fake Fixture Clinic is a clearly fake business used only by the offline leadscout end to end check.";
const FIXTURE_PAGE = [
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
  "<title>Fake Fixture Clinic</title>",
  `<meta name="description" content="${FIXTURE_SUMMARY}">`,
  "</head><body><h1>Fake Fixture Clinic</h1>",
  "<p>&copy; 2019 Fake Fixture Clinic. This page is an offline test fixture.</p>",
  "</body></html>",
].join("");

const fakeFetchFn = (async (input: unknown) => {
  const raw = typeof input === "string" ? input : (input as { url?: string } | undefined)?.url ?? String(input);
  if (raw.includes("/robots.txt")) {
    return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response(FIXTURE_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}) as unknown as typeof fetch;

type RawLeadFixture = {
  name: string;
  category: string;
  city: string;
  country?: string;
  phone?: string;
  website?: string;
  address?: string;
  source: string;
  sourceUrl: string;
};

const DISCOVERY_LEADS: RawLeadFixture[] = [
  {
    name: "Fake Discovered Clinic One",
    category: "clinic",
    city: "Fake City",
    country: "IN",
    phone: "+91 98765 40001",
    website: "https://fake-discovered-one.example",
    source: "osm",
    sourceUrl: "https://www.openstreetmap.org/node/900001",
  },
  {
    name: "Fake Discovered Clinic Two",
    category: "clinic",
    city: "Fake City",
    country: "IN",
    phone: "+91 98765 40002",
    website: "https://fake-discovered-two.example",
    source: "osm",
    sourceUrl: "https://www.openstreetmap.org/node/900002",
  },
  {
    name: "Fake Discovered Restaurant",
    category: "restaurant",
    city: "Fake City",
    country: "IN",
    phone: "+91 98765 40003",
    website: "https://fake-discovered-three.example",
    source: "osm",
    sourceUrl: "https://www.openstreetmap.org/node/900003",
  },
];

const fakeDiscover = async (): Promise<RawLeadFixture[]> => DISCOVERY_LEADS.map((lead) => ({ ...lead }));

// Echo the embedded draft back (same trick server-v2-check uses) so the model polish path
// stays offline and fully cited; if it ever fails, the pipeline keeps the level 0 dossier.
const fakeLlm = async (req: { system: string; prompt: string; taskHint?: string }) => {
  try {
    const at = req.prompt.indexOf("DRAFT TO REWRITE");
    const start = req.prompt.indexOf("{", at);
    const end = req.prompt.lastIndexOf("}");
    const draft = JSON.parse(req.prompt.slice(start, end + 1)) as {
      gap?: unknown;
      sayThis?: unknown;
      pushback?: unknown;
      offers: Array<{ service: string; description: unknown; whyItMatters: unknown }>;
    };
    return {
      text: JSON.stringify({
        gap: draft.gap,
        sayThis: draft.sayThis,
        pushback: draft.pushback,
        offers: draft.offers.map((o) => ({ service: o.service, description: o.description, whyItMatters: o.whyItMatters })),
      }),
      tokensIn: 0,
      tokensOut: 0,
      model: "fake-model",
    };
  } catch {
    return { text: "", tokensIn: 0, tokensOut: 0, model: "fake-model" };
  }
};

const FIXED_NOW = (): Date => new Date("2026-06-01T00:00:00.000Z");

serverMod.setTestHooks({
  llm: fakeLlm,
  fetchFn: fakeFetchFn,
  now: FIXED_NOW,
  pipelineDeps: {
    discover: fakeDiscover,
    fetchFn: fakeFetchFn,
    llm: fakeLlm,
    researchMode: "off",
    reach: null,
    now: FIXED_NOW,
  },
});

// --------------------------------------------------------------------------- HTTP helpers

const server = serverMod.createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const address = server.address();
const PORT = typeof address === "object" && address ? address.port : 0;
const base = `http://127.0.0.1:${PORT}`;

type HttpResult = { status: number; text: string; json: any };
async function http(method: string, path: string, body?: unknown, contentType?: string): Promise<HttpResult> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "content-type": contentType ?? "application/json" };
  }
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

async function waitForJob(ws: string, jobId: string): Promise<any> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const r = await http("GET", `/api/workspaces/${ws}/jobs`);
    const job = Array.isArray(r.json) ? r.json.find((j: any) => j.id === jobId) : null;
    if (job && (job.status === "done" || job.status === "failed")) return job;
    await sleep(100);
  }
  return null;
}

function normalise(text: string): string {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function citedFields(dossier: any): Array<{ name: string; ids: unknown[] }> {
  const out: Array<{ name: string; ids: unknown[] }> = [];
  const push = (name: string, cited: any): void => {
    if (cited && typeof cited === "object") {
      out.push({ name, ids: Array.isArray(cited.evidence) ? cited.evidence : [] });
    }
  };
  if (dossier?.facts && typeof dossier.facts === "object") {
    for (const key of Object.keys(dossier.facts)) push(`facts.${key}`, (dossier.facts as any)[key]);
  }
  if (dossier?.gap) push("gap.headline", dossier.gap.headline);
  push("sayThis", dossier?.sayThis);
  push("pushback", dossier?.pushback);
  for (const offer of Array.isArray(dossier?.offers) ? dossier.offers : []) {
    push(`offer[${String(offer?.rank)}].description`, offer?.description);
    push(`offer[${String(offer?.rank)}].whyItMatters`, offer?.whyItMatters);
  }
  return out;
}

// --------------------------------------------------------------------------- checks

// 1. Workspace.
const created = await http("POST", "/api/workspaces", {
  name: "Fake E2E Workspace",
  offer: { services: ["website", "automation", "ai-chatbot"], description: "Fake offer for the e2e check only." },
  icp: { categories: [], cities: [], countries: [] },
});
const WS: string = created.json?.id ?? "";
check("POST /api/workspaces creates a workspace", created.status === 201 && typeof WS === "string" && WS.length > 0,
  `status=${created.status}`);

// 2. Import three leads by CSV.
const CSV = [
  "name,address,phone,website,category,link",
  "Fake Imported Clinic One,1 Fake Road Fake City,+91 9876501001,https://fake-import-one.example,clinic,https://example.invalid/one",
  "Fake Imported Clinic Two,2 Fake Road Fake City,+91 9876501002,https://fake-import-two.example,clinic,https://example.invalid/two",
  "Fake Imported Restaurant,3 Fake Road Fake City,+91 9876501003,https://fake-import-three.example,restaurant,https://example.invalid/three",
].join("\n");
const imported = await http("POST", `/api/workspaces/${WS}/import-csv`, CSV, "text/csv");
check("POST /import-csv imports 3 leads", imported.status === 200 && Number(imported.json?.imported) === 3,
  `status=${imported.status} imported=${String(imported.json?.imported)}`);

// 3. Run /process for the whole workspace, in the background.
const processStart = await http("POST", `/api/workspaces/${WS}/process`);
check("POST /process returns a job id", processStart.status === 202 && typeof processStart.json?.jobId === "string",
  `status=${processStart.status}`);
const processJob = await waitForJob(WS, String(processStart.json?.jobId ?? ""));
check("process job reports done", processJob?.status === "done", `status=${String(processJob?.status)} error=${String(processJob?.error)}`);
check("process job did not fail with a usage-field error",
  !String(processJob?.error ?? "").includes("no limit for usage field"),
  `error=${String(processJob?.error)}`);

// 4. Every imported lead is fully processed.
const list = await http("GET", `/api/workspaces/${WS}/leads`);
const leads: any[] = Array.isArray(list.json?.leads) ? list.json.leads : [];
check("lead list returns the 3 imported leads", list.status === 200 && leads.length === 3,
  `status=${list.status} count=${leads.length}`);

const fixtureNorm = normalise(FIXTURE_PAGE);
for (const lead of leads) {
  const label = String(lead?.name ?? lead?.id ?? "?");
  check(`lead "${label}" has score > 0`, Number(lead?.score) > 0, `score=${String(lead?.score)}`);
  check(`lead "${label}" has a non-empty fixture summary`,
    typeof lead?.summary === "string" && lead.summary.trim().length > 0 && fixtureNorm.includes(normalise(lead.summary)),
    `summary=${JSON.stringify(lead?.summary)}`);
  check(`lead "${label}" has >= 1 signal`, Array.isArray(lead?.signals) && lead.signals.length >= 1,
    `signals=${JSON.stringify(lead?.signals)}`);
  check(`lead "${label}" has >= 1 fit service with a reason`,
    Array.isArray(lead?.fit) && lead.fit.some((f: any) => typeof f?.reason === "string" && f.reason.trim().length > 0),
    `fit=${JSON.stringify(lead?.fit)}`);
  check(`lead "${label}" has an outreach angle`,
    typeof lead?.angle === "string" && lead.angle.trim().length > 0, `angle=${JSON.stringify(lead?.angle)}`);

  const detail = await http("GET", `/api/workspaces/${WS}/leads/${lead.id}`);
  check(`lead detail "${label}" carries score/summary/signals/fit/angle`,
    detail.status === 200 && Number(detail.json?.score) > 0
      && typeof detail.json?.summary === "string" && detail.json.summary.length > 0
      && Array.isArray(detail.json?.signals) && Array.isArray(detail.json?.fit)
      && typeof detail.json?.angle === "string" && detail.json.angle.length > 0,
    `status=${detail.status}`);

  const dossierRes = await http("GET", `/api/workspaces/${WS}/leads/${lead.id}/dossier`);
  const dossier = dossierRes.json?.dossier;
  check(`lead "${label}" dossier is ready`, dossierRes.status === 200 && dossier && typeof dossier === "object",
    `status=${dossierRes.status} ready=${String(dossierRes.json?.ready)}`);
  if (dossier && typeof dossier === "object") {
    const ids = new Set<string>((Array.isArray(dossier.evidence) ? dossier.evidence : []).map((e: any) => String(e?.id)));
    const claims = citedFields(dossier);
    const bad = claims.filter((c) => c.ids.length === 0 || c.ids.some((id) => !ids.has(String(id))));
    check(`lead "${label}" every dossier claim has a known evidence id`,
      claims.length > 0 && bad.length === 0,
      `claims=${claims.length} bad=${JSON.stringify(bad.map((b) => b.name))}`);
  }
}

// 5. Discovery job over the fixtures.
const discoverStart = await http("POST", `/api/workspaces/${WS}/discover`, {
  category: "clinic",
  city: "Fake City",
  country: "IN",
  limit: 5,
});
check("POST /discover returns a job id", discoverStart.status === 202 && typeof discoverStart.json?.jobId === "string",
  `status=${discoverStart.status}`);
const discoverJob = await waitForJob(WS, String(discoverStart.json?.jobId ?? ""));
check("discovery job reports done", discoverJob?.status === "done", `status=${String(discoverJob?.status)} error=${String(discoverJob?.error)}`);
check("discovery job found > 0", Number(discoverJob?.found) > 0, `found=${String(discoverJob?.found)}`);
check("discovery job enriched > 0", Number(discoverJob?.enriched) > 0, `enriched=${String(discoverJob?.enriched)}`);
check("discovery job has no 'no limit for usage field' error",
  !String(discoverJob?.error ?? "").includes("no limit for usage field"), `error=${String(discoverJob?.error)}`);

// 6. Export CSV.
const exported = await http("GET", `/api/workspaces/${WS}/export?format=generic`);
const exportLines = exported.text.trim().split("\n");
check("GET /export returns CSV with a header and rows",
  exported.status === 200 && exportLines.length >= 4
    && exportLines[0].includes("name") && exportLines[0].includes("score") && exportLines[0].includes("source_url"),
  `status=${exported.status} lines=${exportLines.length} header=${exportLines[0] ?? ""}`);

// 7. Static pages.
for (const page of ["/", "/dossier.html", "/settings.html", "/intake.html", "/optout.html"]) {
  const res = await http("GET", page);
  check(`GET ${page} -> 200`, res.status === 200, `status=${res.status}`);
}

// 8. Edge case: an unknown usage field must allow, meter and warn once, never throw.
{
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  let threw = false;
  let first: any = null;
  let second: any = null;
  try {
    first = access.checkLimit(WS, "mystery-field", 5);
    access.meter(WS, "mystery-field", 2);
    second = access.checkLimit(WS, "mystery-field", 5);
  } catch {
    threw = true;
  } finally {
    console.warn = originalWarn;
  }
  const named = warnings.filter((w) => w.includes("mystery-field"));
  const usage = access.getUsage(WS) as Record<string, unknown>;
  check("unknown usage field allows and does not throw", threw === false && first?.ok === true && second?.ok === true,
    `threw=${threw}`);
  check("unknown usage field is metered", Number(usage["mystery-field"]) === 2, `metered=${String(usage["mystery-field"])}`);
  check("unknown usage field warns exactly once", named.length === 1, `warnings=${named.length}`);
}

// --------------------------------------------------------------------------- teardown

await new Promise<void>((resolve) => server.close(() => resolve()));
store.closeDb();
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const path = tmpDb + suffix;
  if (existsSync(path)) {
    try {
      rmSync(path);
    } catch {
      // ignore cleanup errors
    }
  }
}

console.log(`\n${failed === 0 ? "ALL PASS" : "SOME FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
