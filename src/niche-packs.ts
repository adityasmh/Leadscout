// src/niche-packs.ts
// Order NP1: a niche is an attachment. A "pack" is a versioned JSON file a
// workspace attaches or detaches like a plug-in. Nothing niche-specific lives in
// the core: the pack carries its own categories, queries, cities, signals and an
// optional `serviceRules` overlay that adds signals and weights on top of the
// global rule table in data/service-rules.json.
//
// This module owns its own lazily created tables (niche_packs, workspace_packs)
// in the shared store database (env LEADSCOUT_DB, else the product database).
// It never imports server.ts. Node 24 built-ins only, ES module, .js suffix.
//
// Central exports:
//   validatePack(obj)          -> string[]          (plain validation errors)
//   installPack(json, owner)   -> PackRecord        (validates + versions)
//   listPacks(workspaceId?)    -> PackSummary[]     (shared + own private)
//   attachPack(ws, packId)     -> AttachedPack
//   detachPack(ws, packId)     -> boolean
//   attachedPacks(ws)          -> AttachedPack[]
//   rulesFor(workspaceId)      -> ServiceRules      (global merged with overlays)

// @ts-ignore node:sqlite is a Node 24 built-in; ambient types are not available here.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDb } from "./store.js";
import { loadRules, type ServiceRule, type ServiceRules, type SignalInfo } from "./match.js";

// ---------------------------------------------------------------- types

export type PackOverlaySignal = { kind: string; phrase: string };

export type PackOverlayService = {
  id: string;
  label?: string;
  pitch?: string;
  categoryBonus?: number;
  categories?: string[];
  signals?: Record<string, number>;
  reasons?: Record<string, string>;
};

export type PackOverlay = {
  signals?: Record<string, PackOverlaySignal>;
  services?: PackOverlayService[];
};

export type PackCategory = {
  id: string;
  label?: string;
  aliases?: string[];
  buyerReason?: string;
  videoNeed?: string;
  need?: string;
  queries: string[];
};

export type PackCity = { name: string; tier?: number; areas?: string[] };
export type PackSignal = { id: string; meaning: string; kind?: string; favours?: string[] };

export type NichePackFile = {
  id: string;
  version: number;
  label: string;
  owner: string;
  visibility: "private" | "shared";
  note?: string;
  categories: PackCategory[];
  cities: PackCity[];
  seasonality?: unknown;
  signals?: PackSignal[];
  serviceRules?: PackOverlay;
  sources?: Record<string, string[]>;
};

export type PackRecord = {
  id: string;
  version: number;
  owner: string;
  visibility: string;
  label: string;
  json: NichePackFile;
  createdAt: string;
  updatedAt: string;
};

export type PackSummary = {
  id: string;
  version: number;
  owner: string;
  visibility: string;
  label: string;
  categories: string[];
  updatedAt: string;
};

export type AttachedPack = PackSummary & { attachedAt: string; json: NichePackFile };

export class PackError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join("; ") || "invalid niche pack");
    this.name = "PackError";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------- shipped packs

export const NICHE_PACK_DATA_DIR = new URL("../data/niche-packs/", import.meta.url);

/** The two packs shipped with the product; seeded as shared example packs. */
export const SHIPPED_PACK_IDS = ["wedding-events", "example-dental"] as const;

export function packFilePath(id: string): string {
  return fileURLToPath(new URL(`${id}.json`, NICHE_PACK_DATA_DIR));
}

function readShippedPack(id: string): NichePackFile {
  const text = readFileSync(packFilePath(id), "utf8");
  return JSON.parse(text) as NichePackFile;
}

// ---------------------------------------------------------------- validator

const TOP_LEVEL_FIELDS = new Set([
  "id",
  "version",
  "label",
  "owner",
  "visibility",
  "note",
  "categories",
  "cities",
  "seasonality",
  "signals",
  "serviceRules",
  "sources",
]);

const VISIBILITIES = new Set(["private", "shared"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPlainString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Reject any value that is not plain data: functions, symbols, bigints, undefined
 * entries and any URL whose scheme is not http or https. Returns the first error
 * found under `path`, or null.
 */
function plainDataError(value: unknown, path: string): string | null {
  if (value === null) return null;
  const type = typeof value;
  if (type === "function" || type === "symbol" || type === "bigint") {
    return `${path} is not plain data (${type})`;
  }
  if (type === "undefined") return `${path} is not plain data (undefined)`;
  if (type === "number") {
    return Number.isFinite(value as number) ? null : `${path} is not a finite number`;
  }
  if (type === "string") {
    const text = value as string;
    if (URL_SCHEME.test(text) && !/^https?:\/\//i.test(text)) {
      return `${path} uses a URL that is not http or https`;
    }
    if (/^javascript:/i.test(text) || /^data:/i.test(text)) {
      return `${path} uses an unsafe URL scheme`;
    }
    return null;
  }
  if (type === "boolean") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const err = plainDataError(value[i], `${path}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const err = plainDataError(child, `${path}.${key}`);
      if (err) return err;
    }
    return null;
  }
  return `${path} is not plain data`;
}

/**
 * Validate a pack object. Returns a list of plain errors (empty = valid). Never
 * throws. Rejects unknown top-level fields, duplicate ids, signals without a
 * meaning, queries without a category, and any field that is not plain data.
 */
export function validatePack(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(raw)) return ["root is not an object"];

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_FIELDS.has(key)) errors.push(`unknown top-level field "${key}"`);
  }

  const dataErr = plainDataError(raw, "pack");
  if (dataErr) errors.push(dataErr);

  if (!isPlainString(raw.id)) errors.push("missing id");
  else if (!ID_PATTERN.test(raw.id)) errors.push(`invalid id "${raw.id}"`);
  if (!isPlainString(raw.label)) errors.push("missing label");
  if (!isPlainString(raw.owner)) errors.push("missing owner");
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    errors.push("version must be a positive integer");
  }
  if (!VISIBILITIES.has(String(raw.visibility))) errors.push('visibility must be "private" or "shared"');

  // ---- categories
  if (!Array.isArray(raw.categories) || raw.categories.length === 0) {
    errors.push("categories must be a non-empty array");
  } else {
    const seen = new Set<string>();
    raw.categories.forEach((entry, index) => {
      if (!isObject(entry)) {
        errors.push(`category ${index} is not an object`);
        return;
      }
      const id = isPlainString(entry.id) ? entry.id : "";
      if (!id) errors.push(`category ${index} has no id`);
      if (id && seen.has(id)) errors.push(`duplicate category id "${id}"`);
      if (id) seen.add(id);
      if (entry.queries !== undefined) {
        if (!Array.isArray(entry.queries)) {
          errors.push(`category "${id || index}" queries must be an array`);
        } else {
          if (entry.queries.length === 0) errors.push(`category "${id || index}" has no queries`);
          if (!id) errors.push(`queries without a category in category ${index}`);
          entry.queries.forEach((q, qi) => {
            if (!isPlainString(q)) errors.push(`category "${id || index}" query ${qi} is empty`);
          });
        }
      }
    });
  }

  // ---- cities
  if (!Array.isArray(raw.cities)) {
    errors.push("cities must be an array");
  } else {
    const seen = new Set<string>();
    raw.cities.forEach((entry, index) => {
      if (!isObject(entry)) {
        errors.push(`city ${index} is not an object`);
        return;
      }
      const name = isPlainString(entry.name) ? entry.name : "";
      if (!name) errors.push(`city ${index} has no name`);
      if (name && seen.has(name)) errors.push(`duplicate city "${name}"`);
      if (name) seen.add(name);
      if (entry.areas !== undefined && !Array.isArray(entry.areas)) {
        errors.push(`city "${name || index}" areas must be an array`);
      }
    });
  }

  // ---- signals (declared facts of the niche)
  if (raw.signals !== undefined) {
    if (!Array.isArray(raw.signals)) {
      errors.push("signals must be an array");
    } else {
      const seen = new Set<string>();
      raw.signals.forEach((entry, index) => {
        if (!isObject(entry)) {
          errors.push(`signal ${index} is not an object`);
          return;
        }
        const id = isPlainString(entry.id) ? entry.id : "";
        if (!id) errors.push(`signal ${index} has no id`);
        if (id && seen.has(id)) errors.push(`duplicate signal id "${id}"`);
        if (id) seen.add(id);
        if (!isPlainString(entry.meaning)) errors.push(`signal "${id || index}" is missing a meaning`);
      });
    }
  }

  // ---- serviceRules overlay
  if (raw.serviceRules !== undefined) {
    const overlay = raw.serviceRules;
    if (!isObject(overlay)) {
      errors.push("serviceRules must be an object");
    } else {
      for (const key of Object.keys(overlay)) {
        if (key !== "signals" && key !== "services") errors.push(`unknown serviceRules field "${key}"`);
      }
      if (overlay.signals !== undefined) {
        if (!isObject(overlay.signals)) {
          errors.push("serviceRules.signals must be an object");
        } else {
          for (const [id, info] of Object.entries(overlay.signals)) {
            if (!isObject(info) || !isPlainString((info as PackOverlaySignal).phrase)) {
              errors.push(`serviceRules.signals.${id} needs a phrase`);
            }
          }
        }
      }
      if (overlay.services !== undefined) {
        if (!Array.isArray(overlay.services)) {
          errors.push("serviceRules.services must be an array");
        } else {
          const seen = new Set<string>();
          overlay.services.forEach((svc, index) => {
            if (!isObject(svc)) {
              errors.push(`serviceRules.services ${index} is not an object`);
              return;
            }
            const id = isPlainString(svc.id) ? svc.id : "";
            if (!id) errors.push(`serviceRules.services ${index} has no id`);
            if (id && seen.has(id)) errors.push(`duplicate serviceRules service id "${id}"`);
            if (id) seen.add(id);
            if (svc.signals !== undefined && !isObject(svc.signals)) {
              errors.push(`serviceRules service "${id || index}" signals must be an object`);
            } else if (isObject(svc.signals)) {
              for (const [sig, points] of Object.entries(svc.signals)) {
                if (typeof points !== "number" || !Number.isFinite(points)) {
                  errors.push(`serviceRules service "${id || index}" weight "${sig}" is not a number`);
                }
              }
            }
            if (svc.reasons !== undefined) {
              if (!isObject(svc.reasons)) {
                errors.push(`serviceRules service "${id || index}" reasons must be an object`);
              } else {
                const weights = isObject(svc.signals) ? svc.signals : {};
                for (const sig of Object.keys(svc.reasons)) {
                  if (!(sig in weights)) {
                    errors.push(`serviceRules service "${id || index}" has a reason for unused signal "${sig}"`);
                  }
                }
              }
            }
          });
        }
      }
    }
  }

  // ---- sources
  if (raw.sources !== undefined) {
    if (!isObject(raw.sources)) {
      errors.push("sources must be an object of channel-id arrays");
    } else {
      for (const [category, channels] of Object.entries(raw.sources)) {
        if (!Array.isArray(channels)) {
          errors.push(`sources.${category} must be an array of channel ids`);
        } else if (channels.some((c) => !isPlainString(c))) {
          errors.push(`sources.${category} has an empty channel id`);
        }
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------- storage

const SCHEMA = `
CREATE TABLE IF NOT EXISTS niche_packs (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  owner TEXT NOT NULL,
  visibility TEXT NOT NULL,
  json TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_packs (
  workspaceId TEXT NOT NULL,
  packId TEXT NOT NULL,
  attachedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, packId)
);
`;

let schemaReady = false;

function ensureSchema(): DatabaseSync {
  const db = getDb();
  if (!schemaReady) {
    db.exec(SCHEMA);
    schemaReady = true;
    seedShippedPacks(db);
  }
  return db;
}

function nowIso(): string {
  return new Date().toISOString();
}

type PackRow = {
  id: string;
  version: number;
  owner: string;
  visibility: string;
  json: string;
  createdAt: string;
  updatedAt: string;
};

function toRecord(row: PackRow): PackRecord {
  let parsed: NichePackFile;
  try {
    parsed = JSON.parse(row.json) as NichePackFile;
  } catch {
    parsed = { id: row.id } as unknown as NichePackFile;
  }
  return {
    id: String(row.id),
    version: Number(row.version),
    owner: String(row.owner),
    visibility: String(row.visibility),
    label: typeof parsed.label === "string" ? parsed.label : String(row.id),
    json: parsed,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function getPackRow(id: string): PackRow | undefined {
  const db = ensureSchema();
  return db.prepare("SELECT * FROM niche_packs WHERE id = ?").get(id) as PackRow | undefined;
}

/** Insert the shipped packs as shared examples the first time the store is used. */
function seedShippedPacks(db: DatabaseSync): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM niche_packs").get() as { n: number | bigint };
  if (Number(count?.n ?? 0) > 0) return;
  const at = nowIso();
  for (const id of SHIPPED_PACK_IDS) {
    let pack: NichePackFile;
    try {
      pack = readShippedPack(id);
    } catch {
      continue; // a missing shipped file must not break the store
    }
    const errors = validatePack(pack);
    if (errors.length > 0) continue;
    db.prepare(
      "INSERT OR IGNORE INTO niche_packs (id, version, owner, visibility, json, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      pack.id,
      Number(pack.version ?? 1),
      pack.owner ?? "shared",
      pack.visibility === "private" ? "private" : "shared",
      JSON.stringify(pack),
      at,
      at
    );
  }
}

function summaryOf(record: PackRecord): PackSummary {
  return {
    id: record.id,
    version: record.version,
    owner: record.owner,
    visibility: record.visibility,
    label: record.label,
    categories: Array.isArray(record.json.categories) ? record.json.categories.map((c) => String(c.id)) : [],
    updatedAt: record.updatedAt,
  };
}

/**
 * Validate, version and store a pack. A pack id owned by someone else is never
 * overwritten; re-installing your own pack bumps its version.
 */
export function installPack(json: unknown, owner: string): PackRecord {
  const errors = validatePack(json);
  if (errors.length > 0) throw new PackError(errors);
  const pack = json as NichePackFile;
  const packOwner = isPlainString(owner) ? owner : pack.owner;
  const visibility: "private" | "shared" =
    pack.visibility === "shared" || packOwner === "shared" ? "shared" : "private";
  const db = ensureSchema();
  const existing = getPackRow(pack.id);
  const at = nowIso();
  if (!existing) {
    const version = Number(pack.version ?? 1);
    db.prepare(
      "INSERT INTO niche_packs (id, version, owner, visibility, json, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(pack.id, version, packOwner, visibility, JSON.stringify(pack), at, at);
    return getPackRow(pack.id) ? (toRecord(getPackRow(pack.id) as PackRow)) : toRecord({ id: pack.id, version, owner: packOwner, visibility, json: JSON.stringify(pack), createdAt: at, updatedAt: at });
  }
  if (existing.owner !== packOwner) {
    throw new PackError([`pack "${pack.id}" is owned by "${existing.owner}" and cannot be overwritten`]);
  }
  const version = Number(existing.version) + 1;
  db.prepare("UPDATE niche_packs SET version = ?, visibility = ?, json = ?, updatedAt = ? WHERE id = ?").run(
    version,
    visibility,
    JSON.stringify({ ...pack, version }),
    at,
    pack.id
  );
  return toRecord(getPackRow(pack.id) as PackRow);
}

/** Shared packs plus, when a workspace is given, that workspace's own private packs. */
export function listPacks(workspaceId?: string): PackSummary[] {
  const db = ensureSchema();
  const rows = workspaceId
    ? (db
        .prepare("SELECT * FROM niche_packs WHERE visibility = 'shared' OR owner = ? ORDER BY id ASC")
        .all(workspaceId) as PackRow[])
    : (db.prepare("SELECT * FROM niche_packs WHERE visibility = 'shared' ORDER BY id ASC").all() as PackRow[]);
  return rows.map((row) => summaryOf(toRecord(row)));
}

/** True when the pack exists and is visible to this workspace. */
function packVisibleTo(id: string, workspaceId: string): boolean {
  const row = getPackRow(id);
  if (!row) return false;
  return row.visibility === "shared" || row.owner === workspaceId;
}

export function attachPack(workspaceId: string, packId: string): AttachedPack {
  const db = ensureSchema();
  if (!getPackRow(packId)) throw new PackError([`pack "${packId}" not found`]);
  if (!packVisibleTo(packId, workspaceId)) throw new PackError([`pack "${packId}" is private to another workspace`]);
  const at = nowIso();
  db.prepare(
    "INSERT OR REPLACE INTO workspace_packs (workspaceId, packId, attachedAt) VALUES (?, ?, ?)"
  ).run(workspaceId, packId, at);
  const pack = toRecord(getPackRow(packId) as PackRow);
  return { ...summaryOf(pack), json: pack.json, attachedAt: at };
}

export function detachPack(workspaceId: string, packId: string): boolean {
  const db = ensureSchema();
  const info = db.prepare("DELETE FROM workspace_packs WHERE workspaceId = ? AND packId = ?").run(workspaceId, packId);
  return Number(info.changes ?? 0) > 0;
}

/** The packs this workspace has attached, newest attachment last. */
export function attachedPacks(workspaceId: string): AttachedPack[] {
  const db = ensureSchema();
  const rows = db
    .prepare(
      "SELECT p.*, w.attachedAt AS attachedAt FROM workspace_packs w JOIN niche_packs p ON p.id = w.packId WHERE w.workspaceId = ? ORDER BY w.attachedAt ASC"
    )
    .all(workspaceId) as Array<PackRow & { attachedAt: string }>;
  return rows.map((row) => {
    const record = toRecord(row);
    return { ...summaryOf(record), json: record.json, attachedAt: String(row.attachedAt) };
  });
}

// ---------------------------------------------------------------- rules merge

function cloneRules(rules: ServiceRules): ServiceRules {
  return structuredClone(rules);
}

/** Merge one pack's overlay into a copy of the base rules. Never removes a rule. */
export function applyPackOverlay(base: ServiceRules, overlay: PackOverlay | undefined): ServiceRules {
  if (!overlay) return base;

  if (overlay.signals && typeof overlay.signals === "object") {
    for (const [id, info] of Object.entries(overlay.signals)) {
      if (!base.signals[id]) base.signals[id] = { kind: info.kind as SignalInfo["kind"], phrase: info.phrase };
    }
  }

  for (const ov of overlay.services ?? []) {
    const existing = base.services.find((s) => s.id === ov.id);
    if (existing) {
      for (const [sig, points] of Object.entries(ov.signals ?? {})) {
        if (!base.signals[sig]) continue; // never weight an undefined signal
        existing.signals[sig] = (existing.signals[sig] ?? 0) + points;
      }
      if (ov.reasons) {
        existing.reasons = existing.reasons ?? {};
        for (const [sig, reason] of Object.entries(ov.reasons)) existing.reasons[sig] = reason;
      }
      if (typeof ov.categoryBonus === "number") {
        existing.categoryBonus = (existing.categoryBonus ?? 0) + ov.categoryBonus;
      }
      if (Array.isArray(ov.categories)) {
        existing.categories = [...new Set([...(existing.categories ?? []), ...ov.categories])];
      }
    } else {
      const service: ServiceRule = {
        id: ov.id,
        label: ov.label ?? ov.id,
        pitch: ov.pitch ?? "",
        categoryBonus: ov.categoryBonus,
        categories: ov.categories,
        signals: { ...(ov.signals ?? {}) },
        reasons: ov.reasons ? { ...ov.reasons } : undefined,
      };
      base.services.push(service);
    }
  }
  return base;
}

/**
 * The global rule table merged with the overlays of the packs THIS workspace has
 * attached, and nothing else. A workspace with no attachments gets the plain
 * global rules. An overlay can add and weight signals and services; it can never
 * remove a global rule and never change another workspace.
 */
export function rulesFor(workspaceId: string): ServiceRules {
  const base = cloneRules(loadRules());
  if (!workspaceId) return base;
  for (const pack of attachedPacks(workspaceId)) {
    applyPackOverlay(base, pack.json.serviceRules);
  }
  return base;
}

/** The first attached pack, for feed/match engines that need one pack's shape. */
export function attachedPackFor(workspaceId: string): NichePackFile | undefined {
  const attached = attachedPacks(workspaceId);
  return attached.length > 0 ? attached[0].json : undefined;
}
