// src/callsheet-readonly-check.ts
// Order SIDE1-callsheet-read-only proof. Offline: temp database via env LEADSCOUT_DB
// set BEFORE any module that opens the database is imported, temp COMPANY_ROOT folder,
// the real server (server.ts) started in-process on a random port, one workspace with
// 13 clearly fake callable leads. Verifies GET /callsheet is a read-only preview
// (never writes to call_assignments, answers preview:true again and again) and only
// POST /callsheet/assign stores assignments (second identical POST stores 0).
// Run once: npx tsx src/callsheet-readonly-check.ts
//
// This check does NOT import src/company/, so the sandbox root import (PITFALLS 1) is
// not needed. The live database data/ is never opened.

import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? ": " + detail : ""));
  if (!condition) failed = true;
}

const ROOT = mkdtempSync(join(tmpdir(), "leadscout-callsheet-readonly-"));
process.env.LEADSCOUT_DB = join(ROOT, "check.db");
process.env.COMPANY_ROOT = join(ROOT, "company");
mkdirSync(process.env.COMPANY_ROOT, { recursive: true });
delete process.env.LEADSCOUT_REQUIRE_KEYS;
process.env.LEADSCOUT_DND_DIR = join(ROOT, "no-dnd-here");
process.env.LEADSCOUT_LLM_OFF = "1";

const store = await import("./store.js");
const serverMod = await import("./server.js");

const server = serverMod.createServer();
let PORT = 0;
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    PORT = typeof address === "object" && address ? address.port : 0;
    resolve();
  });
});
check("server listens on a random port", PORT > 0, String(PORT));
const baseUrl = "http://127.0.0.1:" + PORT;

async function req(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; text: string; contentType: string }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(baseUrl + path, init);
  const text = await res.text();
  return { status: res.status, text, contentType: res.headers.get("content-type") ?? "" };
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sheetOf(body: Record<string, unknown> | null): Record<string, unknown> {
  const sheet = body?.["sheet"];
  return typeof sheet === "object" && sheet !== null ? (sheet as Record<string, unknown>) : {};
}

function rowsOf(body: Record<string, unknown> | null): Record<string, unknown>[] {
  const rows = sheetOf(body)["rows"];
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function strOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sortedIds(rows: Record<string, unknown>[]): string[] {
  return rows.map((row) => strOf(row["leadId"])).sort();
}

function assignmentCount(): number {
  const db = store.getDb();
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM call_assignments WHERE workspaceId = ?")
    .get(workspace.id) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

// ------------------------------------------------------------------ fixtures

const workspace = store.createWorkspace({
  name: "Fake Readonly Workspace",
  offer: { services: ["website", "automation"], description: "fake offer for offline checks only" },
  icp: { categories: ["dentist"], cities: ["Fake Town"], countries: ["IN"] },
});
check("workspace created on a temp database", workspace.id.length > 0);

const common = {
  workspaceId: workspace.id,
  category: "dentist",
  city: "Fake Town",
  source: "fixture",
  sourceUrl: "https://example-readonly.test/fixture",
  summary: "clearly fake fixture for offline checks",
  gate: "template" as const,
};
for (let i = 0; i < 13; i += 1) {
  store.upsertLead({
    ...common,
    name: `Fake Readonly Biz ${String(i + 1).padStart(2, "0")}`,
    phone: `+${String(15550000101 + i)}`,
    score: 90 - i,
  });
}
check("13 clearly fake callable leads imported", true);

// ------------------------------------------------------------------ GET never writes

const dateA = "2026-12-01";
const dateB = "2026-12-02";
const dateC = "2026-12-03";

const getA = await req("GET", `/api/workspaces/${workspace.id}/callsheet?format=json&date=${dateA}&perCaller=10&callers=a,b,c`);
const bodyA = parseJson(getA.text);
const rowsA = rowsOf(bodyA);
check("GET date A answers 200 with 13 rows", getA.status === 200 && rowsA.length === 13, `status=${getA.status} rows=${rowsA.length}`);
check("GET date A preview is true", sheetOf(bodyA)["preview"] === true, "preview=" + String(sheetOf(bodyA)["preview"]));

const getB = await req("GET", `/api/workspaces/${workspace.id}/callsheet?format=json&date=${dateB}&perCaller=2&callers=x`);
const bodyB = parseJson(getB.text);
check("GET date B with different callers answers 2 rows capped", getB.status === 200 && rowsOf(bodyB).length === 2, "rows=" + rowsOf(bodyB).length);
check("GET date B preview is true", sheetOf(bodyB)["preview"] === true, "preview=" + String(sheetOf(bodyB)["preview"]));

const getC = await req("GET", `/api/workspaces/${workspace.id}/callsheet?format=json&date=${dateC}&perCaller=2&callers=a,b`);
const bodyC = parseJson(getC.text);
check("GET date C with callers a,b perCaller 2 answers 4 rows", getC.status === 200 && rowsOf(bodyC).length === 4, "rows=" + rowsOf(bodyC).length);
check("GET date C preview is true", sheetOf(bodyC)["preview"] === true, "preview=" + String(sheetOf(bodyC)["preview"]));

check("three GETs stored 0 assignments", assignmentCount() === 0, "count=" + assignmentCount());

const getA2 = await req("GET", `/api/workspaces/${workspace.id}/callsheet?format=json&date=${dateA}&perCaller=10&callers=a,b,c`);
const rowsA2 = rowsOf(parseJson(getA2.text));
check(
  "GET date A again returns the same 13 rows (read-only repeat)",
  getA2.status === 200 && rowsA2.length === 13 && JSON.stringify(sortedIds(rowsA2)) === JSON.stringify(sortedIds(rowsA)),
  "rows=" + rowsA2.length
);
check("repeat GET still stored 0 assignments", assignmentCount() === 0, "count=" + assignmentCount());

const freshRes = await req("GET", `/api/workspaces/${workspace.id}/callsheet?format=json&date=2026-12-04&perCaller=10&callers=a,b,c`);
check("a new date still returns 13 rows (nothing was used up)", rowsOf(parseJson(freshRes.text)).length === 13, "rows=" + rowsOf(parseJson(freshRes.text)).length);

// ------------------------------------------------------------------ html/csv preview markers while preview

const htmlPreview = await req("GET", `/api/workspaces/${workspace.id}/callsheet?format=html&date=${dateA}&perCaller=10&callers=a,b,c`);
check("preview html carries PREVIEW (not assigned yet)", htmlPreview.status === 200 && htmlPreview.text.includes("PREVIEW (not assigned yet)"), "status=" + htmlPreview.status);
check("preview html notes the sheet is only saved by the assign action", htmlPreview.text.toLowerCase().includes("assign"), "missing assign note");

const csvPreview = await req("GET", `/api/workspaces/${workspace.id}/callsheet?format=csv&date=${dateA}&perCaller=10&callers=a,b,c`);
check("preview csv carries PREVIEW (not assigned yet)", csvPreview.status === 200 && csvPreview.text.includes("PREVIEW (not assigned yet)"), "status=" + csvPreview.status);

// ------------------------------------------------------------------ POST assigns once

const post1 = await req("POST", `/api/workspaces/${workspace.id}/callsheet/assign`, { date: dateA, perCaller: 10, callers: ["a", "b", "c"] });
const post1Body = parseJson(post1.text);
check("POST assign answers 201 with assigned 13", post1.status === 201 && (post1Body?.["assigned"] as number) === 13, `status=${post1.status} body=${post1.text.slice(0, 160)}`);
check("POST stored 13 assignments", assignmentCount() === 13, "count=" + assignmentCount());

const post2 = await req("POST", `/api/workspaces/${workspace.id}/callsheet/assign`, { date: dateA, perCaller: 10, callers: ["a", "b", "c"] });
const post2Body = parseJson(post2.text);
check("second identical POST answers 200 with assigned 0", post2.status === 200 && (post2Body?.["assigned"] as number) === 0, `status=${post2.status} body=${post2.text.slice(0, 160)}`);
check("second POST kept 13 assignments", assignmentCount() === 13, "count=" + assignmentCount());

const getStored = await req("GET", `/api/workspaces/${workspace.id}/callsheet?format=json&date=${dateA}&perCaller=10&callers=a,b,c`);
const bodyStored = parseJson(getStored.text);
const rowsStored = rowsOf(bodyStored);
check("GET stored date has preview false", sheetOf(bodyStored)["preview"] === false, "preview=" + String(sheetOf(bodyStored)["preview"]));
check(
  "GET stored date returns the same rows as the preview",
  rowsStored.length === 13 && JSON.stringify(sortedIds(rowsStored)) === JSON.stringify(sortedIds(rowsA)),
  "rows=" + rowsStored.length
);

const getOther = await req("GET", `/api/workspaces/${workspace.id}/callsheet?format=json&date=2026-12-09&perCaller=10&callers=a,b,c`);
check("GET another date shows 0 callable leads left (they are assigned)", rowsOf(parseJson(getOther.text)).length === 0, "rows=" + rowsOf(parseJson(getOther.text)).length);

const htmlStored = await req("GET", `/api/workspaces/${workspace.id}/callsheet?format=html&date=${dateA}&perCaller=10&callers=a,b,c`);
check("stored html has no preview marker", htmlStored.status === 200 && !htmlStored.text.includes("PREVIEW (not assigned yet)"), "status=" + htmlStored.status);

const csvStored = await req("GET", `/api/workspaces/${workspace.id}/callsheet?format=csv&date=${dateA}&perCaller=10&callers=a,b,c`);
check("stored csv has no preview marker", csvStored.status === 200 && !csvStored.text.includes("PREVIEW (not assigned yet)"), "status=" + csvStored.status);

// ------------------------------------------------------------------ teardown

await new Promise<void>((resolve) => {
  server.close(() => resolve());
  server.closeAllConnections();
});
store.closeDb();
rmSync(ROOT, { recursive: true, force: true });

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
