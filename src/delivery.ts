// src/delivery.ts
// Order LG2-gate-delivery: the daily call sheet for human callers.
//
// buildCallSheet(workspaceId, { date, perCaller, callers, minScore }) returns the day's
// gated, callable leads sorted by score then freshness, assigned round-robin across the
// caller names (default one caller), capped by perCaller. Every row carries name, area,
// the phone as a tel: value, the dossier "say this" opener, the top service, one evidence
// line, tags and the lead id.
//
// The same lead is never assigned to two callers or on two days: assignments live in the
// lazily created table call_assignments with PRIMARY KEY (workspaceId, leadId), and a
// build on a new date only sees leads that were never assigned. persistCallSheet records
// the sheet (the POST route uses it); renderCallSheetHtml and renderCallSheetCsv escape
// every value and render tel: links.
//
// Node 24 built-ins only, ES module, .js import suffix.

// @ts-ignore node:sqlite is a Node 24 built-in; ambient types may be absent.
import type { DatabaseSync } from "node:sqlite";
import { getDb, getLead, listLeads, csvCell } from "./store.js";
import { getDossier } from "./dossier.js";
import { gateLead, hasDndSource } from "./gate.js";
import { bizKey } from "./evidence.js";
import type { Lead } from "./types.js";
import type { Dossier } from "./types-v2.js";

export type CallSheetOptions = {
  date?: string;
  perCaller?: number;
  callers?: string[];
  minScore?: number;
};

export type CallSheetRow = {
  leadId: string;
  name: string;
  area: string;
  phone: string;
  tel: string;
  sayThis: string;
  topService: string;
  evidence: string;
  tags: string[];
  score: number;
  caller: string;
  date: string;
};

export type CallSheet = {
  workspaceId: string;
  date: string;
  callers: string[];
  perCaller: number;
  minScore: number;
  dndChecked: boolean;
  dndExcluded: number;
  rows: CallSheetRow[];
  preview: boolean;
};

export const DEFAULT_CALLERS = ["Caller 1"];
export const DEFAULT_PER_CALLER = 10;

const ASSIGNMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS call_assignments (
  workspaceId TEXT NOT NULL,
  leadId TEXT NOT NULL,
  date TEXT NOT NULL,
  caller TEXT NOT NULL,
  phone TEXT,
  bizKey TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, leadId)
);
`;

export function ensureCallAssignmentsTable(db: DatabaseSync = getDb()): void {
  db.exec(ASSIGNMENTS_SCHEMA);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function areaOf(lead: Lead): string {
  return lead.city ?? lead.address ?? lead.country ?? "";
}

function topServiceOf(lead: Lead, dossier?: Dossier): string {
  return dossier?.offers?.[0]?.service ?? lead.fit?.[0]?.service ?? "";
}

function evidenceLineOf(dossier?: Dossier): string {
  const quote = dossier?.evidence?.[0]?.quote ?? "";
  return quote.length > 180 ? `${quote.slice(0, 177)}...` : quote;
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** True only when at least one operator DND export was actually loaded. */
function dndScreenLoaded(): boolean {
  return hasDndSource(process.env.LEADSCOUT_DND_DIR);
}

function rowFor(lead: Lead, caller: string, date: string, phone: string, tags: string[]): CallSheetRow {
  const dossier = getDossier(lead.workspaceId, lead.id);
  return {
    leadId: lead.id,
    name: lead.name,
    area: areaOf(lead),
    phone,
    tel: `tel:${phone}`,
    sayThis: dossier?.sayThis?.value ?? "",
    topService: topServiceOf(lead, dossier),
    evidence: evidenceLineOf(dossier),
    tags,
    score: lead.score ?? 0,
    caller,
    date,
  };
}

function insertAssignment(db: DatabaseSync, workspaceId: string, row: CallSheetRow, bizKey: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO call_assignments " +
      "(workspaceId, leadId, date, caller, phone, bizKey, score, tags, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    workspaceId,
    row.leadId,
    row.date,
    row.caller,
    row.phone,
    bizKey,
    Math.round(row.score ?? 0),
    JSON.stringify(row.tags ?? []),
    new Date().toISOString()
  );
}

/** Persists every row of a sheet (INSERT OR IGNORE). Returns how many were newly stored. */
export function persistCallSheet(sheet: CallSheet): number {
  const db = getDb();
  ensureCallAssignmentsTable(db);
  let inserted = 0;
  for (const row of sheet.rows) {
    const lead = getLead(sheet.workspaceId, row.leadId);
    const key = lead ? bizKey(lead, [row.phone]) : row.phone;
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM call_assignments WHERE workspaceId = ? AND leadId = ?")
      .get(sheet.workspaceId, row.leadId) as { n?: number } | undefined;
    insertAssignment(db, sheet.workspaceId, row, key);
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM call_assignments WHERE workspaceId = ? AND leadId = ?")
      .get(sheet.workspaceId, row.leadId) as { n?: number } | undefined;
    if (Number(after?.n ?? 0) > Number(before?.n ?? 0)) inserted += 1;
  }
  return inserted;
}

/**
 * Builds the day's call sheet. PURE: it never writes to the database. A date with
 * stored assignments returns that sheet with preview:false; a date with none
 * returns a preview computed from never-assigned leads with preview:true.
 * Only persistCallSheet writes (the POST route uses it).
 */
export function buildCallSheet(workspaceId: string, opts: CallSheetOptions = {}): CallSheet {
  const db = getDb();
  ensureCallAssignmentsTable(db);

  const date = opts.date && opts.date.trim() !== "" ? opts.date.trim() : todayIso();
  const callers = (opts.callers ?? DEFAULT_CALLERS).filter((c) => typeof c === "string" && c.trim() !== "");
  const callerList = callers.length > 0 ? callers : DEFAULT_CALLERS;
  const perCaller =
    typeof opts.perCaller === "number" && Number.isFinite(opts.perCaller) && opts.perCaller > 0
      ? Math.floor(opts.perCaller)
      : DEFAULT_PER_CALLER;
  const minScore = typeof opts.minScore === "number" && Number.isFinite(opts.minScore) ? opts.minScore : 0;
  const dndDir = process.env.LEADSCOUT_DND_DIR;
  const dndChecked = dndScreenLoaded();

  const stored = db
    .prepare(
      "SELECT leadId, caller, date, phone, bizKey, score, tags FROM call_assignments WHERE workspaceId = ?"
    )
    .all(workspaceId) as Array<Record<string, unknown>>;

  const assignedLeadIds = new Set<string>();
  const deliveredBizKeys = new Set<string>();
  const deliveredPhones = new Set<string>();
  const forDate: Array<{ leadId: string; caller: string; phone: string; tags: string[] }> = [];
  for (const row of stored) {
    const leadId = String(row.leadId);
    assignedLeadIds.add(leadId);
    if (row.bizKey) deliveredBizKeys.add(String(row.bizKey));
    if (row.phone) deliveredPhones.add(String(row.phone));
    if (String(row.date) === date) {
      const lead = getLead(workspaceId, leadId);
      forDate.push({
        leadId,
        caller: String(row.caller),
        phone: String(row.phone ?? lead?.phone ?? ""),
        tags: parseTags(row.tags),
      });
    }
  }

  // Same date: return the assignments already recorded for it, untouched.
  if (forDate.length > 0) {
    const rows: CallSheetRow[] = [];
    const storedCallers: string[] = [];
    for (const item of forDate) {
      const lead = getLead(workspaceId, item.leadId);
      if (!lead) continue;
      if (!storedCallers.includes(item.caller)) storedCallers.push(item.caller);
      rows.push(rowFor(lead, item.caller, date, item.phone, item.tags));
    }
    return {
      workspaceId,
      date,
      callers: storedCallers.length > 0 ? storedCallers : callerList,
      perCaller,
      minScore,
      dndChecked,
      dndExcluded: 0,
      rows,
      preview: false,
    };
  }

  // New date: gate every never-assigned lead, sort by score then freshness.
  const candidates = listLeads({ workspaceId, minScore, sort: "score", limit: 5000, includeHidden: true }).leads;
  const ready: Array<{ lead: Lead; phone: string; tags: string[]; bizKey: string }> = [];
  let dndExcluded = 0;
  for (const lead of candidates) {
    if (assignedLeadIds.has(lead.id)) continue;
    const gated = gateLead(lead, {
      deliveredBizKeys,
      deliveredPhones,
      ...(dndDir ? { dndDir } : {}),
    });
    if (!gated.pass || !gated.callable || !gated.phone) {
      if (gated.tags.includes("dnd")) dndExcluded += 1;
      continue;
    }
    ready.push({ lead, phone: gated.phone, tags: gated.tags, bizKey: gated.phone });
  }
  ready.sort((a, b) => (b.lead.score ?? 0) - (a.lead.score ?? 0) || b.lead.createdAt.localeCompare(a.lead.createdAt));

  const capacity = perCaller * callerList.length;
  const rows: CallSheetRow[] = [];
  const counts = new Map<string, number>(callerList.map((caller) => [caller, 0]));
  let cursor = 0;
  for (const item of ready) {
    if (rows.length >= capacity) break;
    let chosen: string | null = null;
    for (let step = 0; step < callerList.length; step += 1) {
      const caller = callerList[(cursor + step) % callerList.length];
      if ((counts.get(caller) ?? 0) < perCaller) {
        chosen = caller;
        cursor = (cursor + step + 1) % callerList.length;
        break;
      }
    }
    if (chosen === null) break;
    counts.set(chosen, (counts.get(chosen) ?? 0) + 1);
    const row = rowFor(item.lead, chosen, date, item.phone, item.tags);
    rows.push(row);
  }

  return { workspaceId, date, callers: callerList, perCaller, minScore, dndChecked, dndExcluded, rows, preview: true };
}

// ------------------------------------------------------------------ rendering

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const OUTCOME_BOXES = ["answered", "interested", "call back", "not interested", "wrong number"];

function outcomeBoxes(): string {
  return OUTCOME_BOXES.map(
    (label) => `<label class="cb"><input type="checkbox" name="outcome" value="${escapeHtml(label)}"> ${escapeHtml(label)}</label>`
  ).join(" ");
}

function previewHeadingSuffix(sheet: CallSheet): string {
  return sheet.preview ? " - PREVIEW (not assigned yet)" : "";
}

function previewNoteHtml(sheet: CallSheet): string {
  if (!sheet.preview) return "";
  return `<p><strong>PREVIEW (not assigned yet)</strong> - this sheet is only saved by the assign action (POST /api/workspaces/:ws/callsheet/assign).</p>\n`;
}

/** Printable call sheet: one table per caller, an outcome column with tick boxes. */
export function renderCallSheetHtml(sheet: CallSheet): string {
  const byCaller = new Map<string, CallSheetRow[]>();
  for (const row of sheet.rows) {
    const list = byCaller.get(row.caller) ?? [];
    list.push(row);
    byCaller.set(row.caller, list);
  }
  const sections: string[] = [];
  for (const caller of sheet.callers) {
    const rows = byCaller.get(caller) ?? [];
    const body = rows
      .map(
        (row) => `<tr>
  <td>${escapeHtml(row.name)}</td>
  <td>${escapeHtml(row.area)}</td>
  <td><a href="${escapeHtml(row.tel)}">${escapeHtml(row.phone)}</a></td>
  <td>${escapeHtml(row.sayThis)}</td>
  <td>${escapeHtml(row.topService)}</td>
  <td>${escapeHtml(row.evidence)}</td>
  <td>${row.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(" ")}</td>
  <td class="outcome">${outcomeBoxes()}</td>
  <td class="id">${escapeHtml(row.leadId)}</td>
</tr>`
      )
      .join("\n");
    sections.push(
      `<section>\n<h2>${escapeHtml(caller)} (${rows.length})</h2>\n` +
        `<table>\n<thead><tr><th>Name</th><th>Area</th><th>Phone</th><th>Say this</th>` +
        `<th>Top service</th><th>Evidence</th><th>Tags</th><th>Outcome</th><th>Lead id</th></tr></thead>\n` +
        `<tbody>\n${body}\n</tbody>\n</table>\n</section>`
    );
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Call sheet ${escapeHtml(sheet.date)}</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 16px; color: #111; }
  h1 { font-size: 18px; } h2 { font-size: 15px; margin: 18px 0 6px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 14px; }
  th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; }
  .tag { border: 1px solid #888; border-radius: 3px; padding: 0 4px; font-size: 12px; }
  .outcome { white-space: nowrap; } .cb { display: block; font-size: 12px; }
  .id { font-family: monospace; font-size: 11px; }
  @media print { a { color: #000; text-decoration: none; } }
</style>
</head>
<body>
<h1>Call sheet - ${escapeHtml(sheet.date)}${escapeHtml(previewHeadingSuffix(sheet))}</h1>
${previewNoteHtml(sheet)}${sections.join("\n")}
</body>
</html>
`;
}

const CSV_COLUMNS = [
  "caller",
  "date",
  "name",
  "area",
  "phone",
  "tel",
  "say_this",
  "top_service",
  "evidence",
  "tags",
  "score",
  "lead_id",
] as const;

/** CSV call sheet with every value escaped through store.ts csvCell. */
export function renderCallSheetCsv(sheet: CallSheet): string {
  const columns: string[] = [...CSV_COLUMNS];
  if (sheet.preview) columns.push("preview");
  const lines: string[] = [columns.join(",")];
  for (const row of sheet.rows) {
    const cells = [
      row.caller,
      row.date,
      row.name,
      row.area,
      row.phone,
      row.tel,
      row.sayThis,
      row.topService,
      row.evidence,
      (row.tags ?? []).join("; "),
      String(row.score ?? 0),
      row.leadId,
    ];
    if (sheet.preview) cells.push("PREVIEW (not assigned yet)");
    lines.push(cells.map((value) => csvCell(value)).join(","));
  }
  return `${lines.join("\n")}\n`;
}
