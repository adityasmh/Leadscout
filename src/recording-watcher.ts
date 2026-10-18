// src/recording-watcher.ts
// Order CALL4: watch a folder of phone call recordings, transcribe them locally,
// match each recording to a lead by phone number, and create a DRAFT call note
// with status "needs_review" for a human to confirm. This module NEVER writes a
// confirmed call log entry: confirmation stays in the Call desk (routes-callnotes).
//
// Design notes:
//  - Offline by default. The only outside integration is the polish model, loaded
//    lazily and only when the caller did not inject one; tests inject a fake.
//  - Transcribe uses the local faster-whisper path from transcribe.ts.
//  - Processed files are MOVED to processed/ (never deleted); a small JSON state
//    file guarantees a file is handled at most once across scans.
//  - A file is complete only when its size has not changed for STABLE_MS.
//  - Files whose recording is shorter than MIN_SECONDS are skipped.
//  - The need_review draft is written to the call_notes table owned by
//    routes-callnotes.ts (the call-note store), never to calls.ts's call_logs.
//
// Node 24 built-ins only, ES modules with .js import suffixes.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { polishNote, type NoteContext, type PolishedNote } from "./call-notes.js";
import { getDb, listLeads } from "./store.js";
import { transcribe as defaultTranscribe, type TranscribeResult } from "./transcribe.js";
import type { Lead } from "./types.js";
import type { LlmFn } from "./types-v2.js";

const PRODUCT_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_RECORDINGS_DIR = fileURLToPath(new URL("../data/call-recordings/", import.meta.url));
export const STATE_FILE_NAME = ".watcher-state.json";
export const PROCESSED_DIR_NAME = "processed";

/** A file counts as complete when its size has not changed for this long. */
export const STABLE_MS = 10_000;
/** Recordings shorter than this are skipped. */
export const MIN_SECONDS = 5;
/** Default seconds between scans when the watcher starts its own timer. */
export const DEFAULT_INTERVAL_MS = 15_000;

const TZ = "Asia/Kolkata";
export const AUDIO_EXTENSIONS: readonly string[] = ["m4a", "mp3", "amr", "wav", "aac", "ogg", "opus"];

// ---------------------------------------------------------- file-name parsing

/**
 * One row per recorder family style. Extend by appending a row: the parser tries
 * each pattern in order and uses the first that yields a number and/or a time.
 * Each regex may capture named groups: phone (or who, a free-text field the
 * number is pulled from), y, mo, d, h, mi, s.
 */
export type RecordingNamePattern = { id: string; example: string; re: RegExp };

export const RECORDING_NAME_PATTERNS: readonly RecordingNamePattern[] = [
  {
    id: "samsung-yymmdd",
    example: "Call recording +919876543210_240115_153012.m4a",
    re: /call recording[ _-]+(?<phone>\+?\d[\d -]*\d)[ _-]+(?<y>\d{2})(?<mo>\d{2})(?<d>\d{2})[ _-]+(?<h>\d{2})(?<mi>\d{2})(?<s>\d{2})/i,
  },
  {
    id: "xiaomi-yyyymmdd",
    example: "Call recording +919876543210_20240115_153012.m4a",
    re: /call recording[ _-]+(?<phone>\+?\d[\d -]*\d)[ _-]+(?<y>\d{4})(?<mo>\d{2})(?<d>\d{2})[ _-]+(?<h>\d{2})(?<mi>\d{2})(?<s>\d{2})/i,
  },
  {
    id: "oneplus-compact",
    example: "Call recording +919876543210_20240115153012.m4a",
    re: /call recording[ _-]+(?<phone>\+?\d[\d -]*\d)[ _-]+(?<y>\d{4})(?<mo>\d{2})(?<d>\d{2})(?<h>\d{2})(?<mi>\d{2})(?<s>\d{2})/i,
  },
  {
    id: "google-call-with",
    example: "Call with Fake Lead +919876543210 2024-01-15 15-30-12.m4a",
    re: /call with[ _-]+(?<who>.+?)[ _-]+(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})[ _-]+(?<h>\d{2})-(?<mi>\d{2})(?:-(?<s>\d{2}))?/i,
  },
  {
    id: "truecaller",
    example: "Truecaller +919876543210 2024-01-15 15-30-12.m4a",
    re: /truecaller[ _-]+(?<phone>\+?\d[\d -]*\d)[ _-]+(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})[ _-]+(?<h>\d{2})[.:-](?<mi>\d{2})(?:[.:-](?<s>\d{2}))?/i,
  },
  {
    id: "generic-phone-date",
    example: "+919876543210 2024-01-15 15-30-12.m4a",
    re: /(?<phone>\+?\d[\d -]{8,}\d)[ _-]+(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})[/ _-]+(?<h>\d{2})[.:-](?<mi>\d{2})(?:[.:-](?<s>\d{2}))?/i,
  },
];

export type ParsedRecordingName = {
  /** id of the pattern that matched, or null. */
  pattern: string | null;
  /** The number exactly as captured from the file name. */
  rawPhone: string | null;
  /** E.164 (India) normalised number, or null when no number was in the name. */
  phone: string | null;
  /** ISO timestamp with +05:30 offset, or null. */
  at: string | null;
};

function extractPhoneFromText(text: string): string | null {
  const m = /\+?\d[\d\s-]{8,}\d/.exec(text);
  return m ? m[0] : null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function buildRecordingTime(groups: Record<string, string | undefined>): string | null {
  const yRaw = groups.y;
  const moRaw = groups.mo;
  const dRaw = groups.d;
  if (!yRaw || !moRaw || !dRaw) return null;
  const y = yRaw.length <= 2 ? 2000 + Number(yRaw) : Number(yRaw);
  const mo = Number(moRaw);
  const d = Number(dRaw);
  const h = groups.h !== undefined ? Number(groups.h) : 0;
  const mi = groups.mi !== undefined ? Number(groups.mi) : 0;
  const s = groups.s !== undefined ? Number(groups.s) : 0;
  if (![y, mo, d, h, mi, s].every((n) => Number.isFinite(n))) return null;
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:${pad2(s)}+05:30`;
}

/** Pull a phone number and a time from a recording file name. Pure. */
export function parseRecordingName(name: string): ParsedRecordingName {
  const base = String(name ?? "").replace(/\.[a-z0-9]+$/i, "");
  for (const pattern of RECORDING_NAME_PATTERNS) {
    const match = pattern.re.exec(base);
    if (!match || !match.groups) continue;
    const groups = match.groups as Record<string, string | undefined>;
    const rawPhone = groups.phone ?? (groups.who ? extractPhoneFromText(groups.who) : null) ?? null;
    const at = buildRecordingTime(groups);
    if (!rawPhone && !at) continue;
    return {
      pattern: pattern.id,
      rawPhone,
      phone: rawPhone ? normaliseIndiaE164(rawPhone) : null,
      at,
    };
  }
  return { pattern: null, rawPhone: null, phone: null, at: null };
}

// -------------------------------------------------------------- phone helpers

/** Digits only, or "" when the input has no digits. */
export function digitsOf(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

/** The last 10 digits, or "" when there are fewer than 10. Used for matching. */
export function last10(value: unknown): string {
  const digits = digitsOf(value);
  return digits.length >= 10 ? digits.slice(-10) : "";
}

/** Normalise an Indian phone number to E.164 (+91XXXXXXXXXX). */
export function normaliseIndiaE164(raw: string): string | null {
  const digits = digitsOf(raw);
  if (digits.length < 10) return null;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  if (digits.startsWith("91") && digits.length >= 12) return `+${digits}`;
  return `+${digits}`;
}

/** Every phone string stored on a lead (the scalar phone and the phones list). */
export function leadPhones(lead: Lead): string[] {
  const out: string[] = [];
  if (typeof lead.phone === "string" && lead.phone !== "") out.push(lead.phone);
  if (Array.isArray(lead.phones)) for (const p of lead.phones) if (typeof p === "string" && p !== "") out.push(p);
  return out;
}

/** True when the lead has a phone whose last 10 digits equal the target's. */
export function leadMatchesPhone(lead: Lead, phone: string): boolean {
  const want = last10(phone);
  if (!want) return false;
  return leadPhones(lead).some((candidate) => last10(candidate) === want);
}

/** First lead in the list whose phone matches on the last 10 digits. */
export function matchLeadByPhone(leads: Lead[], phone: string): Lead | undefined {
  const want = last10(phone);
  if (!want) return undefined;
  return leads.find((lead) => leadMatchesPhone(lead, phone));
}

// ------------------------------------------------------------- speaker labels

/**
 * Relabel diarised turns so the model knows who spoke. Recognises common
 * whisper self-hosted labels ("Speaker 1", "SPEAKER_00", "S1:"). The first
 * distinct speaker is labelled "Caller" (us) and the second "Lead". When the
 * transcript has no usable labels it is returned unchanged. Pure.
 */
export function labelSpeakers(transcript: string): string {
  const text = String(transcript ?? "");
  if (text === "") return text;
  const labelRe = /\b(SPEAKER[ _]?\d+|Speaker[ _]?\d+|S\d+)\s*:/gi;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = labelRe.exec(text)) !== null) found.add(m[1].toLowerCase());
  if (found.size < 2) return text;
  const names = ["Caller", "Lead"];
  const map = new Map<string, string>();
  return text.replace(labelRe, (_full: string, label: string) => {
    const key = label.toLowerCase();
    if (!map.has(key)) map.set(key, names[map.size] ?? `Speaker ${map.size + 1}`);
    return `${map.get(key)}:`;
  });
}

// ------------------------------------------------------------ draft note store

export type DraftNoteInput = {
  workspaceId: string;
  leadId: string;
  transcript: string;
  polished: PolishedNote;
  audioPath: string | null;
  createdAt: string;
};

export type DraftNote = { id: string; status: "needs_review" };

// Same table as routes-callnotes.ts owns; kept here only so the watcher can add
// a row without editing that file beyond the list route (order item 2).
const CALL_NOTES_TABLE_SQL = `
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

/** Default: insert a needs_review draft into the call-note store. Never a call log. */
export function defaultCreateDraft(input: DraftNoteInput): DraftNote {
  const db = getDb();
  db.exec(CALL_NOTES_TABLE_SQL);
  const id = randomUUID();
  db.prepare(
    "INSERT INTO call_notes (id, workspaceId, leadId, transcript, polished, status, audioPath, callId, createdAt, updatedAt) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    input.workspaceId,
    input.leadId,
    input.transcript,
    JSON.stringify(input.polished),
    "needs_review",
    input.audioPath,
    null,
    input.createdAt,
    input.createdAt
  );
  return { id, status: "needs_review" };
}

// -------------------------------------------------------------------- watcher

export type WatcherDeps = {
  workspaceId: string;
  /** Folder to watch; defaults to env LEADSCOUT_RECORDINGS_DIR then data/call-recordings/. */
  recordingsDir?: string;
  /** Seconds between scans; 0 disables the timer (tests drive scan() directly). */
  intervalMs?: number;
  /** Injectable clock. */
  now?: () => Date;
  /** Injectable transcription (tests pass a fake). */
  transcribe?: (audioPath: string) => Promise<TranscribeResult>;
  /** Injectable polish (tests pass a fake). */
  polish?: typeof polishNote;
  /** Model function for polish; when omitted the real one is loaded lazily. */
  modelFn?: LlmFn;
  /** Injectable draft creation (tests can capture, default writes the call-note table). */
  createDraft?: (input: DraftNoteInput) => DraftNote | Promise<DraftNote>;
  logger?: (line: string) => void;
};

export type FileOutcome =
  | { kind: "processed"; file: string; noteId: string; phone: string; at: string | null }
  | { kind: "unmatched"; file: string; phone: string | null; at: string | null; reason: string }
  | { kind: "too_short"; file: string; seconds: number }
  | { kind: "failed"; file: string; error: string };

export type ScanResult = {
  scanned: number;
  processed: number;
  skippedGrowing: number;
  skippedShort: number;
  unmatched: Extract<FileOutcome, { kind: "unmatched" }>[];
  notes: Extract<FileOutcome, { kind: "processed" }>[];
  failed: Extract<FileOutcome, { kind: "failed" }>[];
};

type FileState = {
  size: number;
  seenAt: string;
  status: "watching" | "processed" | "unmatched" | "too_short" | "failed";
  processedAt?: string;
  noteId?: string;
  phone?: string | null;
  at?: string | null;
  detail?: string;
};

type WatcherState = { version: 1; files: Record<string, FileState> };

export type WatcherController = {
  scan: () => Promise<ScanResult>;
  stop: () => void;
  /** The in-memory state; write-through to the state file after every file. */
  state: () => WatcherState;
  recordingsDir: string;
  processedDir: string;
};

function isAudioFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return AUDIO_EXTENSIONS.includes(ext);
}

function loadState(file: string): WatcherState {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as WatcherState;
    if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === "object") return parsed;
  } catch {
    // missing or corrupt state: start clean
  }
  return { version: 1, files: {} };
}

function saveState(file: string, state: WatcherState): void {
  writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

/** Longest segment end, or 0 when no segments were returned. */
export function durationFromSegments(segments: { start: number; end: number }[] | undefined): number {
  if (!Array.isArray(segments) || segments.length === 0) return 0;
  return segments.reduce((max, s) => (Number.isFinite(s.end) && s.end > max ? s.end : max), 0);
}

function moveToProcessed(src: string, processedDir: string, name: string): string {
  mkdirSync(processedDir, { recursive: true });
  let dest = join(processedDir, name);
  if (existsSync(dest)) dest = join(processedDir, `${Date.now()}-${name}`);
  renameSync(src, dest);
  return dest;
}

async function loadDefaultModelFn(): Promise<LlmFn> {
  const mod = (await import("./llm.js")) as { defaultLlm?: LlmFn };
  if (typeof mod.defaultLlm !== "function") throw new Error("default model function is unavailable");
  return mod.defaultLlm;
}

async function processFile(
  deps: WatcherDeps,
  name: string,
  dir: string,
  processedDir: string,
  state: WatcherState,
  now: () => Date,
  nowIso: string
): Promise<FileOutcome> {
  const src = join(dir, name);
  const parsed = parseRecordingName(name);

  const leads = listLeads({ workspaceId: deps.workspaceId, limit: 100_000, includeHidden: true }).leads;
  const lead = parsed.phone ? matchLeadByPhone(leads, parsed.phone) : undefined;
  if (!lead) {
    const reason = parsed.phone ? "no lead with this phone" : "no phone number in the file name";
    state.files[name] = {
      ...state.files[name],
      status: "unmatched",
      processedAt: nowIso,
      phone: parsed.phone,
      at: parsed.at,
      detail: reason,
    };
    return { kind: "unmatched", file: name, phone: parsed.phone, at: parsed.at, reason };
  }

  const transcriber = deps.transcribe ?? ((audioPath: string) => defaultTranscribe(audioPath));
  let transcription: TranscribeResult;
  try {
    transcription = await transcriber(src);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    state.files[name] = { ...state.files[name], status: "failed", processedAt: nowIso, detail: error };
    return { kind: "failed", file: name, error };
  }
  if (!transcription.ok) {
    const error = transcription.error ?? "transcription failed";
    state.files[name] = { ...state.files[name], status: "failed", processedAt: nowIso, detail: error };
    return { kind: "failed", file: name, error };
  }

  const seconds = durationFromSegments(transcription.segments);
  if (seconds < MIN_SECONDS) {
    const dest = moveToProcessed(src, processedDir, name);
    state.files[name] = {
      ...state.files[name],
      status: "too_short",
      processedAt: nowIso,
      phone: parsed.phone,
      at: parsed.at,
      detail: `moved to ${dest}`,
    };
    return { kind: "too_short", file: name, seconds };
  }

  const transcript = labelSpeakers(transcription.text ?? "");
  const modelFn = deps.modelFn ?? (await loadDefaultModelFn());
  const polish = deps.polish ?? polishNote;
  const context: NoteContext = {
    leadName: lead.name,
    callAt: parsed.at ?? nowIso,
    now,
    timeZone: TZ,
  };
  let polished: PolishedNote;
  try {
    polished = await polish(transcript, context, modelFn);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    state.files[name] = { ...state.files[name], status: "failed", processedAt: nowIso, detail: error };
    return { kind: "failed", file: name, error };
  }

  const createDraft = deps.createDraft ?? defaultCreateDraft;
  const draft = await Promise.resolve(
    createDraft({
      workspaceId: deps.workspaceId,
      leadId: lead.id,
      transcript,
      polished,
      audioPath: null, // never let confirm delete the recording; processed/ is permanent
      createdAt: nowIso,
    })
  );

  const dest = moveToProcessed(src, processedDir, name);
  state.files[name] = {
    ...state.files[name],
    status: "processed",
    processedAt: nowIso,
    noteId: draft.id,
    phone: parsed.phone,
    at: parsed.at,
    detail: `moved to ${dest}`,
  };
  return { kind: "processed", file: name, noteId: draft.id, phone: parsed.phone as string, at: parsed.at };
}

/**
 * Create a watcher. The returned controller's scan() performs one pass; the
 * timer (when intervalMs > 0) calls scan() on a loop. Nothing is processed
 * until a file has been size-stable for STABLE_MS.
 */
export async function startWatcher(deps: WatcherDeps): Promise<WatcherController> {
  const recordingsDir = deps.recordingsDir ?? process.env.LEADSCOUT_RECORDINGS_DIR ?? DEFAULT_RECORDINGS_DIR;
  const processedDir = join(recordingsDir, PROCESSED_DIR_NAME);
  const stateFile = join(recordingsDir, STATE_FILE_NAME);
  mkdirSync(processedDir, { recursive: true });
  let state = loadState(stateFile);
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? (() => {});

  const scan = async (): Promise<ScanResult> => {
    const nowIso = now().toISOString();
    const result: ScanResult = {
      scanned: 0,
      processed: 0,
      skippedGrowing: 0,
      skippedShort: 0,
      unmatched: [],
      notes: [],
      failed: [],
    };
    const names = readdirSync(recordingsDir)
      .filter((entry) => isAudioFile(entry))
      .filter((entry) => {
        try {
          return statSync(join(recordingsDir, entry)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
    result.scanned = names.length;

    for (const name of names) {
      const src = join(recordingsDir, name);
      const info = statSync(src);
      const prior = state.files[name];
      if (prior && prior.status !== "watching") continue; // already handled
      if (!prior) {
        state.files[name] = { size: info.size, seenAt: nowIso, status: "watching" };
        result.skippedGrowing += 1;
        saveState(stateFile, state);
        continue;
      }
      if (info.size !== prior.size) {
        prior.size = info.size;
        prior.seenAt = nowIso;
        prior.status = "watching";
        result.skippedGrowing += 1;
        saveState(stateFile, state);
        continue;
      }
      if (now().getTime() - Date.parse(prior.seenAt) < STABLE_MS) {
        result.skippedGrowing += 1;
        continue;
      }

      let outcome: FileOutcome;
      try {
        outcome = await processFile(deps, name, recordingsDir, processedDir, state, now, nowIso);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        state.files[name] = { ...state.files[name], status: "failed", processedAt: nowIso, detail: error };
        outcome = { kind: "failed", file: name, error };
      }
      if (outcome.kind === "processed") {
        result.processed += 1;
        result.notes.push(outcome);
      } else if (outcome.kind === "unmatched") {
        result.unmatched.push(outcome);
      } else if (outcome.kind === "too_short") {
        result.skippedShort += 1;
      } else {
        result.failed.push(outcome);
      }
      logger(`recording-watcher: ${name} -> ${outcome.kind}`);
      saveState(stateFile, state);
    }
    saveState(stateFile, state);
    return result;
  };

  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (intervalMs > 0) {
    timer = setInterval(() => {
      void scan().catch((err) => logger(`recording-watcher: scan failed: ${err instanceof Error ? err.message : String(err)}`));
    }, intervalMs);
  }

  return {
    scan,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    state: () => state,
    recordingsDir,
    processedDir,
  };
}

/**
 * Runnable entry: watches one workspace. The workspace id comes from the first
 * argument or env LEADSCOUT_WORKSPACE; the folder from LEADSCOUT_RECORDINGS_DIR.
 * Example: npx tsx src/recording-watcher.ts <wsId>
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const workspaceId = argv[0] ?? process.env.LEADSCOUT_WORKSPACE;
  if (!workspaceId) {
    console.error("recording-watcher: pass the workspace id as the first argument or set LEADSCOUT_WORKSPACE");
    process.exitCode = 1;
    return;
  }
  const controller = await startWatcher({
    workspaceId,
    logger: (line) => console.log(line),
  });
  console.log(`recording-watcher: watching ${controller.recordingsDir} for workspace ${workspaceId}`);
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`recording-watcher: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

export const __productRoot = PRODUCT_ROOT;
