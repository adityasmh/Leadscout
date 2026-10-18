// src/calls-check.ts
// Order CALL1 proof. Offline: temp database, random port, no network, no model.
// Run: npx tsx src/calls-check.ts
//
// access.ts and compliance.ts open the store database when they are first
// imported, so every leadscout module here is loaded with dynamic import AFTER
// LEADSCOUT_DB points at a temp file. The real data file is never touched.
// No src/company import is used, so the company sandbox import is not needed.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

import type { CallLog, CallOutcome } from "./calls.js";
import type { Lead, Workspace } from "./types.js";

const DB_FILE = join(tmpdir(), `leadscout-calls-check-${randomUUID()}.db`);
process.env.LEADSCOUT_DB = DB_FILE;
process.env.LEADSCOUT_REQUIRE_KEYS = "1";

let store: typeof import("./store.js");
let access: typeof import("./access.js");
let compliance: typeof import("./compliance.js");
let routes: typeof import("./routes-calls.js");

// ------------------------------------------------------------------ harness

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`PASS ${name}`);
    })
    .catch((err: unknown) => {
      failed += 1;
      const message = err instanceof Error ? err.stack ?? err.message : String(err);
      console.log(`FAIL ${name}\n     ${message.split("\n").join("\n     ")}`);
    });
}

// --------------------------------------------------------------- fixtures

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const OVERDUE = iso(NOW - 25 * 60 * 60 * 1000);
const TODAY = iso(NOW - 60 * 1000);

function makeWorkspace(name: string): Workspace {
  return store.createWorkspace({
    name,
    offer: { services: ["website", "automation"], description: "fake offer for checks only" },
    icp: { categories: ["dentist"], cities: ["Fake City"], countries: ["IN"] },
  });
}

function makeLead(ws: string, name: string, score: number, phone: string, status?: Lead["status"]): Lead {
  return store.upsertLead({
    workspaceId: ws,
    name,
    category: "dentist",
    source: "fixture",
    sourceUrl: "https://example.invalid/lead",
    phone,
    score,
    status,
  });
}

// ------------------------------------------------------------------ server

let base = "";
let server: ReturnType<typeof createServer>;

function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void routes
      .handleCallRequest(req, res, url)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "not found" }));
        }
      })
      .catch((err: unknown) => {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

type ApiResult = { status: number; data: unknown; text: string };

async function api(key: string | null, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  let data: unknown = text;
  if (contentType.includes("json") && text !== "") {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = text;
    }
  }
  return { status: res.status, data, text };
}

async function logOk(key: string, ws: string, leadId: string, body: Record<string, unknown>): Promise<CallLog> {
  const res = await api(key, "POST", `/api/workspaces/${ws}/leads/${leadId}/calls`, body);
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${res.text}`);
  return res.data as CallLog;
}

// --------------------------------------------------------------------- run

async function run(): Promise<void> {
  const wsA = makeWorkspace("Fake Workspace A");
  const wsB = makeWorkspace("Fake Workspace B");
  const keyA = access.createApiKey(wsA.id, ["read", "write"]).key;
  const keyB = access.createApiKey(wsB.id, ["read", "write"]).key;

  const alpha = makeLead(wsA.id, "Fake Alpha Dental", 80, "+91 90000 00001");
  makeLead(wsA.id, "Fake Beta Salon", 40, "+91 90000 00002");
  makeLead(wsA.id, "Fake Gamma Gym", 60, "+91 90000 00003");
  const deltaB = makeLead(wsB.id, "Fake Delta Clinic", 90, "+91 90000 00004");

  // A call on B, to prove isolation.
  await logOk(keyB, wsB.id, deltaB.id, { channel: "call", outcome: "no_answer", iSaid: "B only" });

  // 1. registerCallRoutes registers every route via the generic pattern.
  await check("registerCallRoutes registers 6 routes and no DELETE", () => {
    const seen: { method: string; pattern: string }[] = [];
    routes.registerCallRoutes((method, pattern) => seen.push({ method, pattern }));
    assert.equal(seen.length, 6, `expected 6 routes, got ${seen.length}`);
    assert.ok(!seen.some((r) => r.method === "DELETE"), "there must be no DELETE route");
  });

  // 2. logging stores every field and returns the call.
  const first = await logOk(keyA, wsA.id, alpha.id, {
    channel: "call",
    outcome: "interested",
    iSaid: "Hello, I build booking pages for clinics.",
    theySaid: "Send me details, we may need this.",
    nextAction: "Send the deck on Monday",
    followUpAt: TODAY,
    durationSec: 75,
    at: iso(NOW - 5 * 60 * 1000),
  });
  await check("logCall stores all fields and returns the call", () => {
    assert.ok(first.id && typeof first.id === "string");
    assert.equal(first.workspaceId, wsA.id);
    assert.equal(first.leadId, alpha.id);
    assert.equal(first.channel, "call");
    assert.equal(first.outcome, "interested");
    assert.equal(first.iSaid, "Hello, I build booking pages for clinics.");
    assert.equal(first.theySaid, "Send me details, we may need this.");
    assert.equal(first.nextAction, "Send the deck on Monday");
    assert.equal(first.followUpAt, TODAY);
    assert.equal(first.durationSec, 75);
    assert.equal(first.at, iso(NOW - 5 * 60 * 1000));
  });

  // 3. status changes per outcome.
  await check("status mapping per outcome (keep, contacted/replied, won, rejected)", async () => {
    const keepLead = makeLead(wsA.id, "Fake Keep NoAnswer", 10, "+91 90000 00010");
    await logOk(keyA, wsA.id, keepLead.id, { channel: "call", outcome: "no_answer" });
    assert.equal(store.getLead(wsA.id, keepLead.id)?.status, "new", "no_answer keeps status");
    await logOk(keyA, wsA.id, keepLead.id, { channel: "call", outcome: "busy" });
    assert.equal(store.getLead(wsA.id, keepLead.id)?.status, "new", "busy keeps status");

    const cbLead = makeLead(wsA.id, "Fake CallBack", 10, "+91 90000 00011");
    await logOk(keyA, wsA.id, cbLead.id, { channel: "call", outcome: "call_back" });
    assert.equal(store.getLead(wsA.id, cbLead.id)?.status, "contacted", "call_back -> contacted");

    assert.equal(store.getLead(wsA.id, alpha.id)?.status, "replied", "interested -> replied");

    const bookLead = makeLead(wsA.id, "Fake Booked", 10, "+91 90000 00012");
    await logOk(keyA, wsA.id, bookLead.id, { channel: "call", outcome: "meeting_booked" });
    assert.equal(store.getLead(wsA.id, bookLead.id)?.status, "replied", "meeting_booked -> replied");

    const wonLead = makeLead(wsA.id, "Fake Won", 10, "+91 90000 00013");
    await logOk(keyA, wsA.id, wonLead.id, { channel: "call", outcome: "won" });
    assert.equal(store.getLead(wsA.id, wonLead.id)?.status, "won", "won -> won");

    const noLead = makeLead(wsA.id, "Fake NotInterested", 10, "+91 90000 00014");
    await logOk(keyA, wsA.id, noLead.id, { channel: "call", outcome: "not_interested" });
    assert.equal(store.getLead(wsA.id, noLead.id)?.status, "rejected", "not_interested -> rejected");
  });

  // 4. do_not_contact rejects and suppresses; wrong_number rejects too.
  const dncLead = makeLead(wsA.id, "Fake DoNotContact", 10, "+91 90000 00015");
  const dnc = await logOk(keyA, wsA.id, dncLead.id, { channel: "call", outcome: "do_not_contact" });
  await check("do_not_contact rejects the lead and suppresses the phone (module present)", () => {
    assert.equal(store.getLead(wsA.id, dncLead.id)?.status, "rejected");
    const result = compliance.isSuppressed({ phone: dncLead.phone, phones: dncLead.phones }, wsA.id);
    assert.equal(result.suppressed, true, `expected suppression, got ${JSON.stringify(result)}`);
    assert.equal(dnc.outcome, "do_not_contact");
  });

  const wrongLead = makeLead(wsA.id, "Fake WrongNumber", 10, "+91 90000 00016");
  await check("wrong_number rejects the lead", async () => {
    await logOk(keyA, wsA.id, wrongLead.id, { channel: "call", outcome: "wrong_number" });
    assert.equal(store.getLead(wsA.id, wrongLead.id)?.status, "rejected");
  });

  // 5. callsForLead newest first.
  const orderLead = makeLead(wsA.id, "Fake Ordered Calls", 10, "+91 90000 00020");
  await logOk(keyA, wsA.id, orderLead.id, { channel: "call", outcome: "no_answer", at: iso(NOW - 3 * 60 * 60 * 1000) });
  await logOk(keyA, wsA.id, orderLead.id, { channel: "whatsapp", outcome: "no_answer", at: iso(NOW - 2 * 60 * 60 * 1000) });
  await logOk(keyA, wsA.id, orderLead.id, { channel: "call", outcome: "interested", at: iso(NOW - 1 * 60 * 60 * 1000) });
  await check("callsForLead returns newest first", async () => {
    const res = await api(keyA, "GET", `/api/workspaces/${wsA.id}/leads/${orderLead.id}/calls`);
    assert.equal(res.status, 200);
    const calls = (res.data as { calls: CallLog[] }).calls;
    assert.equal(calls.length, 3);
    assert.equal(calls[0].at, iso(NOW - 1 * 60 * 60 * 1000));
    assert.equal(calls[1].at, iso(NOW - 2 * 60 * 60 * 1000));
    assert.equal(calls[2].at, iso(NOW - 3 * 60 * 60 * 1000));
  });

  // 6. queue: overdue and today's follow-ups before never-called, by score.
  const wsQ = makeWorkspace("Fake Queue Workspace");
  const keyQ = access.createApiKey(wsQ.id, ["read", "write"]).key;
  const qOverdue = makeLead(wsQ.id, "Fake Queue Overdue", 5, "+91 90000 00100");
  const qToday = makeLead(wsQ.id, "Fake Queue Today", 5, "+91 90000 00101");
  const qNewHigh = makeLead(wsQ.id, "Fake Queue New High", 90, "+91 90000 00102");
  const qNewMid = makeLead(wsQ.id, "Fake Queue New Mid", 60, "+91 90000 00103");
  const qNewLow = makeLead(wsQ.id, "Fake Queue New Low", 30, "+91 90000 00104");
  await logOk(keyQ, wsQ.id, qOverdue.id, { channel: "call", outcome: "call_back", followUpAt: OVERDUE });
  await logOk(keyQ, wsQ.id, qToday.id, { channel: "call", outcome: "call_back", followUpAt: TODAY });
  await check("queue orders overdue/today follow-ups before new leads, new by score", async () => {
    const res = await api(keyQ, "GET", `/api/workspaces/${wsQ.id}/call-queue`);
    assert.equal(res.status, 200);
    const queue = (res.data as { queue: { lead: Lead; kind: string; reason: string }[] }).queue;
    const ids = queue.map((entry) => entry.lead.id);
    assert.deepEqual(ids.slice(0, 2), [qOverdue.id, qToday.id], "overdue then today's follow-up come first");
    assert.equal(queue[0].kind, "follow_up");
    assert.ok(queue[0].reason.includes(OVERDUE), "reason names the follow-up date");
    const neverIds = ids.slice(2);
    assert.deepEqual(neverIds, [qNewHigh.id, qNewMid.id, qNewLow.id], "never-called leads ordered by score desc");
    assert.ok(queue[2].reason.includes("score 90"), "reason carries the score");
  });

  // 7. stats arithmetic on a 12-call fixture.
  const wsS = makeWorkspace("Fake Stats Workspace");
  const keyS = access.createApiKey(wsS.id, ["read", "write"]).key;
  const statLead = makeLead(wsS.id, "Fake Stats Lead", 50, "+91 90000 00200");
  const outcomes: CallOutcome[] = [
    "no_answer", "busy", "wrong_number", "not_interested",
    "call_back", "call_back", "interested", "interested",
    "meeting_booked", "meeting_booked", "won", "do_not_contact",
  ];
  const statBase = NOW - 30 * 60 * 1000;
  for (let i = 0; i < outcomes.length; i += 1) {
    await logOk(keyS, wsS.id, statLead.id, {
      channel: "call",
      outcome: outcomes[i],
      at: iso(statBase + i * 60 * 1000),
    });
  }
  await check("stats arithmetic on a 12-call fixture", async () => {
    const from = iso(statBase - 60 * 1000);
    const to = iso(statBase + 60 * 60 * 1000);
    const res = await api(keyS, "GET", `/api/workspaces/${wsS.id}/call-stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    assert.equal(res.status, 200);
    const s = res.data as { calls: number; reached: number; interested: number; booked: number; byOutcome: Record<string, number> };
    assert.equal(s.calls, 12);
    assert.equal(s.reached, 9, "reached excludes no_answer, busy, wrong_number");
    assert.equal(s.interested, 2);
    assert.equal(s.booked, 3, "meeting_booked x2 + won x1");
    assert.equal(s.byOutcome.call_back, 2);
    assert.equal(s.byOutcome.meeting_booked, 2);
    assert.equal(s.byOutcome.no_answer, 1);
    assert.equal(s.byOutcome.do_not_contact, 1);
  });

  // 8. CSV: header row, quoting of commas/newlines, every field present.
  const wsC = makeWorkspace("Fake Csv Workspace");
  const keyC = access.createApiKey(wsC.id, ["read", "write"]).key;
  const csvLead = makeLead(wsC.id, "Fake Csv Lead, Inc.", 50, "+91 90000 00300");
  await logOk(keyC, wsC.id, csvLead.id, {
    channel: "call",
    outcome: "interested",
    iSaid: "I said: hello, are you free?",
    theySaid: "They said:\ncall next week, please.",
    nextAction: "Call on Monday",
    at: iso(NOW - 60 * 1000),
  });
  await check("CSV has a header, quotes commas/newlines and carries every field", async () => {
    const res = await api(keyC, "GET", `/api/workspaces/${wsC.id}/calls.csv`);
    assert.equal(res.status, 200);
    assert.ok(res.text.startsWith("lead_name,phone,at,outcome,i_said,they_said,next_action\n"), `bad header: ${res.text.slice(0, 80)}`);
    assert.ok(res.text.includes('"Fake Csv Lead, Inc."'), "name with a comma is quoted");
    assert.ok(res.text.includes('"I said: hello, are you free?"'), "i_said with a comma is quoted");
    assert.ok(res.text.includes('"They said:\ncall next week, please."'), "they_said with a newline is quoted");
    assert.ok(res.text.includes("+91 90000 00300"), "phone present");
    assert.ok(res.text.includes("interested"), "outcome present");
    assert.ok(res.text.includes("Call on Monday"), "next_action present");
  });

  // 9. over-long text is trimmed to 4000 characters.
  await check("input over 4000 characters is trimmed", async () => {
    const long = "x".repeat(5000);
    const call = await logOk(keyA, wsA.id, orderLead.id, { channel: "call", outcome: "no_answer", iSaid: long, theySaid: long });
    assert.equal(call.iSaid.length, 4000);
    assert.equal(call.theySaid.length, 4000);
  });

  // 10. invalid input is a clean 400 (never a crash).
  await check("invalid channel/outcome answer 400", async () => {
    const bad1 = await api(keyA, "POST", `/api/workspaces/${wsA.id}/leads/${alpha.id}/calls`, { channel: "smoke-signal", outcome: "interested" });
    assert.equal(bad1.status, 400, bad1.text);
    const bad2 = await api(keyA, "POST", `/api/workspaces/${wsA.id}/leads/${alpha.id}/calls`, { channel: "call", outcome: "maybe" });
    assert.equal(bad2.status, 400, bad2.text);
  });

  // 11. PATCH edits a log entry; DELETE is refused (no such route).
  await check("PATCH edits a call and DELETE is not provided", async () => {
    const patched = await api(keyA, "PATCH", `/api/workspaces/${wsA.id}/calls/${first.id}`, { iSaid: "Edited pitch text", nextAction: "Edited next step" });
    assert.equal(patched.status, 200, patched.text);
    const updated = patched.data as CallLog;
    assert.equal(updated.iSaid, "Edited pitch text");
    assert.equal(updated.nextAction, "Edited next step");
    assert.equal(updated.outcome, "interested", "outcome unchanged");
    const del = await api(keyA, "DELETE", `/api/workspaces/${wsA.id}/calls/${first.id}`);
    assert.equal(del.status, 404, `DELETE must not be provided (got ${del.status})`);
  });

  // 12. missing key is refused.
  await check("a missing key is refused with 401", async () => {
    const res = await api(null, "GET", `/api/workspaces/${wsA.id}/call-queue`);
    assert.equal(res.status, 401, res.text);
  });

  // 13. two workspaces never see each other's calls.
  await check("two workspaces never see each other's calls", async () => {
    const aCalls = await api(keyA, "GET", `/api/workspaces/${wsA.id}/leads/${alpha.id}/calls`);
    assert.equal(aCalls.status, 200);
    const aList = (aCalls.data as { calls: CallLog[] }).calls;
    assert.ok(aList.every((c) => c.workspaceId === wsA.id));

    const bCalls = await api(keyB, "GET", `/api/workspaces/${wsB.id}/leads/${deltaB.id}/calls`);
    const bList = (bCalls.data as { calls: CallLog[] }).calls;
    assert.equal(bList.length, 1);
    assert.ok(!bList.some((c) => c.leadId === alpha.id));

    const aCsv = await api(keyA, "GET", `/api/workspaces/${wsA.id}/calls.csv`);
    assert.ok(!aCsv.text.includes("Fake Delta Clinic"), "A's CSV must not contain B's lead");

    const crossing = await api(keyB, "GET", `/api/workspaces/${wsA.id}/call-queue`);
    assert.equal(crossing.status, 403, `B's key on A must be refused (got ${crossing.status})`);
  });

  // 14. call on a lead in another workspace is refused.
  await check("logging a call on a foreign lead is refused", async () => {
    const res = await api(keyA, "POST", `/api/workspaces/${wsA.id}/leads/${deltaB.id}/calls`, { channel: "call", outcome: "interested" });
    assert.equal(res.status, 400, res.text);
  });
}

async function main(): Promise<void> {
  store = await import("./store.js");
  access = await import("./access.js");
  compliance = await import("./compliance.js");
  routes = await import("./routes-calls.js");
  await startServer();
  try {
    await run();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.closeDb();
    for (const file of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
      if (existsSync(file)) {
        try {
          rmSync(file, { force: true });
        } catch {
          // best effort
        }
      }
    }
  }
  console.log(`\ncalls-check: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  else console.log("calls-check: PASS");
}

void main();
