// src/page-cache.ts
// SQLite-backed conditional GET page cache. Only GET is cached.

import { createHash } from "node:crypto";
import { getDb } from "./store.js";

const MAX_BYTES = 1_572_864; // 1.5 MB
const DEFAULT_TTL_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS page_cache (
  url TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  headers TEXT NOT NULL,
  body TEXT NOT NULL,
  etag TEXT,
  lastModified TEXT,
  fetchedAt TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
`;

getDb().exec(SCHEMA);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function truncateBody(text: string): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= MAX_BYTES) return text;
  return buffer.subarray(0, MAX_BYTES).toString("utf8");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function ttlMs(url: string, ttlDays: number, ttlDaysByHost: Record<string, number>): number {
  const host = hostOf(url);
  const days = host && ttlDaysByHost[host] !== undefined ? ttlDaysByHost[host] : ttlDays;
  return days * MS_PER_DAY;
}

function parseHeaders(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  } catch { /* ignore */ }
  return {};
}

function serializeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function cachedResponse(row: { url: string; status: number; headers: string; body: string; fetchedAt: string }): Response {
  const headers = new Headers(parseHeaders(row.headers));
  headers.set("x-leadscout-cache", "hit");
  return new Response(row.body, { status: row.status, headers });
}

export type CacheOpts = {
  fetchFn?: typeof fetch;
  ttlDays?: number;
  ttlDaysByHost?: Record<string, number>;
  now?: () => Date;
};

export function cachedFetch(opts: CacheOpts = {}): typeof fetch {
  const fetchFn = opts.fetchFn ?? fetch;
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const ttlDaysByHost = opts.ttlDaysByHost ?? {};
  const nowFn = opts.now ?? (() => new Date());

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") return fetchFn(input, init);

    const db = getDb();
    const row = db.prepare("SELECT * FROM page_cache WHERE url = ?").get(url) as
      | { url: string; status: number; headers: string; body: string; etag: string | null; lastModified: string | null; fetchedAt: string; sha256: string }
      | undefined;

    const now = nowFn().getTime();
    const freshUntil = row ? new Date(row.fetchedAt).getTime() + ttlMs(url, ttlDays, ttlDaysByHost) : 0;
    const isFresh = row && now < freshUntil;

    if (isFresh && row) {
      return cachedResponse(row);
    }

    const conditionalInit: RequestInit = { ...init };
    const conditionalHeaders = new Headers(init?.headers);
    if (row?.etag) conditionalHeaders.set("If-None-Match", row.etag);
    if (row?.lastModified) conditionalHeaders.set("If-Modified-Since", row.lastModified);
    conditionalInit.headers = conditionalHeaders;

    const res = await fetchFn(input, conditionalInit);

    if (res.status === 304 && row) {
      const fetchedAt = nowFn().toISOString();
      db.prepare("UPDATE page_cache SET fetchedAt = ? WHERE url = ?").run(fetchedAt, url);
      return cachedResponse({ url: row.url, status: row.status, headers: row.headers, body: row.body, fetchedAt });
    }

    if (res.status === 304) {
      return new Response(null, { status: 304, headers: res.headers });
    }

    const bodyText = await res.text();
    const body = truncateBody(bodyText);
    const headers = serializeHeaders(res.headers);
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;
    const fetchedAt = nowFn().toISOString();
    const hash = sha256(body);

    db.prepare(
      `INSERT OR REPLACE INTO page_cache (url, status, headers, body, etag, lastModified, fetchedAt, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(url, res.status, JSON.stringify(headers), body, etag ?? null, lastModified ?? null, fetchedAt, hash);

    return new Response(body, { status: res.status, headers: res.headers });
  };
}

export function getCachedPage(url: string): { url: string; status: number; body: string; fetchedAt: string } | undefined {
  const row = getDb().prepare("SELECT url, status, body, fetchedAt FROM page_cache WHERE url = ?").get(url) as
    | { url: string; status: number; body: string; fetchedAt: string }
    | undefined;
  return row;
}
