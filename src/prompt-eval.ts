// src/prompt-eval.ts
// Order PE1A-prompt-eval: score a dossier prompt variant on the quality fixtures
// (fixtures-v2/quality/cases.json) through the real evidence builder (evidence.js),
// the real dossier module (dossier.js) with an injected model function, and the real
// citation checker (cite-check.js). Reuses the quality-harness approach from
// quality-check.ts (helpers copied; that module is never imported because it runs
// checks at import time).

import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Dossier,
  DossierOffer,
  Evidence,
  LeadScore,
  LlmFn,
  PriceBook,
} from "./types-v2.js";
import type { DossierInput } from "./dossier.js";
import type { CiteCtx } from "./cite-check.js";

process.env.LEADSCOUT_DB = join(
  mkdtempSync(join(tmpdir(), "leadscout-prompt-eval-")),
  "eval.db",
);

const { buildEvidence, extractFacts } = await import("./evidence.js");
const { buildTemplateDossier, polishDossier } = await import("./dossier.js");
const { checkDossier } = await import("./cite-check.js");

// ---------------------------------------------------------------------------
// Named constants (no magic numbers).
// ---------------------------------------------------------------------------

export const W_UNSUPPORTED = 10;
export const W_INVENTED = 10;
export const W_MISSING = 5;
export const W_REPEAT = 20;
export const TOKEN_DIVISOR = 1000;
export const MIN_IMPROVEMENT = 0.1;
export const BASELINE_ID = "baseline";
export const CHARS_PER_TOKEN = 4;
export const TRIGRAM_SIZE = 3;

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type PromptVariant = {
  id: string;
  transform: (p: { system: string; prompt: string }) => {
    system: string;
    prompt: string;
  };
};

export type PromptCaseEval = {
  id: string;
  unsupported: number;
  invented: number;
  missing: number;
  tokens: number;
};

export type PromptEval = {
  variantId: string;
  unsupportedClaims: number;
  inventedNumbers: number;
  missingSections: number;
  repeatedPhrasing: number;
  tokens: number;
  perCase: PromptCaseEval[];
};

export type RankedVariant = {
  variantId: string;
  loss: number;
  eval: PromptEval;
};

export type CompareResult = {
  ranked: RankedVariant[];
  proposeSwitch: boolean;
};

// ---------------------------------------------------------------------------
// Fixture loading (copied from quality-check.ts; shapes kept identical).
// ---------------------------------------------------------------------------

type FixturePage = { title: string; text: string; url: string };
type FixtureBusiness = {
  name: string;
  category: string;
  city: string;
  phone: string;
  website: string;
};
type QualityCase = {
  id: string;
  business: FixtureBusiness;
  pages: FixturePage[];
  absent: string[];
};

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`prompt-eval: expected object for ${what}`);
  }
  return value as Record<string, unknown>;
}

function reqStr(obj: Record<string, unknown>, key: string, what: string): string {
  const value: unknown = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`prompt-eval: ${what} needs string field ${key}`);
  }
  return value;
}

function optStr(obj: Record<string, unknown>, key: string): string {
  const value: unknown = obj[key];
  return typeof value === "string" ? value : "";
}

function parseCase(value: unknown): QualityCase {
  const obj = asRecord(value, "case");
  const id = reqStr(obj, "id", "case");
  const biz = asRecord(obj["business"], `case ${id} business`);
  const rawPages: unknown = obj["pages"];
  if (!Array.isArray(rawPages) || rawPages.length === 0) {
    throw new Error(`prompt-eval: case ${id} needs a non-empty pages array`);
  }
  const pages: FixturePage[] = rawPages.map((p: unknown) => {
    const page = asRecord(p, `case ${id} page`);
    return {
      title: optStr(page, "title"),
      text: reqStr(page, "text", `case ${id} page`),
      url: optStr(page, "url"),
    };
  });
  const truth = asRecord(obj["truth"], `case ${id} truth`);
  const rawAbsent: unknown = truth["absent"];
  if (!Array.isArray(rawAbsent)) {
    throw new Error(`prompt-eval: case ${id} truth.absent must be an array`);
  }
  const absent: string[] = rawAbsent.map((a: unknown) => {
    if (typeof a !== "string") {
      throw new Error(`prompt-eval: case ${id} truth.absent must be strings`);
    }
    return a;
  });
  return {
    id,
    business: {
      name: reqStr(biz, "name", `case ${id} business`),
      category: reqStr(biz, "category", `case ${id} business`),
      city: reqStr(biz, "city", `case ${id} business`),
      phone: optStr(biz, "phone"),
      website: optStr(biz, "website"),
    },
    pages,
    absent,
  };
}

function loadCases(): QualityCase[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(
    join(here, "..", "fixtures-v2", "quality", "cases.json"),
    "utf8",
  );
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("prompt-eval: cases.json must be an array");
  }
  return parsed.map((c: unknown) => parseCase(c));
}

// ---------------------------------------------------------------------------
// Dossier input construction (copied from quality-check.ts).
// ---------------------------------------------------------------------------

const FETCHED_AT = "2026-10-01T00:00:00.000Z";
const WORKSPACE_ID = "ws-prompt-eval";
const WORKSPACE_NAME = "Prompt Eval";
const FIXTURE_SOURCE = "fixture";
const PRICEBOOK_VERSION = 1;
const OFFER_DESCRIPTION = "Prompt eval test offer";
const SCORE_TOTAL = 80;
const SCORE_FIT = 80;
const SCORE_REACH = 50;
const SCORE_TIMING = 50;
const FIT_SCORE = 80;
const PRIMARY_SIGNAL = "no-analytics";
const SECONDARY_SIGNALS = [
  "no-contact-form",
  "no-chat-widget",
  "no-online-booking",
] as const;

type EvalService = {
  service: string;
  label: string;
  description: string;
  why: string;
};

const EVAL_SERVICES = [
  {
    service: "website",
    label: "new website",
    description:
      "a simple mobile friendly website that lists services and a contact route for this business",
    why: "lets new enquiries find the business and get in touch",
  },
  {
    service: "booking",
    label: "online booking setup",
    description:
      "a simple booking page that takes visit requests and sends confirmations for this business",
    why: "captures enquiries outside office hours without phone tag",
  },
  {
    service: "chatbot",
    label: "chat assistant",
    description:
      "a small chat helper that answers common questions and collects contact details for this business",
    why: "answers repeat questions and keeps every enquiry",
  },
] as const;

const PRICEBOOK_ASSUMPTION = "scope confirmed after a short site walkthrough";
const SCORE_REASON = "prompt eval fixed score";

function pickService(index: number): EvalService {
  const item: unknown = EVAL_SERVICES[index % EVAL_SERVICES.length];
  if (typeof item !== "object" || item === null) {
    throw new Error("prompt-eval: service rotation is empty");
  }
  return item as EvalService;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function firstSentence(text: string): string {
  const match = text.match(/[^.!?]+[.!?]/);
  return (match ? match[0] : text.slice(0, 200)).trim();
}

function buildPriceBook(): PriceBook {
  return {
    workspaceId: WORKSPACE_ID,
    version: PRICEBOOK_VERSION,
    updatedAt: FETCHED_AT,
    items: EVAL_SERVICES.map((s, i) => ({
      service: s.service,
      label: s.label,
      description: s.description,
      buildDays: null,
      price: null,
      assumption: PRICEBOOK_ASSUMPTION,
      doorOpener: i === 0,
    })),
  };
}

function buildInput(
  c: QualityCase,
  index: number,
  evidence: Evidence[],
): DossierInput {
  const first = pickService(index);
  const second = pickService(index + 1);
  const raw = {
    name: c.business.name,
    category: c.business.category,
    city: c.business.city,
    phone: c.business.phone,
    website: c.business.website,
    source: FIXTURE_SOURCE,
    sourceUrl: c.business.website,
  };
  const secondary: string =
    SECONDARY_SIGNALS[index % SECONDARY_SIGNALS.length] ?? "no-contact-form";
  const enrichment = {
    summary: firstSentence(c.pages[0]?.text ?? c.business.name),
    emails: [],
    phones: c.business.phone === "" ? [] : [c.business.phone],
    socials: {},
    signals: [PRIMARY_SIGNAL, secondary],
    language: "en",
  };
  const match = {
    score: SCORE_TOTAL,
    fit: [first, second].map((s) => ({
      service: s.service,
      score: FIT_SCORE,
      reason: `fixture fit for ${s.service}`,
    })),
    angle: "",
  };
  const lead = {
    ...raw,
    ...enrichment,
    ...match,
    id: `lead-${c.id}`,
    workspaceId: WORKSPACE_ID,
    status: "new",
    notes: "",
    createdAt: FETCHED_AT,
  } as DossierInput["lead"];
  const score: LeadScore = {
    total: SCORE_TOTAL,
    fit: SCORE_FIT,
    reach: SCORE_REACH,
    timing: SCORE_TIMING,
    gate: "template",
    reasons: [SCORE_REASON],
  };
  return {
    lead,
    evidence,
    facts: extractFacts(evidence, raw),
    score,
    priceBook: buildPriceBook(),
    explainer: null,
    workspaceName: WORKSPACE_NAME,
    offer: {
      services: EVAL_SERVICES.map((s) => s.service),
      description: OFFER_DESCRIPTION,
    },
  };
}

function buildPages(
  c: QualityCase,
): { url: string; body: string; fetchedAt: string }[] {
  return c.pages.map((p, i) => ({
    url: p.url === "" ? `${FIXTURE_SOURCE}://${c.id}/p${i}` : p.url,
    body: `<html><head><title>${escapeHtml(p.title)}</title></head><body><p>${escapeHtml(p.text)}</p></body></html>`,
    fetchedAt: FETCHED_AT,
  }));
}

// ---------------------------------------------------------------------------
// Metrics (copied from quality-check.ts).
// ---------------------------------------------------------------------------

type Claim = { path: string; value: string; evidence: string[] };

function collectClaims(d: Dossier): Claim[] {
  const out: Claim[] = [];
  if (d.facts.owner !== undefined) {
    out.push({
      path: "facts.owner",
      value: d.facts.owner.value,
      evidence: d.facts.owner.evidence,
    });
  }
  if (d.facts.sinceYear !== undefined) {
    out.push({
      path: "facts.sinceYear",
      value: String(d.facts.sinceYear.value),
      evidence: d.facts.sinceYear.evidence,
    });
  }
  if (d.facts.rating !== undefined) {
    out.push({
      path: "facts.rating",
      value: String(d.facts.rating.value),
      evidence: d.facts.rating.evidence,
    });
  }
  if (d.facts.reviewCount !== undefined) {
    out.push({
      path: "facts.reviewCount",
      value: String(d.facts.reviewCount.value),
      evidence: d.facts.reviewCount.evidence,
    });
  }
  if (d.facts.area !== undefined) {
    out.push({
      path: "facts.area",
      value: d.facts.area.value,
      evidence: d.facts.area.evidence,
    });
  }
  if (d.gap !== null) {
    out.push({
      path: "gap.headline",
      value: d.gap.headline.value,
      evidence: d.gap.headline.evidence,
    });
  }
  if (d.sayThis !== null) {
    out.push({
      path: "sayThis",
      value: d.sayThis.value,
      evidence: d.sayThis.evidence,
    });
  }
  if (d.pushback !== null) {
    out.push({
      path: "pushback",
      value: d.pushback.value,
      evidence: d.pushback.evidence,
    });
  }
  d.offers.forEach((o: DossierOffer, i: number) => {
    out.push({
      path: `offers[${i}].description`,
      value: o.description.value,
      evidence: o.description.evidence,
    });
    out.push({
      path: `offers[${i}].whyItMatters`,
      value: o.whyItMatters.value,
      evidence: o.whyItMatters.evidence,
    });
  });
  return out;
}

function allowedNamesFor(input: DossierInput): string[] {
  const names = [
    input.lead.name,
    input.lead.city ?? "",
    input.workspaceName,
    ...input.offer.services,
    ...input.priceBook.items.map((item) => item.label),
  ].filter((n) => n !== "");
  return Array.from(new Set(names));
}

// Mirrors cite-check rule 2 exactly: numbers have commas stripped, quotes raw.
function numbersIn(text: string): string[] {
  const matches = text.match(/-?\d[\d,]*/g);
  return matches ? matches.map((n) => n.replace(/,/g, "")) : [];
}

function countInventedNumbers(claims: Claim[], evidence: Evidence[]): number {
  const quotes = evidence.map((e) => e.quote);
  let count = 0;
  for (const claim of claims) {
    for (const num of numbersIn(claim.value)) {
      if (!quotes.some((q) => q.includes(num))) {
        count += 1;
      }
    }
  }
  return count;
}

function dossierFullText(d: Dossier): string {
  const parts: string[] = [];
  if (d.gap !== null) parts.push(d.gap.headline.value);
  if (d.sayThis !== null) parts.push(d.sayThis.value);
  if (d.pushback !== null) parts.push(d.pushback.value);
  for (const o of d.offers) {
    parts.push(o.title, o.description.value, o.whyItMatters.value);
  }
  if (d.facts.owner !== undefined) parts.push(d.facts.owner.value);
  if (d.facts.sinceYear !== undefined)
    parts.push(String(d.facts.sinceYear.value));
  if (d.facts.rating !== undefined) parts.push(String(d.facts.rating.value));
  if (d.facts.reviewCount !== undefined)
    parts.push(String(d.facts.reviewCount.value));
  if (d.facts.area !== undefined) parts.push(d.facts.area.value);
  for (const e of d.evidence) parts.push(e.quote);
  return parts.join("\n");
}

function trigramsOf(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
  const out = new Set<string>();
  for (let i = 0; i + TRIGRAM_SIZE <= words.length; i += 1) {
    out.add(words.slice(i, i + TRIGRAM_SIZE).join(" "));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function maxTrigramOverlap(dossiers: Dossier[]): number {
  const sets = dossiers.map((d) => trigramsOf(dossierFullText(d)));
  let max = 0;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const a = sets[i];
      const b = sets[j];
      if (a === undefined || b === undefined) continue;
      const sim = jaccard(a, b);
      if (sim > max) max = sim;
    }
  }
  return max;
}

// missingSections interpretation (see report open issues): count of sections
// among gap, sayThis, pushback, offers (non-empty) that the level-0 template
// draft has but the final dossier lacks.
function countMissingSections(draft: Dossier, final: Dossier): number {
  let missing = 0;
  if (draft.gap !== null && final.gap === null) missing += 1;
  if (draft.sayThis !== null && final.sayThis === null) missing += 1;
  if (draft.pushback !== null && final.pushback === null) missing += 1;
  if (draft.offers.length > 0 && final.offers.length === 0) missing += 1;
  return missing;
}

export function lossOf(e: {
  unsupportedClaims: number;
  inventedNumbers: number;
  missingSections: number;
  repeatedPhrasing: number;
  tokens: number;
}): number {
  return (
    W_UNSUPPORTED * e.unsupportedClaims +
    W_INVENTED * e.inventedNumbers +
    W_MISSING * e.missingSections +
    W_REPEAT * e.repeatedPhrasing +
    e.tokens / TOKEN_DIVISOR
  );
}

// ---------------------------------------------------------------------------
// Evaluator.
// ---------------------------------------------------------------------------

export async function evaluatePrompt(
  variant: PromptVariant,
  modelFn: LlmFn,
): Promise<PromptEval> {
  const wrapped: LlmFn = (req) =>
    modelFn({
      ...req,
      ...variant.transform({ system: req.system, prompt: req.prompt }),
    });
  const cases = loadCases();
  const finals: Dossier[] = [];
  const perCase: PromptCaseEval[] = [];
  let unsupportedClaims = 0;
  let inventedNumbers = 0;
  let missingSections = 0;
  let tokens = 0;
  for (let index = 0; index < cases.length; index += 1) {
    const c = cases[index];
    if (c === undefined) continue;
    const evidence = buildEvidence(
      {
        name: c.business.name,
        category: c.business.category,
        city: c.business.city,
        phone: c.business.phone,
        website: c.business.website,
        source: FIXTURE_SOURCE,
        sourceUrl: c.business.website,
      },
      {
        summary: firstSentence(c.pages[0]?.text ?? c.business.name),
        emails: [],
        phones: c.business.phone === "" ? [] : [c.business.phone],
        socials: {},
        signals: [
          PRIMARY_SIGNAL,
          SECONDARY_SIGNALS[index % SECONDARY_SIGNALS.length] ??
            "no-contact-form",
        ],
        language: "en",
      },
      buildPages(c),
    );
    const input = buildInput(c, index, evidence);
    const draft = buildTemplateDossier(input);
    const final = await polishDossier(input, draft, { llm: wrapped });
    const ctx: CiteCtx = {
      evidence: final.evidence,
      allowedNames: allowedNamesFor(input),
    };
    const check = checkDossier(final, ctx);
    const claims = collectClaims(final);
    const unsupported = check.dropped.length + final.dropped.length;
    const invented = countInventedNumbers(claims, final.evidence);
    const missing = countMissingSections(draft, final);
    const caseTokens = Math.round(
      JSON.stringify(final).length / CHARS_PER_TOKEN,
    );
    unsupportedClaims += unsupported;
    inventedNumbers += invented;
    missingSections += missing;
    tokens += caseTokens;
    finals.push(final);
    perCase.push({
      id: c.id,
      unsupported,
      invented,
      missing,
      tokens: caseTokens,
    });
  }
  return {
    variantId: variant.id,
    unsupportedClaims,
    inventedNumbers,
    missingSections,
    repeatedPhrasing: maxTrigramOverlap(finals),
    tokens,
    perCase,
  };
}

export async function compareVariants(
  variants: PromptVariant[],
  modelFn: LlmFn,
): Promise<CompareResult> {
  const evaluated: { variant: PromptVariant; eval: PromptEval }[] = [];
  for (const variant of variants) {
    evaluated.push({ variant, eval: await evaluatePrompt(variant, modelFn) });
  }
  const indexed = evaluated.map((e, index) => ({ ...e, index }));
  indexed.sort((a, b) => {
    const lossA = lossOf(a.eval);
    const lossB = lossOf(b.eval);
    if (lossA !== lossB) return lossA - lossB;
    return a.index - b.index;
  });
  const ranked: RankedVariant[] = indexed.map((e) => ({
    variantId: e.variant.id,
    loss: lossOf(e.eval),
    eval: e.eval,
  }));
  let proposeSwitch = false;
  const first = evaluated[0];
  const baseline = evaluated.find((e) => e.variant.id === BASELINE_ID);
  if (first !== undefined && baseline !== undefined) {
    const baseUnsupported = baseline.eval.unsupportedClaims;
    if (baseUnsupported >= 1) {
      const improvement =
        (baseUnsupported - first.eval.unsupportedClaims) / baseUnsupported;
      proposeSwitch =
        improvement >= MIN_IMPROVEMENT &&
        first.eval.tokens <= baseline.eval.tokens;
    }
  }
  return { ranked, proposeSwitch };
}
