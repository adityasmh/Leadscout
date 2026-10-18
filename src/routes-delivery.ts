// src/routes-delivery.ts
// Order LG2-gate-delivery: HTTP routes for the daily call sheet.
//
// Same module pattern as routes-calls.ts: export
// `registerDeliveryRoutes(register, helpers)` where `register(method, pattern, handler)`,
// plus a `handleDeliveryRequest(req, res, url)` node:http adapter for the single server
// hook. This file never imports server.ts; the server hook only dynamic-imports it.
//
// Routes (workspace API key guard, the same one the other workspace routes use):
//   GET  /api/workspaces/:ws/callsheet?date=&perCaller=&callers=a,b,c&format=json|csv|html
//   POST /api/workspaces/:ws/callsheet/assign   body {date?, perCaller?, callers?, minScore?}
//
// Every handler returns a reply; nothing throws into the server.
// Node 24 built-ins only, ES module, .js import suffix.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getWorkspace } from "./store.js";
import {
  buildCallSheet,
  persistCallSheet,
  renderCallSheetCsv,
  renderCallSheetHtml,
  DEFAULT_CALLERS,
  DEFAULT_PER_CALLER,
  type CallSheetOptions,
} from "./delivery.js";

/** A bad request; safeHandler maps it to a 400. */
class DeliveryError extends Error {}

export type DeliveryRequestCtx = {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  header: (name: string) => string | undefined;
  readJson: () => Promise<unknown>;
  readText: () => Promise<string>;
};

export type DeliveryReply = {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
};

export type DeliveryHandler = (ctx: DeliveryRequestCtx) => Promise<DeliveryReply> | DeliveryReply;
export type DeliveryRegister = (method: string, pattern: string, handler: DeliveryHandler) => void;
export type DeliveryHelpers = { now?: () => Date };

function ok(json: unknown, status = 200): DeliveryReply {
  return { status, json };
}

function fail(status: number, error: string): DeliveryReply {
  return { status, json: { error } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The workspace API key guard, identical in behaviour to server.ts: open on loopback
 * unless LEADSCOUT_REQUIRE_KEYS=1, and a presented key is always checked. Returns a reply
 * to send when the request is refused, else null.
 */
async function guard(ctx: DeliveryRequestCtx, workspaceId: string): Promise<DeliveryReply | null> {
  const requireKeys = process.env.LEADSCOUT_REQUIRE_KEYS === "1";
  const auth = ctx.header("authorization");
  if (!requireKeys && !auth) return null;
  let access: typeof import("./access.js");
  try {
    access = await import("./access.js");
  } catch {
    return requireKeys ? fail(401, "authorization required: the access module is unavailable") : null;
  }
  const key = access.parseBearer(auth);
  if (!key) return fail(401, "authorization required: send Authorization: Bearer <key> for this workspace");
  const verified = access.verifyApiKey(key);
  if (!verified) return fail(401, "invalid or revoked API key");
  if (verified.workspaceId !== workspaceId) return fail(403, "this key belongs to a different workspace");
  if (ctx.method !== "GET" && !verified.scopes.includes("write")) {
    return fail(403, "this key is read-only; a write-scoped key is needed for this request");
  }
  access.meter(workspaceId, "apiCalls", 1);
  return null;
}

function workspaceOr404(workspaceId: string): DeliveryReply | null {
  if (!getWorkspace(workspaceId)) return fail(404, "workspace not found");
  return null;
}

const MAX_CALLER_NAMES = 20;
const MAX_PER_CALLER = 100;

function parseCallers(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  return cleanCallerNames(value.split(","));
}

/** Trims, drops empties, caps at MAX_CALLER_NAMES; undefined when nothing remains. */
function cleanCallerNames(names: string[]): string[] | undefined {
  const cleaned = names.map((name) => String(name).trim()).filter((name) => name !== "");
  if (cleaned.length === 0) return undefined;
  if (cleaned.length > MAX_CALLER_NAMES) {
    throw new DeliveryError(`at most ${MAX_CALLER_NAMES} caller names are allowed`);
  }
  return cleaned;
}

/** A validated perCaller: a positive integer from 1 to MAX_PER_CALLER. */
function checkPerCaller(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_PER_CALLER) {
    throw new DeliveryError(`perCaller must be a positive integer from 1 to ${MAX_PER_CALLER}`);
  }
  return value;
}

function parsePerCaller(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  return checkPerCaller(Number(value));
}

function numberOrUndefined(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionsFrom(query: URLSearchParams, body?: Record<string, unknown>): CallSheetOptions {
  const opts: CallSheetOptions = {};
  const date = query.get("date") ?? (typeof body?.date === "string" ? body.date : undefined);
  if (date !== undefined && date !== null) opts.date = date;
  const perCaller =
    parsePerCaller(query.get("perCaller")) ??
    (typeof body?.perCaller === "number" ? checkPerCaller(body.perCaller) : undefined) ??
    (typeof body?.perCaller === "string" ? parsePerCaller(body.perCaller) : undefined) ??
    DEFAULT_PER_CALLER;
  opts.perCaller = perCaller;
  const callers =
    parseCallers(query.get("callers")) ??
    (Array.isArray(body?.callers) ? cleanCallerNames((body.callers as unknown[]).map(String)) : undefined) ??
    (typeof body?.callers === "string" ? parseCallers(body.callers) : undefined) ??
    [...DEFAULT_CALLERS];
  opts.callers = callers;
  const minScore =
    numberOrUndefined(query.get("minScore")) ??
    (typeof body?.minScore === "number" ? body.minScore : undefined);
  if (minScore !== undefined) opts.minScore = minScore;
  return opts;
}

/** Registers the call-sheet routes with the given `register(method, pattern, handler)`. */
export function registerDeliveryRoutes(register: DeliveryRegister, _helpers: DeliveryHelpers = {}): void {
  register("GET", "/api/workspaces/:ws/callsheet", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    const format = (ctx.query.get("format") ?? "json").toLowerCase();
    let sheetOpts: CallSheetOptions;
    try {
      sheetOpts = optionsFrom(ctx.query);
    } catch (err) {
      if (err instanceof DeliveryError) return fail(400, err.message);
      throw err;
    }
    const sheet = buildCallSheet(ws, sheetOpts);
    if (format === "csv") {
      return { status: 200, text: renderCallSheetCsv(sheet), contentType: "text/csv; charset=utf-8" };
    }
    if (format === "html") {
      return { status: 200, text: renderCallSheetHtml(sheet), contentType: "text/html; charset=utf-8" };
    }
    return ok({ sheet });
  });

  register("POST", "/api/workspaces/:ws/callsheet/assign", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    let body: Record<string, unknown> = {};
    try {
      const parsed = await ctx.readJson();
      if (isRecord(parsed)) body = parsed;
    } catch {
      throw new DeliveryError("body must be valid JSON");
    }
    let sheetOpts: CallSheetOptions;
    try {
      sheetOpts = optionsFrom(ctx.query, body);
    } catch (err) {
      if (err instanceof DeliveryError) return fail(400, err.message);
      throw err;
    }
    const sheet = buildCallSheet(ws, sheetOpts);
    const assigned = persistCallSheet(sheet);
    const status = assigned > 0 ? 201 : 200;
    return ok({ assigned, date: sheet.date, workspaceId: ws, callers: sheet.callers, rows: sheet.rows.length }, status);
  });
}

// ----------------------------------------------------------------- node:http

function safeHandler(handler: DeliveryHandler): DeliveryHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof DeliveryError) return fail(400, err.message);
      const message = err instanceof Error && err.message ? err.message : String(err);
      return fail(500, message);
    }
  };
}

type CompiledRoute = { method: string; re: RegExp; keys: string[]; handler: DeliveryHandler };

function compileRoutes(): CompiledRoute[] {
  const routes: CompiledRoute[] = [];
  registerDeliveryRoutes((method, pattern, handler) => {
    const keys: string[] = [];
    const re = new RegExp(
      `^${pattern.replace(/:[^/]+/g, (token) => {
        keys.push(token.slice(1));
        return "([^/]+)";
      })}$`
    );
    routes.push({ method, re, keys, handler: safeHandler(handler) });
  });
  return routes;
}

function sendReply(res: ServerResponse, reply: DeliveryReply): void {
  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  let payload: string | undefined;
  if (reply.text !== undefined) {
    headers["content-type"] = reply.contentType ?? "text/plain; charset=utf-8";
    payload = reply.text;
  } else {
    headers["content-type"] = "application/json; charset=utf-8";
    payload = JSON.stringify(reply.json ?? null);
  }
  headers["content-length"] = String(Buffer.byteLength(payload));
  res.writeHead(reply.status, headers);
  res.end(payload);
}

/**
 * node:http adapter used by the single server.ts hook: matches a call-sheet route and
 * sends its reply, returning true when one handled the request. Returns false (and writes
 * nothing) when the path is not a call-sheet route.
 */
export async function handleDeliveryRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? "GET";
  for (const route of compileRoutes()) {
    if (route.method !== method) continue;
    const match = route.re.exec(url.pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      const raw = match[index + 1] ?? "";
      try {
        params[key] = decodeURIComponent(raw);
      } catch {
        params[key] = raw;
      }
    });
    const ctx: DeliveryRequestCtx = {
      method,
      params,
      query: url.searchParams,
      header: (name) => {
        const value = req.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
      },
      readJson: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (text === "") return {};
        return JSON.parse(text) as unknown;
      },
      readText: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString("utf8");
      },
    };
    const reply = await route.handler(ctx);
    sendReply(res, reply);
    return true;
  }
  return false;
}
