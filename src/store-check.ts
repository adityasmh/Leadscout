// Proof for the L2 store + server. Runs against a throwaway SQLite file in the OS temp dir.
// Every fixture is clearly fake; no real network calls are made.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

const tempDir = mkdtempSync(join(tmpdir(), "leadscout-check-"));
process.env.LEADSCOUT_DB = join(tempDir, "check.db");

// The POST /discover test starts the wave-2 pipeline, which would otherwise call
// real Nominatim/Overpass endpoints. Block all external fetch traffic; only the
// local test server (127.0.0.1 / localhost) is allowed through.
const realFetch = globalThis.fetch;
const blockedUrls: string[] = [];
globalThis.fetch = async (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
  const input = args[0];
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
  })();
  if (host === "127.0.0.1" || host === "localhost") {
    return realFetch(...args);
  }
  blockedUrls.push(url);
  throw new Error(`store-check blocks external network calls (${url})`);
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${label}`);
  } catch (err) {
    failed += 1;
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${label}: ${message}`);
    console.log(`FAIL ${label}: ${message}`);
  }
}

const store = await import("./store.js");
const types = await import("./types.js");
const serverMod = await import("./server.js");

type LeadSeed = Parameters<typeof store.upsertLead>[0];

let baseUrl = "";
let testServer: Server | undefined;

try {
  // ---------------------------------------------------------- workspaces
  const alpha = store.createWorkspace({
    name: "Test Alpha (fake)",
    offer: { services: ["website", "automation"], description: "Fake offer used only by the store check." },
    icp: { categories: ["cafe", "bakery"], cities: ["Testville"], countries: ["IN"] },
  });
  const beta = store.createWorkspace({
    name: "Test Beta (fake)",
    offer: { services: ["seo"], description: "Fake offer used only by the store check." },
    icp: { categories: ["salon"], cities: ["Testville"], countries: ["IN"] },
  });

  await check("create and list workspaces", () => {
    assert(alpha.id !== beta.id, "workspace ids must differ");
    const list = store.listWorkspaces();
    eq(list.length, 2, "two workspaces listed");
    eq(list[0].name, "Test Alpha (fake)", "first workspace name");
    eq(store.getWorkspace(alpha.id)?.name, "Test Alpha (fake)", "getWorkspace by id");
    eq(store.getWorkspace(alpha.id)?.icp.countries[0], "IN", "workspace icp survives JSON round trip");
    const renamed = store.updateProfile(alpha.id, { name: "Test Alpha Renamed (fake)" });
    eq(renamed?.name, "Test Alpha Renamed (fake)", "updateProfile changes the name");
    eq(store.updateProfile(alpha.id, { name: "Test Alpha (fake)" })?.name, "Test Alpha (fake)", "name restored");
  });

  // -------------------------------------------------------------- dedupe
  const cafeSeed: LeadSeed = {
    workspaceId: alpha.id,
    name: "Test Cafe",
    category: "cafe",
    city: "Testville",
    country: "IN",
    address: "1 Example Road",
    phone: "+91-00000-00001",
    website: "https://www.testcafe.example/",
    summary: "Fake cafe used only by the store check.",
    emails: ["hello@testcafe.example"],
    signals: ["has-phone"],
    score: 40,
    status: "new",
    source: "test-fixture",
    sourceUrl: "https://example.test/fixture/1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const cafe = store.upsertLead(cafeSeed);

  await check("upsert dedupes by name+city", () => {
    const again = store.upsertLead({ ...cafeSeed, name: "test  cafe!", city: "TESTVILLE", website: "http://testcafe.example/" });
    eq(again.id, cafe.id, "same lead id for a name/city variation");
    eq(store.listLeads({ workspaceId: alpha.id }).total, 1, "still one lead in the workspace");
    eq(again.website, "http://testcafe.example/", "new website was merged in");
    eq(again.status, "new", "status was preserved");
  });

  await check("upsert dedupes by website host", () => {
    const byHost = store.upsertLead({
      workspaceId: alpha.id,
      name: "Test Cafe Express",
      category: "cafe",
      city: "Otherville",
      website: "https://testcafe.example/menu",
      source: "test-fixture",
      sourceUrl: "https://example.test/fixture/2",
    });
    eq(byHost.id, cafe.id, "same lead id for a different name with the same website host");
    eq(store.listLeads({ workspaceId: alpha.id }).total, 1, "host match did not create a second lead");
    eq(store.getLead(alpha.id, cafe.id)?.name, "Test Cafe Express", "merged name is stored");
  });

  await check("two workspaces never see each other's leads", () => {
    const betaLead = store.upsertLead({
      workspaceId: beta.id,
      name: "Test Beta Salon",
      category: "salon",
      city: "Testville",
      website: "https://beta-salon.example/",
      summary: "Fake salon used only by the store check.",
      score: 10,
      source: "test-fixture",
      sourceUrl: "https://example.test/fixture/beta",
      createdAt: "2026-01-06T00:00:00.000Z",
    });
    const alphaIds = store.listLeads({ workspaceId: alpha.id }).leads.map((lead) => lead.id);
    const betaIds = store.listLeads({ workspaceId: beta.id }).leads.map((lead) => lead.id);
    assert(!alphaIds.includes(betaLead.id), "alpha list must not contain the beta lead");
    assert(!betaIds.includes(cafe.id), "beta list must not contain the alpha lead");
    eq(store.getLead(alpha.id, betaLead.id), undefined, "cross-workspace getLead returns undefined");
    eq(store.getLead(beta.id, cafe.id), undefined, "beta cannot read an alpha lead");
    eq(betaIds.length, 1, "beta has exactly its own lead");
  });

  // ------------------------------------------------ more fixtures + queries
  const moreSeeds: LeadSeed[] = [
    {
      workspaceId: alpha.id, name: "Fake Bakery", category: "bakery", city: "Breadtown",
      website: "https://fake-bakery.example/", summary: "Fake bakery, with a comma in the summary.",
      signals: ["no-website", "has-phone"], score: 80, status: "shortlisted",
      source: "test-fixture", sourceUrl: "https://example.test/fixture/3", createdAt: "2026-01-02T00:00:00.000Z",
    },
    {
      workspaceId: alpha.id, name: "Sample Salon", category: "salon", city: "Testville",
      website: "https://sample-salon.example/", summary: "Fake salon used only by the store check.",
      signals: ["no-https"], score: 20, status: "contacted",
      source: "test-fixture", sourceUrl: "https://example.test/fixture/4", createdAt: "2026-01-03T00:00:00.000Z",
    },
    {
      workspaceId: alpha.id, name: "Demo Gym", category: "gym", city: "Ironville",
      website: "https://demo-gym.example/", summary: "Fake gym used only by the store check.",
      signals: ["no-website"], score: 95, status: "new",
      source: "test-fixture", sourceUrl: "https://example.test/fixture/5", createdAt: "2026-01-04T00:00:00.000Z",
    },
    {
      workspaceId: alpha.id, name: "Placeholder Pharmacy", category: "pharmacy", city: "Testville",
      website: "https://placeholder-pharmacy.example/", summary: "Fake pharmacy used only by the store check.",
      signals: ["has-email"], score: 55, status: "won",
      source: "test-fixture", sourceUrl: "https://example.test/fixture/6", createdAt: "2026-01-05T00:00:00.000Z",
    },
  ];
  for (const seed of moreSeeds) store.upsertLead(seed);

  await check("filters (status, minScore, city, category, signal, q)", () => {
    eq(store.listLeads({ workspaceId: alpha.id }).total, 5, "five leads in alpha");
    eq(store.listLeads({ workspaceId: alpha.id, status: "shortlisted" }).total, 1, "status filter");
    eq(store.listLeads({ workspaceId: alpha.id, minScore: 80 }).total, 2, "minScore filter");
    eq(store.listLeads({ workspaceId: alpha.id, city: "Testville" }).total, 2, "city filter");
    eq(store.listLeads({ workspaceId: alpha.id, category: "bakery" }).total, 1, "category filter");
    eq(store.listLeads({ workspaceId: alpha.id, signal: "no-website" }).total, 2, "signal filter");
    eq(store.listLeads({ workspaceId: alpha.id, q: "salon" }).total, 1, "q matches the name");
    eq(store.listLeads({ workspaceId: alpha.id, q: "otherville" }).total, 1, "q matches the city");
    eq(store.listLeads({ workspaceId: alpha.id, q: "nothing-matches-this" }).total, 0, "q with no match");
    eq(store.listLeads({ workspaceId: alpha.id, status: "new" }).total, 2, "status filter is scoped to the workspace");
  });

  await check("sorting", () => {
    const byScore = store.listLeads({ workspaceId: alpha.id, sort: "score", limit: 5 }).leads;
    eq(byScore.map((lead) => lead.name).join(" | "), "Demo Gym | Fake Bakery | Placeholder Pharmacy | Test Cafe Express | Sample Salon", "sort=score descending");
    const byCreated = store.listLeads({ workspaceId: alpha.id, sort: "createdAt", limit: 5 }).leads;
    eq(byCreated[0].name, "Placeholder Pharmacy", "sort=createdAt newest first");
    eq(byCreated[4].name, "Test Cafe Express", "sort=createdAt oldest last");
  });

  await check("pagination", () => {
    const page1 = store.listLeads({ workspaceId: alpha.id, sort: "score", limit: 2, offset: 0 });
    const page2 = store.listLeads({ workspaceId: alpha.id, sort: "score", limit: 2, offset: 2 });
    const page3 = store.listLeads({ workspaceId: alpha.id, sort: "score", limit: 2, offset: 4 });
    eq(page1.total, 5, "total ignores limit/offset");
    eq(page1.leads.length, 2, "page 1 size");
    eq(page2.leads.length, 2, "page 2 size");
    eq(page3.leads.length, 1, "page 3 size");
    assert(page1.leads[0].id !== page2.leads[0].id, "pages must not repeat the first lead");
    eq(page2.leads[0].name, "Placeholder Pharmacy", "page 2 starts where page 1 ended");
    eq(store.listLeads({ workspaceId: alpha.id, limit: 2, offset: 50 }).leads.length, 0, "offset past the end is empty");
  });

  await check("PATCH changes status and notes", () => {
    const patched = store.updateLead(alpha.id, cafe.id, { status: "replied", notes: "Called the fake number on 2026-01-06." });
    eq(patched?.status, "replied", "status changed");
    eq(patched?.notes, "Called the fake number on 2026-01-06.", "notes changed");
    const reread = store.getLead(alpha.id, cafe.id);
    eq(reread?.status, "replied", "status persisted");
    eq(reread?.notes, "Called the fake number on 2026-01-06.", "notes persisted");
    eq(reread?.name, "Test Cafe Express", "other fields untouched");
    eq(store.updateLead(alpha.id, "no-such-lead", { status: "won" }), undefined, "unknown lead returns undefined");
  });

  await check("CSV export has a header row and quotes commas", () => {
    const csv = store.leadsToCsv(store.listLeads({ workspaceId: alpha.id, limit: 100 }).leads);
    const lines = csv.split("\n");
    eq(lines[0], "name,category,city,country,address,phone,email,website,score,status,summary,angle,signals,source,sourceUrl,createdAt", "header row");
    eq(lines.length, 7, "header plus five leads plus trailing newline");
    assert(csv.includes('"Fake bakery, with a comma in the summary."'), "a field containing a comma is quoted");
    assert(lines.some((line) => line.startsWith("Fake Bakery,bakery,Breadtown")), "unquoted fields stay plain");
    eq(store.csvCell('He said "hi", ok'), '"He said ""hi"", ok"', "quotes are doubled");
    eq(store.csvCell("plain"), "plain", "plain cell unchanged");
  });

  // ---------------------------------------------------------------- server
  const httpJson = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text === "" ? null : JSON.parse(text); } catch { json = null; }
    return { status: res.status, json: json as any, text, contentType: res.headers.get("content-type") ?? "" };
  };

  let serverWorkspaceId = "";

  await check("server start on a random port, GET /api/health, create workspace, list leads", async () => {
    testServer = serverMod.createServer();
    await new Promise<void>((resolve) => testServer!.listen(0, "127.0.0.1", resolve));
    const address = testServer.address();
    assert(typeof address === "object" && address !== null, "server is listening on an address");
    const port = address.port;
    assert(port > 0, "random port assigned");
    baseUrl = `http://127.0.0.1:${port}`;

    const health = await httpJson("GET", "/api/health");
    eq(health.status, 200, "health status");
    eq(health.json.ok, true, "health body");

    const created = await httpJson("POST", "/api/workspaces", {
      name: "Server Test Workspace (fake)",
      offer: { services: ["website"], description: "Fake offer used only by the store check." },
      icp: { categories: ["cafe"], cities: ["Testville"], countries: ["IN"] },
    });
    eq(created.status, 201, "create workspace status");
    eq(created.json.name, "Server Test Workspace (fake)", "created workspace name");
    serverWorkspaceId = created.json.id;
    assert(typeof serverWorkspaceId === "string" && serverWorkspaceId.length > 0, "created workspace id");

    const listedWorkspaces = await httpJson("GET", "/api/workspaces");
    eq(listedWorkspaces.status, 200, "list workspaces status");
    assert(Array.isArray(listedWorkspaces.json) && listedWorkspaces.json.length === 3, "three workspaces via HTTP");

    store.upsertLead({
      workspaceId: serverWorkspaceId,
      name: "Server Fixture Cafe",
      category: "cafe",
      city: "Testville",
      website: "https://server-fixture.example/",
      summary: "Fake lead, added by the server check.",
      signals: ["has-phone"],
      score: 30,
      source: "test-fixture",
      sourceUrl: "https://example.test/fixture/server",
    });

    const leads = await httpJson("GET", `/api/workspaces/${serverWorkspaceId}/leads?sort=score`);
    eq(leads.status, 200, "list leads status");
    eq(leads.json.total, 1, "list leads total");
    eq(leads.json.leads[0].name, "Server Fixture Cafe", "list leads content");
    eq(leads.json.leads[0].signals[0], "has-phone", "lead arrays survive the HTTP round trip");
  });

  await check("server PATCH changes status and notes", async () => {
    const first = await httpJson("GET", `/api/workspaces/${serverWorkspaceId}/leads`);
    const leadId = first.json.leads[0].id;
    const patched = await httpJson("PATCH", `/api/workspaces/${serverWorkspaceId}/leads/${leadId}`, {
      status: "contacted",
      notes: "Patched over HTTP by the fake check.",
    });
    eq(patched.status, 200, "patch status code");
    eq(patched.json.status, "contacted", "patched status");
    eq(patched.json.notes, "Patched over HTTP by the fake check.", "patched notes");
    const bad = await httpJson("PATCH", `/api/workspaces/${serverWorkspaceId}/leads/${leadId}`, { status: "not-a-status" });
    eq(bad.status, 400, "invalid status rejected");
    assert(typeof bad.json.error === "string" && bad.json.error.length > 0, "error message returned");
  });

  await check("server CSV export", async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/${serverWorkspaceId}/export.csv?status=contacted`);
    const text = await res.text();
    eq(res.status, 200, "export status");
    assert((res.headers.get("content-type") ?? "").startsWith("text/csv"), "csv content type");
    assert(text.split("\n")[0].startsWith("name,category,city"), "csv header row");
    assert(text.includes("Server Fixture Cafe"), "csv contains the lead");
  });

  await check("server validates input and returns JSON errors", async () => {
    const missingName = await httpJson("POST", "/api/workspaces", { offer: { services: [], description: "x" }, icp: { categories: [], cities: [], countries: [] } });
    eq(missingName.status, 400, "missing name is 400");
    assert(typeof missingName.json.error === "string", "400 returns a JSON error");
    const badOffer = await httpJson("POST", "/api/workspaces", { name: "x", offer: { services: "nope" }, icp: { categories: [], cities: [], countries: [] } });
    eq(badOffer.status, 400, "bad offer is 400");
    const unknownWorkspace = await httpJson("GET", "/api/workspaces/does-not-exist/leads");
    eq(unknownWorkspace.status, 404, "unknown workspace is 404");
    const unknownLead = await httpJson("GET", `/api/workspaces/${serverWorkspaceId}/leads/does-not-exist`);
    eq(unknownLead.status, 404, "unknown lead is 404");
    const unknownRoute = await httpJson("GET", "/api/nope");
    eq(unknownRoute.status, 404, "unknown api route is 404");
    const wrongMethod = await httpJson("GET", `/api/workspaces/${serverWorkspaceId}/discover`);
    eq(wrongMethod.status, 405, "wrong method is 405");
  });

  await check("discover job is accepted and recorded", async () => {
    const res = await httpJson("POST", `/api/workspaces/${serverWorkspaceId}/discover`, { category: "cafe", city: "Testville", limit: 5 });
    eq(res.status, 202, "discover accepted in the background");
    assert(typeof res.json.jobId === "string" && res.json.jobId.length > 0, "job id returned");
    const jobs = await httpJson("GET", `/api/workspaces/${serverWorkspaceId}/jobs`);
    eq(jobs.status, 200, "jobs status");
    eq(jobs.json.length, 1, "one job recorded");
    eq(jobs.json[0].id, res.json.jobId, "recorded job matches the returned id");
    assert(["queued", "running", "done", "failed"].includes(jobs.json[0].status), "job status is a valid JobStatus");
  });

  await check("server stops cleanly", async () => {
    const server = testServer;
    assert(server, "server is running");
    server!.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    testServer = undefined;
    assert(server!.listening === false, "server is no longer listening");
  });
} catch (err) {
  failed += 1;
  const message = err instanceof Error ? err.message : String(err);
  failures.push(`harness: ${message}`);
  console.log(`FAIL harness: ${message}`);
} finally {
  if (testServer) {
    try {
      testServer.closeAllConnections?.();
      testServer.close();
    } catch { /* ignore */ }
  }
  store.closeDb();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log("");
console.log(`store-check: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("failures:");
  for (const failure of failures) console.log(`  - ${failure}`);
}
console.log(`lead statuses known to the API: ${types.LEAD_STATUSES.join(", ")}`);
process.exitCode = failed === 0 ? 0 : 1;
