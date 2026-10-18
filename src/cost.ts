// src/cost.ts
// LLM cost ledger and the S7 selection gate.

import { getDb } from "./store.js";
import type { CostBudget } from "./types-v2.js";

export const DEFAULT_BUDGET: CostBudget = {
  maxTokensPerJob: 150_000,
  maxLlmLeadsPerJob: 25,
  llmTopPercent: 10,
  minScoreForLlm: 60,
  minEvidenceForLlm: 3,
};

const TOKENS_PER_LEAD_ESTIMATE = 5_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS llm_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspaceId TEXT NOT NULL,
  jobId TEXT,
  leadId TEXT,
  inputHash TEXT,
  purpose TEXT NOT NULL,
  model TEXT,
  tokensIn INTEGER NOT NULL,
  tokensOut INTEGER NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_job ON llm_ledger(jobId);
CREATE INDEX IF NOT EXISTS idx_ledger_lead_hash ON llm_ledger(leadId, inputHash);
`;

getDb().exec(SCHEMA);

export type LedgerEntry = {
  workspaceId: string;
  jobId?: string;
  leadId?: string;
  inputHash?: string;
  purpose: "dossier" | "dossier-repair" | "explainer";
  model?: string;
  tokensIn: number;
  tokensOut: number;
  estimated?: boolean;
};

export function record(entry: LedgerEntry): void {
  getDb()
    .prepare(
      `INSERT INTO llm_ledger (workspaceId, jobId, leadId, inputHash, purpose, model, tokensIn, tokensOut, estimated, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.workspaceId,
      entry.jobId ?? null,
      entry.leadId ?? null,
      entry.inputHash ?? null,
      entry.purpose,
      entry.model ?? null,
      entry.tokensIn,
      entry.tokensOut,
      entry.estimated ? 1 : 0,
      new Date().toISOString()
    );
}

export function spentForJob(jobId: string): number {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(tokensIn + tokensOut), 0) AS total FROM llm_ledger WHERE jobId = ?")
    .get(jobId) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

export function callsFor(leadId: string, inputHash: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM llm_ledger WHERE leadId = ? AND inputHash = ?")
    .get(leadId, inputHash) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function selectForLlm(
  cands: { leadId: string; total: number; gate: string; richEvidence: number }[],
  budget: CostBudget,
  spentTokens: number
): string[] {
  const qualified = cands.filter(
    (c) => c.gate === "template" && c.total >= budget.minScoreForLlm && c.richEvidence >= budget.minEvidenceForLlm
  );
  if (qualified.length === 0) return [];

  qualified.sort((a, b) => b.total - a.total);

  const topN = Math.max(1, Math.ceil(qualified.length * budget.llmTopPercent / 100));
  let allowedByCap = Math.min(topN, budget.maxLlmLeadsPerJob);

  // Token budget: each selected lead is estimated at 5,000 tokens.
  const remainingTokens = budget.maxTokensPerJob - spentTokens;
  const allowedByTokens = Math.max(0, Math.floor(remainingTokens / TOKENS_PER_LEAD_ESTIMATE));
  allowedByCap = Math.min(allowedByCap, allowedByTokens);

  if (allowedByCap <= 0) return [];

  return qualified.slice(0, allowedByCap).map((c) => c.leadId);
}
