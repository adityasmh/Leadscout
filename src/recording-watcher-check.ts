// src/recording-watcher-check.ts
// Order CALL4 proof. Fully offline: a temp database, temp recording folders, a
// fake transcribe function and a fake model function. No audio engine, no network,
// no model. This file does not import from src/company/, so the company sandbox
// import is not required.
//
// Run: npx tsx src/recording-watcher-check.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { polishNote, type PolishedNote } from "./call-notes.js";
import type { LlmFn } from "./types-v2.js";
import type { TranscribeResult, TranscribeSegment } from "./transcribe.js";
import type { CallNote, CallNoteRequestCtx, CallNoteReply } from "./routes-callnotes.js";
import type { Lead, Workspace } from "./types.js";

const TMP = mkdtempSync(join(tmpdir(), "leadscout-recording-watcher-check-"));
const DB_FILE = join(TMP, "check.db");
process.env.LEADSCOUT_DB = DB_FILE;
delete process.env.LEADSCOUT_REQUIRE_KEYS;
delete process.env.LEADSCOUT_KEEP_AUDIO;
delete process.env.LEADSCOUT_RECORDINGS_DIR;
delete process.env.LEADSCOUT_TRANSCRIBE_CLOUD;
delete process.env.GROQ_API_KEY;

// Lazy modules so every one of them opens the temp database only.
let store: typeof import("./store.js");
let watcher: typeof import("./recording-watcher.js");
let routes: typeof import("./routes-callnotes.js");

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

// ----------------------------------------------------------------- fixtures

const CALL_AT = "2024-01-15T15:30:12+05:30";

function fakeTranscribe(secondsByName: Record<string, number>, fallback = 12): (audioPath: string) => Promise<TranscribeResult> {
  return async (audioPath: string) => {
    const base = audioPath.replace(/\\/g, "/").split("/").pop() ?? "";
    const seconds = secondsByName[base] ?? fallback;
    const segments: TranscribeSegment[] = [{ start: 0, end: seconds }];
    return {
      ok: true,
      provider: "local",
      language: "en",
      text: "Caller: hello. Lead: call back tomorrow please.",
      segments,
    };
  };
}

function fakeModel(): LlmFn {
  const note = {
    outcome: "call-back",
    i_said: "hello",
    they_said: "call back tomorrow",
    objections: [],
    next_action: "call back tomorrow",
    follow_up_at: "tomorrow",
    numbers_mentioned: [],
    confidence: 0.5,
    evidence: {
      i_said: "hello",
      they_said: "call back tomorrow",
      next_action: "call back tomorrow",
      follow_up_at: "tomorrow",
    },
  };
  return async () => ({ text: JSON.stringify(note), tokensIn: 5, tokensOut: 5, model: "deepseek-chat" });
}

let clock = new Date("2024-01-15T15:31:00+05:30");
const now = () => new Date(clock);
function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function freshDir(label: string): string {
  const dir = join(TMP, `${label}-${Math.random().toString(36).slice(2)}`, "recordings");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRecording(dir: string, name: string, bytes = 4096): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return path;
}

/** Prime the size, wait for it to be stable, then return the scan that processes it. */
async function settleAndScan(controller: { scan: () => Promise<import("./recording-watcher.js").ScanResult> }) {
  await controller.scan(); // records sizes
  advance(11_000); // longer than STABLE_MS
  return controller.scan(); // processes the now-stable files
}

function countCallNotes(status?: string): number {
  const db = store.getDb();
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'call_notes'").get();
  if (!table) return 0;
  const row = (
    status
      ? db.prepare("SELECT COUNT(*) AS n FROM call_notes WHERE status = ?").get(status)
      : db.prepare("SELECT COUNT(*) AS n FROM call_notes").get()
  ) as { n: number };
  return Number(row.n);
}

function countCallLogs(): number {
  const db = store.getDb();
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'call_logs'").get();
  if (!table) return 0;
  const row = db.prepare("SELECT COUNT(*) AS n FROM call_logs").get() as { n: number };
  return Number(row.n);
}

// --------------------------------------------------------------- test bodies

async function run(): Promise<void> {
  store = await import("./store.js");
  watcher = await import("./recording-watcher.js");
  routes = await import("./routes-callnotes.js");

  const ws: Workspace = store.createWorkspace({
    name: "Fake Workspace",
    offer: { services: ["website"], description: "fake" },
    icp: { categories: ["clinic"], cities: ["Pune"], countries: ["India"] },
  });
  const lead: Lead = store.upsertLead({
    workspaceId: ws.id,
    name: "Fake Lead",
    category: "clinic",
    source: "fixture",
    sourceUrl: "https://example.invalid/fake-lead",
    phone: "+91 98765 43210",
  });
  store.upsertLead({
    workspaceId: ws.id,
    name: "Fake Short Caller",
    category: "clinic",
    source: "fixture",
    sourceUrl: "https://example.invalid/fake-short",
    phone: "+91 90000 01111",
  });

  await check("every file-name pattern yields the right number and time", () => {
    for (const pattern of watcher.RECORDING_NAME_PATTERNS) {
      const parsed = watcher.parseRecordingName(pattern.example);
      assert.equal(parsed.pattern, pattern.id, `${pattern.id}: matched`);
      assert.equal(parsed.phone, "+919876543210", `${pattern.id}: E.164 number`);
      assert.equal(parsed.rawPhone?.replace(/\D/g, "").slice(-10), "9876543210", `${pattern.id}: raw number`);
      assert.equal(parsed.at, CALL_AT, `${pattern.id}: time`);
    }
  });

  await check("matching is by the last 10 digits and normalises to E.164", () => {
    assert.equal(watcher.normaliseIndiaE164("09876543210"), "+919876543210");
    assert.equal(watcher.normaliseIndiaE164("9876543210"), "+919876543210");
    assert.equal(watcher.normaliseIndiaE164("+91 98765 43210"), "+919876543210");
    assert.equal(watcher.matchLeadByPhone([lead], "+919876543210")?.id, lead.id);
    assert.equal(watcher.matchLeadByPhone([lead], "09876543210")?.id, lead.id);
    assert.equal(watcher.matchLeadByPhone([lead], "+919999999999"), undefined);
  });

  await check("a number with no lead goes to the unmatched list", async () => {
    const dir = freshDir("unmatched");
    writeRecording(dir, "Call recording +919000009999_240115_153012.m4a");
    const controller = await watcher.startWatcher({
      workspaceId: ws.id,
      recordingsDir: dir,
      intervalMs: 0,
      now,
      transcribe: fakeTranscribe({}),
      modelFn: fakeModel(),
      logger: () => {},
    });
    const result = await settleAndScan(controller);
    const again = await controller.scan(); // state file must stop a repeat
    controller.stop();
    assert.equal(result.unmatched.length, 1, JSON.stringify(result));
    assert.equal(result.unmatched[0].phone, "+919000009999");
    assert.equal(result.unmatched[0].reason, "no lead with this phone");
    assert.equal(result.processed, 0);
    assert.equal(again.unmatched.length, 0, "an already-listed file is not listed again");
  });

  await check("a file still growing is not processed", async () => {
    const dir = freshDir("growing");
    const name = "Call recording +919876543210_240115_153012.m4a";
    const path = writeRecording(dir, name, 1024);
    const controller = await watcher.startWatcher({
      workspaceId: ws.id,
      recordingsDir: dir,
      intervalMs: 0,
      now,
      transcribe: fakeTranscribe({}),
      modelFn: fakeModel(),
      logger: () => {},
    });
    await controller.scan(); // records size 1024
    appendFileSync(path, Buffer.alloc(1024, 2)); // file grew
    advance(11_000);
    const result = await controller.scan();
    controller.stop();
    assert.equal(result.processed, 0, JSON.stringify(result));
    assert.equal(result.notes.length, 0);
    assert.equal(countCallNotes(), 0);
  });

  await check("a completed file is processed exactly once across repeated scans", async () => {
    const dir = freshDir("once");
    writeRecording(dir, "Call recording +919876543210_240115_153012.m4a");
    const controller = await watcher.startWatcher({
      workspaceId: ws.id,
      recordingsDir: dir,
      intervalMs: 0,
      now,
      transcribe: fakeTranscribe({}),
      modelFn: fakeModel(),
      logger: () => {},
    });
    const before = countCallNotes();
    const first = await settleAndScan(controller); // prime + process
    advance(11_000);
    const second = await controller.scan(); // must find nothing to do
    controller.stop();
    assert.equal(first.processed, 1, JSON.stringify(first));
    assert.equal(second.processed, 0, JSON.stringify(second));
    assert.equal(countCallNotes() - before, 1, "exactly one note row");
  });

  await check("processed files are moved to processed/, never deleted", async () => {
    const dir = freshDir("moved");
    const name = "Call recording +919876543210_240115_153012.m4a";
    writeRecording(dir, name);
    const controller = await watcher.startWatcher({
      workspaceId: ws.id,
      recordingsDir: dir,
      intervalMs: 0,
      now,
      transcribe: fakeTranscribe({}),
      modelFn: fakeModel(),
      logger: () => {},
    });
    await settleAndScan(controller);
    controller.stop();
    assert.equal(existsSync(join(dir, name)), false, "source is gone");
    assert.equal(existsSync(join(dir, "processed", name)), true, "file lives in processed/");
  });

  await check("a draft with status needs_review is created and no confirmed call log exists", async () => {
    const dir = freshDir("draft");
    writeRecording(dir, "Call recording +919876543210_240115_153012.m4a");
    const controller = await watcher.startWatcher({
      workspaceId: ws.id,
      recordingsDir: dir,
      intervalMs: 0,
      now,
      transcribe: fakeTranscribe({}),
      modelFn: fakeModel(),
      logger: () => {},
    });
    const beforeNotes = countCallNotes();
    const result = await settleAndScan(controller);
    controller.stop();
    assert.equal(result.processed, 1, JSON.stringify(result));
    const db = store.getDb();
    const row = db
      .prepare("SELECT * FROM call_notes WHERE id = ?")
      .get(result.notes[0].noteId) as Record<string, unknown>;
    assert.ok(row, "the draft row exists");
    assert.equal(String(row.status), "needs_review");
    assert.equal(String(row.callId ?? ""), "", "the draft is not tied to a confirmed call");
    assert.equal(countCallNotes("needs_review") - beforeNotes, 1);
    assert.equal(countCallLogs(), 0, "no confirmed call log entry exists");
  });

  await check("a recording shorter than 5 seconds is skipped", async () => {
    const dir = freshDir("short");
    const name = "Call recording +919000001111_240115_153012.m4a";
    writeRecording(dir, name);
    const controller = await watcher.startWatcher({
      workspaceId: ws.id,
      recordingsDir: dir,
      intervalMs: 0,
      now,
      transcribe: fakeTranscribe({ [name]: 3 }),
      modelFn: fakeModel(),
      logger: () => {},
    });
    const beforeNotes = countCallNotes();
    const result = await settleAndScan(controller);
    controller.stop();
    assert.equal(result.skippedShort, 1, JSON.stringify(result));
    assert.equal(result.processed, 0);
    assert.equal(countCallNotes() - beforeNotes, 0, "no note for a too-short recording");
    assert.equal(existsSync(join(dir, "processed", name)), true, "the short file is still kept");
  });

  await check("GET /api/workspaces/:ws/call-notes?status=needs_review lists the draft", async () => {
    const captured: { route?: { method: string; pattern: string; handler: (ctx: CallNoteRequestCtx) => Promise<CallNoteReply> | CallNoteReply } } = {};
    routes.registerCallNoteRoutes((method, pattern, handler) => {
      if (pattern === "/api/workspaces/:ws/call-notes" && method === "GET") captured.route = { method, pattern, handler };
    }, {});
    assert.ok(captured.route, "the workspace-level list route is registered");
    const ctx: CallNoteRequestCtx = {
      method: "GET",
      params: { ws: ws.id },
      query: new URLSearchParams("status=needs_review"),
      header: () => undefined,
      readJson: async () => ({}),
      readText: async () => "",
      readBytes: async () => Buffer.alloc(0),
    };
    const reply = await captured.route.handler(ctx);
    assert.equal(reply.status, 200, JSON.stringify(reply));
    const body = reply.json as { notes: CallNote[] };
    assert.ok(Array.isArray(body.notes) && body.notes.length >= 1, "at least one needs_review note");
    assert.ok(body.notes.every((n) => n.status === "needs_review"), "all returned notes are needs_review");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run()
  .catch((err) => {
    console.error(`check crashed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      rmSync(TMP, { recursive: true, force: true });
    } catch {
      // best effort cleanup of the temp folder
    }
  });
