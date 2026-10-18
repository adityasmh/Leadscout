// src/callsheet-callers-check.ts
// Order CS1-callsheet-callers proof. Offline: LEADSCOUT_DB points at a temp file set
// BEFORE any module that opens the database is imported, the real server (server.ts) is
// started in-process on a random port, workspaces with 13 clearly fake callable leads and
// 3 leads without a phone are imported, and the call-sheet routes are exercised through
// the server hook:
//   GET /api/workspaces/:ws/callsheet?format=json|csv|html&perCaller=&callers=
// plus HTTP 400 for bad perCaller/callers and the DND flag with/without a temp DND file.
// No network beyond 127.0.0.1, no model, no router.
// Run once: npx tsx src/callsheet-callers-check.ts
//
// This check does NOT import src/company/, so the sandbox root import (PITFALLS 1) is not
// needed. The live database data/ is never opened: the DND folder is
// redirected to a temp path and the database path is a temp file.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? ": " + detail : ""));
  if (!condition) failed = true;
}

const ROOT = mkdtempSync(join(tmpdir(), "leadscout-callsheet-callers-"));
process.env.LEADSCOUT_DB = join(ROOT, "check.db");
delete process.env.LEADSCOUT_REQUIRE_KEYS;
process.env.LEADSCOUT_DND_DIR = join(ROOT, "no-dnd-here"); // nothing under data/ is read
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

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) return count;
    count += 1;
    from = found + needle.length;
  }
}

/** Counts tel: links inside one caller's html section (heading carries the real count). */
function sectionTelCount(html: string, caller: string, expected: number): boolean {
  const head = html.indexOf(`>${caller} (${expected})<`);
  if (head < 0) return false;
  const end = html.indexOf("</section>", head);
  if (end < 0) return false;
  return countOccurrences(html.slice(head, end), "tel:+1555") === expected;
}

/** Counts rows per caller name in a json sheet. */
function callerCounts(rows: Record<string, unknown>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const caller = strOf(row["caller"]);
    counts.set(caller, (counts.get(caller) ?? 0) + 1);
  }
  return counts;
}

/** A workspace with 13 clearly fake callable leads (distinct scores) + 3 without a phone. */
function makeCallerWorkspace(name: string): { id: string; dndPhone: string } {
  const workspace = store.createWorkspace({
    name,
    offer: { services: ["website", "automation"], description: "fake offer for offline checks only" },
    icp: { categories: ["dentist"], cities: ["Fake Town"], countries: ["IN"] },
  });
  const common = {
    workspaceId: workspace.id,
    category: "dentist",
    city: "Fake Town",
    source: "fixture",
    sourceUrl: "https://example-callsheet.test/fixture",
    summary: "clearly fake fixture for offline checks",
    gate: "template" as const,
  };
  let dndPhone = "";
  for (let i = 0; i < 13; i += 1) {
    const phone = `+${String(15550000101 + i)}`;
    if (i === 0) dndPhone = phone;
    store.upsertLead({
      ...common,
      name: `Fake Callsheet Biz ${String(i + 1).padStart(2, "0")}`,
      phone,
      score: 90 - i,
    });
  }
  for (let i = 0; i < 3; i += 1) {
    store.upsertLead({ ...common, name: `Fake Callsheet NoPhone ${i + 1}`, score: 10 + i });
  }
  return { id: workspace.id, dndPhone };
}

// ------------------------------------------------------------------ main split

const wsA = makeCallerWorkspace("Fake Callsheet Workspace A");
check("workspace A imported (13 callable + 3 phone-less)", wsA.id.length > 0);

const dateA = "2026-11-01";
const jsonRes = await req(
  "GET",
  `/api/workspaces/${wsA.id}/callsheet?format=json&date=${dateA}&perCaller=10&callers=a,b,c`
);
check("json callers=a,b,c perCaller=10 answers 200", jsonRes.status === 200, "status=" + jsonRes.status);
const jsonBody = parseJson(jsonRes.text);
const jsonRows = rowsOf(jsonBody);
check("json sheet has 13 rows for 13 callable leads", jsonRows.length === 13, "rows=" + jsonRows.length);
const perCallerOf = sheetOf(jsonBody)["perCaller"];
const callersOf = sheetOf(jsonBody)["callers"];
check(
  "json sheet echoes perCaller=10 and callers a,b,c",
  perCallerOf === 10 && Array.isArray(callersOf) && (callersOf as unknown[]).join(",") === "a,b,c",
  `perCaller=${String(perCallerOf)} callers=${JSON.stringify(callersOf)}`
);
const byCaller = new Map<string, number>();
for (const row of jsonRows) byCaller.set(strOf(row["caller"]), (byCaller.get(strOf(row["caller"])) ?? 0) + 1);
check(
  "json rows split 5,4,4 across a,b,c (round-robin, differ by at most one)",
  byCaller.get("a") === 5 && byCaller.get("b") === 4 && byCaller.get("c") === 4,
  JSON.stringify([...byCaller])
);
const leadIds = jsonRows.map((row) => strOf(row["leadId"]));
check("json rows never assign one lead twice", new Set(leadIds).size === 13, `unique=${new Set(leadIds).size}`);
check(
  "every json row caller is one of the names given",
  jsonRows.length === 13 && jsonRows.every((row) => ["a", "b", "c"].includes(strOf(row["caller"]))),
  JSON.stringify(jsonRows.map((row) => row["caller"]))
);
const rowNames = jsonRows.map((row) => strOf(row["name"]));
check(
  "the 3 phone-less leads are excluded from the sheet",
  !rowNames.some((name) => name.includes("NoPhone")),
  JSON.stringify(rowNames)
);
check(
  "dndChecked is false when no data/dnd/*.csv was loaded",
  sheetOf(jsonBody)["dndChecked"] === false,
  "dndChecked=" + String(sheetOf(jsonBody)["dndChecked"])
);
check(
  "rows keep the dnd-unchecked tag when no DND file was loaded",
  jsonRows.length === 13 &&
    jsonRows.every((row) => Array.isArray(row["tags"]) && (row["tags"] as unknown[]).includes("dnd-unchecked")),
  JSON.stringify(jsonRows[0]?.["tags"])
);

// ------------------------------------------------------------------ perCaller cap

const wsB = makeCallerWorkspace("Fake Callsheet Workspace B");
const capRes = await req(
  "GET",
  `/api/workspaces/${wsB.id}/callsheet?format=json&date=2026-11-02&perCaller=2&callers=a,b,c`
);
const capRows = rowsOf(parseJson(capRes.text));
check("perCaller=2 with 3 callers gives 6 rows", capRes.status === 200 && capRows.length === 6, "rows=" + capRows.length);
const capByCaller = new Map<string, number>();
for (const row of capRows) capByCaller.set(strOf(row["caller"]), (capByCaller.get(strOf(row["caller"])) ?? 0) + 1);
check(
  "perCaller=2 rows split 2,2,2",
  capByCaller.get("a") === 2 && capByCaller.get("b") === 2 && capByCaller.get("c") === 2,
  JSON.stringify([...capByCaller])
);
const capIds = capRows.map((row) => strOf(row["leadId"]));
check(
  "perCaller=2 rows never assign one lead twice",
  capRows.length === 6 && new Set(capIds).size === 6,
  `unique=${new Set(capIds).size}`
);

// ------------------------------------------------------------------ html groups

const htmlRes = await req(
  "GET",
  `/api/workspaces/${wsA.id}/callsheet?format=html&date=${dateA}&perCaller=10&callers=a,b,c`
);
check(
  "html answers 200 as text/html",
  htmlRes.status === 200 && htmlRes.contentType.includes("text/html"),
  `status=${htmlRes.status} type=${htmlRes.contentType}`
);
check("html heading shows a (5)", htmlRes.text.includes("a (5)"), "");
check("html heading shows b (4)", htmlRes.text.includes("b (4)"), "");
check("html heading shows c (4)", htmlRes.text.includes("c (4)"), "");
check(
  "html contains 13 tel: links (one per row)",
  countOccurrences(htmlRes.text, "tel:+1555") === 13,
  "telCount=" + countOccurrences(htmlRes.text, "tel:+1555")
);
check("html section a holds its own 5 tel: links", sectionTelCount(htmlRes.text, "a", 5), "");
check("html section b holds its own 4 tel: links", sectionTelCount(htmlRes.text, "b", 4), "");
check("html section c holds its own 4 tel: links", sectionTelCount(htmlRes.text, "c", 4), "");

// ------------------------------------------------------------------ csv column

const csvRes = await req(
  "GET",
  `/api/workspaces/${wsA.id}/callsheet?format=csv&date=${dateA}&perCaller=10&callers=a,b,c`
);
check(
  "csv answers 200 as text/csv",
  csvRes.status === 200 && csvRes.contentType.includes("text/csv"),
  `status=${csvRes.status} type=${csvRes.contentType}`
);
const csvLines = csvRes.text.split(/\r?\n/).filter((line) => line.trim() !== "");
const csvBase = "caller,date,name,area,phone,tel,say_this,top_service,evidence,tags,score,lead_id";
const csvAssignRes = await req("POST", `/api/workspaces/${wsA.id}/callsheet/assign`, {
  date: dateA,
  perCaller: 10,
  callers: ["a", "b", "c"],
});
const csvStoredRes = await req(
  "GET",
  `/api/workspaces/${wsA.id}/callsheet?format=csv&date=${dateA}&perCaller=10&callers=a,b,c`
);
const csvStoredLines = csvStoredRes.text.split(/\r?\n/).filter((line) => line.trim() !== "");
const csvStoredHeader = csvStoredLines[0] ?? "";
const csvPreviewHeader = csvLines[0] ?? "";
check(
  "csv starts with a caller column",
  csvAssignRes.status === 201 &&
    csvStoredRes.status === 200 &&
    csvPreviewHeader.startsWith(csvBase) &&
    csvStoredHeader.startsWith(csvBase) &&
    csvPreviewHeader === `${csvBase},preview` &&
    csvStoredHeader === csvBase,
  `preview=${csvPreviewHeader} stored=${csvStoredHeader} assign=${csvAssignRes.status}`
);
check(
  "csv carries the caller names on 13 data rows",
  csvLines.length === 14 &&
    csvLines.slice(1).every((line) => line.startsWith("a,") || line.startsWith("b,") || line.startsWith("c,")),
  "lines=" + csvLines.length
);

// ------------------------------------------------------------------ no double date

const laterAssignRes = await req("POST", `/api/workspaces/${wsA.id}/callsheet/assign`, {
  date: dateA,
  perCaller: 10,
  callers: ["a", "b", "c"],
});
const laterRes = await req("GET", `/api/workspaces/${wsA.id}/callsheet?format=json&date=2026-11-05`);
const laterRows = rowsOf(parseJson(laterRes.text));
check(
  "a later date has no leads left (assignment memory kept)",
  laterRes.status === 200 && laterRows.length === 0,
  "rows=" + laterRows.length
);

// ------------------------------------------------------------------ 400s

const wsC = store.createWorkspace({
  name: "Fake Callsheet Workspace C",
  offer: { services: ["website"], description: "fake offer for offline checks only" },
  icp: { categories: ["dentist"], cities: ["Fake Town"], countries: ["IN"] },
});
const badZero = await req("GET", `/api/workspaces/${wsC.id}/callsheet?format=json&perCaller=0`);
check("perCaller=0 answers HTTP 400 with a plain message", badZero.status === 400 && badZero.text.includes("perCaller"), `status=${badZero.status} body=${badZero.text.slice(0, 120)}`);
const badAbc = await req("GET", `/api/workspaces/${wsC.id}/callsheet?format=json&perCaller=abc`);
check("perCaller=abc answers HTTP 400 with a plain message", badAbc.status === 400 && badAbc.text.includes("perCaller"), `status=${badAbc.status} body=${badAbc.text.slice(0, 120)}`);
const manyCallers = Array.from({ length: 21 }, (_, i) => `c${i + 1}`).join(",");
const badMany = await req("GET", `/api/workspaces/${wsC.id}/callsheet?format=json&callers=${manyCallers}`);
check("21 callers answer HTTP 400 with a plain message", badMany.status === 400 && badMany.text.includes("caller"), `status=${badMany.status} body=${badMany.text.slice(0, 120)}`);
const badBig = await req("GET", `/api/workspaces/${wsC.id}/callsheet?format=json&perCaller=101`);
check("perCaller=101 answers HTTP 400 (maximum 100)", badBig.status === 400, `status=${badBig.status}`);
const badFrac = await req("GET", `/api/workspaces/${wsC.id}/callsheet?format=json&perCaller=2.5`);
check("perCaller=2.5 answers HTTP 400 with a plain message", badFrac.status === 400 && badFrac.text.includes("perCaller"), `status=${badFrac.status} body=${badFrac.text.slice(0, 120)}`);

// ------------------------------------------------------------------ same date twice, then a second date

const wsI = makeCallerWorkspace("Fake Callsheet Workspace I");
const day1aRes = await req("GET", `/api/workspaces/${wsI.id}/callsheet?format=json&date=2026-11-11&perCaller=2&callers=a,b`);
const day1aRows = rowsOf(parseJson(day1aRes.text));
const day1bRows = rowsOf(
  parseJson((await req("GET", `/api/workspaces/${wsI.id}/callsheet?format=json&date=2026-11-11&perCaller=2&callers=a,b`)).text)
);
const day1aIds = day1aRows.map((row) => strOf(row["leadId"])).sort();
const day1bIds = day1bRows.map((row) => strOf(row["leadId"])).sort();
check(
  "same sheet twice for one date returns the same 4 leads",
  day1aRes.status === 200 && day1aRows.length === 4 && JSON.stringify(day1aIds) === JSON.stringify(day1bIds),
  `rows=${day1aRows.length}`
);
const day1AssignRes = await req("POST", `/api/workspaces/${wsI.id}/callsheet/assign`, {
  date: "2026-11-11",
  perCaller: 2,
  callers: ["a", "b"],
});
const day2Rows = rowsOf(
  parseJson((await req("GET", `/api/workspaces/${wsI.id}/callsheet?format=json&date=2026-11-12&perCaller=2&callers=a,b`)).text)
);
const day2Ids = day2Rows.map((row) => strOf(row["leadId"]));
check(
  "a second date uses only different leads (no lead on both dates)",
  day2Rows.length === 4 &&
    new Set(day2Ids).size === 4 &&
    day2Ids.every((id) => !day1aIds.includes(id)),
  `rows=${day2Rows.length}`
);

// ------------------------------------------------------------------ query edges

const wsE = makeCallerWorkspace("Fake Callsheet Workspace E");
const emptyCallers = await req("GET", `/api/workspaces/${wsE.id}/callsheet?format=json&date=2026-11-07&callers=`);
const emptyBody = parseJson(emptyCallers.text);
check(
  "empty callers falls back to the default Caller 1",
  emptyCallers.status === 200 &&
    JSON.stringify(sheetOf(emptyBody)["callers"]) === `["Caller 1"]` &&
    rowsOf(emptyBody).every((row) => strOf(row["caller"]) === "Caller 1"),
  `status=${emptyCallers.status} callers=${JSON.stringify(sheetOf(emptyBody)["callers"])}`
);

const wsF = makeCallerWorkspace("Fake Callsheet Workspace F");
const spaceRes = await req(
  "GET",
  `/api/workspaces/${wsF.id}/callsheet?format=json&date=2026-11-08&perCaller=10&callers=%20,a,,%20%20,b,`
);
const spaceRows = rowsOf(parseJson(spaceRes.text));
check(
  "whitespace/empty caller entries are trimmed and dropped",
  spaceRes.status === 200 &&
    spaceRows.length === 13 &&
    spaceRows.every((row) => ["a", "b"].includes(strOf(row["caller"]))),
  `status=${spaceRes.status} rows=${spaceRows.length}`
);
const spaceCounts = callerCounts(spaceRows);
check(
  "trimmed callers a,b split 7,6 (round-robin remainder)",
  spaceCounts.get("a") === 7 && spaceCounts.get("b") === 6,
  JSON.stringify([...spaceCounts])
);

const wsH = makeCallerWorkspace("Fake Callsheet Workspace H");
const defRes = await req("GET", `/api/workspaces/${wsH.id}/callsheet?format=json&date=2026-11-10`);
const defBody = parseJson(defRes.text);
const defRows = rowsOf(defBody);
check(
  "no params defaults to Caller 1 with at most 10 rows",
  defRes.status === 200 &&
    JSON.stringify(sheetOf(defBody)["callers"]) === `["Caller 1"]` &&
    defRows.length === 10 &&
    defRows.every((row) => strOf(row["caller"]) === "Caller 1"),
  `status=${defRes.status} rows=${defRows.length} callers=${JSON.stringify(sheetOf(defBody)["callers"])}`
);

// ------------------------------------------------------------------ POST body

const wsG = makeCallerWorkspace("Fake Callsheet Workspace G");
const postOk = await req("POST", `/api/workspaces/${wsG.id}/callsheet/assign`, {
  date: "2026-11-09",
  perCaller: 2,
  callers: ["x", "y"],
});
const postOkBody = parseJson(postOk.text);
check(
  "POST assign honours body perCaller and callers (2 x 2 = 4)",
  postOk.status === 201 && (postOkBody?.["rows"] as number) === 4,
  `status=${postOk.status} body=${postOk.text.slice(0, 160)}`
);
const postStr = await req("POST", `/api/workspaces/${wsC.id}/callsheet/assign`, { perCaller: "abc" });
check("POST perCaller \"abc\" answers HTTP 400", postStr.status === 400 && postStr.text.includes("perCaller"), `status=${postStr.status} body=${postStr.text.slice(0, 120)}`);
const postZero = await req("POST", `/api/workspaces/${wsC.id}/callsheet/assign`, { perCaller: 0 });
check("POST perCaller 0 answers HTTP 400", postZero.status === 400, `status=${postZero.status}`);

// ------------------------------------------------------------------ DND flag

const wsD = makeCallerWorkspace("Fake Callsheet Workspace D");
const dndDir = join(ROOT, "dnd");
mkdirSync(dndDir, { recursive: true });
writeFileSync(join(dndDir, "operator-export.csv"), `phone\n${wsD.dndPhone}\n`, "utf8");
process.env.LEADSCOUT_DND_DIR = dndDir;
const dndRes = await req("GET", `/api/workspaces/${wsD.id}/callsheet?format=json&date=2026-11-06&perCaller=10&callers=a,b,c`);
const dndBody = parseJson(dndRes.text);
const dndRows = rowsOf(dndBody);
check("with a DND file the sheet has 12 rows (one number excluded)", dndRows.length === 12, "rows=" + dndRows.length);
check("with a DND file dndChecked is true", sheetOf(dndBody)["dndChecked"] === true, "dndChecked=" + String(sheetOf(dndBody)["dndChecked"]));
check("with a DND file dndExcluded counts the listed number", sheetOf(dndBody)["dndExcluded"] === 1, "dndExcluded=" + String(sheetOf(dndBody)["dndExcluded"]));
check(
  "the DND-listed number is excluded from the rows",
  !dndRows.some((row) => strOf(row["phone"]) === wsD.dndPhone),
  wsD.dndPhone
);

// ------------------------------------------------------------------ teardown

await new Promise<void>((resolve) => {
  server.close(() => resolve());
  server.closeAllConnections();
});
store.closeDb();
rmSync(ROOT, { recursive: true, force: true });

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
