// Per-workspace price book and branding for Leadscout.
// Uses the DB from ./store.js so temp-database checks can set LEADSCOUT_DB before import.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, getWorkspace } from "./store.js";
import type { PriceItem, PriceBook, Quote, Branding } from "./types-v2.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ITEMS: PriceItem[] = JSON.parse(
  readFileSync(join(HERE, "..", "data", "default-pricebook.json"), "utf-8")
);

const TENANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS price_books (
  workspaceId TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  items TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branding (
  workspaceId TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
`;

// Initialise tables on first use of this module. In tests, LEADSCOUT_DB must be set before import.
getDb().exec(TENANT_SCHEMA);

export function getPriceBook(workspaceId: string): PriceBook {
  const row = getDb()
    .prepare("SELECT version, items, updatedAt FROM price_books WHERE workspaceId = ?")
    .get(workspaceId) as { version: number; items: string; updatedAt: string } | undefined;
  if (!row) {
    return {
      workspaceId,
      version: 0,
      items: DEFAULT_ITEMS,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    workspaceId,
    version: Number(row.version),
    items: JSON.parse(row.items) as PriceItem[],
    updatedAt: row.updatedAt,
  };
}

export function setPriceBook(workspaceId: string, items: PriceItem[]): PriceBook {
  validatePriceBook(items);
  const current = getDb()
    .prepare("SELECT version FROM price_books WHERE workspaceId = ?")
    .get(workspaceId) as { version: number } | undefined;
  const version = current ? Number(current.version) + 1 : 1;
  const updatedAt = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO price_books (workspaceId, version, items, updatedAt) VALUES (?, ?, ?, ?)"
    )
    .run(workspaceId, version, JSON.stringify(items), updatedAt);
  return { workspaceId, version, items, updatedAt };
}

function validatePriceBook(items: PriceItem[]) {
  if (!Array.isArray(items)) {
    throw new Error("item 'book': items must be an array");
  }
  const allowedFields = new Set([
    "service",
    "label",
    "description",
    "buildDays",
    "price",
    "assumption",
    "doorOpener",
  ]);
  const seen = new Set<string>();
  let doorOpeners = 0;

  for (const item of items) {
    if (!item || typeof item !== "object") {
      throw new Error("item '?': item must be an object");
    }
    const svc = item.service;

    for (const key of Object.keys(item)) {
      if (!allowedFields.has(key)) {
        throw new Error(`item '${svc ?? "?"}': unknown field '${key}'`);
      }
    }

    if (typeof svc !== "string" || svc.trim() === "") {
      throw new Error(`item '${svc ?? "?"}': service must be non-empty`);
    }
    if (seen.has(svc)) {
      throw new Error(`item '${svc}': service must be unique`);
    }
    seen.add(svc);

    if (typeof item.label !== "string" || item.label.trim() === "") {
      throw new Error(`item '${svc}': label must be non-empty`);
    }
    if (typeof item.description !== "string") {
      throw new Error(`item '${svc}': description must be a string`);
    }

    if (item.buildDays !== null) {
      if (
        !Array.isArray(item.buildDays) ||
        item.buildDays.length !== 2 ||
        !Number.isInteger(item.buildDays[0]) ||
        !Number.isInteger(item.buildDays[1])
      ) {
        throw new Error(`item '${svc}': buildDays must be null or [integer, integer]`);
      }
      const [minDays, maxDays] = item.buildDays;
      if (minDays < 0 || maxDays < 0 || minDays > maxDays) {
        throw new Error(`item '${svc}': buildDays min/max must be non-negative and min <= max`);
      }
    }

    if (item.price !== null) {
      const p = item.price as Quote;
      if (!p || typeof p !== "object" || typeof p.currency !== "string") {
        throw new Error(`item '${svc}': price.currency must be a 3-letter code`);
      }
      if (!/^[A-Za-z]{3}$/.test(p.currency)) {
        throw new Error(`item '${svc}': price.currency must be a 3-letter code`);
      }
      if (
        typeof p.min !== "number" ||
        typeof p.max !== "number" ||
        !Number.isFinite(p.min) ||
        !Number.isFinite(p.max)
      ) {
        throw new Error(`item '${svc}': price.min and price.max must be numbers`);
      }
      if (p.min < 0 || p.max < 0 || p.min > p.max) {
        throw new Error(`item '${svc}': price min/max must be non-negative and min <= max`);
      }
      if (p.max >= 100_000_000) {
        throw new Error(`item '${svc}': price.max must be below 100000000`);
      }
    }

    if (typeof item.assumption !== "string" || item.assumption.trim() === "") {
      throw new Error(`item '${svc}': assumption must be non-empty`);
    }
    if (item.assumption.length > 200) {
      throw new Error(`item '${svc}': assumption must be at most 200 chars`);
    }

    if (typeof item.doorOpener !== "boolean") {
      throw new Error(`item '${svc}': doorOpener must be boolean`);
    }
    if (item.doorOpener) {
      doorOpeners++;
    }
  }

  if (doorOpeners > 3) {
    const last = items[items.length - 1]?.service ?? "?";
    throw new Error(`item '${last}': at most 3 door-openers allowed`);
  }
}

export function priceFor(book: PriceBook, service: string): PriceItem | undefined {
  return book.items.find((i) => i.service === service);
}

export function getBranding(workspaceId: string): Branding {
  const row = getDb()
    .prepare("SELECT json FROM branding WHERE workspaceId = ?")
    .get(workspaceId) as { json: string } | undefined;
  if (row) {
    const parsed = JSON.parse(row.json) as Branding;
    return { ...parsed, hidePoweredBy: parsed.hidePoweredBy ?? false };
  }
  const workspace = getWorkspace(workspaceId);
  return {
    displayName: workspace?.name ?? "Leadscout",
    hidePoweredBy: false,
  };
}

export function setBranding(workspaceId: string, b: Branding): Branding {
  validateBranding(b);
  const stored: Branding = {
    displayName: b.displayName,
    logoUrl: b.logoUrl,
    accent: b.accent,
    contactLine: b.contactLine,
    reportFooter: b.reportFooter,
    senderName: b.senderName,
    hidePoweredBy: b.hidePoweredBy ?? false,
  };
  const updatedAt = new Date().toISOString();
  getDb()
    .prepare("INSERT OR REPLACE INTO branding (workspaceId, json, updatedAt) VALUES (?, ?, ?)")
    .run(workspaceId, JSON.stringify(stored), updatedAt);
  return stored;
}

function validateBranding(b: Branding) {
  if (!b || typeof b !== "object") {
    throw new Error("branding: must be an object");
  }

  if (
    typeof b.displayName !== "string" ||
    b.displayName.trim().length < 1 ||
    b.displayName.length > 80
  ) {
    throw new Error("branding: displayName must be 1-80 chars");
  }

  const stringFields: (keyof Branding)[] = [
    "displayName",
    "logoUrl",
    "accent",
    "contactLine",
    "reportFooter",
    "senderName",
  ];
  for (const field of stringFields) {
    const v = b[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") {
      throw new Error(`branding: ${field} must be a string`);
    }
    if (v.includes("<") || v.includes(">")) {
      throw new Error(`branding: ${field} must not contain '<' or '>'`);
    }
  }

  if (b.logoUrl !== undefined) {
    if (!/^https:\/\//.test(b.logoUrl)) {
      throw new Error("branding: logoUrl must use https");
    }
    if (b.logoUrl.length > 500) {
      throw new Error("branding: logoUrl must be at most 500 chars");
    }
  }

  if (b.accent !== undefined) {
    if (!/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(b.accent)) {
      throw new Error("branding: accent must be #rgb or #rrggbb");
    }
  }

  const text300: (keyof Branding)[] = ["contactLine", "reportFooter", "senderName"];
  for (const field of text300) {
    const v = b[field];
    if (typeof v === "string" && v.length > 300) {
      throw new Error(`branding: ${field} must be at most 300 chars`);
    }
  }
}
