// src/routes-intake-check.ts
// Offline proof for order L30-wiring-3: intake, brief-driven discovery, lookalike
// and channels/status exposed through the server via the routes-intake.ts hook.
//
// Temp database, HTTP server on a random port, fake fetch for lookalike examples,
// no real network. Run once:
//   npx tsx src/routes-intake-check.ts
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "leadscout-routes-intake-"));
process.env.LEADSCOUT_DB = join(ROOT, "routes-intake.db");

const store = await import("./store.js");
const intake = await import("./intake.js");
const routesIntake = await import("./routes-intake.js");
const { createServer, setTestHooks } = await import("./server.js");

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!condition) failed = true;
}

// ------------------------------------------------------------------ fixtures

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures-v2/lookalike/${name}`, import.meta.url), "utf8");
}

const HOST_HTML: Record<string, string> = {
  "fixture-a.example": fixture("example-a.html"),
  "fixture-b.example": fixture("example-b.html"),
};

const fixtureFetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = String(input);
  if (url.includes("fixture-dead")) throw new Error("simulated network failure: dead fixture host");
  if (url.endsWith("/robots.txt")) {
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  }
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = "";
  }
  const html = HOST_HTML[host];
  if (!html) throw new Error(`fake fetch: no route for ${url}`);
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}) as typeof fetch;

routesIntake.configureIntake({ fetchFn: fixtureFetch });
setTestHooks({ fetchFn: fixtureFetch });

// ------------------------------------------------------------- HTTP harness

const server = createServer();
let PORT = 0;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
{
  const address = server.address();
  PORT = typeof address === "object" && address ? address.port : 0;
}

type Res = { status: number; body: unknown; text: string };
async function call(method: string, path: string, body?: unknown, key?: string): Promise<Res> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    /* not json */
  }
  return { status: res.status, body: parsed, text };
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function questionIds(body: unknown): string[] {
  return arr(obj(body).questions).map((q) => String(obj(q).id ?? ""));
}

// ------------------------------------------------------------------- checks

// 1. server starts with the hook
{
  const health = await call("GET", "/api/health");
  check("server starts with the hook (health 200)", health.status === 200 && obj(health.body).ok === true, `status=${health.status}`);
}

// 2. intake questions for a fresh workspace and for `default`
const fresh = store.createWorkspace({
  name: "Fake Intake Workspace",
  offer: { services: ["website"], description: "fake offer" },
  icp: { categories: ["dental"], cities: ["Pune"], countries: ["IN"] },
});
{
  const first = await call("GET", `/api/workspaces/${fresh.id}/intake`);
  const next = await call("GET", `/api/workspaces/${fresh.id}/intake/next`);
  const ids1 = questionIds(first.body);
  const ids2 = questionIds(next.body);
  check("GET intake returns questions for a fresh workspace", first.status === 200 && ids1.includes("seller.sellToWhom"), `status=${first.status} n=${ids1.length}`);
  check("GET intake/next returns questions for a fresh workspace", next.status === 200 && ids2.includes("seller.sellToWhom"), `status=${next.status} n=${ids2.length}`);

  const def = await call("GET", "/api/workspaces/default/intake");
  const defIds = questionIds(def.body);
  check("GET intake returns questions for `default`", def.status === 200 && defIds.includes("seller.sellToWhom"), `status=${def.status}`);
  check("`default` workspace is created on demand", store.getWorkspace("default") !== undefined);

  const defNext = await call("GET", "/api/workspaces/default/intake/next");
  check("GET intake/next returns questions for `default`", defNext.status === 200 && questionIds(defNext.body).includes("seller.sellToWhom"), `status=${defNext.status}`);
}

// 3. answering changes the next questions
{
  const before = await call("GET", `/api/workspaces/${fresh.id}/intake`);
  const beforeIds = questionIds(before.body);
  const answered = await call("POST", `/api/workspaces/${fresh.id}/intake/answer`, {
    id: "seller.sellToWhom",
    value: "We build WhatsApp booking bots for dental clinics in the Pune area.",
  });
  const afterIds = questionIds(answered.body);
  check("POST intake/answer accepted", answered.status === 200 && obj(answered.body).ok === true, `status=${answered.status}`);
  check("answering removes the answered question", beforeIds.includes("seller.sellToWhom") && !afterIds.includes("seller.sellToWhom"));
  check("answering changes the next questions", JSON.stringify(beforeIds) !== JSON.stringify(afterIds));
}

// 4. brief round trip
const briefState = {
  workspaceId: fresh.id,
  industry: "dental implants",
  answers: {
    "seller.sellToWhom": "We build WhatsApp booking bots for clinic owners in Pune.",
    "offer.services": ["website", "automation"],
    "niche.industry": "dental implants",
    "niche.subNiche": "dental clinics",
    "geo.country": "India",
    "geo.cities": ["Pune"],
    "exclusions.list": ["chains"],
    "volume.callsPerWeek": 25,
  },
} as const;
const brief = intake.compileBrief(briefState as never);
{
  const put = await call("PUT", `/api/workspaces/${fresh.id}/brief`, { brief });
  const get = await call("GET", `/api/workspaces/${fresh.id}/brief`);
  const loaded = obj(get.body).brief;
  check("PUT brief accepted", put.status === 200, `status=${put.status}`);
  check("brief round trip is identical", JSON.stringify(loaded) === JSON.stringify(brief));
}

// 5. brief/run creates discovery jobs with the exclusions applied
{
  const run = await call("POST", `/api/workspaces/${fresh.id}/brief/run`);
  const body = obj(run.body);
  const jobs = arr(body.jobIds);
  const stored = store.listJobs(fresh.id);
  const exclusionTerms = arr(obj(body.exclusions).terms).map(String);
  const exclusionsOk = exclusionTerms.includes("chains") && jobs.length > 0 && stored.length === jobs.length;
  check("brief/run creates discovery jobs", run.status === 202 && jobs.length > 0 && stored.length === jobs.length, `status=${run.status} jobs=${jobs.length}`);
  check("discovery jobs carry the exclusions", exclusionsOk, `jobs=${stored.length}`);
}

// 6. lookalike/profile with fixture examples (two usable, one skipped)
{
  const res = await call("POST", `/api/workspaces/${fresh.id}/lookalike/profile`, {
    examples: [
      { name: "Fake Dental A", website: "https://fixture-a.example", category: "dental-clinic" },
      { name: "Fake Dental B", website: "https://fixture-b.example", category: "dental-clinic" },
      { name: "Fake Dental Dead", website: "https://fixture-dead.example", category: "dental-clinic" },
    ],
  });
  const profile = obj(obj(res.body).profile);
  check(
    "lookalike/profile builds from two usable fixture examples",
    res.status === 200 && profile.usedCount === 2 && arr(profile.skipped).length === 1,
    `status=${res.status} used=${String(profile.usedCount)} skipped=${arr(profile.skipped).length}`,
  );
}

// 7. channels/status has no secret values
{
  process.env.LEADSCOUT_TEST_TOKEN = "FAKE-SECRET-TOKEN-123";
  const res = await call("GET", "/api/channels/status");
  const body = obj(res.body);
  const channels = arr(body.channels);
  const text = JSON.stringify(res.body);
  const shapeOk = channels.every((c) => {
    const rec = obj(c);
    return typeof rec.id === "string" && typeof rec.name === "string" && typeof rec.tier === "string" && typeof rec.enabled === "boolean" && "reason" in rec;
  });
  const noSecrets =
    !text.includes("FAKE-SECRET-TOKEN-123") &&
    !/cookie\s*[:=]/i.test(text) &&
    !/bearer\s+[A-Za-z0-9._-]+/i.test(text) &&
    !/"(?:password|secret|api[_-]?key|token)"\s*:/i.test(text);
  check("channels/status lists channels with tier/enabled/reason", res.status === 200 && channels.length > 0 && shapeOk, `status=${res.status} n=${channels.length}`);
  check("channels/status includes browser reader status", obj(body.browser) !== undefined && Object.keys(obj(body.browser)).length > 0);
  check("channels/status has no secret values or cookies", noSecrets);
  delete process.env.LEADSCOUT_TEST_TOKEN;
}

// 8. a missing key is refused
{
  process.env.LEADSCOUT_REQUIRE_KEYS = "1";
  const noKey = await call("GET", `/api/workspaces/${fresh.id}/intake`);
  check("missing key is refused (401)", noKey.status === 401, `status=${noKey.status}`);
  delete process.env.LEADSCOUT_REQUIRE_KEYS;
}

// 9. the five static pages still answer 200
{
  const pages = ["/", "/intake.html", "/dossier.html", "/settings.html", "/calls.html"];
  const statuses: number[] = [];
  for (const page of pages) {
    const res = await fetch(`http://127.0.0.1:${PORT}${page}`);
    statuses.push(res.status);
    await res.text();
  }
  check("five static pages answer 200", statuses.every((s) => s === 200), `statuses=${statuses.join(",")}`);
}

// ------------------------------------------------------------------ shutdown

await new Promise<void>((resolve) => server.close(() => resolve()));
store.closeDb();
try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* ignore cleanup failures */
}

console.log(failed ? "\nroutes-intake-check FAILED" : "\nroutes-intake-check PASSED");
process.exit(failed ? 1 : 0);
