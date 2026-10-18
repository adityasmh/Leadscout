// src/prompt-store-check.ts
// Order PE1B-prompt-store proof: offline checks over temp folders only.
// Prints one PASS/FAIL line per item; exits non-zero if any FAIL.

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompareResult } from "./prompt-eval.js";
import {
  TEMP_FILE_PREFIX,
  WAITING_SENTENCE,
  applyEdits,
  loadVariant,
  mutate,
  promote,
  proposePromotion,
  rollback,
  saveVariant,
} from "./prompt-store.js";
import type { StoredVariant } from "./prompt-store.js";

// ---------------------------------------------------------------------------
// Named constants (no magic numbers).
// ---------------------------------------------------------------------------

const SCRATCH_PREFIX = "leadscout-prompt-store-check-";
const MUTATE_SEED_A = 1;
const MUTATE_SEED_B = 2;
const VERSION_ONE = 1;
const VERSION_TWO = 2;
const VERSION_MISSING = 9;
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const SYSTEM_TEXT = "alpha\n(optional) beta\ngamma";
const RULE_TEXT = "RULE: be concrete.";
const EXPECT_PREPEND = "RULE: be concrete.\nalpha\n(optional) beta\ngamma";
const EXPECT_APPEND = "alpha\n(optional) beta\ngamma\nRULE: be concrete.";
const EXPECT_SHORTEN = "alpha\ngamma";
const EXPECT_REORDER = "gamma\nalpha\n(optional) beta";
const PROMPT_TEXT = "write the dossier";
const FIXED_CREATED_AT = "2026-10-01T00:00:00.000Z";
const CANDIDATE_LOSS = 12.5;
const CANDIDATE_UNSUPPORTED = 1;
const CANDIDATE_TOKENS = 300;
const BASELINE_LOSS = 25.75;
const BASELINE_UNSUPPORTED = 3;
const BASELINE_TOKENS = 500;

// ---------------------------------------------------------------------------
// Tiny harness.
// ---------------------------------------------------------------------------

let failures = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`PASS: ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL: ${name}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Fixtures (built by hand; never calls compareVariants/evaluatePrompt).
// ---------------------------------------------------------------------------

const root: string = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
const proposalsDir: string = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));

const variantOne: StoredVariant = {
  id: "dossier-v1",
  version: VERSION_ONE,
  edits: [{ op: "prepend-rule", text: RULE_TEXT }],
  metrics: { loss: BASELINE_LOSS },
  createdAt: FIXED_CREATED_AT,
};

const comparison: CompareResult = {
  ranked: [
    {
      variantId: "dossier-v2",
      loss: CANDIDATE_LOSS,
      eval: {
        variantId: "dossier-v2",
        unsupportedClaims: CANDIDATE_UNSUPPORTED,
        inventedNumbers: 0,
        missingSections: 0,
        repeatedPhrasing: 0,
        tokens: CANDIDATE_TOKENS,
        perCase: [],
      },
    },
    {
      variantId: "baseline",
      loss: BASELINE_LOSS,
      eval: {
        variantId: "baseline",
        unsupportedClaims: BASELINE_UNSUPPORTED,
        inventedNumbers: 0,
        missingSections: 0,
        repeatedPhrasing: 0,
        tokens: BASELINE_TOKENS,
        perCase: [],
      },
    },
  ],
  proposeSwitch: true,
};

// ---------------------------------------------------------------------------
// save/load round-trip.
// ---------------------------------------------------------------------------

saveVariant(root, variantOne);
check(
  "save/load round-trip deep-equals",
  deepEqual(loadVariant(root, VERSION_ONE), variantOne),
);

// ---------------------------------------------------------------------------
// promote pointer + previous.
// ---------------------------------------------------------------------------

promote(root, VERSION_ONE);
const variantTwo: StoredVariant = {
  id: "dossier-v2",
  version: VERSION_TWO,
  edits: [],
  createdAt: FIXED_CREATED_AT,
};
saveVariant(root, variantTwo);
promote(root, VERSION_TWO);
check(
  "promote writes pointer and keeps previous",
  deepEqual(
    JSON.parse(readFileSync(join(root, "current.json"), "utf8")),
    { version: 2, previous: 1 },
  ),
);

let promoteMissingThrew = false;
try {
  promote(root, VERSION_MISSING);
} catch (err: unknown) {
  promoteMissingThrew =
    err instanceof Error && err.message.includes("dossier-v9.json");
}
check("promote fails clearly when dossier file is missing", promoteMissingThrew);

// ---------------------------------------------------------------------------
// rollback restores; rollback fails when previous is null.
// ---------------------------------------------------------------------------

rollback(root);
check(
  "rollback restores previous pointer",
  deepEqual(
    JSON.parse(readFileSync(join(root, "current.json"), "utf8")),
    { version: 1, previous: 2 },
  ),
);

rollback(root);
check(
  "rollback swaps back to version 2",
  deepEqual(
    JSON.parse(readFileSync(join(root, "current.json"), "utf8")),
    { version: 2, previous: 1 },
  ),
);

const freshRoot: string = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
saveVariant(freshRoot, variantOne);
promote(freshRoot, VERSION_ONE);
let rollbackNullThrew = false;
try {
  rollback(freshRoot);
} catch (err: unknown) {
  rollbackNullThrew =
    err instanceof Error && err.message.includes("previous is null");
}
check("rollback throws when previous is null", rollbackNullThrew);

// ---------------------------------------------------------------------------
// mutate determinism + difference.
// ---------------------------------------------------------------------------

const mutatedA1: StoredVariant = mutate(variantOne, MUTATE_SEED_A);
const mutatedA2: StoredVariant = mutate(variantOne, MUTATE_SEED_A);
check("mutate deterministic for one seed", deepEqual(mutatedA1, mutatedA2));

const mutatedB: StoredVariant = mutate(variantOne, MUTATE_SEED_B);
check(
  "mutate differs for another seed",
  !deepEqual(mutatedA1, mutatedB) &&
    mutatedA1.version === VERSION_TWO &&
    mutatedB.version === VERSION_TWO &&
    mutatedA1.edits.length === variantOne.edits.length + 1 &&
    mutatedB.edits.length === variantOne.edits.length + 1,
);

// ---------------------------------------------------------------------------
// applyEdits: one assertion per op.
// ---------------------------------------------------------------------------

check(
  "applyEdits prepend-rule puts rule on its own first line",
  (() => {
    const out = applyEdits([{ op: "prepend-rule", text: RULE_TEXT }]).transform(
      { system: SYSTEM_TEXT, prompt: PROMPT_TEXT },
    );
    return out.system === EXPECT_PREPEND && out.prompt === PROMPT_TEXT;
  })(),
);

check(
  "applyEdits append-rule puts rule on its own last line",
  (() => {
    const out = applyEdits([{ op: "append-rule", text: RULE_TEXT }]).transform(
      { system: SYSTEM_TEXT, prompt: PROMPT_TEXT },
    );
    return out.system === EXPECT_APPEND && out.prompt === PROMPT_TEXT;
  })(),
);

check(
  "applyEdits shorten removes lines starting with (optional)",
  (() => {
    const out = applyEdits([{ op: "shorten" }]).transform({
      system: SYSTEM_TEXT,
      prompt: PROMPT_TEXT,
    });
    return out.system === EXPECT_SHORTEN && out.prompt === PROMPT_TEXT;
  })(),
);

check(
  "applyEdits reorder moves last line to front",
  (() => {
    const out = applyEdits([{ op: "reorder" }]).transform({
      system: SYSTEM_TEXT,
      prompt: PROMPT_TEXT,
    });
    return out.system === EXPECT_REORDER && out.prompt === PROMPT_TEXT;
  })(),
);

// ---------------------------------------------------------------------------
// proposePromotion: file content + current.json untouched.
// ---------------------------------------------------------------------------

const beforeBytes: Buffer = readFileSync(join(root, "current.json"));
const writtenPath: string = proposePromotion(root, proposalsDir, comparison);
const proposalText: string = readFileSync(writtenPath, "utf8");
check(
  "proposePromotion writes prompt-v2.md with numbers and sentence",
  writtenPath === join(proposalsDir, "prompt-v2.md") &&
    proposalText.includes(`- loss: ${CANDIDATE_LOSS}`) &&
    proposalText.includes(`- unsupportedClaims: ${CANDIDATE_UNSUPPORTED}`) &&
    proposalText.includes(`- tokens: ${CANDIDATE_TOKENS}`) &&
    proposalText.includes(`- loss: ${BASELINE_LOSS}`) &&
    proposalText.includes(`- unsupportedClaims: ${BASELINE_UNSUPPORTED}`) &&
    proposalText.includes(`- tokens: ${BASELINE_TOKENS}`) &&
    proposalText.includes(WAITING_SENTENCE),
);

const afterBytes: Buffer = readFileSync(join(root, "current.json"));
check(
  "proposePromotion leaves current.json bytes identical",
  beforeBytes.equals(afterBytes),
);

// ---------------------------------------------------------------------------
// No leftover temp files.
// ---------------------------------------------------------------------------

function hasTempFiles(dir: string): boolean {
  return readdirSync(dir).some((name) => name.startsWith(TEMP_FILE_PREFIX));
}

check(
  "no leftover temp files and only expected names remain",
  !hasTempFiles(root) &&
    !hasTempFiles(proposalsDir) &&
    deepEqual(readdirSync(root).sort(), [
      "current.json",
      "dossier-v1.json",
      "dossier-v2.json",
    ]) &&
    deepEqual(readdirSync(proposalsDir).sort(), ["prompt-v2.md"]),
);

if (failures > 0) {
  console.log(`FAILURES: ${failures}`);
  process.exit(EXIT_FAIL);
} else {
  console.log("ALL PASS");
  process.exit(EXIT_OK);
}
