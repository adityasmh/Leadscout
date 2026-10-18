// src/intake.ts
// L29-intake: adaptive intake interview -> Target Brief -> discovery queries.
// Loads the question tree (data/intake-questions.json) written by the parallel
// coder against the binding schema in the order. Node 24 built-ins only,
// ES modules, .js import suffix.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------ question tree

export type IntakeSection = {
  id: string;
  letter: string;
  title: string;
  order: number;
  questions: IntakeQuestion[];
};

export type IntakeQuestion = {
  id: string; // "<section>.<name>"
  text: string;
  type: "text" | "number" | "choice" | "multi" | "list" | "url-list";
  options?: string[];
  required: boolean;
  expect?: "number" | "place" | "url" | "any";
  minWords?: number;
  minItems?: number;
  followUp?: string;
  showIf?: { id: string; equals?: string; includes?: string };
  section?: string;
};

export type IntakeTree = {
  version: number;
  sections: IntakeSection[];
  packs: Record<string, { label: string; match: string[]; questions: IntakeQuestion[] }>;
};

const DEFAULT_TREE_FILE = join(HERE, "..", "data", "intake-questions.json");

export function loadTree(path?: string): IntakeTree {
  return JSON.parse(readFileSync(path ?? DEFAULT_TREE_FILE, "utf-8")) as IntakeTree;
}

// The tree the flow functions use. Defaults to the shipped file; tests can point
// LEADSCOUT_INTAKE_TREE at a different file before importing this module.
const TREE = loadTree(process.env.LEADSCOUT_INTAKE_TREE);

export const SECTION_IDS = TREE.sections
  .slice()
  .sort((a, b) => a.order - b.order)
  .map((s) => s.id);

export const PACK_KEYS = Object.keys(TREE.packs);

function sectionById(id: string): IntakeSection | undefined {
  return TREE.sections.find((s) => s.id === id);
}

// ------------------------------------------------------------------- types

export type IntakeState = {
  workspaceId?: string;
  answers: Record<string, string | number | string[]>;
  industry?: string;
};

export type IntakeQuestionOut = IntakeQuestion & { sectionId: string; sectionTitle: string; parentId?: string };

export type DiscoveryQuery = { category: string; city: string; country: string; limit: number };

export type TargetBriefSection = {
  sectionId: string;
  title: string;
  answers: { id: string; text: string; value: string | number | string[] }[];
};

export type TargetBrief = {
  sections: TargetBriefSection[];
  meta: {
    workspaceId?: string;
    industry?: string;
    packKey?: string;
    packLabel?: string;
    createdAt: string;
  };
};

export type CompiledQueries = {
  queries: DiscoveryQuery[];
  signalPriorities: string[];
  scoringWeights: Record<string, number>;
  exclusions: { terms: string[]; rules: string[] };
  dossierTone: string;
};

// ------------------------------------------------------------ answer helpers

function isAnswered(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function answerOf(state: IntakeState, id: string): string | number | string[] | undefined {
  const direct = state.answers[id];
  if (isAnswered(direct)) return direct;
  if (id === "niche.industry" && state.industry !== undefined) return state.industry;
  return undefined;
}

function textOf(value: string | number | string[] | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).join(", ");
  return String(value).trim();
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// ------------------------------------------------------------------ pack match

function matchPack(state: IntakeState): { key: string; pack: IntakeTree["packs"][string] } | undefined {
  const industry = textOf(answerOf(state, "niche.industry")).toLowerCase();
  if (industry === "") return undefined;
  for (const [key, pack] of Object.entries(TREE.packs)) {
    if (pack.match.some((kw) => kw !== "" && industry.includes(kw.toLowerCase()))) return { key, pack };
  }
  return undefined;
}

// ---------------------------------------------------------------- vague checks

export function isVagueAnswer(q: IntakeQuestion, value: string | number | string[]): boolean {
  if (!isAnswered(value)) return false;
  if (Array.isArray(value)) {
    if (q.minItems !== undefined && value.length < q.minItems) return true;
    return false;
  }
  const text = textOf(value);
  if (q.expect === "number" || q.type === "number") return text === "" || !/\d/.test(text);
  if (q.expect === "place") {
    const placeWords =
      /\b(mumbai|delhi|new delhi|bengaluru|bangalore|chennai|kolkata|hyderabad|pune|ahmedabad|jaipur|lucknow|kanpur|nagpur|indore|thane|bhopal|visakhapatnam|surat|patna|vadodara|ghaziabad|ludhiana|agra|nashik|faridabad|meerut|rajkot|varanasi|navi mumbai|ranchi|noida|gurgaon|gurugram|india|usa|united states|uk|canada|australia|uae|dubai|city|town|state|district|area|radius|km|within)\b/i;
    const properNoun = /(^|[^A-Za-z])[A-Z][a-zA-Z]{2,}/.test(text);
    return !(placeWords.test(text) || properNoun);
  }
  if (q.expect === "url") return !/\w+\.\w/.test(text);
  if (typeof value === "number") return false;
  if (q.minWords !== undefined) return words(text).length < q.minWords || text.length < 3;
  return text.length < 3;
}

function followUpTextOf(q: IntakeQuestion): string {
  if (q.followUp !== undefined && q.followUp.trim() !== "") return q.followUp;
  return `The answer looks a bit short. Can you say more about "${q.text}"? Details like numbers, places or names help.`;
}

function sectionOfQuestion(id: string): string {
  const dot = id.indexOf(".");
  return dot > 0 ? id.slice(0, dot) : "";
}

function sectionTitle(sectionId: string): string {
  const section = sectionById(sectionId);
  if (section) return section.title;
  for (const pack of Object.values(TREE.packs)) {
    if (pack.questions.some((q) => q.id.split(".")[0] === sectionId)) return sectionId;
  }
  return sectionId;
}

function questionVisible(q: IntakeQuestion, state: IntakeState): boolean {
  if (!q.showIf) return true;
  const actual = answerOf(state, q.showIf.id);
  if (actual === undefined) return false;
  if (q.showIf.equals !== undefined) return textOf(actual).toLowerCase() === q.showIf.equals.toLowerCase();
  if (q.showIf.includes !== undefined) return textOf(actual).toLowerCase().includes(q.showIf.includes.toLowerCase());
  return true;
}

// ------------------------------------------------------------- nextQuestions

function emitQuestions(
  state: IntakeState,
  out: IntakeQuestionOut[],
  sectionId: string,
  sectionTitleText: string,
  questions: IntakeQuestion[]
): void {
  for (const q of questions) {
    if (!questionVisible(q, state)) continue;
    const value = answerOf(state, q.id);
    if (!isAnswered(value)) {
      out.push({ ...q, sectionId, sectionTitle: sectionTitleText });
      continue;
    }
    // Answered: at most one vague-answer follow-up per question, never asked again
    // once "<qid>.followup" itself has an answer.
    const followUpId = `${q.id}.followup`;
    if (isAnswered(state.answers[followUpId])) continue;
    if (isVagueAnswer(q, value as string | number | string[])) {
      out.push({
        id: followUpId,
        text: followUpTextOf(q),
        type: "text",
        required: false,
        parentId: q.id,
        sectionId,
        sectionTitle: sectionTitleText,
      });
    }
  }
}

export function nextQuestions(state: IntakeState): IntakeQuestionOut[] {
  const out: IntakeQuestionOut[] = [];
  for (const section of TREE.sections.slice().sort((a, b) => a.order - b.order)) {
    emitQuestions(state, out, section.id, section.title, section.questions);
  }
  const pack = matchPack(state);
  if (pack && isAnswered(answerOf(state, "niche.industry"))) {
    const firstId = pack.pack.questions[0]?.id ?? "pack";
    emitQuestions(state, out, sectionOfQuestion(firstId), `More about ${pack.pack.label}`, pack.pack.questions);
  }
  return out;
}

// ------------------------------------------------------------ refineWithModel

export async function refineWithModel(
  state: IntakeState,
  modelFn?: (req: { system: string; prompt: string; taskHint?: string }) => Promise<{ text: string }>
): Promise<string[]> {
  if (!modelFn) return [];
  const prompt = buildRefinePrompt(state);
  let text: string;
  try {
    const reply = await modelFn({
      system:
        "You write short, sharp follow-up interview questions for a lead-generation intake. " +
        "Reply with one question per line, three lines maximum.",
      prompt,
      taskHint: "follow-up questions",
    });
    text = reply?.text ?? "";
  } catch {
    return [];
  }
  return parseRefineReply(text).slice(0, 3);
}

function buildRefinePrompt(state: IntakeState): string {
  const lines: string[] = ['Current intake answers (empty means not answered yet):'];
  for (const section of TREE.sections.slice().sort((a, b) => a.order - b.order)) {
    for (const q of section.questions) {
      const value = answerOf(state, q.id);
      if (value === undefined) continue;
      lines.push(`- ${q.id}: ${textOf(value)}`);
    }
  }
  if (state.industry !== undefined) lines.push(`- industry: ${state.industry}`);
  const pack = matchPack(state);
  if (pack) lines.push(`- category pack: ${pack.pack.label}`);
  lines.push(
    "Suggest up to 3 sharper follow-up questions that would most improve the target brief. " +
      "JSON only, please, in exactly this shape: [\"question 1\", \"question 2\", \"question 3\"] " +
      "(or write plain lines, one question per line)."
  );
  return lines.join("\n");
}

function parseRefineReply(text: string): string[] {
  const out: string[] = [];
  if (typeof text !== "string") return out;
  const trimmed = text.trim();
  // Try JSON array first.
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item !== "string") continue;
          const clean = sanitiseLine(item);
          if (clean !== "" && !out.includes(clean)) out.push(clean);
        }
        if (out.length > 0) return out;
      }
    } catch {
      // fall through to line parsing
    }
  }
  // Plain lines.
  for (const line of trimmed.split(/\r?\n|\u2022|(?<=[.!?])\s+(?=[A-Z?])/)) {
    const clean = sanitiseLine(line);
    if (clean === "") continue;
    if (clean.length < 8) continue; // junk guard
    if (!clean.includes("?") && !/^(what|which|how|who|when|where|do|does|is|are|can|tell|name|list)/i.test(clean)) continue;
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

function sanitiseLine(line: string): string {
  return String(line)
    .replace(/^[\s\-*ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢\d.)\]]+/, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function sanitiseValue(value: string | number | string[]): string | number | string[] {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((v) => cleanAnswer(v));
  return cleanAnswer(String(value));
}

function cleanAnswer(line: string): string {
  return String(line)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// -------------------------------------------------------------- compileBrief

export function compileBrief(state: IntakeState): TargetBrief {
  const sections: TargetBriefSection[] = [];
  const sorted = TREE.sections.slice().sort((a, b) => a.order - b.order);
  const answeredSectionIds = new Set<string>();

  for (const section of sorted) {
    const entries: TargetBriefSection["answers"] = [];
    for (const q of section.questions) {
      if (q.showIf && !questionVisible(q, state)) continue;
      const value = answerOf(state, q.id);
      if (!isAnswered(value)) continue;
      entries.push({ id: q.id, text: q.text, value: sanitiseValue(value as string | number | string[]) });
      const followUpValue = state.answers[`${q.id}.followup`];
      if (isAnswered(followUpValue)) {
        entries.push({
          id: `${q.id}.followup`,
          text: `Follow-up for: ${q.text}`,
          value: sanitiseValue(followUpValue),
        });
      }
    }
    if (entries.length > 0) {
      answeredSectionIds.add(section.id);
      sections.push({ sectionId: section.id, title: section.title, answers: entries });
    }
  }

  // Category pack questions that were answered land in their own pseudo-sections.
  const pack = matchPack(state);
  const packAnswered: TargetBriefSection["answers"] = [];
  if (pack) {
    for (const q of pack.pack.questions) {
      for (const id of [q.id, `${q.id}.followup`]) {
        const value = answerOf(state, id);
        if (!isAnswered(value)) continue;
        packAnswered.push({
          id,
          text: id === q.id ? q.text : `Follow-up for: ${q.text}`,
          value: sanitiseValue(value as string | number | string[]),
        });
      }
    }
    if (packAnswered.length > 0) answeredSectionIds.add(pack.key);
  }

  const brief: TargetBrief = {
    sections,
    meta: {
      workspaceId: state.workspaceId,
      industry: textOf(answerOf(state, "niche.industry")) !== "" ? textOf(answerOf(state, "niche.industry")) : undefined,
      packKey: pack ? pack.key : undefined,
      packLabel: pack ? pack.pack.label : undefined,
      createdAt: new Date().toISOString(),
    },
  };
  if (packAnswered.length > 0) {
    brief.sections.push({ sectionId: pack!.key, title: `Pack: ${pack!.pack.label}`, answers: packAnswered });
  }
  return brief;
}

export function answeredSections(brief: TargetBrief): string[] {
  return brief.sections.map((s) => s.sectionId);
}

// -------------------------------------------------------------- pack presence

export function packForIndustry(industry: string): { key: string; label: string } | undefined {
  const found = matchPack({ answers: {}, industry: industry ?? "" });
  return found ? { key: found.key, label: found.pack.label } : undefined;
}

// ------------------------------------------------------------ briefToQueries

export function briefToQueries(brief: TargetBrief): CompiledQueries {
  const readAll = (sectionId: string): string[] => {
    const section = brief.sections.find((s) => s.sectionId === sectionId);
    if (!section) return [];
    return section.answers.flatMap((a) => (Array.isArray(a.value) ? a.value.map(textOf) : [textOf(a.value)]))
      .filter((v) => v !== "");
  };
  const sectionFrom = (id: string): string | undefined => {
    for (const section of brief.sections) {
      for (const a of section.answers) {
        if (a.id === id) return textOf(a.value);
      }
    }
    return undefined;
  };

  const country = (sectionFrom("geo.country") ?? "").trim() || "IN";
  const cityCandidates = (brief.sections.find((s) => s.sectionId === "geo")?.answers ?? [])
    .filter((a) => a.id === "geo.cities")
    .flatMap((a) => (Array.isArray(a.value) ? a.value : [a.value]))
    .map(textOf)
    .filter((v) => v !== "");
  // One list item is one city (the follow-up says one per line); a radius entry
  // like "Pune, 30 km" keeps the city part only.
  const cityList = cityCandidates
    .map((v) => {
      const m = v.match(/^(.*?),\s*\d+\s*km\b/i);
      return m ? m[1] : v;
    })
    .map((v) => v.trim())
    .filter((v) => v.length >= 2 && !/^none?$/i.test(v));

  const industry = brief.meta.industry ?? readAll("niche").find((v) => v !== "") ?? "";
  const sectionNiche = brief.sections.find((s) => s.sectionId === "niche");
  const subNiche = (sectionNiche?.answers ?? [])
    .filter((a) => a.id !== "niche.industry")
    .map((a) => textOf(a.value))
    .filter((v) => v !== "")[0];

  // limit: weekly callable volume, bounded 1..200, default 20
  const limitRaw =
    sectionFrom("volume.callsPerWeek") ??
    sectionFrom("volume.leadsPerWeek") ??
    sectionFrom("volume.perWeek") ??
    sectionFrom("volume.callCapacity") ??
    readAll("volume")[0];
  let limit = 20;
  if (limitRaw !== undefined) {
    const parsed = parseInt(String(limitRaw).replace(/[^\d]/g, ""), 10);
    if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
  }
  limit = Math.max(1, Math.min(200, Math.floor(limit)));

  const category = (subNiche && subNiche !== industry ? `${subNiche}` : industry) || "business";
  const uniqueCities = cityList.length > 0 ? Array.from(new Set(cityList)) : [""];
  const queries: DiscoveryQuery[] = uniqueCities.map((city) => ({
    category: category.trim() || "business",
    city: city.trim(),
    country: country.trim(),
    limit,
  }));

  // signal priorities: CONTRACT SIGNALS ids only
  const signalAnswers = readAll("signals").join(" ").toLowerCase();
  const SIGNAL_IDS = [
    "no-website", "no-https", "not-mobile-friendly", "no-contact-form", "no-chat-widget",
    "no-online-booking", "no-analytics", "outdated-copyright", "wordpress", "wix", "shopify",
    "custom-cms", "has-whatsapp", "has-email", "has-phone", "social-active-links", "slow-response",
    "site-unreachable", "ecommerce", "appointment-based", "high-volume-enquiry-type",
  ];
  const signalPriorities = SIGNAL_IDS.filter((id) =>
    id.split("-").some((part) => part.length > 2 && signalAnswers.includes(part))
  );

  // scoring weights keyed by service ids from the offer + signal ids
  const scoringWeights: Record<string, number> = {};
  const offerAnswers = readAll("offer").join(" ").toLowerCase();
  for (const service of ["website", "automation", "ai-chatbot", "seo", "crm-setup"]) {
    if (offerAnswers.includes(service.replace("-", " ")) || offerAnswers.includes(service)) {
      scoringWeights[service] = 2;
    }
  }
  for (const id of signalPriorities) scoringWeights[id] = 1.5;

  // exclusions from the exclusions section
  const exclusionRaw = readAll("exclusions").join("; ");
  const exclusionTerms = exclusionTermsOf(exclusionRaw);
  const exclusions: CompiledQueries["exclusions"] = {
    terms: exclusionTerms,
    rules: exclusionRaw === "" ? [] : [exclusionRaw],
  };

  // tone from the outreach section
  const toneAnswer = (sectionFrom("outreach.tone") ?? "").trim();
  const outreachRaw = toneAnswer !== "" ? toneAnswer : readAll("outreach").join(" ");
  let dossierTone = "plain, direct, no hype";
  if (outreachRaw !== "") {
    if (/formal|professional/i.test(outreachRaw)) dossierTone = "formal and professional";
    else if (/friendly|warm|casual/i.test(outreachRaw)) dossierTone = "friendly and conversational";
    else if (/short|concise|brief|to the point/i.test(outreachRaw)) dossierTone = "short and to the point";
    else dossierTone = sanitiseLine(outreachRaw).slice(0, 160);
  }

  return { queries, signalPriorities, scoringWeights, exclusions, dossierTone };
}

function exclusionTermsOf(raw: string): string[] {
  if (raw === "") return [];
  return raw
    .split(/[,;\n]+/)
    .map((term) => sanitiseLine(term).toLowerCase())
    .filter((term) => term.length >= 2 && !/^none?$/i.test(term))
    .slice(0, 100);
}

// -------------------------------------------------------------- persistence

const BRIEF_SCHEMA = `
CREATE TABLE IF NOT EXISTS intake_briefs (
  workspaceId TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
`;

// tenant.ts pattern: the table exists from module load. In tests, LEADSCOUT_DB
// must be set before importing this module.
getDb().exec(BRIEF_SCHEMA);

export function saveBrief(workspaceId: string, brief: TargetBrief): void {
  const db = getDb();
  db.exec(BRIEF_SCHEMA);
  db.prepare("INSERT OR REPLACE INTO intake_briefs (workspaceId, json, updatedAt) VALUES (?, ?, ?)")
    .run(workspaceId, JSON.stringify(brief), new Date().toISOString());
}

export function loadBrief(workspaceId: string): TargetBrief | undefined {
  const row = getDb()
    .prepare("SELECT json FROM intake_briefs WHERE workspaceId = ?")
    .get(workspaceId) as { json: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.json) as TargetBrief;
  } catch {
    return undefined;
  }
}
