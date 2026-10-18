
import type { LlmFn } from "./types-v2.js";
import {
  BASELINE_ID,
  MIN_IMPROVEMENT,
  TOKEN_DIVISOR,
  W_INVENTED,
  W_MISSING,
  W_REPEAT,
  W_UNSUPPORTED,
  compareVariants,
  evaluatePrompt,
  lossOf,
  type PromptEval,
  type PromptVariant,
} from "./prompt-eval.js";

// ---------------------------------------------------------------------------
// Named constants (no magic numbers).
// ---------------------------------------------------------------------------

const NOISY_MARKER = "prompt-eval noisy marker 7f3a";
const TIGHT_MARKER = "prompt-eval tight marker 9c1e";
const INVENTED_SUFFIX = " Rated 4.9 stars from 5000 reviews.";
const DRAFT_MARKER = "DRAFT TO REWRITE";
const FAKE_TOKENS_IN = 100;
const FAKE_TOKENS_OUT = 50;
const FAKE_MODEL_NAME = "prompt-eval-fake-model";
const LOSS_EPSILON = 1e-9;
const ZERO_COUNT = 0;

// ---------------------------------------------------------------------------
// Fake models. A plain LlmFn only receives system/prompt, so each fake recovers
// the level-0 draft from the prompt text: buildPrompt (dossier-prompts.ts)
// embeds it as JSON after the "DRAFT TO REWRITE" marker. Recovery is possible,
// so no signature change was needed.
// ---------------------------------------------------------------------------

type CitedJson = { value: string; evidence: string[] };
type DraftPayload = {
  gap: { headline: CitedJson; tag: string } | null;
  sayThis: CitedJson | null;
  pushback: CitedJson | null;
  offers: {
    service: string;
    description: CitedJson;
    whyItMatters: CitedJson;
  }[];
};

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`prompt-eval-check: expected object for ${what}`);
  }
  return value as Record<string, unknown>;
}

function asCitedJson(value: unknown, what: string): CitedJson {
  const obj = asRecord(value, what);
  const val: unknown = obj["value"];
  const ev: unknown = obj["evidence"];
  if (typeof val !== "string" || !Array.isArray(ev)) {
    throw new Error(`prompt-eval-check: ${what} needs value string and evidence array`);
  }
  const ids: string[] = [];
  for (const id of ev) {
    if (typeof id !== "string") {
      throw new Error(`prompt-eval-check: ${what} evidence ids must be strings`);
    }
    ids.push(id);
  }
  return { value: val, evidence: ids };
}

function balancedJsonObject(text: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(
    "prompt-eval-check: draft JSON object after DRAFT TO REWRITE marker is unbalanced",
  );
}

function draftFromPrompt(prompt: string): DraftPayload {
  const markerAt = prompt.indexOf(DRAFT_MARKER);
  if (markerAt < 0) {
    throw new Error(
      "prompt-eval-check: DRAFT TO REWRITE marker missing from prompt text",
    );
  }
  const braceAt = prompt.indexOf("{", markerAt);
  if (braceAt < 0) {
    throw new Error(
      "prompt-eval-check: no draft JSON object found after DRAFT TO REWRITE marker",
    );
  }
  const parsed: unknown = JSON.parse(balancedJsonObject(prompt, braceAt));
  const obj = asRecord(parsed, "draft payload");
  const gapRaw: unknown = obj["gap"];
  let gap: DraftPayload["gap"] = null;
  if (gapRaw !== null && gapRaw !== undefined) {
    const gapObj = asRecord(gapRaw, "draft gap");
    const tag: unknown = gapObj["tag"];
    if (typeof tag !== "string") {
      throw new Error("prompt-eval-check: draft gap.tag must be a string");
    }
    gap = { headline: asCitedJson(gapObj["headline"], "draft gap.headline"), tag };
  }
  const sayRaw: unknown = obj["sayThis"];
  const pushRaw: unknown = obj["pushback"];
  const offersRaw: unknown = obj["offers"];
  if (!Array.isArray(offersRaw)) {
    throw new Error("prompt-eval-check: draft offers must be an array");
  }
  const offers: DraftPayload["offers"] = offersRaw.map((o: unknown) => {
    const offer = asRecord(o, "draft offer");
    const service: unknown = offer["service"];
    if (typeof service !== "string") {
      throw new Error("prompt-eval-check: draft offer.service must be a string");
    }
    return {
      service,
      description: asCitedJson(offer["description"], "draft offer.description"),
      whyItMatters: asCitedJson(offer["whyItMatters"], "draft offer.whyItMatters"),
    };
  });
  return {
    gap,
    sayThis:
      sayRaw === null || sayRaw === undefined
        ? null
        : asCitedJson(sayRaw, "draft sayThis"),
    pushback:
      pushRaw === null || pushRaw === undefined
        ? null
        : asCitedJson(pushRaw, "draft pushback"),
    offers,
  };
}

// Echoes the draft verbatim when makeDirty returns false; otherwise appends an
// invented rating to sayThis (numbers absent from every evidence quote plus
// review words without structured-data rating evidence, so cite-check drops it).
function makeFakeLlm(makeDirty: (prompt: string) => boolean): LlmFn {
  return async (req) => {
    const draft = draftFromPrompt(req.prompt);
    const dirty = makeDirty(req.prompt);
    const sayThis =
      draft.sayThis === null
        ? null
        : {
            value: dirty
              ? `${draft.sayThis.value}${INVENTED_SUFFIX}`
              : draft.sayThis.value,
            evidence: [...draft.sayThis.evidence],
          };
    const text = JSON.stringify({
      gap: draft.gap
        ? { headline: { ...draft.gap.headline }, tag: draft.gap.tag }
        : undefined,
      sayThis,
      pushback: draft.pushback ? { ...draft.pushback } : null,
      offers: draft.offers.map((o) => ({
        service: o.service,
        description: { ...o.description },
        whyItMatters: { ...o.whyItMatters },
      })),
    });
    return {
      text,
      tokensIn: FAKE_TOKENS_IN,
      tokensOut: FAKE_TOKENS_OUT,
      model: FAKE_MODEL_NAME,
    };
  };
}

const honestFake: LlmFn = makeFakeLlm(() => false);
const noisySensitiveFake: LlmFn = makeFakeLlm((prompt) =>
  prompt.includes(NOISY_MARKER),
);
const tightSensitiveFake: LlmFn = makeFakeLlm(
  (prompt) => !prompt.includes(TIGHT_MARKER),
);

// ---------------------------------------------------------------------------
// Variants.
// ---------------------------------------------------------------------------

const baselineVariant: PromptVariant = {
  id: BASELINE_ID,
  transform: (p) => ({ system: p.system, prompt: p.prompt }),
};

const noisyVariant: PromptVariant = {
  id: "noisy",
  transform: (p) => ({
    system: p.system,
    prompt: `${p.prompt}\n${NOISY_MARKER}`,
  }),
};

const tightVariant: PromptVariant = {
  id: "tight",
  transform: (p) => ({
    system: p.system,
    prompt: `${p.prompt}\n${TIGHT_MARKER}`,
  }),
};

// ---------------------------------------------------------------------------
// Checks.
// ---------------------------------------------------------------------------

function handLoss(e: PromptEval): number {
  return (
    W_UNSUPPORTED * e.unsupportedClaims +
    W_INVENTED * e.inventedNumbers +
    W_MISSING * e.missingSections +
    W_REPEAT * e.repeatedPhrasing +
    e.tokens / TOKEN_DIVISOR
  );
}

function rankIds(ranked: { variantId: string }[]): string {
  return ranked.map((r) => r.variantId).join(",");
}

const results: { name: string; ok: boolean; detail: string }[] = [];

function report(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name} (${detail})`);
  results.push({ name, ok, detail });
}

const honest = await evaluatePrompt(baselineVariant, honestFake);
report(
  "honest baseline scores clean",
  honest.unsupportedClaims === ZERO_COUNT &&
    honest.inventedNumbers === ZERO_COUNT,
  `unsupported=${honest.unsupportedClaims} invented=${honest.inventedNumbers}`,
);

const noisyCompare = await compareVariants(
  [baselineVariant, noisyVariant],
  noisySensitiveFake,
);
const noisyEval = noisyCompare.ranked.find((r) => r.variantId === "noisy");
const baseEval2 = noisyCompare.ranked.find((r) => r.variantId === BASELINE_ID);
const noisyWorse =
  noisyEval !== undefined &&
  baseEval2 !== undefined &&
  noisyEval.loss > baseEval2.loss &&
  rankIds(noisyCompare.ranked) === `${BASELINE_ID},noisy`;
report(
  "noisy scores worse and ranks below baseline",
  noisyWorse,
  `order=${rankIds(noisyCompare.ranked)} baselineLoss=${baseEval2?.loss ?? "?"}` +
    ` noisyLoss=${noisyEval?.loss ?? "?"} baselineUnsupported=${baseEval2?.eval.unsupportedClaims ?? "?"}` +
    ` noisyUnsupported=${noisyEval?.eval.unsupportedClaims ?? "?"}`,
);

const tightCompare = await compareVariants(
  [tightVariant, baselineVariant],
  tightSensitiveFake,
);
const tightFirst = tightCompare.ranked[0]?.variantId === "tight";
report(
  "tight ranks above baseline and proposes switch",
  tightFirst && tightCompare.proposeSwitch === true,
  `order=${rankIds(tightCompare.ranked)} proposeSwitch=${tightCompare.proposeSwitch}` +
    ` improvement>=${MIN_IMPROVEMENT}`,
);

const cleanCompare = await compareVariants(
  [tightVariant, baselineVariant],
  honestFake,
);
report(
  "no switch when baseline has zero unsupported",
  cleanCompare.proposeSwitch === false,
  `proposeSwitch=${cleanCompare.proposeSwitch}` +
    ` baselineUnsupported=${cleanCompare.ranked.find((r) => r.variantId === BASELINE_ID)?.eval.unsupportedClaims ?? "?"}`,
);

const rerun = await compareVariants(
  [tightVariant, baselineVariant],
  tightSensitiveFake,
);
const deterministic =
  rankIds(rerun.ranked) === rankIds(tightCompare.ranked) &&
  rerun.proposeSwitch === tightCompare.proposeSwitch &&
  rerun.ranked.every((r, i) => r.loss === tightCompare.ranked[i]?.loss);
report(
  "ranking deterministic across two runs",
  deterministic,
  `first=${rankIds(tightCompare.ranked)} second=${rankIds(rerun.ranked)}`,
);

const sample = tightCompare.ranked[0];
const lossMatches =
  sample !== undefined &&
  Math.abs(handLoss(sample.eval) - sample.loss) < LOSS_EPSILON &&
  Math.abs(lossOf(sample.eval) - sample.loss) < LOSS_EPSILON;
report(
  "loss weights applied (hand-computed)",
  lossMatches,
  `variant=${sample?.variantId ?? "?"} reported=${sample?.loss ?? "?"}` +
    ` hand=${sample ? handLoss(sample.eval) : "?"} weights=10/10/5/20/1000`,
);

const passed = results.filter((r) => r.ok).length;
console.log(`PE1A prompt-eval: ${passed}/${results.length} checks passed`);
process.exitCode = passed === results.length ? 0 : 1;
