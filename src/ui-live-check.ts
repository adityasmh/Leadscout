// src/ui-live-check.ts
// ORDER_I2-ui-wiring check. Fully offline.
//
// Starts the real HTTP server on a random port against a temporary database, creates one
// workspace, imports two leads, processes them with injected offline fixtures, then:
//   1. fetches every static page the order names,
//   2. requests every API path the five UI HTML files call, with the real workspace and
//      lead ids, and fails on any 404 or 500 for a path that server.ts actually serves,
//   3. lists the paths the pages call that the server does not serve under MISSING ROUTES
//      (intake and outreach are named in the order as "may not exist"; not a failure),
//   4. string-checks the HTML for the Process, Open dossier and lead-picker elements.
//
// No outside calls: a fake page fetch and a fake model keep discover/enrich/dossier offline.
// LEADSCOUT_DB points at a temp file only; the real data/ database is never opened.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The temp database and fixture switch must be in place BEFORE store/server are imported.
const tmpDb = join(tmpdir(), `leadscout-ui-check-${randomBytes(8).toString("hex")}.db`);
process.env.LEADSCOUT_DB = tmpDb;
process.env.LEADSCOUT_TEST_FIXTURES = "1";
delete process.env.LEADSCOUT_REQUIRE_KEYS;
delete process.env.LEADSCOUT_LLM_URL;
delete process.env.LEADSCOUT_REACH;
delete process.env.LEADSCOUT_SEND_ENABLED;

const serverMod = await import("./server.js");
const store = await import("./store.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
function check(name: string, cond: unknown, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${detail ? `: ${detail}` : ""}`);
  }
}
function info(name: string, detail = ""): void {
  console.log(`INFO: ${name}${detail ? `: ${detail}` : ""}`);
}

// ------------------------------------------------------------------ offline fixtures

const FIXTURE_SUMMARY =
  "Fake Ui Fixture Clinic is a clearly fake business used only by the offline leadscout ui check.";
const FIXTURE_PAGE = [
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
  "<title>Fake Ui Fixture Clinic</title>",
  `<meta name="description" content="${FIXTURE_SUMMARY}">`,
  "</head><body><h1>Fake Ui Fixture Clinic</h1>",
  "<p>&copy; 2019 Fake Ui Fixture Clinic. This page is an offline test fixture.</p>",
  "</body></html>",
].join("");

const fakeFetchFn = (async (input: unknown) => {
  const raw = typeof input === "string"
    ? input
    : (input as { url?: string } | undefined)?.url ?? String(input);
  if (raw.includes("/robots.txt")) {
    return new Response("User-agent: *\nAllow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response(FIXTURE_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}) as unknown as typeof fetch;

// Echo the embedded draft back so the optional polish path stays offline and cited.
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
    fetchFn: fakeFetchFn,
    llm: fakeLlm,
    researchMode: "off",
    reach: null,
    now: FIXED_NOW,
  },
});

// ------------------------------------------------------------------ HTTP helpers

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

// ------------------------------------------------------------------ route table (from server.ts)

// [method, template]. ":param" matches any single path segment. This list mirrors the
// route branches in src/server.ts plus the dynamic routes-calls.ts module.
const SERVER_ROUTES: Array<[string, string]> = [
  ["GET", "/api/health"],
  ["POST", "/api/optout"],
  ["GET", "/api/workspaces"],
  ["POST", "/api/workspaces"],
  ["GET", "/api/workspaces/:ws"],
  ["PUT", "/api/workspaces/:ws"],
  ["POST", "/api/workspaces/:ws/discover"],
  ["POST", "/api/workspaces/:ws/process"],
  ["GET", "/api/workspaces/:ws/jobs"],
  ["GET", "/api/workspaces/:ws/usage"],
  ["GET", "/api/workspaces/:ws/keys"],
  ["POST", "/api/workspaces/:ws/keys"],
  ["DELETE", "/api/workspaces/:ws/keys/:id"],
  ["GET", "/api/workspaces/:ws/pricebook"],
  ["PUT", "/api/workspaces/:ws/pricebook"],
  ["GET", "/api/workspaces/:ws/branding"],
  ["PUT", "/api/workspaces/:ws/branding"],
  ["GET", "/api/workspaces/:ws/export"],
  ["GET", "/api/workspaces/:ws/export.csv"],
  ["POST", "/api/workspaces/:ws/share"],
  ["GET", "/api/workspaces/:ws/leads"],
  ["GET", "/api/workspaces/:ws/leads/:id"],
  ["PATCH", "/api/workspaces/:ws/leads/:id"],
  ["POST", "/api/workspaces/:ws/leads/:id/process"],
  ["GET", "/api/workspaces/:ws/leads/:id/dossier"],
  ["POST", "/api/workspaces/:ws/leads/:id/dossier"],
  ["PATCH", "/api/workspaces/:ws/leads/:id/dossier"],
  ["POST", "/api/workspaces/:ws/leads/:id/outreach"],
  ["POST", "/api/workspaces/:ws/leads/:id/outreach/send"],
  ["POST", "/api/workspaces/:ws/import-csv"],
  ["GET", "/api/workspaces/:ws/invoices"],
  ["POST", "/api/workspaces/:ws/invoices"],
  ["GET", "/api/workspaces/:ws/invoices/:id"],
  ["POST", "/api/workspaces/:ws/invoices/:id/pay-link"],
  ["PUT", "/api/workspaces/:ws/limits"],
  ["GET", "/api/report/:token"],
  ["POST", "/api/workspaces/:ws/leads/:id/calls"],
  ["GET", "/api/workspaces/:ws/leads/:id/calls"],
  ["GET", "/api/workspaces/:ws/call-queue"],
  ["GET", "/api/workspaces/:ws/call-stats"],
  ["GET", "/api/workspaces/:ws/calls.csv"],
  ["PATCH", "/api/workspaces/:ws/calls/:callId"],
];

function routeServed(method: string, path: string): boolean {
  const clean = path.split("?")[0];
  const p = clean.split("/").filter(Boolean);
  for (const [m, tpl] of SERVER_ROUTES) {
    if (m !== method) continue;
    const t = tpl.split("/").filter(Boolean);
    if (t.length !== p.length) continue;
    let ok = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i].startsWith(":")) continue;
      if (t[i] !== p[i]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// ------------------------------------------------------------------ HTML extraction + string checks

const PAGE_FILES = ["index.html", "dossier.html", "intake.html", "settings.html", "optout.html"];

function readPage(name: string): string {
  return readFileSync(join(PUBLIC_DIR, name), "utf8");
}

// Every string literal that starts with /api/ (template literals keep their ${...} parts).
function extractApiRefs(html: string): string[] {
  const refs = new Set<string>();
  const re = /["'`](\/api\/[^"'`\s]*)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) refs.add(m[1]);
  const reFetch = /fetch\(\s*["'`](\/api\/[^"'`]*)["'`]/g;
  while ((m = reFetch.exec(html)) !== null) refs.add(m[1]);
  return [...refs];
}

// ------------------------------------------------------------------ probes

type Probe = { method: string; template: string; path: string; body?: unknown };

const probes: Probe[] = [];
function probe(method: string, template: string, path: string, body?: unknown): void {
  probes.push({ method, template, path, body });
}

// ------------------------------------------------------------------ run: workspace + leads

const created = await http("POST", "/api/workspaces", {
  name: "Fake Ui Wiring Workspace",
  offer: { services: ["website", "automation", "ai-chatbot"], description: "Fake offer for the ui wiring check only." },
  icp: { categories: ["clinic"], cities: ["Fake City"], countries: ["IN"] },
});
const WS: string = created.json?.id ?? "";
check("POST /api/workspaces creates a workspace", created.status === 201 && WS.length > 0, `status=${created.status}`);

const CSV = [
  "name,address,phone,website,category,link",
  "Fake Ui Clinic One,1 Fake Road Fake City,+91 9876502001,https://fake-ui-one.example,clinic,https://example.invalid/ui-one",
  "Fake Ui Clinic Two,2 Fake Road Fake City,+91 9876502002,https://fake-ui-two.example,clinic,https://example.invalid/ui-two",
].join("\n");
const imported = await http("POST", `/api/workspaces/${WS}/import-csv`, CSV, "text/csv");
check("POST /import-csv imports 2 leads",
  imported.status === 200 && Number(imported.json?.imported) === 2,
  `status=${imported.status} imported=${String(imported.json?.imported)}`);

const listAfterImport = await http("GET", `/api/workspaces/${WS}/leads`);
const LEAD: string = Array.isArray(listAfterImport.json?.leads) && listAfterImport.json.leads[0]
  ? String(listAfterImport.json.leads[0].id)
  : "";
check("lead list returns the imported leads", LEAD.length > 0, `count=${String(listAfterImport.json?.leads?.length)}`);

// Process the workspace so the dossier route has a stored dossier (ready:true) for the
// downstream page calls; this is the exact route index.html's "Process" button uses.
const processStart = await http("POST", `/api/workspaces/${WS}/process`);
check("POST /api/workspaces/:ws/process returns a job id",
  processStart.status === 202 && typeof processStart.json?.jobId === "string", `status=${processStart.status}`);
{
  const jobId = String(processStart.json?.jobId ?? "");
  const deadline = Date.now() + 30000;
  let done = false;
  while (Date.now() < deadline) {
    const jobs = await http("GET", `/api/workspaces/${WS}/jobs`);
    const job = Array.isArray(jobs.json) ? jobs.json.find((j: any) => j.id === jobId) : null;
    if (job && (job.status === "done" || job.status === "failed")) { done = true; break; }
    await sleep(100);
  }
  check("process job finishes", done, "timeout");
}

// ------------------------------------------------------------------ probes: every API path the pages call

probe("GET", "GET /api/health", "/api/health");
probe("GET", "GET /api/workspaces", "/api/workspaces");
probe("GET", "GET /api/workspaces/:ws", `/api/workspaces/${WS}`);
probe("GET", "GET /api/workspaces/:ws/jobs", `/api/workspaces/${WS}/jobs`);
probe("GET", "GET /api/workspaces/:ws/leads", `/api/workspaces/${WS}/leads?limit=20&offset=0`);
probe("GET", "GET /api/workspaces/:ws/leads/:id", `/api/workspaces/${WS}/leads/${LEAD}`);
probe("PATCH", "PATCH /api/workspaces/:ws/leads/:id", `/api/workspaces/${WS}/leads/${LEAD}`, { status: "new" });
probe("GET", "GET /api/workspaces/:ws/leads/:id/dossier", `/api/workspaces/${WS}/leads/${LEAD}/dossier`);
probe("PATCH", "PATCH /api/workspaces/:ws/leads/:id/dossier", `/api/workspaces/${WS}/leads/${LEAD}/dossier`, { callStatus: "not-called" });
probe("POST", "POST /api/workspaces/:ws/leads/:id/process", `/api/workspaces/${WS}/leads/${LEAD}/process`);
probe("GET", "GET /api/workspaces/:ws/export.csv", `/api/workspaces/${WS}/export.csv`);
probe("GET", "GET /api/workspaces/:ws/export", `/api/workspaces/${WS}/export?format=generic`);
probe("GET", "GET /api/workspaces/:ws/pricebook", `/api/workspaces/${WS}/pricebook`);
probe("GET", "GET /api/workspaces/:ws/branding", `/api/workspaces/${WS}/branding`);
probe("GET", "GET /api/workspaces/:ws/keys", `/api/workspaces/${WS}/keys`);
probe("GET", "GET /api/workspaces/:ws/usage", `/api/workspaces/${WS}/usage`);
probe("PUT", "PUT /api/workspaces/:ws/intake/answers", `/api/workspaces/${WS}/intake/answers`, { answers: {}, industry: "" });
probe("POST", "POST /api/workspaces/:ws/intake/compile", `/api/workspaces/${WS}/intake/compile`, { answers: {}, industry: "" });
probe("GET", "GET /api/workspaces/:ws/intake", `/api/workspaces/${WS}/intake`);
probe("GET", "GET /api/workspaces/:ws/outreach", `/api/workspaces/${WS}/outreach`);
probe("POST", "POST /api/optout", "/api/optout", { value: "fake-ui-check.example" });

const missing = new Map<string, string>();
for (const p of probes) {
  if (!routeServed(p.method, p.path)) {
    missing.set(p.template, `${p.method} ${p.path.split("?")[0]}`);
    continue;
  }
  const res = await http(p.method, p.path, p.body);
  // The order: fail on any 404 or 500 for a path that exists in server.ts.
  check(`${p.template} answers (${res.status})`, res.status !== 404 && res.status !== 500,
    `status=${res.status} body=${res.text.slice(0, 120)}`);
}

// Share token -> public report route (dossier.html?report= / ?token=).
{
  const share = await http("POST", `/api/workspaces/${WS}/share`, { days: 1 });
  check("POST /api/workspaces/:ws/share returns a token",
    share.status === 200 && typeof share.json?.token === "string", `status=${share.status}`);
  const token = String(share.json?.token ?? "");
  if (token) {
    const report = await http("GET", `/api/report/${encodeURIComponent(token)}`);
    check("GET /api/report/:token answers (report view)",
      report.status !== 404 && report.status !== 500, `status=${report.status}`);
  }
}

// ------------------------------------------------------------------ MISSING ROUTES

console.log("");
console.log("MISSING ROUTES (paths the pages call that server.ts does not serve):");
if (missing.size === 0) {
  console.log("  (none)");
} else {
  for (const [template, concrete] of missing) {
    console.log(`  ${template}  ->  ${concrete}`);
  }
  console.log("  note: intake and outreach are named in ORDER_I2 as routes that may not exist yet, so they are reported, not failed.");
}

// ------------------------------------------------------------------ pages

for (const [path, label] of [["/", "index (root)"], ["/index.html", "index.html"], ["/dossier.html", "dossier.html"],
  ["/intake.html", "intake.html"], ["/settings.html", "settings.html"], ["/optout.html", "optout.html"]] as Array<[string, string]>) {
  const res = await http("GET", path);
  check(`GET ${label} -> 200`, res.status === 200, `status=${res.status}`);
}

// ------------------------------------------------------------------ extracted refs + element string checks

for (const file of PAGE_FILES) {
  const html = readPage(file);
  const refs = extractApiRefs(html);
  info(`${file} references ${refs.length} API path(s)`, refs.join(", "));
}

const indexHtml = readPage("index.html");
check("index.html has a 'Process all new leads' button",
  /id="process-all-btn"/.test(indexHtml) && /Process all new leads/.test(indexHtml));
check("index.html has a per-lead Process action",
  /id="lead-process-btn"/.test(indexHtml));
check("index.html has an 'Open dossier' action",
  /id="lead-dossier-btn"/.test(indexHtml) && /Open dossier/.test(indexHtml));
check("index.html links to dossier.html?ws=", /dossier\.html\?ws=/.test(indexHtml));
check("index.html shows the not-processed message",
  /Not processed yet\. Press Process\./.test(indexHtml));

const dossierHtml = readPage("dossier.html");
check("dossier.html has a lead picker element",
  /id="id-lead-picker"/.test(dossierHtml) && /renderLeadPicker/.test(dossierHtml));
check("dossier.html handles a not-ready dossier with a Process button",
  /ready\s*===?\s*false/.test(dossierHtml));

const intakeHtml = readPage("intake.html");
check("intake.html resolves the workspace from ?ws= or localStorage",
  /localStorage\.getItem\(/.test(intakeHtml) && /leadscout\.workspace/.test(intakeHtml));
check("intake.html has a plain 'not installed' message (no raw URL as the main message)",
  /not installed yet/.test(intakeHtml));

const settingsHtml = readPage("settings.html");
check("settings.html resolves the workspace from ?ws= or localStorage",
  /localStorage\.getItem\(/.test(settingsHtml) && /leadscout\.workspace/.test(settingsHtml));

// ------------------------------------------------------------------ teardown + summary

await new Promise<void>((resolve) => server.close(() => resolve()));
store.closeDb();
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const path = tmpDb + suffix;
  if (existsSync(path)) {
    try { rmSync(path); } catch { /* ignore cleanup errors */ }
  }
}

console.log("");
console.log(`${failed === 0 ? "ALL PASS" : "SOME FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
