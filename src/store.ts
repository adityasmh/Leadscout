// SQLite store for leadscout (node:sqlite, no dependencies).
// DB file: env LEADSCOUT_DB, else data/leadscout.db.
// @ts-ignore node:sqlite is a Node 24 built-in; ambient types are not available in this environment.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Icp, Job, JobQuery, Lead, LeadFilter, Offer, Workspace } from "./types.js";

// SQLite statement results are untyped by design. We narrow them once on entry
// and treat them as records of unknown values thereafter.
type SqliteRow = Record<string, unknown>;
function str(value: unknown): string {
  return String(value ?? "");
}
function optStr(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
function optNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = join(HERE, "..", "data", "leadscout.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  offer TEXT NOT NULL,
  icp TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  address TEXT,
  city TEXT,
  country TEXT,
  lat REAL,
  lon REAL,
  phone TEXT,
  email TEXT,
  website TEXT,
  source TEXT NOT NULL,
  sourceUrl TEXT NOT NULL,
  fetchedUrl TEXT,
  title TEXT,
  description TEXT,
  summary TEXT NOT NULL DEFAULT '',
  emails TEXT NOT NULL DEFAULT '[]',
  phones TEXT NOT NULL DEFAULT '[]',
  socials TEXT NOT NULL DEFAULT '{}',
  signals TEXT NOT NULL DEFAULT '[]',
  language TEXT,
  score REAL NOT NULL DEFAULT 0,
  fit TEXT NOT NULL DEFAULT '[]',
  angle TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT NOT NULL DEFAULT '',
  gate TEXT NOT NULL DEFAULT 'template',
  createdAt TEXT NOT NULL,
  enrichedAt TEXT,
  normName TEXT NOT NULL DEFAULT '',
  normCity TEXT NOT NULL DEFAULT '',
  websiteHost TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_leads_ws ON leads(workspaceId);
CREATE INDEX IF NOT EXISTS idx_leads_dedupe ON leads(workspaceId, normName, normCity);
CREATE INDEX IF NOT EXISTS idx_leads_host ON leads(workspaceId, websiteHost);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  query TEXT NOT NULL,
  status TEXT NOT NULL,
  found INTEGER NOT NULL DEFAULT 0,
  enriched INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_ws ON jobs(workspaceId);
`;

let db: DatabaseSync | null = null;

export function dbPath(): string {
  const env = process.env.LEADSCOUT_DB;
  return env && env.trim() !== "" ? env : DEFAULT_DB;
}

export function getDb(): DatabaseSync {
  if (!db) {
    const file = dbPath();
    mkdirSync(dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    db.exec(SCHEMA);
    ensureGateColumn(db);
  }
  return db;
}

/** Wave 2 (L18): old databases made before the gate column keep working; add gate only when missing. */
function ensureGateColumn(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA table_info(leads)").all() as SqliteRow[];
  const hasGate = rows.some((row) => str(row.name) === "gate");
  if (!hasGate) {
    database.exec("ALTER TABLE leads ADD COLUMN gate TEXT NOT NULL DEFAULT 'template'");
  }
}

export function closeDb(): void {
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    db = null;
  }
}

// ---------------------------------------------------------------- helpers

function json(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value) ?? "null";
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function defined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) if (value !== undefined) out[key] = value;
  return out as Partial<T>;
}

/** Lowercase, strip punctuation, collapse whitespace. Used for name+city dedupe. */
export function normaliseName(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normaliseCity(city?: string): string {
  return normaliseName(city ?? "");
}

/** Hostname without leading www, else "" for missing/unparseable input. */
export function websiteHost(website?: string): string {
  if (!website) return "";
  const raw = website.trim();
  if (raw === "") return "";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ------------------------------------------------------------ workspaces

function toWorkspace(row: SqliteRow): Workspace {
  return {
    id: str(row.id),
    name: str(row.name),
    offer: parseJson<Offer>(row.offer, { services: [], description: "" }),
    icp: parseJson<Icp>(row.icp, { categories: [], cities: [], countries: [] }),
    createdAt: str(row.createdAt),
  };
}

export function createWorkspace(input: { name: string; offer: Offer; icp: Icp }): Workspace {
  const workspace: Workspace = {
    id: randomUUID(),
    name: input.name,
    offer: input.offer,
    icp: input.icp,
    createdAt: new Date().toISOString(),
  };
  getDb()
    .prepare("INSERT INTO workspaces (id, name, offer, icp, createdAt) VALUES (?, ?, ?, ?, ?)")
    .run(workspace.id, workspace.name, json(workspace.offer), json(workspace.icp), workspace.createdAt);
  return workspace;
}

export function getWorkspace(id: string): Workspace | undefined {
  const row = getDb().prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
  return row ? toWorkspace(row as SqliteRow) : undefined;
}

export function listWorkspaces(): Workspace[] {
  const rows = getDb().prepare("SELECT * FROM workspaces ORDER BY createdAt ASC, rowid ASC").all();
  return (rows as SqliteRow[]).map(toWorkspace);
}

export function updateProfile(id: string, patch: { name?: string; offer?: Offer; icp?: Icp }): Workspace | undefined {
  const current = getWorkspace(id);
  if (!current) return undefined;
  const next: Workspace = {
    ...current,
    name: patch.name ?? current.name,
    offer: patch.offer ?? current.offer,
    icp: patch.icp ?? current.icp,
  };
  getDb()
    .prepare("UPDATE workspaces SET name = ?, offer = ?, icp = ? WHERE id = ?")
    .run(next.name, json(next.offer), json(next.icp), id);
  return next;
}

// ----------------------------------------------------------------- leads

export type LeadInput = Partial<Lead> & {
  workspaceId: string;
  name: string;
  category: string;
  source: string;
  sourceUrl: string;
};

function toLead(row: SqliteRow): Lead {
  return {
    id: str(row.id),
    workspaceId: str(row.workspaceId),
    name: str(row.name),
    category: str(row.category),
    address: optStr(row.address),
    city: optStr(row.city),
    country: optStr(row.country),
    lat: optNum(row.lat),
    lon: optNum(row.lon),
    phone: optStr(row.phone),
    email: optStr(row.email),
    website: optStr(row.website),
    source: str(row.source),
    sourceUrl: str(row.sourceUrl),
    fetchedUrl: optStr(row.fetchedUrl),
    title: optStr(row.title),
    description: optStr(row.description),
    summary: optStr(row.summary) ?? "",
    emails: parseJson<string[]>(row.emails, []),
    phones: parseJson<string[]>(row.phones, []),
    socials: parseJson<Lead["socials"]>(row.socials, {}),
    signals: parseJson<string[]>(row.signals, []),
    language: optStr(row.language),
    score: optNum(row.score) ?? 0,
    fit: parseJson<Lead["fit"]>(row.fit, []),
    angle: optStr(row.angle) ?? "",
    status: str(row.status) as Lead["status"],
    notes: optStr(row.notes) ?? "",
    gate: optStr(row.gate) as Lead["gate"],
    createdAt: str(row.createdAt),
    enrichedAt: optStr(row.enrichedAt),
  };
}

function writeLead(lead: Lead): void {
  const row: Record<string, string | number | null> = {
    id: lead.id,
    workspaceId: lead.workspaceId,
    name: lead.name,
    category: lead.category,
    address: lead.address ?? null,
    city: lead.city ?? null,
    country: lead.country ?? null,
    lat: lead.lat ?? null,
    lon: lead.lon ?? null,
    phone: lead.phone ?? null,
    email: lead.email ?? null,
    website: lead.website ?? null,
    source: lead.source,
    sourceUrl: lead.sourceUrl,
    fetchedUrl: lead.fetchedUrl ?? null,
    title: lead.title ?? null,
    description: lead.description ?? null,
    summary: lead.summary ?? "",
    emails: json(lead.emails ?? []),
    phones: json(lead.phones ?? []),
    socials: json(lead.socials ?? {}),
    signals: json(lead.signals ?? []),
    language: lead.language ?? null,
    score: lead.score ?? 0,
    fit: json(lead.fit ?? []),
    angle: lead.angle ?? "",
    status: lead.status,
    notes: lead.notes ?? "",
    gate: lead.gate ?? "template",
    createdAt: lead.createdAt,
    enrichedAt: lead.enrichedAt ?? null,
    normName: normaliseName(lead.name),
    normCity: normaliseCity(lead.city),
    websiteHost: websiteHost(lead.website),
  };
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  getDb()
    .prepare(`INSERT OR REPLACE INTO leads (${columns.join(", ")}) VALUES (${placeholders})`)
    .run(...columns.map((column) => row[column]));
}

function findByDedupe(workspaceId: string, name: string, city: string | undefined, host: string): Lead | undefined {
  const database = getDb();
  const byNameCity = database
    .prepare("SELECT * FROM leads WHERE workspaceId = ? AND normName = ? AND normCity = ? ORDER BY rowid ASC LIMIT 1")
    .get(workspaceId, normaliseName(name), normaliseCity(city));
  if (byNameCity) return toLead(byNameCity as SqliteRow);
  if (host) {
    const byHost = database
      .prepare("SELECT * FROM leads WHERE workspaceId = ? AND websiteHost = ? ORDER BY rowid ASC LIMIT 1")
      .get(workspaceId, host);
    if (byHost) return toLead(byHost as SqliteRow);
  }
  return undefined;
}

/** Insert, or merge into the existing lead matched by (workspace + normalised name + city) or website host. */
export function upsertLead(input: LeadInput): Lead {
  const patch = defined(input);
  const host = websiteHost(input.website);
  const existing = findByDedupe(input.workspaceId, input.name, input.city, host);

  if (existing) {
    const merged: Lead = {
      ...existing,
      ...patch,
      id: existing.id,
      workspaceId: existing.workspaceId,
      createdAt: existing.createdAt,
      status: existing.status,
      notes: existing.notes,
    };
    writeLead(merged);
    return merged;
  }

  const lead: Lead = {
    ...patch,
    id: typeof input.id === "string" && input.id !== "" ? input.id : randomUUID(),
    workspaceId: input.workspaceId,
    name: input.name,
    category: input.category,
    source: input.source,
    sourceUrl: input.sourceUrl,
    summary: input.summary ?? "",
    emails: input.emails ?? [],
    phones: input.phones ?? [],
    socials: input.socials ?? {},
    signals: input.signals ?? [],
    score: input.score ?? 0,
    fit: input.fit ?? [],
    angle: input.angle ?? "",
    status: input.status ?? "new",
    notes: input.notes ?? "",
    gate: input.gate ?? "template",
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  writeLead(lead);
  return lead;
}

export function getLead(workspaceId: string, id: string): Lead | undefined {
  const row = getDb().prepare("SELECT * FROM leads WHERE workspaceId = ? AND id = ?").get(workspaceId, id);
  return row ? toLead(row as SqliteRow) : undefined;
}

export function updateLead(workspaceId: string, id: string, patch: Partial<Lead>): Lead | undefined {
  const current = getLead(workspaceId, id);
  if (!current) return undefined;
  const next: Lead = {
    ...current,
    ...defined(patch),
    id: current.id,
    workspaceId: current.workspaceId,
    createdAt: current.createdAt,
  };
  writeLead(next);
  return next;
}

export function listLeads(filter: LeadFilter): { total: number; leads: Lead[] } {
  const where: string[] = ["workspaceId = ?"];
  const params: (string | number)[] = [filter.workspaceId];

  // Wave 2 (L18): hidden leads (suppressed by verify/score/compliance) are excluded
  // from every listing and its total unless the filter explicitly includes them.
  if (filter.includeHidden !== true) {
    where.push("(gate IS NULL OR gate <> 'hidden')");
  }

  if (filter.status) {
    const statuses = filter.status.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
  }
  if (typeof filter.minScore === "number" && Number.isFinite(filter.minScore)) {
    where.push("score >= ?");
    params.push(filter.minScore);
  }
  if (filter.city) {
    where.push("LOWER(COALESCE(city, '')) LIKE ?");
    params.push(`%${filter.city.toLowerCase()}%`);
  }
  if (filter.category) {
    where.push("LOWER(category) LIKE ?");
    params.push(`%${filter.category.toLowerCase()}%`);
  }
  if (filter.signal) {
    where.push("signals LIKE ?");
    params.push(`%"${filter.signal}"%`);
  }
  if (filter.q) {
    const like = `%${filter.q.toLowerCase()}%`;
    where.push(
      "(LOWER(name) LIKE ? OR LOWER(COALESCE(summary, '')) LIKE ? OR LOWER(COALESCE(city, '')) LIKE ?" +
      " OR LOWER(category) LIKE ? OR LOWER(COALESCE(address, '')) LIKE ? OR LOWER(COALESCE(notes, '')) LIKE ?)"
    );
    params.push(like, like, like, like, like, like);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const countRow = getDb().prepare(`SELECT COUNT(*) AS n FROM leads ${whereSql}`).get(...params);
  const total = Number((countRow as SqliteRow)?.n ?? 0);

  const order = filter.sort === "score" ? "score DESC, createdAt DESC, rowid DESC" : "createdAt DESC, rowid DESC";
  const limit = typeof filter.limit === "number" && Number.isFinite(filter.limit) && filter.limit > 0 ? Math.floor(filter.limit) : 100;
  const offset = typeof filter.offset === "number" && Number.isFinite(filter.offset) && filter.offset > 0 ? Math.floor(filter.offset) : 0;
  const rows = getDb()
    .prepare(`SELECT * FROM leads ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  return { total, leads: (rows as SqliteRow[]).map(toLead) };
}

// ------------------------------------------------------------------ jobs

function toJob(row: SqliteRow): Job {
  return {
    id: str(row.id),
    workspaceId: str(row.workspaceId),
    query: parseJson<JobQuery>(row.query, { category: "" }),
    status: str(row.status) as Job["status"],
    found: Number(row.found ?? 0),
    enriched: Number(row.enriched ?? 0),
    error: optStr(row.error),
    createdAt: str(row.createdAt),
  };
}

export function createJob(workspaceId: string, query: JobQuery): Job {
  const job: Job = {
    id: randomUUID(),
    workspaceId,
    query,
    status: "queued",
    found: 0,
    enriched: 0,
    createdAt: new Date().toISOString(),
  };
  getDb()
    .prepare("INSERT INTO jobs (id, workspaceId, query, status, found, enriched, error, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(job.id, job.workspaceId, json(job.query), job.status, job.found, job.enriched, null, job.createdAt);
  return job;
}

export function updateJob(
  workspaceId: string,
  jobId: string,
  patch: Partial<Pick<Job, "status" | "found" | "enriched" | "error">>
): Job | undefined {
  const row = getDb().prepare("SELECT * FROM jobs WHERE workspaceId = ? AND id = ?").get(workspaceId, jobId);
  if (!row) return undefined;
  const next: Job = { ...toJob(row as SqliteRow), ...defined(patch) };
  getDb()
    .prepare("UPDATE jobs SET status = ?, found = ?, enriched = ?, error = ? WHERE workspaceId = ? AND id = ?")
    .run(next.status, next.found, next.enriched, next.error ?? null, workspaceId, jobId);
  return next;
}

export function listJobs(workspaceId: string): Job[] {
  const rows = getDb()
    .prepare("SELECT * FROM jobs WHERE workspaceId = ? ORDER BY createdAt DESC, rowid DESC")
    .all(workspaceId);
  return (rows as SqliteRow[]).map(toJob);
}

// ------------------------------------------------------------------- CSV

const CSV_COLUMNS = [
  "name", "category", "city", "country", "address", "phone", "email", "website",
  "score", "status", "summary", "angle", "signals", "source", "sourceUrl", "createdAt",
] as const;

export function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function leadsToCsv(leads: Lead[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const lead of leads) {
    lines.push(
      CSV_COLUMNS.map((column) =>
        csvCell(column === "signals" ? (lead.signals ?? []).join("; ") : lead[column])
      ).join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}
