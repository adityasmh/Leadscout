// src/server-check-3.ts
// ORDER L30-wiring-3 proof: the intake -> brief -> discovery flow plus lookalike and reach
// through the real HTTP server. Random port, temp database, fully offline fixtures.
// Prints PASS or FAIL for each Proof item, then stops the server.
//
// This script does NOT import from src/company/, so no sandbox-company-root import is needed.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Temp database + offline fixture switch must be set BEFORE importing store/access/server.
const ROOT = mkdtempSync(join(tmpdir(), `leadscout-server3-${randomBytes(4).toString("hex")}-`));
process.env.LEADSCOUT_DB = join(ROOT, "main.db");
process.env.LEADSCOUT_TEST_FIXTURES = "1";
delete process.env.LEADSCOUT_RESOLVE_LIVE;
delete process.env.LEADSCOUT_REQUIRE_KEYS;
delete process.env.LEADSCOUT_LLM_URL;
delete process.env.LEADSCOUT_REACH;

const serverMod = await import("./server.js");
const store = await import("./store.js");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let failed = false;
function check(name: string, cond: unknown, detail = ""): void {
  const line = cond ? `PASS ${name}` : `FAIL ${name}${detail ? `: ${detail}` : ""}`;
  console.log(line);
  if (!cond) failed = true;
}

// --------------------------------------------------------------------------- fixtures

const FIXTURE_PAGE = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8">',
  "<title>Fake Fixture Business</title>",
  '<meta name="description" content="A clearly fake business used only by the offline leadscout server check.">',
  "</head><body><h1>Fake Fixture Business</h1>",
  "<p>We are a fake clinic with 3 branches and a team of 12 people. Established 2019.</p>",
  '<p><a href="https://wa.me/910000000000">chat</a> fake@example-fixture.test</p>',
  "</body></html>",
].join("");

const fakeFetchFn = (async (input: unknown) => {
  const raw = typeof input === "string" ? input : (input as { url?: string } | undefined)?.url ?? String(input);
  if (raw.includes("/robots.txt")) {
    return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response(FIXTURE_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}) as unknown as typeof fetch;

const fakeLlm = async (): Promise<{ text: string; tokensIn: number; tokensOut: number; model: string }> => ({
  text: "",
  tokensIn: 0,
  tokensOut: 0,
  model: "fake-model",
});

const FIXED_NOW = (): Date => new Date("2026-06-01T00:00:00.000Z");

type RawLeadFixture = { name: string; category: string; city: string; country?: string; website?: string; source: string; sourceUrl: string };

const DISCOVERY_LEADS: RawLeadFixture[] = [
  { name: "Fake Fixture Clinic One", category: "clinic", city: "Fake City A", country: "IN", website: "https://fake-fixture-one.test", source: "osm", sourceUrl: "https://osm.example.invalid/1" },
  { name: "Fake Fixture Clinic Two", category: "clinic", city: "Fake City B", country: "IN", website: "https://fake-fixture-two.test", source: "osm", sourceUrl: "https://osm.example.invalid/2" },
  // This one matches the brief exclusion term and must never be stored.
  { name: "Fake Excludedbiz Clinic", category: "clinic", city: "Fake City A", country: "IN", website: "https://fake-excludedbiz.test", source: "osm", sourceUrl: "https://osm.example.invalid/3" },
];

const fakeDiscover = async (): Promise<RawLeadFixture[]> => DISCOVERY_LEADS.map((lead) => ({ ...lead }));

serverMod.setTestHooks({
  llm: fakeLlm,
  fetchFn: fakeFetchFn,
  now: FIXED_NOW,
  pipelineDeps: {
    discover: fakeDiscover as never,
    fetchFn: fakeFetchFn,
    llm: fakeLlm as never,
    researchMode: "off",
    reach: null,
    now: FIXED_NOW,
  },
});

// --------------------------------------------------------------------------- server + http

const server = serverMod.createServer();
let PORT = 0;
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    PORT = typeof address === "object" && address ? address.port : 0;
    resolve();
  });
});

type HttpResult = { status: number; text: string; json: any };
async function http(method: string, path: string, body?: unknown): Promise<HttpResult> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, text, json };
}

const base = (ws: string, p: string): string => `/api/workspaces/${ws}${p}`;

// --------------------------------------------------------------------------- setup

const created = await http("POST", "/api/workspaces", {
  name: "Fake Leadgen Workspace",
  offer: { services: ["website", "automation"], description: "Clearly fake offer used only by this check." },
  icp: { categories: [], cities: [], countries: [] },
});
const WS: string = created.json?.id ?? "";

// 1. Intake flow end to end: post fake answers, expect a persisted brief.
{
  const answers = {
    "niche.industry": "dental clinics",
    "niche.subNiche": "implant clinics",
    "geo.country": "IN",
    "geo.cities": ["Fake City A", "Fake City B"],
    "volume.leadsPerWeek": 5,
    "offer.services": "website",
    "exclusions.list": "excludedbiz",
    "outreach.tone": "friendly",
  };
  const ans = await http("POST", base(WS, "/intake/answer"), { answers, industry: "dental clinics" });
  const brief = ans.json?.brief;
  check(
    "intake flow end to end with fake answers produces a brief",
    ans.status === 200 && ans.json?.ok === true && Array.isArray(brief?.sections) && brief.sections.length > 0,
    `status=${ans.status} sections=${Array.isArray(brief?.sections) ? brief.sections.length : "none"}`,
  );
  const got = await http("GET", base(WS, "/brief"));
  check(
    "GET /brief returns the persisted brief",
    got.status === 200 && Array.isArray(got.json?.brief?.sections) && got.json.brief.sections.length > 0,
    `status=${got.status}`,
  );
}

// 2. Brief run: one job per city query, exclusions applied.
{
  const run = await http("POST", base(WS, "/brief/run"), {});
  const jobIds: string[] = Array.isArray(run.json?.jobIds) ? run.json.jobIds : [];
  check(
    "brief run creates the right number of jobs with exclusions applied",
    run.status === 202 && run.json?.count === 2 && jobIds.length === 2,
    `status=${run.status} count=${String(run.json?.count)} jobIds=${jobIds.length}`,
  );

  // Wait for the background jobs, then confirm the excluded business was never stored.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const jobs = store.listJobs(WS);
    const done = jobIds.length > 0 && jobIds.every((id) => {
      const job = jobs.find((j) => j.id === id);
      return job && (job.status === "done" || job.status === "failed");
    });
    if (done) break;
    await sleep(100);
  }
  const names = store.listLeads({ workspaceId: WS, includeHidden: true, limit: 100000, offset: 0 }).leads.map((l) => l.name.toLowerCase());
  check(
    "brief exclusions applied (excluded business never stored)",
    names.length > 0 && !names.some((n) => n.includes("excludedbiz")),
    `stored=${JSON.stringify(names)}`,
  );
}

// 3. Lookalike profile endpoint with fixture examples.
{
  const examples = [
    { name: "Fake Example One", website: "https://fake-example-one.test", category: "dental clinic" },
    { name: "Fake Example Two", website: "https://fake-example-two.test", category: "dental clinic" },
    { name: "Fake Example Three", website: "https://fake-example-three.test", category: "dental clinic" },
  ];
  const look = await http("POST", base(WS, "/lookalike/profile"), { examples });
  check(
    "lookalike profile endpoint with fixture examples",
    look.status === 200 && look.json?.profile?.usedCount === 3 && typeof look.json.profile?.categories !== "undefined",
    `status=${look.status} usedCount=${String(look.json?.profile?.usedCount)}`,
  );
}

// 4. Missing workspace key refused by the same guard as the other routes.
{
  process.env.LEADSCOUT_REQUIRE_KEYS = "1";
  const noKey = await http("GET", base(WS, "/intake/next"));
  check("missing key refused", noKey.status === 401, `status=${noKey.status} body=${noKey.text.slice(0, 80)}`);
  delete process.env.LEADSCOUT_REQUIRE_KEYS;
}

// 5. Reach status reported, name only, without leaking values.
{
  const health = await http("GET", "/api/health");
  const reach = health.json?.reach;
  const leaked = /pipx|agent_reach_cmd|install\\?|backends|password|cookie/i.test(health.text);
  check(
    "reach status reported without leaking values",
    health.status === 200 && reach?.name === "reach" && typeof reach?.available === "boolean" && !leaked,
    `status=${health.status} reach=${JSON.stringify(reach)}`,
  );
}

// --------------------------------------------------------------------------- shutdown

await new Promise<void>((resolve) => server.close(() => resolve()));
store.closeDb();
rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? "server-check-3 FAILED" : "server-check-3 PASSED");
process.exit(failed ? 1 : 0);
