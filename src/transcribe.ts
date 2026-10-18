// src/transcribe.ts
// Order CALL3: turn one recorded audio file into text, locally and privately.
//
// Provider chain (local first, cloud only as a fallback and only when the
// operator explicitly opts in):
//   (a) local faster-whisper through tools/whisper_run.py, launched with
//       LEADSCOUT_WHISPER_PY (default deps/whisper-venv/Scripts/python.exe);
//   (b) Groq Whisper over HTTPS, used only when GROQ_API_KEY is set AND
//       LEADSCOUT_TRANSCRIBE_CLOUD=1. The cloud path always goes through an
//       injected fetchFn (default globalThis.fetch), so tests stay offline.
//
// Node 24 built-ins only, ES modules, .js import suffixes. transcribe() never
// throws: it returns {ok:true, ...} or {ok:false, error}.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export type TranscribeSegment = { start: number; end: number };

export type TranscribeResult = {
  ok: boolean;
  text?: string;
  language?: string;
  segments?: TranscribeSegment[];
  provider?: "local" | "groq";
  error?: string;
};

export type RunnerOptions = { windowsHide: boolean; timeout: number; cwd?: string };
export type RunnerResult = { stdout: string; stderr: string; code: number };
/** Injectable process runner. May reject (missing binary, non-zero exit, timeout). */
export type TranscribeRunner = (file: string, args: string[], opts: RunnerOptions) => Promise<RunnerResult>;

export type TranscribeOpts = {
  /** Override the process runner (tests pass a fake). */
  runner?: TranscribeRunner;
  /** Injected fetch used by the cloud path; defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Environment source; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Python launcher path; defaults to env LEADSCOUT_WHISPER_PY then the venv default. */
  pythonPath?: string;
  /** Path to tools/whisper_run.py; defaults to the file beside this module. */
  scriptPath?: string;
  /** Model size for the local launcher; default "small". */
  model?: string;
  /** "auto" (default) lets the engine detect the language. */
  language?: string;
  /** Model id for the Groq cloud path; default "whisper-large-v3". */
  cloudModel?: string;
};

const DEFAULT_MODEL = "small";
const DEFAULT_LANG = "auto";
const CLOUD_MODEL = "whisper-large-v3";
const TIMEOUT_MS = 180_000;
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

const PRODUCT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_SCRIPT = fileURLToPath(new URL("../tools/whisper_run.py", import.meta.url));
const DEFAULT_PYTHON = fileURLToPath(new URL("../deps/whisper-venv/Scripts/python.exe", import.meta.url));

const EXT_BY_TYPE: Record<string, string> = {
  "audio/webm": ".webm",
  "audio/mp4": ".mp4",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
};

/** Default runner: execFile, hidden window, hard timeout. Rejects on failure. */
const defaultRunner: TranscribeRunner = (file, args, opts) =>
  new Promise<RunnerResult>((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: opts.windowsHide, timeout: opts.timeout, cwd: opts.cwd, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          const reason = e.killed ? `timed out after ${opts.timeout} ms` : e.message || "process failed";
          const tail = stderr ? `: ${String(stderr).trim()}` : "";
          reject(new Error(`${reason}${tail}`));
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 });
      }
    );
  });

function toSegments(value: unknown): TranscribeSegment[] {
  if (!Array.isArray(value)) return [];
  const out: TranscribeSegment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as { start?: unknown; end?: unknown };
    const start = Number(s.start);
    const end = Number(s.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ start, end });
  }
  return out;
}

function pythonFor(env: Record<string, string | undefined>, opts: TranscribeOpts): string {
  const fromOpt = typeof opts.pythonPath === "string" && opts.pythonPath.trim() !== "" ? opts.pythonPath : "";
  const fromEnv = typeof env.LEADSCOUT_WHISPER_PY === "string" && env.LEADSCOUT_WHISPER_PY.trim() !== "" ? env.LEADSCOUT_WHISPER_PY : "";
  return fromOpt || fromEnv || DEFAULT_PYTHON;
}

/** True only when both cloud variables are set exactly as the order requires. */
export function cloudEnabled(env: Record<string, string | undefined>): boolean {
  return Boolean(env.GROQ_API_KEY) && env.LEADSCOUT_TRANSCRIBE_CLOUD === "1";
}

/** Content types accepted for an audio upload, with the file extension to store it under. */
export function audioExtension(contentType: string): string | null {
  const bare = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  return EXT_BY_TYPE[bare] ?? null;
}

/** Run the local faster-whisper launcher. Never throws. */
async function runLocal(audioPath: string, opts: TranscribeOpts, env: Record<string, string | undefined>): Promise<TranscribeResult> {
  const runner = opts.runner ?? defaultRunner;
  const python = pythonFor(env, opts);
  const script = opts.scriptPath ?? DEFAULT_SCRIPT;
  const model = opts.model ?? DEFAULT_MODEL;
  const language = opts.language ?? DEFAULT_LANG;

  try {
    const res = await runner(python, [script, audioPath, model, language], {
      windowsHide: true,
      timeout: TIMEOUT_MS,
      cwd: PRODUCT_ROOT,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout.trim());
    } catch {
      return { ok: false, error: `local transcription failed: launcher did not return JSON (${res.stdout.slice(0, 120)})` };
    }
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "local transcription failed: launcher returned non-object JSON" };
    }
    const body = parsed as { text?: unknown; language?: unknown; segments?: unknown };
    return {
      ok: true,
      provider: "local",
      text: typeof body.text === "string" ? body.text : "",
      language: typeof body.language === "string" ? body.language : language,
      segments: toSegments(body.segments),
    };
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    return { ok: false, error: `local transcription failed (${python}): ${message}` };
  }
}

/** Send the audio to Groq Whisper through the injected fetch. Never throws. */
async function runCloud(audioPath: string, opts: TranscribeOpts, env: Record<string, string | undefined>): Promise<TranscribeResult> {
  if (!cloudEnabled(env)) {
    return { ok: false, error: "cloud transcription is off: set GROQ_API_KEY and LEADSCOUT_TRANSCRIBE_CLOUD=1 to enable it" };
  }
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") return { ok: false, error: "cloud transcription failed: no fetch implementation available" };

  try {
    const bytes = await readFile(audioPath);
    const form = new FormData();
    form.append("file", new Blob([bytes]), basename(audioPath) || "note.webm");
    form.append("model", opts.cloudModel ?? CLOUD_MODEL);
    form.append("response_format", "verbose_json");
    const language = opts.language ?? DEFAULT_LANG;
    if (language && language !== "auto") form.append("language", language);

    const res = await fetchFn(GROQ_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: form,
    });
    if (!res.ok) return { ok: false, error: `cloud transcription failed: groq returned ${res.status}` };
    const data = (await res.json()) as { text?: unknown; language?: unknown; segments?: unknown };
    return {
      ok: true,
      provider: "groq",
      text: typeof data.text === "string" ? data.text : "",
      language: typeof data.language === "string" ? data.language : language,
      segments: toSegments(data.segments),
    };
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    return { ok: false, error: `cloud transcription failed: ${message}` };
  }
}

/**
 * Transcribe one audio file. Tries the local launcher first; falls back to the
 * cloud path only when it is explicitly enabled and the local path failed.
 * Never throws.
 */
export async function transcribe(audioPath: string, opts: TranscribeOpts = {}): Promise<TranscribeResult> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  if (!audioPath || typeof audioPath !== "string") {
    return { ok: false, error: "transcribe: an audio path is required" };
  }

  const local = await runLocal(audioPath, opts, env);
  if (local.ok) return local;
  if (!cloudEnabled(env)) return local;

  const cloud = await runCloud(audioPath, opts, env);
  return cloud.ok ? cloud : { ok: false, error: `${local.error}; ${cloud.error}` };
}
