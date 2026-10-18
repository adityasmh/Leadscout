// src/dossier.ts
// Level-0/level-1 dossier pipeline for leadscout.
// Types come from ./types-v2.js where they exist; DossierInput is declared locally per PLAN_V2 6.1.

import { createHash } from "node:crypto";
// @ts-ignore node:sqlite is a Node 24 built-in; ambient types are not available in this environment.
import { DatabaseSync } from "node:sqlite";
import {
  type Branding,
  type CategoryExplainer,
  type Cited,
  type Dossier,
  type Evidence,
  type GapTag,
  type LeadScore,
  type LlmFn,
  type PriceBook,
  type PriceItem,
} from "./types-v2.js";
import { type Lead, type Offer, type FitService } from "./types.js";
import { PROMPT_VERSION, buildPrompt } from "./dossier-prompts.js";
import { checkDossier } from "./cite-check.js";
import { getDb, websiteHost } from "./store.js";

// Local declaration of the input shape described in PLAN_V2 section 6.1.
export type DossierInput = {
  lead: Lead;
  evidence: Evidence[];
  facts: Dossier["facts"];
  score: LeadScore;
  priceBook: PriceBook;
  explainer?: CategoryExplainer | null;
  workspaceName: string;
  offer: Offer;
  senderName?: string;
  branding?: Branding;
};

const GAP_TEMPLATES: Record<
  GapTag,
  { headline: string; sayThis: string; pushback: string }
> = {
  "GOING UNSEEN": {
    headline: "No working website for {name}; enquiries can only find {name} by word of mouth.",
    sayThis:
      "{intro} I noticed {name} doesn't appear to have a working website, so new enquiries may be missing you.",
    pushback:
      "May I send you a quick note on how a simple site could help {name} get found?",
  },
  LEAKING: {
    headline:
      "No online booking or chat on {name}'s website; enquiries go by phone only.",
    sayThis:
      "{intro} I was looking at {name}'s website and couldn't book or chat instantly.",
    pushback:
      "May I send you a quick example of how {name} could capture enquiries outside office hours?",
  },
  OUTDATED: {
    headline: "{name}'s website looks outdated and may not work well on mobile.",
    sayThis:
      "{intro} I noticed {name}'s website looks outdated and may not work well on phones.",
    pushback:
      "May I send you a quick note on how a fresh site could help {name} make a better first impression?",
  },
  "NOT MEASURING": {
    headline: "{name} is not measuring what visitors do on its website.",
    sayThis:
      "{intro} I noticed {name} doesn't appear to track website visits, so ad spend is hard to judge.",
    pushback:
      "May I send you a quick note on how simple analytics could help {name} see what works?",
  },
};

const POLISH_TASK_HINT = "leadscout dossier: short structured JSON rewrite, low complexity";

const DOSSIERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS dossiers (
  workspaceId TEXT NOT NULL,
  leadId TEXT NOT NULL,
  json TEXT NOT NULL,
  inputHash TEXT NOT NULL,
  level INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, leadId)
);
`;

let dossiersTableEnsured = false;

function ensureDossiersTable(db: DatabaseSync): void {
  if (!dossiersTableEnsured) {
    db.exec(DOSSIERS_SCHEMA);
    dossiersTableEnsured = true;
  }
}

function normaliseName(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function buildBizKey(lead: Lead): string {
  if (lead.website) {
    const host = websiteHost(lead.website);
    if (host) return host;
  }
  return `${normaliseName(lead.name)}|${normaliseName(lead.city ?? "")}`;
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function cited<T>(value: T, evidence: string[]): Cited<T> {
  return { value, evidence };
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
}

function evidenceForSignal(evidence: Evidence[], signalId: string): Evidence[] {
  return evidence.filter((e) => e.field === `signal:${signalId}`);
}

function hasSignal(evidence: Evidence[], signalId: string): boolean {
  return evidenceForSignal(evidence, signalId).length > 0;
}

function evidenceForVerificationStatus(
  evidence: Evidence[],
  status: string
): Evidence[] {
  return evidence.filter(
    (e) =>
      e.kind === "verification" &&
      e.quote.toLowerCase().includes(status.toLowerCase())
  );
}

function isSiteAlive(evidence: Evidence[]): boolean {
  const verificationAlive = evidence.some(
    (e) => e.kind === "verification" && /\balive\b/i.test(e.quote)
  );
  const verificationDead = evidence.some(
    (e) => e.kind === "verification" && /\bdead\b/i.test(e.quote)
  );
  const unreachable = hasSignal(evidence, "site-unreachable");
  if (verificationAlive) return true;
  if (verificationDead || unreachable) return false;
  // No explicit verification: assume alive if we fetched any page text.
  return evidence.some((e) => e.kind === "page-text");
}

function chooseGap(
  evidence: Evidence[]
): { tag: GapTag; evidenceIds: string[] } | null {
  // Rule 1: GOING UNSEEN (first match wins).
  const noWebsite = evidenceForSignal(evidence, "no-website");
  const siteUnreachable = evidenceForSignal(evidence, "site-unreachable");
  const deadSite = evidenceForVerificationStatus(evidence, "dead");
  if (noWebsite.length || deadSite.length || siteUnreachable.length) {
    return {
      tag: "GOING UNSEEN",
      evidenceIds: unique([
        ...noWebsite,
        ...deadSite,
        ...siteUnreachable,
      ]).map((e) => e.id),
    };
  }

  // Rule 2: LEAKING.
  const isHighVolume =
    hasSignal(evidence, "high-volume-enquiry-type") ||
    hasSignal(evidence, "appointment-based");
  const missingWidgets = [
    ...evidenceForSignal(evidence, "no-online-booking"),
    ...evidenceForSignal(evidence, "no-chat-widget"),
    ...evidenceForSignal(evidence, "no-contact-form"),
  ];
  if (isHighVolume && isSiteAlive(evidence) && missingWidgets.length) {
    return {
      tag: "LEAKING",
      evidenceIds: unique(missingWidgets).map((e) => e.id),
    };
  }

  // Rule 3: OUTDATED.
  const outdated = [
    ...evidenceForSignal(evidence, "outdated-copyright"),
    ...evidenceForSignal(evidence, "no-https"),
    ...evidenceForSignal(evidence, "not-mobile-friendly"),
  ];
  if (outdated.length) {
    return {
      tag: "OUTDATED",
      evidenceIds: unique(outdated).map((e) => e.id),
    };
  }

  // Rule 4: NOT MEASURING.
  const noAnalytics = evidenceForSignal(evidence, "no-analytics");
  if (isSiteAlive(evidence) && noAnalytics.length) {
    return {
      tag: "NOT MEASURING",
      evidenceIds: unique(noAnalytics).map((e) => e.id),
    };
  }

  return null;
}

function signalEvidenceIds(evidence: Evidence[]): string[] {
  return unique(
    evidence.filter((e) => e.field?.startsWith("signal:")).map((e) => e.id)
  );
}

/** Plain plural noun phrase for a category id: "real-estate-developer" -> "real estate developers". */
function plainCategoryPlural(category: string | undefined): string {
  const words = String(category ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (words === "") return "local businesses";
  const parts = words.split(" ");
  const last = parts[parts.length - 1];
  let plural: string;
  if (/[^aeiou]y$/.test(last)) plural = `${last.slice(0, -1)}ies`;
  else if (/(s|x|z|ch|sh)$/.test(last)) plural = `${last}es`;
  else plural = `${last}s`;
  return [...parts.slice(0, -1), plural].join(" ");
}

/** Short, plain observation for a signal that is present in the evidence. Generic: no service knowledge. */
const EVIDENCE_OBSERVATIONS: Record<string, string> = {
  "no-website": "you don't appear to have a working website",
  "no-https": "your site isn't on HTTPS",
  "not-mobile-friendly": "your site doesn't look mobile friendly",
  "slow-response": "your site was slow to respond",
  "outdated-copyright": "your site's copyright line is out of date",
  "no-analytics": "your site has no analytics installed",
  ecommerce: "you already sell online",
  "social-active-links": "you're active on social media",
  "has-email": "you list an email address",
  "has-phone": "you list a phone number",
  "has-whatsapp": "you take messages on WhatsApp",
  "high-volume-enquiry-type": "your business type gets a lot of enquiries",
  "appointment-based": "you work on appointments",
};

/** One evidence-backed observation for the opener, or "" when the dossier has none. */
function observationFromEvidence(evidence: Evidence[]): string {
  for (const e of evidence) {
    const field = String(e.field ?? "");
    if (!field.startsWith("signal:")) continue;
    const phrase = EVIDENCE_OBSERVATIONS[field.slice("signal:".length)];
    if (phrase) return phrase;
  }
  return "";
}

function getWhereAutomationHelps(
  explainer: DossierInput["explainer"],
  service: string
): string | undefined {
  return explainer?.whereAutomationHelps.find((w) => w.service === service)?.point;
}

function priceItemFor(book: PriceBook, service: string): PriceItem | undefined {
  return book.items.find((i) => i.service === service);
}

function makeOffer(
  service: string,
  item: PriceItem,
  rank: number,
  signalIds: string[],
  explainer: DossierInput["explainer"],
  doorOpener: boolean
): Dossier["offers"][number] {
  const extra = getWhereAutomationHelps(explainer, service);
  const value = item.description + (extra ? ` ${extra}` : "");
  const evidence = signalIds.length ? signalIds : ["E0"];
  return {
    rank,
    service,
    title: item.label,
    description: cited(value, evidence),
    whyItMatters: cited(value, evidence),
    buildDays: item.buildDays,
    quote: item.price,
    assumption: item.assumption,
    doorOpener,
  };
}

function buildOffers(input: DossierInput): Dossier["offers"] {
  const { lead, priceBook, offer, explainer, evidence } = input;
  const fitServices = lead.fit ?? [];
  const allowedServices = new Set(offer.services ?? []);
  const signalIds = signalEvidenceIds(evidence);

  // Choose one door-opener.
  // 1. Prefer a door-opener whose service is in lead.fit.
  let doorOpenerService: string | undefined;
  let doorOpenerItem: PriceItem | undefined;
  for (const f of fitServices) {
    const item = priceItemFor(priceBook, f.service);
    if (item && allowedServices.has(f.service) && item.doorOpener) {
      doorOpenerService = f.service;
      doorOpenerItem = item;
      break;
    }
  }

  // 2. Otherwise take the first door-opener in price-book order that is in the offer list.
  if (!doorOpenerItem) {
    for (const item of priceBook.items) {
      if (item.doorOpener && allowedServices.has(item.service)) {
        doorOpenerService = item.service;
        doorOpenerItem = item;
        break;
      }
    }
  }

  const offers: Dossier["offers"] = [];
  let rank = 1;

  // Paid services from lead.fit, skipping the chosen door-opener, max 4.
  for (const f of fitServices) {
    if (rank > 4) break;
    if (f.service === doorOpenerService) continue;
    const item = priceItemFor(priceBook, f.service);
    if (!item || !allowedServices.has(f.service)) continue;
    offers.push(makeOffer(f.service, item, rank++, signalIds, explainer, false));
  }

  // Add the door-opener last.
  if (doorOpenerItem && doorOpenerService) {
    offers.push(
      makeOffer(doorOpenerService, doorOpenerItem, rank++, signalIds, explainer, true)
    );
  }

  return offers;
}

/** Build a level-0 dossier from rules and the workspace price book. No model call. */
export function buildTemplateDossier(input: DossierInput): Dossier {
  const lead = input.lead;
  const evidence = input.evidence;
  const businessName = lead.name;
  const sender = (input.senderName ?? "").trim();
  const company = (input.workspaceName ?? "").trim();
  let openerIntro: string;
  if (sender !== "" && sender !== company) {
    openerIntro = `Hi, this is ${sender}`;
    if (company !== "" && company !== sender) openerIntro += ` from ${company}`;
    openerIntro += ".";
  } else {
    openerIntro = `Hi, is this ${businessName}?`;
  }
  const now = new Date().toISOString();
  const offers = buildOffers(input);

  const gapInfo = chooseGap(evidence);
  let gap: Dossier["gap"] = null;
  let sayThis: Dossier["sayThis"] = null;
  let pushback: Dossier["pushback"] = null;

  if (gapInfo) {
    const tmpl = GAP_TEMPLATES[gapInfo.tag];
    const headlineText = fillTemplate(tmpl.headline, { name: businessName });
    const sayThisText = fillTemplate(tmpl.sayThis, {
      intro: openerIntro,
      name: businessName,
      headline: headlineText,
    });
    const pushbackText = fillTemplate(tmpl.pushback, {
      name: businessName,
      headline: headlineText,
    });
    gap = {
      headline: cited(headlineText, gapInfo.evidenceIds),
      tag: gapInfo.tag,
    };
    sayThis = cited(sayThisText, gapInfo.evidenceIds);
    pushback = cited(pushbackText, gapInfo.evidenceIds);
  } else {
    // No evidenced gap: give an honest service-led opener built from the
    // lead's top-ranked offer only (never the whole services list), naming the
    // category in plain words and claiming nothing that is not in the evidence.
    const topOffer = offers[0];
    if (topOffer) {
      const label = String(topOffer.title ?? topOffer.service ?? "")
        .trim()
        .toLowerCase();
      const categoryPlural = plainCategoryPlural(lead.category);
      const observation = observationFromEvidence(evidence);
      const observationClause =
        observation !== "" ? `, and I noticed ${observation}` : "";
      if (label !== "") {
        const openerText = `${openerIntro} I make ${label} for ${categoryPlural}${observationClause}. Do you have a minute?`;
        const ids = signalEvidenceIds(evidence);
        const citeIds = ids.length
          ? ids
          : evidence[0]
            ? [evidence[0].id]
            : ["E0"];
        sayThis = cited(openerText, citeIds);
      }
    }
  }

  const facts: Dossier["facts"] = { ...input.facts };
  if (!facts.area && lead.city) {
    const ids = signalEvidenceIds(evidence);
    facts.area = cited(lead.city, ids.length ? ids : ["E0"]);
  }

  return {
    leadId: lead.id,
    workspaceId: lead.workspaceId,
    bizKey: buildBizKey(lead),
    level: 0,
    facts,
    gap,
    sayThis,
    pushback,
    offers,
    explainerId: input.explainer?.id,
    evidence,
    callStatus: "not-called",
    dropped: [],
    inputHash: inputHashOf(input),
    promptVersion: PROMPT_VERSION,
    tokensIn: 0,
    tokensOut: 0,
    createdAt: now,
  };
}

/** Dossier input hash per PLAN_V2 section 1.5. */
export function inputHashOf(input: DossierInput): string {
  const evidence = [...input.evidence].sort((a, b) => a.id.localeCompare(b.id));
  const parts = [
    ...evidence.map((e) => `${e.id}:${e.quote}`),
    ...(input.offer.services ?? []).slice().sort(),
    String(input.priceBook.version),
    input.explainer?.id ?? "",
    PROMPT_VERSION,
  ];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// Level-1 polish
// ---------------------------------------------------------------------------

type PolishedAnswer = {
  gap?: {
    headline?: { value?: string; evidence?: string[] };
    tag?: GapTag;
  };
  sayThis?: { value?: string; evidence?: string[] };
  pushback?: { value?: string; evidence?: string[] };
  offers?: Array<{
    description?: { value?: string; evidence?: string[] };
    whyItMatters?: { value?: string; evidence?: string[] };
  }>;
};

function allowedNames(input: DossierInput): string[] {
  const names = [
    input.lead.name,
    input.lead.city ?? "",
    input.workspaceName,
    input.senderName ?? "",
    ...(input.offer.services ?? []),
    ...input.priceBook.items.map((i) => i.label),
  ].filter(Boolean);
  return unique(names);
}

function mergeAnswer(draft: Dossier, answer: PolishedAnswer): Dossier {
  const next: Dossier = { ...draft };
  if (draft.gap && answer.gap?.headline?.value && Array.isArray(answer.gap.headline.evidence)) {
    next.gap = {
      headline: {
        value: answer.gap.headline.value,
        evidence: answer.gap.headline.evidence,
      },
      tag: answer.gap.tag ?? draft.gap.tag,
    };
  }
  if (answer.sayThis?.value && Array.isArray(answer.sayThis.evidence)) {
    next.sayThis = {
      value: answer.sayThis.value,
      evidence: answer.sayThis.evidence,
    };
  }
  if (answer.pushback?.value && Array.isArray(answer.pushback.evidence)) {
    next.pushback = {
      value: answer.pushback.value,
      evidence: answer.pushback.evidence,
    };
  }
  if (Array.isArray(answer.offers)) {
    next.offers = draft.offers.map((o, i) => {
      const a = answer.offers?.[i];
      const description =
        a?.description?.value && Array.isArray(a.description.evidence)
          ? { value: a.description.value, evidence: a.description.evidence }
          : o.description;
      const whyItMatters =
        a?.whyItMatters?.value && Array.isArray(a.whyItMatters.evidence)
          ? { value: a.whyItMatters.value, evidence: a.whyItMatters.evidence }
          : o.whyItMatters;
      return { ...o, description, whyItMatters };
    });
  }
  return next;
}

function applyFallbacks(
  polished: Dossier,
  draft: Dossier,
  dropped: { field: string; reason: string }[]
): Dossier {
  const out: Dossier = { ...polished };
  const fields = new Set(dropped.map((d) => d.field));
  if (fields.has("sayThis") && draft.sayThis) out.sayThis = draft.sayThis;
  if (fields.has("pushback") && draft.pushback) out.pushback = draft.pushback;
  if (fields.has("offers")) {
    out.offers = draft.offers;
  } else {
    for (let i = 0; i < out.offers.length; i++) {
      if (fields.has(`offers[${i}].description`)) {
        out.offers[i].description = draft.offers[i].description;
      }
      if (fields.has(`offers[${i}].whyItMatters`)) {
        out.offers[i].whyItMatters = draft.offers[i].whyItMatters;
      }
    }
  }
  return out;
}

/** Rewrite a level-0 draft through one LLM call (plus at most one repair call). */
export async function polishDossier(
  input: DossierInput,
  draft: Dossier,
  deps: { llm: LlmFn }
): Promise<Dossier> {
  if (!draft.gap) {
    // Conservative path: if there is no evidenced gap there is nothing to rewrite.
    return {
      ...draft,
      dropped: [
        ...draft.dropped,
        {
          field: "gap",
          reason: "draft gap is null; model rewrite skipped (open issue)",
        },
      ],
    };
  }

  const { system, prompt } = buildPrompt(input, draft);
  let result = await deps.llm({
    system,
    prompt,
    taskHint: POLISH_TASK_HINT,
  });
  let text = result.text;
  let tokensIn = result.tokensIn;
  let tokensOut = result.tokensOut;
  let model = result.model;

  // Oversize answers are rejected immediately and do not consume the repair budget.
  if (text.length > 8000) {
    return {
      ...draft,
      dropped: [
        ...draft.dropped,
        { field: "answer", reason: "answer exceeded 8000 chars; rejected" },
      ],
      tokensIn,
      tokensOut,
      model,
    };
  }

  let parsed: PolishedAnswer | undefined;
  let parseError: string | undefined;
  try {
    parsed = JSON.parse(text) as PolishedAnswer;
  } catch (err) {
    parseError = (err as Error).message;
  }

  if (parseError) {
    // Exactly one repair call including the parse error, then stop.
    const repairResult = await deps.llm({
      system,
      prompt:
        prompt +
        "\n\nYour previous answer was not valid JSON. Parse error: " +
        parseError +
        ". Please return strictly valid JSON in the same shape.",
      taskHint: POLISH_TASK_HINT,
    });
    tokensIn += repairResult.tokensIn;
    tokensOut += repairResult.tokensOut;
    model = repairResult.model ?? model;
    text = repairResult.text;
    if (text.length <= 8000) {
      try {
        parsed = JSON.parse(text) as PolishedAnswer;
        parseError = undefined;
      } catch (err) {
        parseError = (err as Error).message;
      }
    } else {
      parseError = "repair answer exceeded 8000 chars";
    }
  }

  if (!parsed) {
    return {
      ...draft,
      dropped: [
        ...draft.dropped,
        {
          field: "answer",
          reason: `invalid JSON after repair: ${parseError ?? "unknown"}`,
        },
      ],
      tokensIn,
      tokensOut,
      model,
    };
  }

  const merged = mergeAnswer(draft, parsed);
  const ctx = { evidence: draft.evidence, allowedNames: allowedNames(input) };
  const check = checkDossier(merged, ctx);
  const finalDropped = [...draft.dropped, ...check.dropped];

  // A failed gap headline discards the whole level-1 rewrite.
  const gapHeadlineDropped = check.dropped.some((d) => d.field === "gap.headline");
  if (gapHeadlineDropped) {
    return {
      ...draft,
      dropped: finalDropped,
      tokensIn,
      tokensOut,
      model,
    };
  }

  const afterFallback = applyFallbacks(merged, draft, check.dropped);
  return {
    ...afterFallback,
    dropped: finalDropped,
    level: 1,
    tokensIn,
    tokensOut,
    model,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function saveDossier(d: Dossier): void {
  const db = getDb();
  ensureDossiersTable(db);
  db.prepare(
    "INSERT OR REPLACE INTO dossiers (workspaceId, leadId, json, inputHash, level, createdAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(d.workspaceId, d.leadId, JSON.stringify(d), d.inputHash, d.level, d.createdAt);
}

export function getDossier(workspaceId: string, leadId: string): Dossier | undefined {
  const db = getDb();
  ensureDossiersTable(db);
  const row = db
    .prepare(
      "SELECT json FROM dossiers WHERE workspaceId = ? AND leadId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1"
    )
    .get(workspaceId, leadId) as { json?: string } | undefined;
  if (!row || typeof row.json !== "string") return undefined;
  try {
    return JSON.parse(row.json) as Dossier;
  } catch {
    return undefined;
  }
}

export function setCallStatus(
  workspaceId: string,
  leadId: string,
  status: Dossier["callStatus"]
): Dossier | undefined {
  const existing = getDossier(workspaceId, leadId);
  if (!existing) return undefined;
  const next: Dossier = { ...existing, callStatus: status };
  saveDossier(next);
  return next;
}
