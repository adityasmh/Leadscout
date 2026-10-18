// Category explainer cache (L9). Generated once per (category, country, language, promptVersion).
// import type { CategoryExplainer, LlmFn } from "./types-v2.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./store.js";
import type { CategoryExplainer, LlmFn } from "./types-v2.js";

export const EXPLAINER_PROMPT_VERSION = "2026-10-07-v1";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_RULES_PATH = join(HERE, "..", "data", "service-rules.json");

let tableEnsured = false;
let serviceIdsCache: Set<string> | undefined;
let serviceSourceLogged = false;

function ensureTable(): void {
  if (tableEnsured) return;
  getDb().exec(`
CREATE TABLE IF NOT EXISTS category_explainers (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  country TEXT NOT NULL,
  language TEXT NOT NULL,
  promptVersion TEXT NOT NULL,
  howItWorks TEXT NOT NULL,
  whereAutomationHelps TEXT NOT NULL,
  model TEXT,
  tokensIn INTEGER NOT NULL,
  tokensOut INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  reviewed INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_explainers_key
  ON category_explainers(category, country, language, promptVersion);
CREATE INDEX IF NOT EXISTS idx_explainers_created
  ON category_explainers(createdAt);
`);
  tableEnsured = true;
}

function rowToExplainer(row: any): CategoryExplainer {
  return {
    id: row.id,
    category: row.category,
    country: row.country,
    language: row.language,
    promptVersion: row.promptVersion,
    howItWorks: JSON.parse(row.howItWorks),
    whereAutomationHelps: JSON.parse(row.whereAutomationHelps),
    model: row.model ?? undefined,
    tokensIn: Number(row.tokensIn),
    tokensOut: Number(row.tokensOut),
    createdAt: row.createdAt,
    reviewed: Boolean(row.reviewed),
  };
}

function loadServiceIds(): Set<string> {
  if (serviceIdsCache) return serviceIdsCache;
  try {
    const raw = JSON.parse(readFileSync(SERVICE_RULES_PATH, "utf8"));
    const ids: string[] = (raw.services ?? []).map((s: any) => String(s.id));
    serviceIdsCache = new Set(ids);
    if (!serviceSourceLogged) {
      console.log(`[explainer] service id source: data/service-rules.json (${ids.length} ids)`);
      serviceSourceLogged = true;
    }
  } catch {
    // Fallback: CONTRACT Offer comment list plus the L5 order list.
    const fallback = [
      "website",
      "automation",
      "ai-chatbot",
      "seo",
      "crm-setup",
      "website-redesign",
      "whatsapp-automation",
      "booking-system",
      "ecommerce",
      "ai-voice-agent",
      "lead-gen",
    ];
    serviceIdsCache = new Set(fallback);
    if (!serviceSourceLogged) {
      console.log(`[explainer] service id source: fallback (CONTRACT Offer comment + L5 order list, ${fallback.length} ids)`);
      serviceSourceLogged = true;
    }
  }
  return serviceIdsCache;
}

function allowedNames(category: string, country: string): Set<string> {
  const names = new Set<string>();
  for (const part of [category, country]) {
    for (const word of part.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word) names.add(word);
    }
  }
  return names;
}

/**
 * Capitalisation heuristic. Sentence-initial capitals are allowed because they are grammar,
 * not proper nouns. Any other capitalised token is allowed only if it matches category or
 * country (case-insensitive, word-by-word). This is intentionally conservative and will flag
 * some legitimate words; that is recorded as an open issue in the L9 report.
 */
function hasDisallowedCapitalisation(texts: string[], category: string, country: string): boolean {
  const allowed = allowedNames(category, country);
  for (const text of texts) {
    // Split into sentences by terminal punctuation followed by whitespace.
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const tokens = sentence.trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        // Sentence-initial token is allowed to be capitalised.
        if (i === 0) continue;
        const alpha = token.replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z]+$/, "");
        if (!alpha) continue;
        if (alpha[0] >= "A" && alpha[0] <= "Z") {
          if (allowed.has(alpha.toLowerCase())) continue;
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Heuristic to avoid naming or describing one specific business. Triggers:
 * - ampersand or straight/double quotes (often appear in brand names);
 * - common company suffixes;
 * - URLs.
 */
function mentionsSpecificBusiness(texts: string[]): boolean {
  const combined = texts.join(" ");
  if (/["&]/.test(combined)) return true;
  if (/\b(LLC|Ltd|Inc|Limited|Pvt|GmbH|Co\.?|Corp\.?|LLP|PLC)\b/i.test(combined)) return true;
  if (/\bwww\.|\.com\b/i.test(combined)) return true;
  return false;
}

/**
 * Validate the LLM answer before saving. Returns parsed data on success, null on any failure.
 * - JSON shape: { howItWorks: string[], whereAutomationHelps: {service, point}[] }
 * - Max 6 howItWorks bullets.
 * - Each bullet max 25 words (whitespace split).
 * - service must be a known service id.
 * - No digits anywhere in values.
 * - No disallowed capitalisation (see above).
 * - No specific business names (heuristic).
 */
function validateAnswer(
  text: string,
  category: string,
  country: string
): { howItWorks: string[]; whereAutomationHelps: { service: string; point: string }[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.howItWorks) || !Array.isArray(obj.whereAutomationHelps)) return null;

  if (obj.howItWorks.length > 6) return null;

  const allowedServices = loadServiceIds();
  const allValues: string[] = [];
  const howItWorks: string[] = [];

  for (const raw of obj.howItWorks) {
    if (typeof raw !== "string") return null;
    const bullet = raw.trim();
    if (!bullet) return null;
    // Word count rule: split on whitespace and count non-empty tokens.
    const wordCount = bullet.split(/\s+/).filter(Boolean).length;
    if (wordCount > 25) return null;
    allValues.push(bullet);
    howItWorks.push(bullet);
  }

  const whereAutomationHelps: { service: string; point: string }[] = [];
  for (const raw of obj.whereAutomationHelps) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.service !== "string" || typeof item.point !== "string") return null;
    const service = item.service.trim();
    const point = item.point.trim();
    if (!service || !point) return null;
    if (!allowedServices.has(service)) return null;
    allValues.push(service, point);
    whereAutomationHelps.push({ service, point });
  }

  // No digits anywhere in the returned values.
  if (/\d/.test(allValues.join(" "))) return null;

  if (hasDisallowedCapitalisation(allValues, category, country)) return null;
  if (mentionsSpecificBusiness(allValues)) return null;

  return { howItWorks, whereAutomationHelps };
}

function buildPrompt(category: string, country: string, _language: string): { system: string; prompt: string } {
  const system =
    "You are a helpful assistant that writes general business process explainers for a category of business in a country. " +
    "Output only valid JSON. Never name a specific business, owner, brand, phone number, year, price, or URL. " +
    "Use lowercase except for the category and country names.";

  const allowedServices = Array.from(loadServiceIds()).join(", ");

  const prompt = `Explain how a typical ${category} business in ${country} gets customers, handles enquiries and bookings, and where manual work tends to pile up.

Reply with compact JSON:

{
  "howItWorks": ["short bullet", "..."],
  "whereAutomationHelps": [
    {"service": "one of: ${allowedServices}", "point": "one short sentence"}
  ]
}

Rules:
- howItWorks: at most 6 bullets, each at most 25 words.
- whereAutomationHelps: service must be exactly one of the ids listed above; point is one short sentence.
- No digits, years, prices, phone numbers, URLs, or business names anywhere.
- Do not capitalise any words except ${category} and ${country}.
- Write generally about the category, not about any single business.`;

  return { system, prompt };
}

/**
 * Get a category explainer. Cache hit returns the stored row with zero LLM calls.
 * On cache miss, generation only happens when allowGenerate is true and an llm is available.
 * Default llm is loaded dynamically from ./llm.js; if that fails the function returns null.
 */
export async function getExplainer(
  category: string,
  country: string,
  deps?: { llm?: LlmFn; allowGenerate?: boolean; language?: string }
): Promise<CategoryExplainer | null> {
  ensureTable();
  const cat = (category ?? "").trim().toLowerCase();
  const ctry = (country ?? "").trim().toLowerCase();
  if (!cat || !ctry) return null;

  // Language source: deps.language, otherwise 'en'. Documented in the L9 report.
  const language = deps?.language?.trim() || "en";

  const existing = getDb()
    .prepare(
      "SELECT * FROM category_explainers WHERE category = ? AND country = ? AND language = ? AND promptVersion = ?"
    )
    .get(cat, ctry, language, EXPLAINER_PROMPT_VERSION) as any;
  if (existing) return rowToExplainer(existing);

  if (deps?.allowGenerate !== true) return null;

  let llm: LlmFn | undefined = deps?.llm;
  if (!llm) {
    try {
      const mod = await import("./llm.js");
      llm = (mod as any).defaultLlm as LlmFn | undefined;
    } catch {
      // Missing or broken default llm module -> null, never throw.
      return null;
    }
  }
  if (!llm) return null;

  const { system, prompt } = buildPrompt(cat, ctry, language);
  if (prompt.length >= 3200) return null;

  let result: Awaited<ReturnType<LlmFn>>;
  try {
    result = await llm({
      system,
      prompt,
      taskHint: "leadscout category explainer: short structured JSON, low complexity",
    });
  } catch {
    // Default or injected llm failed; treat as a generation failure (no save, no throw).
    return null;
  }

  const validated = validateAnswer(result.text, cat, ctry);
  if (!validated) return null;

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const model = result.model ?? null;

  getDb()
    .prepare(
      `INSERT INTO category_explainers
       (id, category, country, language, promptVersion, howItWorks, whereAutomationHelps, model, tokensIn, tokensOut, createdAt, reviewed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      cat,
      ctry,
      language,
      EXPLAINER_PROMPT_VERSION,
      JSON.stringify(validated.howItWorks),
      JSON.stringify(validated.whereAutomationHelps),
      model,
      result.tokensIn,
      result.tokensOut,
      createdAt,
      0
    );

  return rowToExplainer({
    id,
    category: cat,
    country: ctry,
    language,
    promptVersion: EXPLAINER_PROMPT_VERSION,
    howItWorks: JSON.stringify(validated.howItWorks),
    whereAutomationHelps: JSON.stringify(validated.whereAutomationHelps),
    model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    createdAt,
    reviewed: 0,
  });
}

/**
 * Mark an explainer as reviewed. Unknown ids are a no-op (returns false).
 * listExplainers() on an empty table returns [].
 */
export function markReviewed(id: string): boolean {
  ensureTable();
  const res = getDb()
    .prepare("UPDATE category_explainers SET reviewed = 1 WHERE id = ?")
    .run(id);
  return (res.changes ?? 0) > 0;
}

export function listExplainers(): CategoryExplainer[] {
  ensureTable();
  const rows = getDb()
    .prepare("SELECT * FROM category_explainers ORDER BY createdAt DESC, rowid DESC")
    .all() as any[];
  return rows.map(rowToExplainer);
}
