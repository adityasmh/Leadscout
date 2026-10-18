// src/showcase-check.ts
// Order DEMO2-showcase-page: offline proof for the showcase overview.
// Starts the real server on a random port with a temp database, creates a
// workspace, imports 3 clearly fake leads, checks the showcase endpoint's
// counts and top-leads shape, checks the 404 for an unknown workspace, and
// checks public/showcase.html (six step names, print stylesheet, no external
// script/style source). No network beyond 127.0.0.1. Prints PASS/FAIL per item.
//
// Sets LEADSCOUT_DB to a temp file BEFORE dynamically importing store/server.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? ": " + detail : ""));
  if (!condition) failed = true;
}

const ROOT = mkdtempSync(join(tmpdir(), "leadscout-showcase-"));
process.env.LEADSCOUT_DB = join(ROOT, "check.db");
delete process.env.LEADSCOUT_REQUIRE_KEYS;
delete process.env.LEADSCOUT_LLM_URL;
process.env.LEADSCOUT_LLM_OFF = "1";

const store = await import("./store.js");
const serverMod = await import("./server.js");

const server = serverMod.createServer();
let PORT = 0;
await new Promise<void>(function (resolve) {
  server.listen(0, "127.0.0.1", function () {
    const address = server.address();
    PORT = typeof address === "object" && address ? address.port : 0;
    resolve();
  });
});
check("server listens on a random port", PORT > 0, String(PORT));
const baseUrl = "http://127.0.0.1:" + PORT;

async function req(method: string, path: string): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(baseUrl + path, { method: method });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, text: text, json: json };
}

// ------------------------------------------------------------ fixtures

const workspace = store.createWorkspace({
  name: "Fake Showcase Workspace",
  offer: {
    services: ["website", "automation", "seo"],
    description: "We build fake websites and fake automations for fake local businesses.",
  },
  icp: { categories: ["dentist", "gym"], cities: ["Fake Town"], countries: ["IN"] },
});
check("workspace created with a temp database", typeof workspace.id === "string" && workspace.id.length > 0);

const common = { workspaceId: workspace.id, source: "fixture", sourceUrl: "https://example-showcase.test/fixture" };
store.upsertLead({
  ...common,
  name: "Fake Dentist One",
  category: "dentist",
  city: "Fake Town",
  phone: "+919000000101",
  email: "one@example-showcase.test",
  website: "https://one.fake-showcase.test/",
  summary: "A fake dental practice used only for offline checks.",
  enrichedAt: "2026-10-01T00:00:00.000Z",
  score: 72,
  fit: [{ service: "website", score: 80, reason: "fake reason" }],
  gate: "template",
});
store.upsertLead({
  ...common,
  name: "Fake Dentist Two",
  category: "dentist",
  city: "Fake Town",
  score: 55,
  fit: [{ service: "automation", score: 60, reason: "fake reason" }],
  gate: "template",
});
store.upsertLead({
  ...common,
  name: "Fake Gym Three",
  category: "gym",
  city: "Fake City",
  phone: "+919000000103",
  website: "https://three.fake-showcase.test/",
  summary: "A fake gym used only for offline checks.",
  enrichedAt: "2026-10-02T00:00:00.000Z",
  score: 88,
  fit: [{ service: "seo", score: 70, reason: "fake reason" }],
  gate: "template",
});
check("3 clearly fake leads imported", store.listLeads({ workspaceId: workspace.id, limit: 10, offset: 0 }).total === 3);

// ------------------------------------------------------------ showcase endpoint

const result = await req("GET", "/api/workspaces/" + workspace.id + "/showcase");
check("GET showcase answers 200", result.status === 200, "status=" + result.status);
const body: any = result.json || {};
const counts = body.counts || {};
check("counts: leads total is 3", counts.leads === 3, "leads=" + String(counts.leads));
check("counts: enriched is 2", counts.enriched === 2, "enriched=" + String(counts.enriched));
check("counts: scored is 3", counts.scored === 3, "scored=" + String(counts.scored));
check("counts: with phone is 2", counts.withPhone === 2, "withPhone=" + String(counts.withPhone));
check("counts: with email is 1", counts.withEmail === 1, "withEmail=" + String(counts.withEmail));
check("counts: with website is 2", counts.withWebsite === 2, "withWebsite=" + String(counts.withWebsite));

const funnel = body.funnel || {};
check("funnel: discovered 3, understood 2, scored 3, contactable 2",
  funnel.discovered === 3 && funnel.understood === 2 && funnel.scored === 3 && funnel.contactable === 2,
  JSON.stringify(funnel));

const topLeads: any[] = Array.isArray(body.topLeads) ? body.topLeads : [];
check("topLeads is a list of 3", topLeads.length === 3, "len=" + topLeads.length);
const shapeOk = topLeads.every(function (l) {
  return l && typeof l.id === "string" && typeof l.name === "string"
    && typeof l.category === "string" && typeof l.area === "string"
    && typeof l.score === "number" && typeof l.topService === "string"
    && typeof l.gapHeadline === "string" && typeof l.phone === "string";
});
check("every top lead has the expected shape", shapeOk);
check("top lead is the highest score (Fake Gym Three, 88)",
  topLeads.length > 0 && topLeads[0].name === "Fake Gym Three" && topLeads[0].score === 88,
  topLeads.length > 0 ? topLeads[0].name + " / " + topLeads[0].score : "empty");
check("a lead without a phone has an empty phone field",
  topLeads.some(function (l) { return l.name === "Fake Dentist Two" && l.phone === ""; }));

const categories: any[] = Array.isArray(body.categories) ? body.categories : [];
check("categories list has the two fake categories", categories.length === 2, "len=" + categories.length);
check("categories expose category, leads, avgScore, topService",
  categories.every(function (c) {
    return typeof c.category === "string" && typeof c.leads === "number"
      && typeof c.avgScore === "number" && typeof c.topService === "string";
  }));

const recentCalls = body.recentCalls;
check("recentCalls is an empty list when nothing was called", Array.isArray(recentCalls) && recentCalls.length === 0);

// ------------------------------------------------------------ unknown workspace 404

const missing = await req("GET", "/api/workspaces/this-workspace-does-not-exist/showcase");
check("unknown workspace answers 404", missing.status === 404, "status=" + missing.status);
check("unknown workspace body has a plain error string",
  !!missing.json && typeof missing.json.error === "string" && missing.json.error.length > 0,
  JSON.stringify(missing.json));

// ------------------------------------------------------------ showcase.html

const page = await fetch(baseUrl + "/showcase.html");
const html = await page.text();
check("GET /showcase.html is served", page.status === 200 && html.indexOf("Leadscout showcase") !== -1, "status=" + page.status);
const steps = ["Find", "Understand", "Score", "Brief", "Call", "Learn"];
const missingSteps = steps.filter(function (s) { return html.indexOf(s) === -1; });
check("the six step names are present", missingSteps.length === 0, missingSteps.join(", "));
check("a print stylesheet is present", html.indexOf("@media print") !== -1);
check("no external script source",
  !/<script[^>]+src\s*=/i.test(html));
check("no http/https src or href",
  !/(?:src|href)\s*=\s*["']\s*https?:\/\//i.test(html));
check("no bare http:// or https:// anywhere in the page",
  html.indexOf("http://") === -1 && html.indexOf("https://") === -1);

// ------------------------------------------------------------ teardown

await new Promise<void>(function (resolve) {
  server.close(function () { resolve(); });
  server.closeAllConnections();
});
store.closeDb();
rmSync(ROOT, { recursive: true, force: true });

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
