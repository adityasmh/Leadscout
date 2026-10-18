// src/prompt-store.ts
// Order PE1B-prompt-store: versioned prompt storage, deterministic mutation,
// and a promotion proposal (no auto-promotion). Promotion happens ONLY via
// promote(); nothing else in this module calls it.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PromptVariant, CompareResult } from "./prompt-eval.js";

// ---------------------------------------------------------------------------
// Named constants (no magic numbers).
// ---------------------------------------------------------------------------

export const DEFAULT_STORE_ROOT = "data/prompts";
export const DEFAULT_PROPOSALS_DIR = "docs/leadgen/proposals";
export const TEMP_FILE_PREFIX = ".tmp-prompt-store-";
export const OPTIONAL_MARKER = "(optional)";
export const WAITING_SENTENCE = "Waiting for a person to run promote";
export const LCG_MULTIPLIER = 1664525;
export const LCG_INCREMENT = 1013904223;
export const LCG_MODULUS = 4294967296;
export const LINE_SEPARATOR = "\n";
export const EMPTY_TEXT = "";
export const JSON_INDENT = 2;
export const NEXT_VERSION_STEP = 1;
export const LAST_LINE_OFFSET = 1;
export const SINGLE_LINE_COUNT = 1;
export const TEMP_COUNTER_START = 0;
export const DOSSIER_ID_PREFIX = "dossier-v";
export const DOSSIER_FILE_SUFFIX = ".json";
export const CURRENT_FILE_NAME = "current.json";
export const PROPOSAL_FILE_PREFIX = "prompt-v";
export const PROPOSAL_FILE_SUFFIX = ".md";
export const BASELINE_VARIANT_ID = "baseline";
export const APPLIED_VARIANT_ID = "applied-edits";

export const MUTATION_EDITS = [
  { op: "prepend-rule", text: "Cite evidence for every factual claim." },
  { op: "append-rule", text: "Keep the dossier concise and concrete." },
  { op: "shorten" },
  { op: "reorder" },
] as const;

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type PromptEdit = {
  op: "prepend-rule" | "append-rule" | "shorten" | "reorder";
  text?: string;
};

export type StoredVariant = {
  id: string;
  version: number;
  edits: PromptEdit[];
  metrics?: object;
  createdAt: string;
};

export type CurrentPointer = {
  version: number;
  previous: number | null;
};

// ---------------------------------------------------------------------------
// Edit application.
// ---------------------------------------------------------------------------

export function applyEdits(edits: PromptEdit[]): PromptVariant {
  const snapshot: PromptEdit[] = edits.map((edit) => ({ ...edit }));
  return {
    id: APPLIED_VARIANT_ID,
    transform: (p: { system: string; prompt: string }) => {
      let system: string = p.system;
      for (const edit of snapshot) {
        if (edit.op === "prepend-rule") {
          const rule: string = edit.text ?? EMPTY_TEXT;
          system =
            system === EMPTY_TEXT
              ? rule
              : rule + LINE_SEPARATOR + system;
        } else if (edit.op === "append-rule") {
          const rule: string = edit.text ?? EMPTY_TEXT;
          system =
            system === EMPTY_TEXT
              ? rule
              : system + LINE_SEPARATOR + rule;
        } else if (edit.op === "shorten") {
          system = system
            .split(LINE_SEPARATOR)
            .filter((line) => !line.startsWith(OPTIONAL_MARKER))
            .join(LINE_SEPARATOR);
        } else {
          const lines: string[] = system.split(LINE_SEPARATOR);
          if (lines.length > SINGLE_LINE_COUNT) {
            const last: string = lines[lines.length - LAST_LINE_OFFSET] ?? EMPTY_TEXT;
            const rest: string[] = lines.slice(
              TEMP_COUNTER_START,
              lines.length - LAST_LINE_OFFSET,
            );
            system = [last, ...rest].join(LINE_SEPARATOR);
          }
        }
      }
      return { system, prompt: p.prompt };
    },
  };
}

// ---------------------------------------------------------------------------
// Atomic file writes (temp file in the same folder, then rename; the temp
// file never remains, even on failure).
// ---------------------------------------------------------------------------

let tempFileCounter: number = TEMP_COUNTER_START;

function writeFileAtomic(
  folder: string,
  fileName: string,
  content: string,
): void {
  mkdirSync(folder, { recursive: true });
  tempFileCounter += NEXT_VERSION_STEP;
  const tempPath: string = join(
    folder,
    `${TEMP_FILE_PREFIX}${process.pid}-${tempFileCounter}`,
  );
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, join(folder, fileName));
  } catch (err: unknown) {
    try {
      unlinkSync(tempPath);
    } catch (cleanupErr: unknown) {
      void cleanupErr;
    }
    throw err;
  }
}

function dossierFileName(version: number): string {
  return `${DOSSIER_ID_PREFIX}${version}${DOSSIER_FILE_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Validation helpers (unknown in, typed out; no hiding casts).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reqString(
  obj: Record<string, unknown>,
  key: string,
  what: string,
): string {
  const value: unknown = obj[key];
  if (typeof value !== "string" || value.length === TEMP_COUNTER_START) {
    throw new Error(`prompt-store: ${what} needs a non-empty string ${key}`);
  }
  return value;
}

function reqVersion(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`prompt-store: ${what} needs an integer version`);
  }
  return value;
}

function parseEdit(value: unknown, what: string): PromptEdit {
  if (!isRecord(value)) {
    throw new Error(`prompt-store: ${what} edit must be an object`);
  }
  const op: unknown = value["op"];
  if (
    op !== "prepend-rule" &&
    op !== "append-rule" &&
    op !== "shorten" &&
    op !== "reorder"
  ) {
    throw new Error(`prompt-store: ${what} edit has unknown op`);
  }
  const text: unknown = value["text"];
  if (text === undefined) {
    return { op };
  }
  if (typeof text !== "string") {
    throw new Error(`prompt-store: ${what} edit text must be a string`);
  }
  return { op, text };
}

function parseStoredVariant(value: unknown, what: string): StoredVariant {
  if (!isRecord(value)) {
    throw new Error(`prompt-store: ${what} must be an object`);
  }
  const id: string = reqString(value, "id", what);
  const version: number = reqVersion(value["version"], what);
  const rawEdits: unknown = value["edits"];
  if (!Array.isArray(rawEdits)) {
    throw new Error(`prompt-store: ${what} needs an edits array`);
  }
  const edits: PromptEdit[] = rawEdits.map((e: unknown, i: number) =>
    parseEdit(e, `${what} edits[${i}]`),
  );
  const createdAt: string = reqString(value, "createdAt", what);
  const metrics: unknown = value["metrics"];
  if (metrics === undefined) {
    return { id, version, edits, createdAt };
  }
  if (typeof metrics !== "object" || metrics === null) {
    throw new Error(`prompt-store: ${what} metrics must be an object`);
  }
  return { id, version, edits, metrics, createdAt };
}

function readCurrentPointer(root: string): CurrentPointer {
  const raw: string = readFileSync(join(root, CURRENT_FILE_NAME), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("prompt-store: current.json must be an object");
  }
  const version: number = reqVersion(parsed["version"], "current.json");
  const previous: unknown = parsed["previous"];
  if (previous === null) {
    return { version, previous: null };
  }
  return { version, previous: reqVersion(previous, "current.json") };
}

// ---------------------------------------------------------------------------
// Version storage.
// ---------------------------------------------------------------------------

export function saveVariant(
  root: string = DEFAULT_STORE_ROOT,
  variant: StoredVariant,
): void {
  const content: string =
    JSON.stringify(variant, null, JSON_INDENT) + LINE_SEPARATOR;
  writeFileAtomic(root, dossierFileName(variant.version), content);
}

export function loadVariant(
  root: string = DEFAULT_STORE_ROOT,
  version: number,
): StoredVariant {
  const raw: string = readFileSync(
    join(root, dossierFileName(version)),
    "utf8",
  );
  const parsed: unknown = JSON.parse(raw);
  return parseStoredVariant(parsed, dossierFileName(version));
}

// ---------------------------------------------------------------------------
// Promotion (the ONLY writer of current.json) and rollback.
// ---------------------------------------------------------------------------

export function promote(
  root: string = DEFAULT_STORE_ROOT,
  version: number,
): void {
  const fileName: string = dossierFileName(version);
  if (!existsSync(join(root, fileName))) {
    throw new Error(`prompt-store: cannot promote missing ${fileName}`);
  }
  let previous: number | null = null;
  if (existsSync(join(root, CURRENT_FILE_NAME))) {
    previous = readCurrentPointer(root).version;
  }
  const pointer: CurrentPointer = { version, previous };
  writeFileAtomic(
    root,
    CURRENT_FILE_NAME,
    JSON.stringify(pointer, null, JSON_INDENT) + LINE_SEPARATOR,
  );
}

export function rollback(root: string = DEFAULT_STORE_ROOT): void {
  if (!existsSync(join(root, CURRENT_FILE_NAME))) {
    throw new Error(
      "prompt-store: cannot rollback because current.json is absent",
    );
  }
  const current: CurrentPointer = readCurrentPointer(root);
  if (current.previous === null) {
    throw new Error(
      "prompt-store: cannot rollback because previous is null",
    );
  }
  const pointer: CurrentPointer = {
    version: current.previous,
    previous: current.version,
  };
  writeFileAtomic(
    root,
    CURRENT_FILE_NAME,
    JSON.stringify(pointer, null, JSON_INDENT) + LINE_SEPARATOR,
  );
}

// ---------------------------------------------------------------------------
// Deterministic mutation. createdAt is copied from the input variant (not
// Date.now()) so the same seed and same input always give the same output.
// ---------------------------------------------------------------------------

export function mutate(variant: StoredVariant, seed: number): StoredVariant {
  const truncated: number = Math.trunc(seed);
  const positiveSeed: number =
    ((truncated % LCG_MODULUS) + LCG_MODULUS) % LCG_MODULUS;
  const rand: number =
    (LCG_MULTIPLIER * positiveSeed + LCG_INCREMENT) % LCG_MODULUS;
  const index: number = rand % MUTATION_EDITS.length;
  const picked = MUTATION_EDITS[index];
  if (picked === undefined) {
    throw new Error("prompt-store: mutation edit list is empty");
  }
  const nextVersion: number = variant.version + NEXT_VERSION_STEP;
  const nextEdit: PromptEdit =
    "text" in picked ? { op: picked.op, text: picked.text } : { op: picked.op };
  return {
    id: `${DOSSIER_ID_PREFIX}${nextVersion}`,
    version: nextVersion,
    edits: [...variant.edits.map((edit) => ({ ...edit })), nextEdit],
    metrics: variant.metrics,
    createdAt: variant.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Promotion proposal (never promotes, never writes current.json).
// ---------------------------------------------------------------------------

function parseDossierVersion(variantId: string): number {
  if (!variantId.startsWith(DOSSIER_ID_PREFIX)) {
    throw new Error(
      `prompt-store: candidate variantId ${variantId} is not ${DOSSIER_ID_PREFIX}<N>`,
    );
  }
  const digits: string = variantId.slice(DOSSIER_ID_PREFIX.length);
  if (digits.length === TEMP_COUNTER_START) {
    throw new Error(
      `prompt-store: candidate variantId ${variantId} is not ${DOSSIER_ID_PREFIX}<N>`,
    );
  }
  const parsed: number = Number(digits);
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `prompt-store: candidate variantId ${variantId} is not ${DOSSIER_ID_PREFIX}<N>`,
    );
  }
  return parsed;
}

export function proposePromotion(
  root: string = DEFAULT_STORE_ROOT,
  proposalsDir: string = DEFAULT_PROPOSALS_DIR,
  comparison: CompareResult,
): string {
  void root;
  const baseline = comparison.ranked.find(
    (entry) => entry.variantId === BASELINE_VARIANT_ID,
  );
  if (baseline === undefined) {
    throw new Error("prompt-store: comparison has no baseline entry");
  }
  const candidate = comparison.ranked.find(
    (entry) => entry.variantId !== BASELINE_VARIANT_ID,
  );
  if (candidate === undefined) {
    throw new Error("prompt-store: comparison has no non-baseline candidate");
  }
  const candidateVersion: number = parseDossierVersion(candidate.variantId);
  const fileName: string = `${PROPOSAL_FILE_PREFIX}${candidateVersion}${PROPOSAL_FILE_SUFFIX}`;
  const lines: string[] = [
    `# Prompt promotion proposal: ${PROPOSAL_FILE_PREFIX}${candidateVersion}`,
    EMPTY_TEXT,
    `Baseline (\`${BASELINE_VARIANT_ID}\`):`,
    `- loss: ${baseline.loss}`,
    `- unsupportedClaims: ${baseline.eval.unsupportedClaims}`,
    `- tokens: ${baseline.eval.tokens}`,
    EMPTY_TEXT,
    `Candidate (\`${candidate.variantId}\`):`,
    `- loss: ${candidate.loss}`,
    `- unsupportedClaims: ${candidate.eval.unsupportedClaims}`,
    `- tokens: ${candidate.eval.tokens}`,
    EMPTY_TEXT,
    WAITING_SENTENCE,
    EMPTY_TEXT,
  ];
  mkdirSync(proposalsDir, { recursive: true });
  writeFileAtomic(proposalsDir, fileName, lines.join(LINE_SEPARATOR));
  return join(proposalsDir, fileName);
}
