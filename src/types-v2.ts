// src/types-v2.ts - wave 2 contract (docs/leadgen/PLAN_V2.md section 2.1)

export type EvidenceKind = "listing" | "page-text" | "structured-data" | "absence" | "verification";
export type Evidence = {
  id: string;          // "E1", "E2", ... unique within one business snapshot
  kind: EvidenceKind;
  url: string;         // where it came from: OSM element URL, page URL, robots.txt URL
  quote: string;       // exact text span from the source, max 300 chars; for "absence": what was checked and not found
  field?: string;      // what it supports: "phone", "owner", "since-year", "rating", "signal:no-online-booking", ...
  fetchedAt: string;   // ISO time of the fetch
};
export type Cited<T> = { value: T; evidence: string[] };   // evidence ids, never empty

export type GapTag = "GOING UNSEEN" | "LEAKING" | "OUTDATED" | "NOT MEASURING";
export type Quote = { currency: string; min: number; max: number };
export type DossierOffer = {
  rank: number;                 // 1..5
  service: string;              // a service id present in the workspace price book and offer
  title: string;                // price book label
  description: Cited<string>;   // what we would build for this business
  whyItMatters: Cited<string>;
  buildDays: [number, number] | null;   // from the price book, filled by code
  quote: Quote | null;                  // from the price book, filled by code; null = price not set
  assumption: string;                   // from the price book, always shown next to the quote
  doorOpener: boolean;                  // the free first piece of work
};
export type CallStatus = "not-called" | "queued" | "called" | "no-answer" | "call-back" | "not-interested" | "meeting-set";
export type Dossier = {
  leadId: string; workspaceId: string; bizKey: string;
  level: 0 | 1;                 // 0 = rule templates only, no model; 1 = model-polished and citation-checked
  facts: { owner?: Cited<string>; sinceYear?: Cited<number>; rating?: Cited<number>; reviewCount?: Cited<number>; area?: Cited<string> };
  gap: { headline: Cited<string>; tag: GapTag } | null;   // null = no evidenced gap
  sayThis: Cited<string> | null;
  pushback: Cited<string> | null;
  offers: DossierOffer[];       // max 5, ranked, at most one doorOpener
  explainerId?: string;         // shared category explainer id
  evidence: Evidence[];         // the numbered list shown to the reader
  callStatus: CallStatus;
  dropped: { field: string; reason: string }[];   // claims removed by the citation checker
  inputHash: string; promptVersion: string; model?: string;
  tokensIn: number; tokensOut: number; createdAt: string;
};

export type Verification = {
  bizKey: string; checkedAt: string;
  website: "alive" | "dead" | "none" | "not-checked"; finalUrl?: string; httpStatus?: number;
  emails: { value: string; result: "ok" | "no-mx" | "bad-syntax" | "disposable" | "dummy" }[];
  phones: { value: string; e164?: string; result: "mobile" | "landline" | "invalid" }[];
  whatsapp: boolean;
  contactable: boolean;         // at least one valid route: ok email, valid phone, or WhatsApp link
  reasons: string[];
};
export type LeadScore = {
  total: number; fit: number; reach: number; timing: number;   // 0-100 each
  gate: "hidden" | "template" | "llm";
  reasons: string[];            // each names a signal, a verification result or a calendar entry
};
export type CategoryExplainer = {
  id: string; category: string; country: string; language: string;
  howItWorks: string[];         // max 6 short bullets, general to the category, never about one business
  whereAutomationHelps: { service: string; point: string }[];
  promptVersion: string; model?: string; tokensIn: number; tokensOut: number; createdAt: string; reviewed: boolean;
};
export type PriceItem = {
  service: string; label: string; description: string;
  buildDays: [number, number] | null; price: Quote | null;
  assumption: string; doorOpener: boolean;
};
export type PriceBook = { workspaceId: string; version: number; items: PriceItem[]; updatedAt: string };
export type Branding = { displayName: string; logoUrl?: string; accent?: string; contactLine?: string; reportFooter?: string; senderName?: string; hidePoweredBy: boolean };
export type UsageField = "discovered" | "enriched" | "dossiers" | "tokensIn" | "tokensOut" | "exports" | "apiCalls";
export type Usage = { workspaceId: string; month: string } & Record<UsageField, number>;
export type Limits = { leadsPerMonth: number; dossiersPerMonth: number; tokensPerMonth: number; exportsPerMonth: number; apiCallsPerMonth: number };
export type CostBudget = { maxTokensPerJob: number; maxLlmLeadsPerJob: number; llmTopPercent: number; minScoreForLlm: number; minEvidenceForLlm: number };
export type LlmFn = (req: { system: string; prompt: string; taskHint?: string }) => Promise<{ text: string; tokensIn: number; tokensOut: number; model?: string; estimated?: boolean }>;
export type OptOut = { id: string; kind: "domain" | "email" | "phone" | "bizKey"; value: string; scope: string; source: string; createdAt: string }; // scope "global" or a workspace id
