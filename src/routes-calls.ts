// src/routes-calls.ts
// Order CALL1: HTTP routes for the call log. Same shape as the other route
// files (`routes-intake.ts`): export `registerCallRoutes(register, helpers)`
// where `register(method, pathPattern, handler)`. This file never imports
// `server.ts`; the server hook only dynamic-imports it. Node 24 built-ins only.
//
// Routes (workspace API key guard, the same one the other workspace routes use):
//   POST   /api/workspaces/:ws/leads/:id/calls
//   GET    /api/workspaces/:ws/leads/:id/calls
//   GET    /api/workspaces/:ws/call-queue
//   GET    /api/workspaces/:ws/call-stats?from=&to=
//   GET    /api/workspaces/:ws/calls.csv
//   PATCH  /api/workspaces/:ws/calls/:callId
// DELETE is deliberately NOT provided: call history is kept.
//
// Every handler returns a reply; nothing throws into the server.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getLead, getWorkspace } from "./store.js";
import {
  CallError,
  callQueue,
  callsForLead,
  exportCsv,
  logCall,
  stats,
  updateCallLog,
  type CallEdit,
} from "./calls.js";

export type CallRequestCtx = {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  header: (name: string) => string | undefined;
  readJson: () => Promise<unknown>;
  readText: () => Promise<string>;
};

export type CallReply = {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
};

export type CallHandler = (ctx: CallRequestCtx) => Promise<CallReply> | CallReply;
export type CallRegister = (method: string, pattern: string, handler: CallHandler) => void;
export type CallHelpers = { now?: () => Date };

function ok(json: unknown, status = 200): CallReply {
  return { status, json };
}

function fail(status: number, error: string): CallReply {
  return { status, json: { error } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The workspace API key guard, identical in behaviour to server.ts:
 * open on loopback unless LEADSCOUT_REQUIRE_KEYS=1, and a presented key is always
 * checked. Returns a reply to send when the request is refused, else null.
 */
async function guard(ctx: CallRequestCtx, workspaceId: string): Promise<CallReply | null> {
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

/** Resolves the workspace or returns the reply to send when it is missing. */
function workspaceOr404(workspaceId: string): CallReply | null {
  if (!getWorkspace(workspaceId)) return fail(404, "workspace not found");
  return null;
}

async function readObject(ctx: CallRequestCtx): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await ctx.readJson();
  } catch {
    throw new CallError("body must be valid JSON");
  }
  if (!isRecord(body)) throw new CallError("body must be a JSON object");
  return body;
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Registers every call route with the given `register(method, pattern, handler)`
 * function. Handlers share the workspace key guard and never throw.
 */
export function registerCallRoutes(register: CallRegister, helpers: CallHelpers = {}): void {
  const now = () => (helpers.now ? helpers.now() : new Date());

  register("POST", "/api/workspaces/:ws/leads/:id/calls", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    const body = await readObject(ctx);
    const input: Record<string, unknown> = { workspaceId: ws, leadId: ctx.params.id };
    if (body.channel !== undefined) input.channel = body.channel;
    if (body.outcome !== undefined) input.outcome = body.outcome;
    if (body.iSaid !== undefined) input.iSaid = body.iSaid;
    if (body.theySaid !== undefined) input.theySaid = body.theySaid;
    if (body.nextAction !== undefined) input.nextAction = body.nextAction;
    if (body.followUpAt !== undefined) input.followUpAt = body.followUpAt;
    if (body.durationSec !== undefined) input.durationSec = body.durationSec;
    if (body.at !== undefined) input.at = body.at;
    const call = await logCall(input as unknown as Parameters<typeof logCall>[0]);
    return ok(call, 201);
  });

  register("GET", "/api/workspaces/:ws/leads/:id/calls", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    if (!getLead(ws, ctx.params.id)) return fail(404, "lead not found");
    return ok({ calls: callsForLead(ws, ctx.params.id) });
  });

  register("GET", "/api/workspaces/:ws/call-queue", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    return ok({ queue: callQueue(ws, now()) });
  });

  register("GET", "/api/workspaces/:ws/call-stats", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    const from = ctx.query.get("from") ?? undefined;
    const to = ctx.query.get("to") ?? undefined;
    return ok(stats(ws, from, to));
  });

  register("GET", "/api/workspaces/:ws/calls.csv", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    return { status: 200, text: exportCsv(ws), contentType: "text/csv; charset=utf-8" };
  });

  register("PATCH", "/api/workspaces/:ws/calls/:callId", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    const body = await readObject(ctx);
    const patch: CallEdit = {};
    if (body.channel !== undefined) patch.channel = body.channel as CallEdit["channel"];
    if (body.outcome !== undefined) patch.outcome = body.outcome as CallEdit["outcome"];
    if (body.iSaid !== undefined) patch.iSaid = textOrUndefined(body.iSaid);
    if (body.theySaid !== undefined) patch.theySaid = textOrUndefined(body.theySaid);
    if (body.nextAction !== undefined) patch.nextAction = textOrUndefined(body.nextAction);
    if (body.followUpAt !== undefined) patch.followUpAt = body.followUpAt as CallEdit["followUpAt"];
    if (body.durationSec !== undefined) patch.durationSec = body.durationSec as CallEdit["durationSec"];
    if (body.at !== undefined) patch.at = textOrUndefined(body.at);
    const updated = updateCallLog(ws, ctx.params.callId, patch);
    if (!updated) return fail(404, "call not found");
    return ok(updated);
  });
}

// ----------------------------------------------------------------- node:http

/** Wraps one handler so CallError becomes a 400 and anything else a 500. */
function safeHandler(handler: CallHandler): CallHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof CallError) return fail(400, err.message);
      const message = err instanceof Error && err.message ? err.message : String(err);
      return fail(500, message);
    }
  };
}

type CompiledRoute = { method: string; re: RegExp; keys: string[]; handler: CallHandler };

/** Compiles `:param` patterns into regexes; the internal store for the node adapter. */
function compileRoutes(): CompiledRoute[] {
  const routes: CompiledRoute[] = [];
  registerCallRoutes((method, pattern, handler) => {
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

function sendReply(res: ServerResponse, reply: CallReply): void {
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
 * node:http adapter used by the single server.ts hook: matches a call route and
 * sends its reply, returning true when a call route handled the request. It
 * registers through `registerCallRoutes`, so the generic pattern is the one that
 * runs. Returns false (and writes nothing) when the path is not a call route.
 */
export async function handleCallRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
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
    const ctx: CallRequestCtx = {
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
