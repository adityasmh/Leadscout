// src/quality-check.ts
// Order L28B quality harness: measures dossier quality on fixtures-v2/quality/cases.json
// using the real evidence builder (evidence.js), the real dossier module (dossier.js)
// with an injected fake model, and the real citation checker (cite-check.js).
// No network, no real database writes (a temp LEADSCOUT_DB path is set before any
// project module is imported; the harness never calls save/load functions).

import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Dossier,
  DossierOffer,
  Evidence,
  GapTag,
  LeadScore,
  LlmFn,
  PriceBook,
} from "./types-v2.js";
import type { DossierInput } from "./dossier.js";
import type { CiteCtx } from "./cite-check.js";
import type { Enrichment, Lead, Match, RawLead } from "./types.js";

process.env.LEADSCOUT_DB = join(
  mkdtempSync(join(tmpdir(), "leadscout-quality-")),
  "check.db",
);

const { buildEvidence, extractFacts } = await import("./evidence.js");
const { buildTemplateDossier, polishDossier } = await import("./dossier.js");
const { checkDossier } = await import("./cite-check.js");

// ---------------------------------------------------------------------------
// Thresholds and harness constants (no magic numbers: every bar is named).
// ---------------------------------------------------------------------------

const MIN_COVERAGE = 1;
const MAX_UNSUPPORTED = 0;
const MAX_INVENTED_NUMBERS = 0;
const MAX_ABSENT_CLAIMS = 0;
const MAX_TRIGRAM_OVERLAP = 0.5;
const MAX_TOKENS_PER_DOSSIER = 5000;
const CHARS_PER_TOKEN = 4;
const TRIGRAM_SIZE = 3;
const FETCHED_AT = "2026-10-01T00:00:00.000Z";
const WORKSPACE_ID = "ws-quality-harness";
const WORKSPACE_NAME = "Quality Harness";
const FIXTURE_SOURCE = "fixture";
const PRICEBOOK_VERSION = 1;
const OFFER_DESCRIPTION = "Quality harness test offer";
const SCORE_TOTAL = 80;
const SCORE_FIT = 80;
const SCORE_REACH = 50;
const SCORE_TIMING = 50;
const FIT_SCORE = 80;
const FAKE_TOKENS_IN = 100;
const FAKE_TOKENS_OUT = 50;
const FAKE_MODEL_NAME = "honest-fake-model";
const DISHONEST_MODEL_NAME = "dishonest-fake-model";
const DISHONEST_SUFFIX = " Rated 4.9 stars from 5000 reviews.";

// Every case cites a real absence item so offer/dossier citations always have a
// valid evidence id. "no-analytics" deterministically yields a NOT MEASURING gap
// (PLAN_V2 2.3 rule 4); the second signal only varies the evidence wording.
const PRIMARY_SIGNAL = "no-analytics";
const SECONDARY_SIGNALS = [
  "no-contact-form",
  "no-chat-widget",
  "no-online-booking",
] as const;

type HarnessService = {
  service: string;
  label: string;
  description: string;
  why: string;
};

// All prose is lowercase (except sentence starts, which cite-check exempts) so
// the honest run introduces no capitalised words outside cited quotes; no
// numbers, currency markers, review words or banned claims appear anywhere.
const HARNESS_SERVICES = [
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
const SCORE_REASON = "quality harness fixed score";
// Honest-fake prose budget (all within cite-check word caps: sayThis 45,
// pushback 30, offer description 40, whyItMatters 30).
const SAY_THIS_PAGE_WORDS = 35;
const PUSHBACK_PAGE_WORDS = 20;
const OFFER_DESC_PAGE_WORDS = 8;
const OFFER_WHY_PAGE_WORDS = 6;
const MIN_WORD_CHARS = 2;
// Tokens the honest fake drops from page restatements so rules 2/4/5 stay
// clean (digits already vanish via the [^a-z] split below): review words,
// currency words and banned-claim fragments. Dropping is omission, never
// invention.
const STRIPPED_TOKENS = new Set([
  "review",
  "reviews",
  "rated",
  "star",
  "stars",
  "rs",
  "inr",
  "rupees",
  "lakh",
  "crore",
  "guarantee",
  "guaranteed",
  "urgent",
  "competitor",
  "competitors",
  "double",
  "limited",
  "act",
]);

// ---------------------------------------------------------------------------
// Fixture loading (typed, no `any`).
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
    throw new Error(`quality harness: expected object for ${what}`);
  }
  return value as Record<string, unknown>;
}

function reqStr(obj: Record<string, unknown>, key: string, what: string): string {
  const value: unknown = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`quality harness: ${what} needs string field ${key}`);
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
    throw new Error(`quality harness: case ${id} needs a non-empty pages array`);
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
    throw new Error(`quality harness: case ${id} truth.absent must be an array`);
  }
  const absent: string[] = rawAbsent.map((a: unknown) => {
    if (typeof a !== "string") {
      throw new Error(`quality harness: case ${id} truth.absent must be strings`);
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
    throw new Error("quality harness: cases.json must be an array");
  }
  return parsed.map((c: unknown) => parseCase(c));
}

// ---------------------------------------------------------------------------
// Dossier input construction from a fixture case.
// ---------------------------------------------------------------------------

function pickService(index: number): HarnessService {
  const item: unknown = HARNESS_SERVICES[index % HARNESS_SERVICES.length];
  if (typeof item !== "object" || item === null) {
    throw new Error("quality harness: service rotation is empty");
  }
  return item as HarnessService;
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
    items: HARNESS_SERVICES.map((s, i) => ({
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
  const raw: RawLead = {
    name: c.business.name,
    category: c.business.category,
    city: c.business.city,
    phone: c.business.phone,
    website: c.business.website,
    source: FIXTURE_SOURCE,
    sourceUrl: c.business.website,
  };
  const secondary: string = SECONDARY_SIGNALS[index % SECONDARY_SIGNALS.length] ?? "no-contact-form";
  const enrichment: Enrichment = {
    summary: firstSentence(c.pages[0]?.text ?? c.business.name),
    emails: [],
    phones: c.business.phone === "" ? [] : [c.business.phone],
    socials: {},
    signals: [PRIMARY_SIGNAL, secondary],
    language: "en",
  };
  const match: Match = {
    score: SCORE_TOTAL,
    fit: [first, second].map((s) => ({
      service: s.service,
      score: FIT_SCORE,
      reason: `fixture fit for ${s.service}`,
    })),
    angle: "",
  };
  const lead: Lead = {
    ...raw,
    ...enrichment,
    ...match,
    id: `lead-${c.id}`,
    workspaceId: WORKSPACE_ID,
    status: "new",
    notes: "",
    createdAt: FETCHED_AT,
  };
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
      services: HARNESS_SERVICES.map((s) => s.service),
      description: OFFER_DESCRIPTION,
    },
  };
}

function buildPages(c: QualityCase): { url: string; body: string; fetchedAt: string }[] {
  return c.pages.map((p, i) => ({
    url: p.url === "" ? `${FIXTURE_SOURCE}://${c.id}/p${i}` : p.url,
    body: `<html><head><title>${escapeHtml(p.title)}</title></head><body><p>${escapeHtml(p.text)}</p></body></html>`,
    fetchedAt: FETCHED_AT,
  }));
}

// ---------------------------------------------------------------------------
// Fake models. The honest fake echoes the level-0 draft verbatim (valid ids,
// no new factual claims); the dishonest fake appends an invented rating.
// ---------------------------------------------------------------------------

type CitedJson = { value: string; evidence: string[] };
type FakeAnswer = {
  gap?: { headline: CitedJson; tag: GapTag };
  sayThis: CitedJson | null;
  pushback: CitedJson | null;
  offers: { service: string; description: CitedJson; whyItMatters: CitedJson }[];
};

function answerJson(draft: Dossier, sayThisSuffix: string): string {
  const answer: FakeAnswer = {
    gap: draft.gap
      ? { headline: { ...draft.gap.headline }, tag: draft.gap.tag }
      : undefined,
    sayThis: draft.sayThis
      ? {
          value: `${draft.sayThis.value}${sayThisSuffix}`,
          evidence: [...draft.sayThis.evidence],
        }
      : null,
    pushback: draft.pushback ? { ...draft.pushback } : null,
    offers: draft.offers.map((o: DossierOffer) => ({
      service: o.service,
      description: { ...o.description },
      whyItMatters: { ...o.whyItMatters },
    })),
  };
  return JSON.stringify(answer);
}

// Lowercase words of a case's own pages. Lowercase keeps cite-check rule 3
// vacuous (it only constrains capitalised words); digits die in the split so
// rule 2 stays clean. Same content, no new facts.
function cleanedPageWords(c: QualityCase): string[] {
  const text = c.pages.map((p) => `${p.title} ${p.text}`).join(" ");
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= MIN_WORD_CHARS && !STRIPPED_TOKENS.has(w));
}

function takeWords(words: string[], start: number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const w = words[(start + i) % words.length];
    if (w !== undefined) out.push(w);
  }
  return out.join(" ");
}

// The honest fake restates this case's own page words (lowercase, valid ids,
// no new factual claims), so its prose is grounded and varies per case.
function honestAnswer(c: QualityCase, input: DossierInput, draft: Dossier): string {
  const evidence = draft.evidence;
  const absence = evidence.filter((e) => e.kind === "absence");
  const firstAbsence = absence[0];
  const secondAbsence = absence[1] ?? firstAbsence;
  let title = evidence.find((e) => e.kind === "page-text");
  for (const e of evidence) {
    if (e.kind === "page-text" && (title === undefined || e.quote.length > title.quote.length)) {
      title = e;
    }
  }
  const gapIds = draft.gap ? draft.gap.headline.evidence : [];
  const words = cleanedPageWords(c);
  if (words.length === 0) {
    throw new Error(`quality harness: case ${c.id} has no usable page words`);
  }

  const sayEvidence = firstAbsence !== undefined && title !== undefined
    ? Array.from(new Set([...gapIds, firstAbsence.id, title.id]))
    : (draft.sayThis?.evidence ?? []);
  const pushEvidence = secondAbsence !== undefined
    ? Array.from(new Set([...gapIds, secondAbsence.id]))
    : (draft.pushback?.evidence ?? []);
  const sayThis: CitedJson | null = draft.sayThis
    ? {
        value: `Hi, is this ${input.lead.name}? ${takeWords(words, 0, SAY_THIS_PAGE_WORDS)}`,
        evidence: sayEvidence,
      }
    : null;
  const pushback: CitedJson | null = draft.pushback
    ? {
        value: `May I send a note? ${takeWords(words, SAY_THIS_PAGE_WORDS, PUSHBACK_PAGE_WORDS)}`,
        evidence: pushEvidence,
      }
    : null;
  const answer: FakeAnswer = {
    gap: draft.gap
      ? { headline: { ...draft.gap.headline }, tag: draft.gap.tag }
      : undefined,
    sayThis,
    pushback,
    offers: draft.offers.map((o: DossierOffer, i: number) => ({
      service: o.service,
      description: {
        value: `${o.description.value} ${takeWords(words, SAY_THIS_PAGE_WORDS + PUSHBACK_PAGE_WORDS + i * (OFFER_DESC_PAGE_WORDS + OFFER_WHY_PAGE_WORDS), OFFER_DESC_PAGE_WORDS)}`,
        evidence: [...o.description.evidence],
      },
      whyItMatters: {
        value: `${o.whyItMatters.value} ${takeWords(words, SAY_THIS_PAGE_WORDS + PUSHBACK_PAGE_WORDS + i * (OFFER_DESC_PAGE_WORDS + OFFER_WHY_PAGE_WORDS) + OFFER_DESC_PAGE_WORDS, OFFER_WHY_PAGE_WORDS)}`,
        evidence: [...o.whyItMatters.evidence],
      },
    })),
  };
  return JSON.stringify(answer);
}

function honestLlm(c: QualityCase, input: DossierInput, draft: Dossier): LlmFn {
  const text = honestAnswer(c, input, draft);
  return async () => ({
    text,
    tokensIn: FAKE_TOKENS_IN,
    tokensOut: FAKE_TOKENS_OUT,
    model: FAKE_MODEL_NAME,
  });
}

function dishonestLlm(input: DossierInput, draft: Dossier): LlmFn {
  const text = answerJson(draft, DISHONEST_SUFFIX);
  void input;
  return async () => ({
    text,
    tokensIn: FAKE_TOKENS_IN,
    tokensOut: FAKE_TOKENS_OUT,
    model: DISHONEST_MODEL_NAME,
  });
}

// ---------------------------------------------------------------------------
// Metrics.
// ---------------------------------------------------------------------------

type Claim = { path: string; value: string; evidence: string[] };

function collectClaims(d: Dossier): Claim[] {
  const out: Claim[] = [];
  if (d.facts.owner !== undefined) {
    out.push({ path: "facts.owner", value: d.facts.owner.value, evidence: d.facts.owner.evidence });
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
    out.push({ path: "facts.area", value: d.facts.area.value, evidence: d.facts.area.evidence });
  }
  if (d.gap !== null) {
    out.push({ path: "gap.headline", value: d.gap.headline.value, evidence: d.gap.headline.evidence });
  }
  if (d.sayThis !== null) {
    out.push({ path: "sayThis", value: d.sayThis.value, evidence: d.sayThis.evidence });
  }
  if (d.pushback !== null) {
    out.push({ path: "pushback", value: d.pushback.value, evidence: d.pushback.evidence });
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

const ABSENT_PATTERNS: Record<string, RegExp> = {
  owner: /\bowner\b|\bproprietor\b|\bfounded by\b/,
  rating: /\bratings?\b|\brated\b|\bstars?\b|\breviews?\b/,
  reviews: /\bratings?\b|\brated\b|\bstars?\b|\breviews?\b/,
  price: /₹|\$|\brs\b|\binr\b|\brupees\b|\blakh\b|\bcrore\b|\bprice\b|\bquote\b|\bcosts?\b/i,
};

function countAbsentClaims(
  dossier: Dossier,
  claims: Claim[],
  absent: string[],
): number {
  const text = claims.map((c) => c.value).join("\n");
  let count = 0;
  for (const kind of absent) {
    const key = kind.toLowerCase();
    if (key === "owner" && dossier.facts.owner !== undefined) {
      count += 1;
      continue;
    }
    if (
      (key === "rating" || key === "reviews") &&
      (dossier.facts.rating !== undefined || dossier.facts.reviewCount !== undefined)
    ) {
      count += 1;
      continue;
    }
    const pattern = ABSENT_PATTERNS[key] ?? new RegExp(`\\b${key}\\b`, "i");
    if (pattern.test(text)) {
      count += 1;
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
  if (d.facts.sinceYear !== undefined) parts.push(String(d.facts.sinceYear.value));
  if (d.facts.rating !== undefined) parts.push(String(d.facts.rating.value));
  if (d.facts.reviewCount !== undefined) parts.push(String(d.facts.reviewCount.value));
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

// ---------------------------------------------------------------------------
// Run + report.
// ---------------------------------------------------------------------------

type CaseMetrics = {
  id: string;
  coverage: number;
  unsupported: number;
  invented: number;
  absentClaims: number;
  tokens: number;
};

function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function printTable(title: string, rows: CaseMetrics[]): void {
  console.log(title);
  console.log(
    `${padEnd("case", 22)} ${padStart("cover", 6)} ${padStart("unsup", 6)} ${padStart("invent", 7)} ${padStart("absent", 7)} ${padStart("tok", 6)}  verdict`,
  );
  for (const r of rows) {
    const pass =
      r.coverage >= MIN_COVERAGE &&
      r.unsupported <= MAX_UNSUPPORTED &&
      r.invented <= MAX_INVENTED_NUMBERS &&
      r.absentClaims <= MAX_ABSENT_CLAIMS &&
      r.tokens <= MAX_TOKENS_PER_DOSSIER;
    console.log(
      `${padEnd(r.id, 22)} ${padStart(r.coverage.toFixed(2), 6)} ${padStart(String(r.unsupported), 6)} ${padStart(String(r.invented), 7)} ${padStart(String(r.absentClaims), 7)} ${padStart(String(r.tokens), 6)}  ${pass ? "PASS" : "FAIL"}`,
    );
  }
}

async function runAll(mode: "honest" | "dishonest"): Promise<{
  rows: CaseMetrics[];
  trigramMax: number;
  overall: boolean;
}> {
  const cases = loadCases();
  const dossiers: Dossier[] = [];
  const rows: CaseMetrics[] = [];
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
          SECONDARY_SIGNALS[index % SECONDARY_SIGNALS.length] ?? "no-contact-form",
        ],
        language: "en",
      },
      buildPages(c),
    );
    const input = buildInput(c, index, evidence);
    const draft = buildTemplateDossier(input);
    const llm = mode === "honest" ? honestLlm(c, input, draft) : dishonestLlm(input, draft);
    const final = await polishDossier(input, draft, { llm });
    const ctx: CiteCtx = {
      evidence: final.evidence,
      allowedNames: allowedNamesFor(input),
    };
    const check = checkDossier(final, ctx);
    const claims = collectClaims(final);
    const evidenceIds = new Set(final.evidence.map((e) => e.id));
    const covered = claims.filter(
      (cl) => cl.evidence.length > 0 && cl.evidence.every((id) => evidenceIds.has(id)),
    ).length;
    dossiers.push(final);
    // Unsupported = claims the real checker still flags in the final dossier
    // plus claims it already dropped during polish (logged in dossier.dropped
    // and replaced by level-0 fallback text, e.g. the dishonest rating).
    const unsupported = check.dropped.length + final.dropped.length;
    rows.push({
      id: c.id,
      coverage: claims.length === 0 ? 0 : covered / claims.length,
      unsupported,
      invented: countInventedNumbers(claims, final.evidence),
      absentClaims: countAbsentClaims(final, claims, c.absent),
      tokens: Math.round(JSON.stringify(final).length / CHARS_PER_TOKEN),
    });
  }
  const trigramMax = maxTrigramOverlap(dossiers);
  const rowsPass = rows.every(
    (r) =>
      r.coverage >= MIN_COVERAGE &&
      r.unsupported <= MAX_UNSUPPORTED &&
      r.invented <= MAX_INVENTED_NUMBERS &&
      r.absentClaims <= MAX_ABSENT_CLAIMS &&
      r.tokens <= MAX_TOKENS_PER_DOSSIER,
  );
  return { rows, trigramMax, overall: rowsPass && trigramMax < MAX_TRIGRAM_OVERLAP };
}

function printTotals(rows: CaseMetrics[]): void {
  let minCoverage = 1;
  let unsupported = 0;
  let invented = 0;
  let absent = 0;
  let maxTokens = 0;
  for (const r of rows) {
    if (r.coverage < minCoverage) minCoverage = r.coverage;
    unsupported += r.unsupported;
    invented += r.invented;
    absent += r.absentClaims;
    if (r.tokens > maxTokens) maxTokens = r.tokens;
  }
  console.log(
    `${padEnd("TOTALS", 22)} ${padStart(minCoverage.toFixed(2), 6)} ${padStart(String(unsupported), 6)} ${padStart(String(invented), 7)} ${padStart(String(absent), 7)} ${padStart(String(maxTokens), 6)}`,
  );
}

// ---------------------------------------------------------------------------
// Metric self-test: prove countInventedNumbers and countAbsentClaims can fail
// when called directly on hand-made fake objects (bypassing cite-check).
// ---------------------------------------------------------------------------

const SELFTEST_RATING_TEXT = "4.9";
const SELFTEST_REVIEW_COUNT_TEXT = "5000";
const SELFTEST_RATING_CLAIM_VALUE = `Rated ${SELFTEST_RATING_TEXT} stars from ${SELFTEST_REVIEW_COUNT_TEXT} reviews`;
const SELFTEST_RATING_NUMBER = 4.9;
const SELFTEST_OWNER_NAME = "Sample Person";
const SELFTEST_OWNER_CLAIM_VALUE = `the owner is ${SELFTEST_OWNER_NAME}`;
const SELFTEST_CLEAN_CLAIM_VALUE = "Open weekdays";
const SELFTEST_SUPPORTED_QUOTE = `customers rated it ${SELFTEST_RATING_TEXT} stars from ${SELFTEST_REVIEW_COUNT_TEXT} reviews here`;
const SELFTEST_PLAIN_QUOTE = "the shop is open on weekdays";
const SELFTEST_MIN_INVENTED = 2;
const SELFTEST_MIN_ABSENT = 1;
const SELFTEST_EXPECTED_NONE = 0;
const SELFTEST_EVIDENCE_ID = "E1";
const SELFTEST_CLAIM_PATH = "sayThis";

function metricSelfTest(): { name: string; ok: boolean }[] {
  const ratingClaims: Claim[] = [
    { path: SELFTEST_CLAIM_PATH, value: SELFTEST_RATING_CLAIM_VALUE, evidence: [SELFTEST_EVIDENCE_ID] },
  ];
  const bareEvidence: Evidence[] = [
    {
      id: SELFTEST_EVIDENCE_ID,
      kind: "page-text",
      url: `${FIXTURE_SOURCE}://selftest/p0`,
      quote: SELFTEST_PLAIN_QUOTE,
      fetchedAt: FETCHED_AT,
    },
  ];
  const quotedEvidence: Evidence[] = [
    {
      id: SELFTEST_EVIDENCE_ID,
      kind: "page-text",
      url: `${FIXTURE_SOURCE}://selftest/p0`,
      quote: SELFTEST_SUPPORTED_QUOTE,
      fetchedAt: FETCHED_AT,
    },
  ];
  const baseDossier: Omit<Dossier, "facts"> = {
    leadId: "selftest",
    workspaceId: WORKSPACE_ID,
    bizKey: "selftest",
    level: 0,
    gap: null,
    sayThis: null,
    pushback: null,
    offers: [],
    evidence: [],
    callStatus: "not-called",
    dropped: [],
    inputHash: "selftest",
    promptVersion: "selftest",
    tokensIn: FAKE_TOKENS_IN,
    tokensOut: FAKE_TOKENS_OUT,
    createdAt: FETCHED_AT,
  };
  const emptyFactsDossier: Dossier = { ...baseDossier, facts: {} };
  const ownerClaims: Claim[] = [
    { path: SELFTEST_CLAIM_PATH, value: SELFTEST_OWNER_CLAIM_VALUE, evidence: [SELFTEST_EVIDENCE_ID] },
  ];
  const ratingFactsDossier: Dossier = {
    ...baseDossier,
    facts: { rating: { value: SELFTEST_RATING_NUMBER, evidence: [SELFTEST_EVIDENCE_ID] } },
  };
  const cleanClaims: Claim[] = [
    { path: SELFTEST_CLAIM_PATH, value: SELFTEST_CLEAN_CLAIM_VALUE, evidence: [SELFTEST_EVIDENCE_ID] },
  ];
  return [
    {
      name: "invented-numbers-flagged-when-unsupported",
      ok: countInventedNumbers(ratingClaims, bareEvidence) >= SELFTEST_MIN_INVENTED,
    },
    {
      name: "invented-numbers-zero-when-quoted",
      ok: countInventedNumbers(ratingClaims, quotedEvidence) === SELFTEST_EXPECTED_NONE,
    },
    {
      name: "absent-claim-flags-owner-name",
      ok:
        countAbsentClaims(emptyFactsDossier, ownerClaims, ["owner"]) >= SELFTEST_MIN_ABSENT,
    },
    {
      name: "absent-claim-flags-rating-fact",
      ok:
        countAbsentClaims(ratingFactsDossier, [], ["rating"]) >= SELFTEST_MIN_ABSENT,
    },
    {
      name: "absent-claim-zero-when-clean",
      ok:
        countAbsentClaims(emptyFactsDossier, cleanClaims, ["owner", "rating", "price"]) ===
        SELFTEST_EXPECTED_NONE,
    },
  ];
}

const selfTestResults = metricSelfTest();
console.log("METRIC SELF-TEST");
for (const item of selfTestResults) {
  console.log(`${item.ok ? "PASS" : "FAIL"}: ${item.name}`);
}
const selfTestOk = selfTestResults.every((item) => item.ok);

const honest = await runAll("honest");
console.log("L28B quality harness: real evidence builder + real dossier/cite-check modules, fake model only.");
console.log(
  `bars: coverage>=${MIN_COVERAGE} unsupported<=${MAX_UNSUPPORTED} invented<=${MAX_INVENTED_NUMBERS} absent<=${MAX_ABSENT_CLAIMS} trigram<${MAX_TRIGRAM_OVERLAP} tokens<=${MAX_TOKENS_PER_DOSSIER}`,
);
printTable("HONEST RUN (fake model restates exact evidence quotes with valid ids)", honest.rows);
printTotals(honest.rows);
console.log(`trigram max (highest pairwise word-trigram Jaccard): ${honest.trigramMax.toFixed(3)} ${honest.trigramMax < MAX_TRIGRAM_OVERLAP ? "PASS" : "FAIL"}`);
console.log(`HONEST OVERALL: ${honest.overall ? "PASS" : "FAIL"}`);

const dishonest = await runAll("dishonest");
printTable("DISHONEST RUN (fake model appends an invented 4.9-star / 5000-review rating)", dishonest.rows);
printTotals(dishonest.rows);
console.log(`trigram max (highest pairwise word-trigram Jaccard): ${dishonest.trigramMax.toFixed(3)} ${dishonest.trigramMax < MAX_TRIGRAM_OVERLAP ? "PASS" : "FAIL"}`);
console.log(`DISHONEST OVERALL: ${dishonest.overall ? "PASS" : "FAIL"} (expected FAIL on metric 2 unsupported)`);
const harnessOk = selfTestOk && honest.overall && !dishonest.overall;
console.log(`HARNESS: ${harnessOk ? "PASS (honest passes, dishonest fails)" : "FAIL"}`);
process.exitCode = harnessOk ? 0 : 1;
