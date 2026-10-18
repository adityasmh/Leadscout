// src/delivery-hook-check.ts
// Order LG3-hook-delivery proof. Offline: LEADSCOUT_DB points at a temp file set BEFORE any
// module that opens the database is imported, the real server (server.ts) is started
// in-process on a random port, a workspace and 5 clearly fake leads are imported (3 with
// valid phones), and the call-sheet routes are exercised through the server hook:
//   GET  /api/workspaces/:ws/callsheet?format=json|csv|html
//   POST /api/workspaces/:ws/callsheet/assign
// plus the 404 for an unknown workspace. No network beyond 127.0.0.1, no model, no router.
// Run once: npx tsx src/delivery-hook-check.ts
//
// This check does NOT import src/company/, so the sandbox root import (PITFALLS 1) is not
// needed. The live database data/ is never opened: the DND folder is
// redirected to a temp path that does not exist (so nothing under data/ is read) and the
// database path is a temp file.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? ": " + detail : ""));
  if (!condition) failed = true;
}

const ROOT = mkdtempSync(join(tmpdir(), "leadscout-delivery-hook-"));
process.env.LEADSCOUT_DB = join(ROOT, "check.db");
delete process.env.LEADSCOUT_REQUIRE_KEYS;
process.env.LEADSCOUT_DND_DIR = join(ROOT, "no-dnd-here"); // keep gate.ts off data/
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

function parseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ fixtures

const workspace = store.createWorkspace({
  name: "Fake Delivery Workspace",
  offer: { services: ["website", "automation"], description: "fake offer for offline checks only" },
  icp: { categories: ["dentist"], cities: ["Fake Town"], countries: ["IN"] },
});
check("workspace created with a temp database", typeof workspace.id === "string" && workspace.id.length > 0);

const common = {
  workspaceId: workspace.id,
  category: "dentist",
  city: "Fake Town",
  source: "fixture",
  sourceUrl: "https://example-delivery.test/fixture",
  summary: "clearly fake fixture for offline checks",
  gate: "template",
};
store.upsertLead({ ...common, name: "Fake Delivery One", phone: "+919000000001", score: 70 });
store.upsertLead({ ...common, name: "Fake Delivery Two", phone: "+919000000002", score: 60 });
store.upsertLead({ ...common, name: "Fake Delivery Three", phone: "+919000000003", score: 50 });
store.upsertLead({ ...common, name: "Fake Delivery Four", score: 40 });
store.upsertLead({ ...common, name: "Fake Delivery Five", score: 30 });
check(
  "5 clearly fake leads imported (3 with phones)",
  store.listLeads({ workspaceId: workspace.id, limit: 10, offset: 0 }).total === 5
);

const sheetDate = "2026-10-20";

// ------------------------------------------------------------------ format=json

const jsonRes = await req(
  "GET",
  `/api/workspaces/${workspace.id}/callsheet?format=json&date=${sheetDate}`
);
check("GET callsheet?format=json answers 200", jsonRes.status === 200, "status=" + jsonRes.status);
const sheetRows: any[] = parseJson(jsonRes.text)?.sheet?.rows ?? [];
check("format=json returns exactly the 3 callable leads", sheetRows.length === 3, "rows=" + sheetRows.length);
check(
  "every callable row carries a phone and a tel: value",
  sheetRows.length === 3 && sheetRows.every((r) => typeof r.tel === "string" && r.tel.startsWith("tel:+91")),
  JSON.stringify(sheetRows.map((r) => r.tel))
);
const names: string[] = sheetRows.map((r) => String(r.name));
check(
  "the 2 phone-less leads are excluded from the sheet",
  !names.includes("Fake Delivery Four") && !names.includes("Fake Delivery Five"),
  JSON.stringify(names)
);

// ------------------------------------------------------------------ format=csv

const csvRes = await req(
  "GET",
  `/api/workspaces/${workspace.id}/callsheet?format=csv&date=${sheetDate}`
);
check(
  "GET callsheet?format=csv answers 200 as text/csv",
  csvRes.status === 200 && csvRes.contentType.includes("text/csv"),
  `status=${csvRes.status} type=${csvRes.contentType}`
);
const header = (csvRes.text.split(/\r?\n/)[0] ?? "").trim();
check("format=csv starts with a header row", header.startsWith("caller,date,name"), header);
check(
  "format=csv renders the callable leads with tel: values",
  csvRes.text.includes("tel:+919000000001") && csvRes.text.includes("Fake Delivery One"),
  ""
);

// ------------------------------------------------------------------ format=html

const htmlRes = await req(
  "GET",
  `/api/workspaces/${workspace.id}/callsheet?format=html&date=${sheetDate}`
);
check(
  "GET callsheet?format=html answers 200 as text/html",
  htmlRes.status === 200 && htmlRes.contentType.includes("text/html"),
  `status=${htmlRes.status} type=${htmlRes.contentType}`
);
check(
  "format=html contains tel: links",
  htmlRes.text.includes('href="tel:+919000000001"'),
  ""
);

// ------------------------------------------------------------------ POST assign persists

const postWs = store.createWorkspace({
  name: "Fake Delivery Post Workspace",
  offer: { services: ["website"], description: "fake offer for offline checks only" },
  icp: { categories: ["dentist"], cities: ["Fake Town"], countries: ["IN"] },
});
const postCommon = {
  workspaceId: postWs.id,
  category: "dentist",
  city: "Fake Town",
  source: "fixture",
  sourceUrl: "https://example-delivery.test/post",
  summary: "clearly fake fixture for offline checks",
  gate: "template",
};
store.upsertLead({ ...postCommon, name: "Fake Post One", phone: "+919000000011", score: 55 });
store.upsertLead({ ...postCommon, name: "Fake Post Two", phone: "+919000000012", score: 45 });

const postDate = "2026-10-21";
const postRes = await req(
  "POST",
  `/api/workspaces/${postWs.id}/callsheet/assign`,
  { date: postDate }
);
check("POST callsheet/assign answers 201", postRes.status === 201, "status=" + postRes.status);
const postBody = parseJson(postRes.text);
check("POST callsheet/assign reports 2 rows", postBody?.rows === 2, JSON.stringify(postBody));

const afterPost = await req(
  "GET",
  `/api/workspaces/${postWs.id}/callsheet?format=json&date=${postDate}`
);
const afterRows: any[] = parseJson(afterPost.text)?.sheet?.rows ?? [];
check(
  "follow-up GET returns the 2 persisted assignments",
  afterPost.status === 200 && afterRows.length === 2,
  `status=${afterPost.status} rows=${afterRows.length}`
);
const nextDay = await req(
  "GET",
  `/api/workspaces/${postWs.id}/callsheet?format=json&date=2026-10-22`
);
const nextRows: any[] = parseJson(nextDay.text)?.sheet?.rows ?? [];
check(
  "a later date has no leads left (the POST assignments persisted)",
  nextRows.length === 0,
  "rows=" + nextRows.length
);

// ------------------------------------------------------------------ unknown workspace

const missing = await req("GET", "/api/workspaces/this-workspace-does-not-exist/callsheet?format=json");
check("unknown workspace answers 404", missing.status === 404, "status=" + missing.status);

// ------------------------------------------------------------------ teardown

await new Promise<void>((resolve) => {
  server.close(() => resolve());
  server.closeAllConnections();
});
store.closeDb();
rmSync(ROOT, { recursive: true, force: true });

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
