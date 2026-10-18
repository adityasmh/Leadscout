// Leadscout access control, metering, limits and share tokens.
// Uses the DB from ./store.js so temp-database checks can set LEADSCOUT_DB before import.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "./store.js";
import type { Limits, Usage, UsageField } from "./types-v2.js";

const USAGE_FIELDS: UsageField[] = [
  "discovered",
  "enriched",
  "dossiers",
  "tokensIn",
  "tokensOut",
  "exports",
  "apiCalls",
];

const VALID_SCOPES = new Set(["read", "write"]);

// Usage fields this module does not (yet) know about are still allowed and metered
// instead of throwing: a single missing field must never fail a whole discovery or
// process job. The field is named in exactly one warning line per process.
const warnedUnknownFields = new Set<string>();
function warnUnknownField(field: string): void {
  if (warnedUnknownFields.has(field)) return;
  warnedUnknownFields.add(field);
  console.warn(
    `access: no plan limit for usage field "${field}"; allowing and metering it with the generous default`
  );
}

const LIMIT_KEYS: (keyof Limits)[] = [
  "leadsPerMonth",
  "dossiersPerMonth",
  "tokensPerMonth",
  "exportsPerMonth",
  "apiCallsPerMonth",
];

// Documented generous defaults for the free and demo workspaces (no plan in
// data/plans.json). A paying plan's own numbers are applied per workspace with
// setLimits(); data/plans.json (starter/growth/agency) lists includedLeads,
// includedDossiers and includedPolishCalls for the commercial tiers.
export const DEFAULT_LIMITS: Limits = {
  leadsPerMonth: 2000,
  dossiersPerMonth: 200,
  tokensPerMonth: 1_000_000,
  exportsPerMonth: 50,
  apiCallsPerMonth: 20_000,
};

const ACCESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  lastUsedAt TEXT,
  revokedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON api_keys(workspaceId);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hash);

CREATE TABLE IF NOT EXISTS usage (
  workspaceId TEXT NOT NULL,
  month TEXT NOT NULL,
  discovered INTEGER NOT NULL DEFAULT 0,
  enriched INTEGER NOT NULL DEFAULT 0,
  dossiers INTEGER NOT NULL DEFAULT 0,
  tokensIn INTEGER NOT NULL DEFAULT 0,
  tokensOut INTEGER NOT NULL DEFAULT 0,
  exports INTEGER NOT NULL DEFAULT 0,
  apiCalls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspaceId, month)
);

-- Catch-all counters for usage fields that are not part of the fixed Usage contract,
-- so meter() can record them without a schema change and never throws.
CREATE TABLE IF NOT EXISTS usage_extra (
  workspaceId TEXT NOT NULL,
  month TEXT NOT NULL,
  field TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspaceId, month, field)
);

CREATE TABLE IF NOT EXISTS limits (
  workspaceId TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS share_tokens (
  hash TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  scope TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_tokens_hash ON share_tokens(hash);
`;

// Initialise tables on first use of this module. In tests, LEADSCOUT_DB must be set before import.
getDb().exec(ACCESS_SCHEMA);

function iso(now: Date): string {
  return now.toISOString();
}

function toMonth(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function validateScopes(scopes: string[]): string[] {
  if (!Array.isArray(scopes)) {
    throw new Error("scopes must be an array");
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const s of scopes) {
    if (!VALID_SCOPES.has(s)) {
      throw new Error(`invalid scope: ${s}`);
    }
    if (!seen.has(s)) {
      seen.add(s);
      normalized.push(s);
    }
  }
  if (normalized.length === 0) {
    throw new Error("scopes must not be empty");
  }
  return normalized;
}

// ------------------------------------------------------------------ API keys

export function createApiKey(
  workspaceId: string,
  scopes: string[],
  now = new Date()
): { id: string; key: string } {
  const normalized = validateScopes(scopes);

  const key = "ls_" + randomBytes(32).toString("base64url");
  const hash = sha256(key);
  const prefix = key.slice(0, 8);
  const id = randomUUID();
  const createdAt = iso(now);

  getDb()
    .prepare(
      "INSERT INTO api_keys (id, workspaceId, hash, prefix, scopes, createdAt, lastUsedAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      workspaceId,
      hash,
      prefix,
      JSON.stringify(normalized),
      createdAt,
      null,
      null
    );

  return { id, key };
}

export function verifyApiKey(
  raw: unknown,
  now = new Date()
): { workspaceId: string; scopes: string[] } | null {
  if (typeof raw !== "string") return null;

  const inputHash = sha256(raw);
  const row = getDb()
    .prepare("SELECT * FROM api_keys WHERE hash = ?")
    .get(inputHash) as
    | {
        id: string;
        workspaceId: string;
        hash: string;
        scopes: string;
        revokedAt: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.revokedAt) return null;

  const storedBuf = Buffer.from(row.hash, "hex");
  const inputBuf = Buffer.from(inputHash, "hex");
  if (storedBuf.length !== inputBuf.length) return null;
  if (!timingSafeEqual(storedBuf, inputBuf)) return null;

  getDb()
    .prepare("UPDATE api_keys SET lastUsedAt = ? WHERE id = ?")
    .run(iso(now), row.id);

  return { workspaceId: row.workspaceId, scopes: JSON.parse(row.scopes) as string[] };
}

export function listApiKeys(workspaceId: string): {
  id: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}[] {
  const rows = getDb()
    .prepare(
      "SELECT id, prefix, scopes, createdAt, lastUsedAt, revokedAt FROM api_keys WHERE workspaceId = ? ORDER BY createdAt ASC, rowid ASC"
    )
    .all(workspaceId) as Array<{
      id: string;
      prefix: string;
      scopes: string;
      createdAt: string;
      lastUsedAt: string | null;
      revokedAt: string | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    prefix: r.prefix,
    scopes: JSON.parse(r.scopes) as string[],
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  }));
}

export function revokeApiKey(
  workspaceId: string,
  id: string,
  now = new Date()
): boolean {
  const result = getDb()
    .prepare(
      "UPDATE api_keys SET revokedAt = ? WHERE id = ? AND workspaceId = ?"
    )
    .run(iso(now), id, workspaceId);
  return (result as { changes: number }).changes > 0;
}

// ------------------------------------------------------------------ metering

export function meter(
  workspaceId: string,
  field: UsageField | string,
  n: number,
  now = new Date()
): void {
  if (!Number.isInteger(n)) {
    throw new RangeError("n must be an integer");
  }
  if (n < 0) {
    throw new RangeError("n must be non-negative");
  }
  if (n === 0) {
    return;
  }
  const month = toMonth(now);
  if (!USAGE_FIELDS.includes(field as UsageField)) {
    // Unknown field: allow and meter it in the catch-all table instead of throwing.
    warnUnknownField(String(field));
    getDb()
      .prepare(
        `INSERT INTO usage_extra (workspaceId, month, field, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(workspaceId, month, field) DO UPDATE SET count = count + excluded.count`
      )
      .run(workspaceId, month, String(field), n);
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO usage (workspaceId, month, ${field}) VALUES (?, ?, ?) ON CONFLICT(workspaceId, month) DO UPDATE SET ${field} = ${field} + excluded.${field}`
    )
    .run(workspaceId, month, n);
}

export function getUsage(
  workspaceId: string,
  month?: string,
  now = new Date()
): Usage {
  const targetMonth = month ?? toMonth(now);
  const row = getDb()
    .prepare("SELECT * FROM usage WHERE workspaceId = ? AND month = ?")
    .get(workspaceId, targetMonth) as
    | Record<UsageField, number | null>
    | undefined;

  const base: Usage = {
    workspaceId,
    month: targetMonth,
    discovered: 0,
    enriched: 0,
    dossiers: 0,
    tokensIn: 0,
    tokensOut: 0,
    exports: 0,
    apiCalls: 0,
  };
  if (row) {
    for (const f of USAGE_FIELDS) {
      base[f] = Number(row[f] ?? 0);
    }
  }
  // Unknown fields metered through meter() live in the catch-all table.
  const extra = getDb()
    .prepare("SELECT field, count FROM usage_extra WHERE workspaceId = ? AND month = ?")
    .all(workspaceId, targetMonth) as Array<{ field: string; count: number }>;
  for (const e of extra) {
    (base as Record<string, number>)[String(e.field)] = Number(e.count);
  }
  return base;
}

// ------------------------------------------------------------------ limits

export function getLimits(workspaceId: string): Limits {
  const row = getDb()
    .prepare("SELECT json FROM limits WHERE workspaceId = ?")
    .get(workspaceId) as { json: string } | undefined;
  const stored = row ? (JSON.parse(row.json) as Partial<Limits>) : {};
  return { ...DEFAULT_LIMITS, ...stored };
}

export function setLimits(
  workspaceId: string,
  partialLimits: Partial<Limits>
): void {
  if (!partialLimits || typeof partialLimits !== "object") {
    throw new Error("limits must be an object");
  }
  const allowed = new Set(LIMIT_KEYS);
  for (const key of Object.keys(partialLimits)) {
    if (!allowed.has(key as keyof Limits)) {
      throw new Error(`unknown limit key: ${key}`);
    }
    const value = partialLimits[key as keyof Limits];
    if (
      typeof value !== "number" ||
      Number.isNaN(value) ||
      !Number.isInteger(value) ||
      value < 0
    ) {
      throw new Error(`${key} must be a non-negative integer`);
    }
  }
  const next: Limits = { ...getLimits(workspaceId), ...partialLimits };
  getDb()
    .prepare("INSERT OR REPLACE INTO limits (workspaceId, json) VALUES (?, ?)")
    .run(workspaceId, JSON.stringify(next));
}

export function checkLimit(
  workspaceId: string,
  field: UsageField | string,
  n: number,
  now = new Date()
): { ok: boolean; remaining: number; message: string } {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError("n must be a non-negative integer");
  }
  const limits = getLimits(workspaceId);
  const usage = getUsage(workspaceId, undefined, now);

  let limit: number;
  let used: number;
  let name: string;

  switch (field) {
    case "discovered":
      limit = limits.leadsPerMonth;
      used = usage.discovered;
      name = "leads per month";
      break;
    // `enriched` is metered per lead; data/plans.json has no separate enriched quota, so
    // it shares the plan's leads-per-month allowance (generous free/demo default below).
    case "enriched":
      limit = limits.leadsPerMonth;
      used = usage.enriched;
      name = "leads enriched per month";
      break;
    case "dossiers":
      limit = limits.dossiersPerMonth;
      used = usage.dossiers;
      name = "dossiers per month";
      break;
    case "tokensIn":
    case "tokensOut":
      limit = limits.tokensPerMonth;
      used = usage.tokensIn + usage.tokensOut;
      name = "tokens per month";
      break;
    case "exports":
      limit = limits.exportsPerMonth;
      used = usage.exports;
      name = "exports per month";
      break;
    case "apiCalls":
      limit = limits.apiCallsPerMonth;
      used = usage.apiCalls;
      name = "API calls per month";
      break;
    default:
      // An unknown field must never throw: allow it and warn exactly once per field.
      warnUnknownField(String(field));
      return { ok: true, remaining: Number.MAX_SAFE_INTEGER, message: "" };
  }

  const projected = used + n;
  const ok = projected <= limit;
  const remaining = Math.max(0, limit - projected);
  const message = ok
    ? ""
    : `Over the ${name} limit: used ${used}, allowed ${limit}; allowance resets next month.`;
  return { ok, remaining, message };
}

// ------------------------------------------------------------------ share tokens

export function createShareToken(
  workspaceId: string,
  scope: unknown,
  days = 30,
  now = new Date()
): string {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error("days must be a non-negative integer");
  }
  const token = randomBytes(24).toString("base64url");
  const hash = sha256(token);
  const createdAt = iso(now);
  const expiresAt = iso(new Date(now.getTime() + days * 24 * 60 * 60 * 1000));
  getDb()
    .prepare(
      "INSERT INTO share_tokens (hash, workspaceId, scope, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)"
    )
    .run(hash, workspaceId, JSON.stringify(scope), createdAt, expiresAt);
  return token;
}

export function resolveShareToken(
  token: unknown,
  now = new Date()
): { workspaceId: string; scope: unknown } | null {
  if (typeof token !== "string") return null;
  if (token.length !== 32) return null; // 24 random bytes -> 32 base64url chars
  const hash = sha256(token);
  const row = getDb()
    .prepare("SELECT * FROM share_tokens WHERE hash = ?")
    .get(hash) as
    | {
        workspaceId: string;
        scope: string;
        expiresAt: string;
      }
    | undefined;
  if (!row) return null;
  if (iso(now) >= row.expiresAt) return null;
  return { workspaceId: row.workspaceId, scope: JSON.parse(row.scope) };
}

// ------------------------------------------------------------------ helpers

export function parseBearer(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== "bearer") return null;
  const token = parts[1];
  if (!token) return null;
  return token;
}
