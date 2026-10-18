// src/calls-ui-check.ts
// Order CALL2-call-desk: offline proof for public/calls.html.
// Starts the real server on a random port with a temp database, creates a
// workspace and imports 3 leads by CSV, then drives the page's own core logic
// (extracted between CALL-DESK-CORE markers) and the call routes. No browser,
// no network beyond 127.0.0.1. Prints PASS/FAIL per item, exits 1 on any FAIL.
//
// Sets LEADSCOUT_DB to a temp file BEFORE dynamically importing store/server.

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(HERE, "..", "public", "calls.html");

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? ": " + detail : ""));
  if (!condition) failed = true;
}

// ---------------------------------------------------------------- 1. read file + core

check("calls.html exists", existsSync(HTML_PATH), HTML_PATH);
if (!existsSync(HTML_PATH)) {
  console.log("RESULT: FAIL");
  process.exit(1);
}
const html = readFileSync(HTML_PATH, "utf8");

const START = "/* ==== CALL-DESK-CORE-START ==== */";
const END = "/* ==== CALL-DESK-CORE-END ==== */";
const startIdx = html.indexOf(START);
const endIdx = html.indexOf(END);
check("core markers present", startIdx !== -1 && endIdx > startIdx);
if (startIdx === -1 || endIdx <= startIdx) {
  console.log("RESULT: FAIL");
  process.exit(1);
}
const coreSource = html.slice(startIdx, endIdx);
const returnStmt =
  "\nreturn { escapeHtml: escapeHtml, OUTCOMES: OUTCOMES, outcomeLabel: outcomeLabel," +
  " telHref: telHref, whatsappHref: whatsappHref, areaOf: areaOf, buildCallBody: buildCallBody," +
  " buildQueueRow: buildQueueRow, DraftStore: DraftStore, applySaveResult: applySaveResult," +
  " nextIndex: nextIndex, addDaysIso: addDaysIso, quickFollowUp: quickFollowUp };";
const factory = new Function(coreSource + returnStmt) as () => any;
const core: any = factory();

// ---------------------------------------------------------------- 2. string checks

const outcomeLabels = [
  "No answer", "Busy", "Call back", "Interested", "Meeting booked",
  "Not interested", "Wrong number", "Do not contact", "Won",
];
const missingLabels = outcomeLabels.filter(function (l) { return html.indexOf(l) === -1; });
check("all nine outcome labels present", missingLabels.length === 0, missingLabels.join(", "));
check("tel: links in the file", html.indexOf("tel:") !== -1);
check("WhatsApp links point at wa.me", html.indexOf("https://wa.me/") !== -1);
check("dossier empty state says 'not processed yet'", html.indexOf("not processed yet") !== -1);
check("light and dark follow prefers-color-scheme", html.indexOf("prefers-color-scheme") !== -1);
check("workspace choice remembered via localStorage inside try/catch",
  html.indexOf("localStorage") !== -1 && html.indexOf("try") !== -1 && html.indexOf("catch") !== -1);
check("queue and stats endpoints are used",
  html.indexOf("call-queue") !== -1 && html.indexOf("call-stats") !== -1);
check("Export CSV button hits calls.csv", html.indexOf("calls.csv") !== -1);
check("keyboard: Ctrl+Enter saves", html.indexOf("ctrlKey") !== -1 && html.indexOf("Enter") !== -1);
check("keyboard: number keys 1-9 pick outcomes", html.indexOf("[1-9]") !== -1);

const urls = html.match(/https?:\/\/[^\s"'<>)]+/g) || [];
const badUrls = urls.filter(function (u) { return u.indexOf("https://wa.me/") !== 0; });
check("no external URL other than wa.me", badUrls.length === 0, badUrls.join(", "));
check("no static external src/href hosts",
  !/(?:src|href)\s*=\s*["']\s*https?:\/\//i.test(html));

// ---------------------------------------------------------------- 3. core logic

check("escapeHtml neutralises a hostile name", (function () {
  const hostile = "<img src=x onerror=alert(1)>\" & '";
  const out = core.escapeHtml(hostile);
  return out.indexOf("<") === -1 && out.indexOf(">") === -1 && out.indexOf("\"") === -1
    && out.indexOf("&lt;img") !== -1;
})(), core.escapeHtml("<img src=x onerror=alert(1)>"));

check("tel and WhatsApp hrefs strip to digits",
  core.telHref("+91 90000-00001") === "tel:+919000000001"
  && core.whatsappHref("+91 90000-00001") === "https://wa.me/919000000001");

check("buildCallBody posts the route's body shape", (function () {
  const b = core.buildCallBody({
    channel: "call", outcome: "interested", iSaid: "hi", theySaid: "maybe",
    nextAction: "send deck", followUpAt: "2026-10-09",
  });
  return b.channel === "call" && b.outcome === "interested" && b.iSaid === "hi"
    && b.theySaid === "maybe" && b.nextAction === "send deck" && b.followUpAt === "2026-10-09";
})());

check("quick follow-up dates are tomorrow / 3 days / week", (function () {
  const base = "2026-10-08T09:00:00Z";
  return core.addDaysIso(1, base) === "2026-10-09"
    && core.addDaysIso(3, base) === "2026-10-11"
    && core.addDaysIso(7, base) === "2026-10-15";
})());

check("drafts survive switching leads", (function () {
  const d = new core.DraftStore();
  d.set("lead-A", { iSaid: "text for A" });
  d.set("lead-B", { iSaid: "text for B" });
  const a = d.get("lead-A");
  const b = d.get("lead-B");
  return !!a && a.iSaid === "text for A" && !!b && b.iSaid === "text for B";
})());

check("a failed save keeps the draft; success clears it", (function () {
  const d = new core.DraftStore();
  d.set("lead-C", { iSaid: "keep me" });
  core.applySaveResult(d, "lead-C", false);
  const kept = d.get("lead-C");
  const afterKeep = !!kept && kept.iSaid === "keep me";
  core.applySaveResult(d, "lead-C", true);
  return afterKeep && d.get("lead-C") === null;
})());

check("nextIndex advances and wraps at the end",
  core.nextIndex(3, 0) === 1 && core.nextIndex(1, 0) === 0);

// ---------------------------------------------------------------- 4. server + fixtures

const ROOT = mkdtempSync(join(tmpdir(), "leadscout-calls-ui-"));
process.env.LEADSCOUT_DB = join(ROOT, "check.db");
delete process.env.LEADSCOUT_REQUIRE_KEYS;

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

async function req(method: string, path: string, body?: string, contentType?: string): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = contentType;
  const res = await fetch(baseUrl + path, { method: method, headers: headers, body: body });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, text: text, json: json };
}

const created = await req("POST", "/api/workspaces", JSON.stringify({
  name: "Fake Calls Workspace",
  offer: { services: ["website"], description: "fake offer for checks" },
  icp: { categories: ["cafe"], cities: ["Fake City"], countries: ["IN"] },
}), "application/json");
const workspaceId = created.json && created.json.id ? String(created.json.id) : "";
check("workspace created over HTTP", created.status === 201 && workspaceId.length > 0, "status=" + created.status);

const csv = [
  "name,phone,category,address,link",
  "Fake Alpha Cafe,+919000000001,cafe,12 Fake Road,https://example-calls.test/a",
  "Fake <img src=x onerror=alert(1)> Beta,+919000000002,cafe,9 Fake Lane,https://example-calls.test/b",
  "Fake Gamma Clinic,+919000000003,clinic,3 Fake Street,https://example-calls.test/c",
].join("\n");
const imported = await req("POST", "/api/workspaces/" + workspaceId + "/import-csv", csv, "text/csv");
check("3 leads imported by CSV",
  imported.status === 200 && imported.json && imported.json.imported === 3,
  "status=" + imported.status + " imported=" + String(imported.json && imported.json.imported));

// ---------------------------------------------------------------- 5. the page is served

const page = await fetch(baseUrl + "/calls.html");
const pageText = await page.text();
check("GET /calls.html is served by the server", page.status === 200 && pageText.indexOf("Call desk") !== -1, "status=" + page.status);

// ---------------------------------------------------------------- 6. queue renders 3 rows

const q1 = await req("GET", "/api/workspaces/" + workspaceId + "/call-queue");
const queue1: any[] = (q1.json && q1.json.queue) || [];
check("call-queue returns the 3 imported leads", q1.status === 200 && queue1.length === 3, "len=" + queue1.length);

const rows: string[] = queue1.map(function (entry, i) {
  return core.buildQueueRow(entry, { index: i, selected: i === 0, lastOutcome: "not called yet" });
});
const telCount = rows.filter(function (r) { return r.indexOf('href="tel:') !== -1; }).length;
const waCount = rows.filter(function (r) { return r.indexOf("https://wa.me/") !== -1; }).length;
check("each rendered row has a tel: link", telCount === 3, "tel=" + telCount);
check("each rendered row has a WhatsApp link", waCount === 3, "wa=" + waCount);

const hostileEntry = queue1.map(function (e) { return e; }).filter(function (e) {
  return String(e.lead && e.lead.name).indexOf("<img") !== -1;
})[0];
check("hostile name is present in the fixture queue", !!hostileEntry);
if (hostileEntry) {
  const hostileRow = core.buildQueueRow(hostileEntry, { index: 0, selected: false, lastOutcome: "" });
  check("hostile lead name is escaped in the rendered row",
    hostileRow.indexOf("<img") === -1 && hostileRow.indexOf("&lt;img") !== -1,
    hostileRow.slice(0, 160));
}

// ---------------------------------------------------------------- 7. save posts the right body and advances

const first = queue1[0];
const firstLeadId = String(first.lead.id);
const body = core.buildCallBody({
  channel: "call", outcome: "interested", iSaid: "Fake hello", theySaid: "Fake maybe",
  nextAction: "Send a fake deck", followUpAt: core.addDaysIso(30, new Date().toISOString()),
});
const posted = await req("POST", "/api/workspaces/" + workspaceId + "/leads/" + firstLeadId + "/calls", JSON.stringify(body), "application/json");
check("saving a call posts the body and gets 201", posted.status === 201, "status=" + posted.status + " body=" + posted.text.slice(0, 120));

const readBack = await req("GET", "/api/workspaces/" + workspaceId + "/leads/" + firstLeadId + "/calls");
const calls: any[] = (readBack.json && readBack.json.calls) || [];
check("stored call matches the posted body",
  calls.length === 1 && calls[0].outcome === "interested" && calls[0].iSaid === "Fake hello"
  && calls[0].theySaid === "Fake maybe" && calls[0].nextAction === "Send a fake deck",
  JSON.stringify(calls[0] || null));

const q2 = await req("GET", "/api/workspaces/" + workspaceId + "/call-queue");
const queue2: any[] = (q2.json && q2.json.queue) || [];
const stillThere = queue2.some(function (e) { return String(e.lead.id) === firstLeadId; });
check("after saving, the queue advanced (the saved lead left it)", queue2.length === 2 && !stillThere, "len=" + queue2.length);

// ---------------------------------------------------------------- 8. a failed save keeps the typed text

const badBody = core.buildCallBody({ channel: "call", outcome: "nonsense", iSaid: "keep this text" });
const badPost = await req("POST", "/api/workspaces/" + workspaceId + "/leads/" + firstLeadId + "/calls", JSON.stringify(badBody), "application/json");
check("a bad outcome is refused with 400 and a plain message",
  badPost.status === 400 && typeof (badPost.json && badPost.json.error) === "string",
  "status=" + badPost.status + " error=" + String(badPost.json && badPost.json.error));

const drafts = new core.DraftStore();
drafts.set(firstLeadId, { iSaid: "keep this text" });
core.applySaveResult(drafts, firstLeadId, false);
const keptDraft = drafts.get(firstLeadId);
check("failed save keeps the typed text for the lead",
  !!keptDraft && keptDraft.iSaid === "keep this text");

// ---------------------------------------------------------------- teardown

await new Promise<void>(function (resolve) {
  server.close(function () { resolve(); });
  server.closeAllConnections();
});
store.closeDb();
rmSync(ROOT, { recursive: true, force: true });

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
