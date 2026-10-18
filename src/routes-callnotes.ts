// src/routes-callnotes.ts
// Order CALL3: HTTP routes for the call-note (voice note) flow. Same shape as
// routes-calls.ts: export `registerCallNoteRoutes(register, helpers)` where
// `register(method, pattern, handler)`. This file never imports server.ts; the
// server hook only dynamic-imports it and calls `handleCallNoteRequest`.
//
// Routes (workspace API key guard, the same one the other workspace routes use):
//   POST   /api/workspaces/:ws/leads/:id/call-notes
//   GET    /api/workspaces/:ws/leads/:id/call-notes
//   GET    /api/workspaces/:ws/leads/:id/call-notes/:noteId
//   POST   /api/workspaces/:ws/leads/:id/call-notes/:noteId/confirm
//   POST   /api/workspaces/:ws/leads/:id/call-notes/:noteId/discard
//
// Audio is written under data/call-audio/ and deleted after confirm (unless
// LEADSCOUT_KEEP_AUDIO=1), on discard, and when transcription fails.
// Nothing throws into the server.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CALL_OUTCOMES, CallError, logCall, type CallOutcome } from "./calls.js";
import { polishNote as defaultPolish, type NoteContext, type PolishedNote } from "./call-notes.js";
import { getDb, getLead, getWorkspace } from "./store.js";
import { audioExtension, transcribe as defaultTranscribe, type TranscribeResult } from "./transcribe.js";
import type { LlmFn } from "./types-v2.js";

export type CallNoteRequestCtx = {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  header: (name: string) => string | undefined;
  readJson: () => Promise<unknown>;
  readText: () => Promise<string>;
  readBytes: () => Promise<Buffer>;
};

export type CallNoteReply = {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
};

export type CallNoteHandler = (ctx: CallNoteRequestCtx) => Promise<CallNoteReply> | CallNoteReply;
export type CallNoteRegister = (method: string, pattern: string, handler: CallNoteHandler) => void;

export type CallNoteHelpers = {
  now?: () => Date;
  /** Injectable transcription (tests pass a fake). */
  transcribe?: (audioPath: string, opts?: Record<string, unknown>) => Promise<TranscribeResult>;
  /** Injectable polish wrapper. */
  polish?: (transcript: string, context: NoteContext, modelFn: LlmFn) => Promise<PolishedNote>;
  /** Injectable model function for polish. */
  modelFn?: LlmFn;
  /** Directory for audio files; defaults to <product>/data/call-audio. */
  dataDir?: string;
};

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const PRODUCT_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_AUDIO_DIR = resolve(PRODUCT_ROOT, "data", "call-audio");

/** Validate an upload's content type and size. Pure, so tests can call it directly. */
export function validateAudioUpload(contentType: string, size: number): { ok: boolean; status: number; ext: string; error?: string } {
  const ext = audioExtension(contentType);
  if (!ext) return { ok: false, status: 415, ext: "", error: "unsupported audio type: use audio/webm, audio/mp4, audio/ogg or audio/wav" };
  if (!Number.isFinite(size) || size <= 0) return { ok: false, status: 400, ext: "", error: "empty audio body" };
  if (size > MAX_AUDIO_BYTES) return { ok: false, status: 413, ext: "", error: `audio too large: ${size} bytes (max ${MAX_AUDIO_BYTES})` };
  return { ok: true, status: 200, ext };
}

// ------------------------------------------------------------------ storage

type NoteRow = Record<string, unknown>;

export type CallNote = {
  id: string;
  workspaceId: string;
  leadId: string;
  transcript: string;
  polished: PolishedNote;
  status: "needs_review" | "confirmed" | "discarded";
  audioPath: string | null;
  callId: string | null;
  createdAt: string;
  updatedAt: string;
};

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS call_notes (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  leadId TEXT NOT NULL,
  transcript TEXT NOT NULL,
  polished TEXT NOT NULL,
  status TEXT NOT NULL,
  audioPath TEXT,
  callId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_notes_ws ON call_notes(workspaceId, leadId);
`;

function ensureTable(): void {
  getDb().exec(TABLE_SQL);
}

function toNote(row: NoteRow): CallNote {
  let polished: PolishedNote;
  try {
    polished = JSON.parse(String(row.polished)) as PolishedNote;
  } catch {
    polished = {} as PolishedNote;
  }
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    leadId: String(row.leadId),
    transcript: String(row.transcript),
    polished,
    status: String(row.status) as CallNote["status"],
    audioPath: row.audioPath === null || row.audioPath === undefined ? null : String(row.audioPath),
    callId: row.callId === null || row.callId === undefined ? null : String(row.callId),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function insertNote(note: CallNote): void {
  ensureTable();
  getDb()
    .prepare(
      "INSERT INTO call_notes (id, workspaceId, leadId, transcript, polished, status, audioPath, callId, createdAt, updatedAt) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      note.id,
      note.workspaceId,
      note.leadId,
      note.transcript,
      JSON.stringify(note.polished),
      note.status,
      note.audioPath,
      note.callId,
      note.createdAt,
      note.updatedAt
    );
}

function getNoteRow(workspaceId: string, leadId: string, noteId: string): CallNote | undefined {
  ensureTable();
  const row = getDb()
    .prepare("SELECT * FROM call_notes WHERE workspaceId = ? AND leadId = ? AND id = ?")
    .get(workspaceId, leadId, noteId) as NoteRow | undefined;
  return row ? toNote(row) : undefined;
}

function listNoteRows(workspaceId: string, leadId: string): CallNote[] {
  ensureTable();
  const rows = getDb()
    .prepare("SELECT * FROM call_notes WHERE workspaceId = ? AND leadId = ? ORDER BY createdAt DESC, rowid DESC")
    .all(workspaceId, leadId) as NoteRow[];
  return rows.map(toNote);
}

/** Order CALL4: workspace-wide list, optionally filtered by status (e.g. needs_review). */
function listNoteRowsByStatus(workspaceId: string, status?: string): CallNote[] {
  ensureTable();
  const rows = (
    status
      ? getDb()
          .prepare("SELECT * FROM call_notes WHERE workspaceId = ? AND status = ? ORDER BY createdAt DESC, rowid DESC")
          .all(workspaceId, status)
      : getDb()
          .prepare("SELECT * FROM call_notes WHERE workspaceId = ? ORDER BY createdAt DESC, rowid DESC")
          .all(workspaceId)
  ) as NoteRow[];
  return rows.map(toNote);
}

const CALL_NOTE_STATUSES: readonly CallNote["status"][] = ["needs_review", "confirmed", "discarded"];

function setNoteStatus(noteId: string, status: CallNote["status"], callId: string | null, updatedAt: string): void {
  getDb()
    .prepare("UPDATE call_notes SET status = ?, callId = ?, updatedAt = ? WHERE id = ?")
    .run(status, callId, updatedAt, noteId);
}

function safeUnlink(path: string | null): void {
  if (!path) return;
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best effort: a missing/locked audio file must not fail the request
  }
}

function mergePolished(polished: PolishedNote, body: Record<string, unknown>): PolishedNote {
  const merged: PolishedNote = { ...polished };
  if (body.i_said !== undefined) merged.i_said = String(body.i_said ?? "");
  if (body.they_said !== undefined) merged.they_said = String(body.they_said ?? "");
  if (body.next_action !== undefined) merged.next_action = String(body.next_action ?? "");
  if (body.objections !== undefined) merged.objections = Array.isArray(body.objections) ? body.objections.map((o) => String(o)) : [];
  if (body.outcome !== undefined) merged.outcome = String(body.outcome) as PolishedNote["outcome"];
  if (body.follow_up_at !== undefined) {
    const value = body.follow_up_at;
    merged.follow_up_at = value === null || value === "" ? null : String(value);
  }
  return merged;
}

// ------------------------------------------------------------------- helpers

function ok(json: unknown, status = 200): CallNoteReply {
  return { status, json };
}

function fail(status: number, error: string): CallNoteReply {
  return { status, json: { error } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadDefaultModelFn(): Promise<LlmFn> {
  const mod = (await import("./llm.js")) as { defaultLlm?: LlmFn };
  if (typeof mod.defaultLlm !== "function") throw new Error("default model function is unavailable");
  return mod.defaultLlm;
}

async function guard(ctx: CallNoteRequestCtx, workspaceId: string): Promise<CallNoteReply | null> {
  const requireKeys = process.env.LEADSCOUT_REQUIRE_KEYS === "1";
  const auth = ctx.header("authorization");
  if (!requireKeys && !auth) return null;
  let access: typeof import("./access.js");
  try {
    access = await import("./access.js");
  } catch {
    return requireKeys ? fail(401, "authorization required: the access module is unavailable") : null;
  }
  const key = access.parseBearer(auth);
  if (!key) return fail(401, "authorization required: send Authorization: Bearer <key> for this workspace");
  const verified = access.verifyApiKey(key);
  if (!verified) return fail(401, "invalid or revoked API key");
  if (verified.workspaceId !== workspaceId) return fail(403, "this key belongs to a different workspace");
  if (ctx.method !== "GET" && !verified.scopes.includes("write")) {
    return fail(403, "this key is read-only; a write-scoped key is needed for this request");
  }
  access.meter(workspaceId, "apiCalls", 1);
  return null;
}

function workspaceOr404(workspaceId: string): CallNoteReply | null {
  if (!getWorkspace(workspaceId)) return fail(404, "workspace not found");
  return null;
}

async function readObject(ctx: CallNoteRequestCtx): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await ctx.readJson();
  } catch {
    throw new CallError("body must be valid JSON");
  }
  if (!isRecord(body)) throw new CallError("body must be a JSON object");
  return body;
}

const AUDIO_MARKERS: readonly string[] = ["iSaid", "theySaid", "nextAction", "followUpAt", "outcome"];

// -------------------------------------------------------------------- routes

/** Registers every call-note route with the given `register(method, pattern, handler)`. */
export function registerCallNoteRoutes(register: CallNoteRegister, helpers: CallNoteHelpers = {}): void {
  const now = () => (helpers.now ? helpers.now() : new Date());

  register("POST", "/api/workspaces/:ws/leads/:id/call-notes", async (ctx) => {
    const ws = ctx.params.ws;
    const leadId = ctx.params.id;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    const lead = getLead(ws, leadId);
    if (!lead) return fail(404, "lead not found");

    const contentType = ctx.header("content-type") ?? "";
    const bytes = await ctx.readBytes();
    const check = validateAudioUpload(contentType, bytes.length);
    if (!check.ok) return fail(check.status, check.error ?? "invalid audio upload");

    const dir = helpers.dataDir ?? DEFAULT_AUDIO_DIR;
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const audioPath = join(dir, `${id}${check.ext}`);
    writeFileSync(audioPath, bytes);

    const transcriber = helpers.transcribe ?? defaultTranscribe;
    let transcription: TranscribeResult;
    try {
      transcription = await transcriber(audioPath);
    } catch (err) {
      transcription = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!transcription.ok) {
      safeUnlink(audioPath);
      return fail(422, transcription.error ?? "transcription failed");
    }
    const transcript = transcription.text ?? "";

    const polish = helpers.polish ?? defaultPolish;
    let modelFn = helpers.modelFn;
    try {
      if (!modelFn) modelFn = await loadDefaultModelFn();
    } catch (err) {
      safeUnlink(audioPath);
      return fail(502, `model function unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    let polished: PolishedNote;
    try {
      polished = await polish(transcript, { leadName: lead.name, callAt: now().toISOString(), now }, modelFn);
    } catch (err) {
      safeUnlink(audioPath);
      return fail(502, `polish failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const at = now().toISOString();
    const note: CallNote = {
      id,
      workspaceId: ws,
      leadId,
      transcript,
      polished,
      status: "needs_review",
      audioPath,
      callId: null,
      createdAt: at,
      updatedAt: at,
    };
    insertNote(note);
    return ok({ id: note.id, transcript: note.transcript, polished: note.polished, status: note.status }, 201);
  });

  register("GET", "/api/workspaces/:ws/leads/:id/call-notes", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    if (!getLead(ws, ctx.params.id)) return fail(404, "lead not found");
    return ok({ notes: listNoteRows(ws, ctx.params.id) });
  });

  register("GET", "/api/workspaces/:ws/call-notes", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    const status = ctx.query.get("status") ?? undefined;
    if (status && !(CALL_NOTE_STATUSES as readonly string[]).includes(status)) {
      return fail(400, `status must be one of ${CALL_NOTE_STATUSES.join(", ")}`);
    }
    return ok({ notes: listNoteRowsByStatus(ws, status) });
  });

  register("GET", "/api/workspaces/:ws/leads/:id/call-notes/:noteId", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    const note = getNoteRow(ws, ctx.params.id, ctx.params.noteId);
    if (!note) return fail(404, "call note not found");
    return ok({ id: note.id, transcript: note.transcript, polished: note.polished, status: note.status, callId: note.callId });
  });

  register("POST", "/api/workspaces/:ws/leads/:id/call-notes/:noteId/confirm", async (ctx) => {
    const ws = ctx.params.ws;
    const leadId = ctx.params.id;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    const note = getNoteRow(ws, leadId, ctx.params.noteId);
    if (!note) return fail(404, "call note not found");
    if (note.status !== "needs_review") return fail(409, `call note is ${note.status}, not open for review`);

    const body = await readObject(ctx);
    const merged = mergePolished(note.polished, body);
    const outcome = merged.outcome;
    if (outcome === "unknown" || !(CALL_OUTCOMES as readonly string[]).includes(outcome)) {
      return fail(400, `outcome must be one of ${CALL_OUTCOMES.join(", ")}`);
    }

    let call;
    try {
      call = await logCall({
        workspaceId: ws,
        leadId,
        channel: "call",
        outcome: outcome as CallOutcome,
        iSaid: merged.i_said,
        theySaid: merged.they_said,
        nextAction: merged.next_action,
        followUpAt: merged.follow_up_at,
      });
    } catch (err) {
      if (err instanceof CallError) return fail(400, err.message);
      return fail(500, err instanceof Error ? err.message : String(err));
    }

    setNoteStatus(note.id, "confirmed", call.id, now().toISOString());
    if (process.env.LEADSCOUT_KEEP_AUDIO !== "1") safeUnlink(note.audioPath);

    return ok({
      id: note.id,
      transcript: note.transcript,
      polished: merged,
      status: "confirmed",
      callId: call.id,
      call,
    });
  });

  register("POST", "/api/workspaces/:ws/leads/:id/call-notes/:noteId/discard", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    const note = getNoteRow(ws, ctx.params.id, ctx.params.noteId);
    if (!note) return fail(404, "call note not found");
    safeUnlink(note.audioPath);
    setNoteStatus(note.id, "discarded", note.callId, now().toISOString());
    return ok({ ok: true, id: note.id, status: "discarded" });
  });
}

// ----------------------------------------------------------------- node:http

function safeHandler(handler: CallNoteHandler): CallNoteHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof CallError) return fail(400, err.message);
      const message = err instanceof Error && err.message ? err.message : String(err);
      return fail(500, message);
    }
  };
}

type CompiledRoute = { method: string; re: RegExp; keys: string[]; handler: CallNoteHandler };

function compileRoutes(helpers: CallNoteHelpers): CompiledRoute[] {
  const routes: CompiledRoute[] = [];
  registerCallNoteRoutes((method, pattern, handler) => {
    const keys: string[] = [];
    const re = new RegExp(
      `^${pattern.replace(/:[^/]+/g, (token) => {
        keys.push(token.slice(1));
        return "([^/]+)";
      })}$`
    );
    routes.push({ method, re, keys, handler: safeHandler(handler) });
  }, helpers);
  return routes;
}

function sendReply(res: ServerResponse, reply: CallNoteReply): void {
  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  let payload: string | undefined;
  if (reply.text !== undefined) {
    headers["content-type"] = reply.contentType ?? "text/plain; charset=utf-8";
    payload = reply.text;
  } else {
    headers["content-type"] = "application/json; charset=utf-8";
    payload = JSON.stringify(reply.json ?? null);
  }
  headers["content-length"] = String(Buffer.byteLength(payload));
  res.writeHead(reply.status, headers);
  res.end(payload);
}

/**
 * node:http adapter used by the single server.ts hook: matches a call-note route
 * and sends its reply, returning true when it handled the request. Returns false
 * (and writes nothing) when the path is not a call-note route.
 */
export async function handleCallNoteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  helpers: CallNoteHelpers = {}
): Promise<boolean> {
  const method = req.method ?? "GET";
  for (const route of compileRoutes(helpers)) {
    if (route.method !== method) continue;
    const match = route.re.exec(url.pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      const raw = match[index + 1] ?? "";
      try {
        params[key] = decodeURIComponent(raw);
      } catch {
        params[key] = raw;
      }
    });
    const ctx: CallNoteRequestCtx = {
      method,
      params,
      query: url.searchParams,
      header: (name) => {
        const value = req.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
      },
      readJson: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (text === "") return {};
        return JSON.parse(text) as unknown;
      },
      readText: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString("utf8");
      },
      readBytes: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
      },
    };
    const reply = await route.handler(ctx);
    sendReply(res, reply);
    return true;
  }
  return false;
}

// The markers list is exported only so a UI check can assert the audio route
// never reads JSON body fields; kept tiny and side-effect free.
export const AUDIO_BODY_MARKERS = AUDIO_MARKERS;
