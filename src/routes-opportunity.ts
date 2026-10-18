// src/routes-opportunity.ts
// Order OM1-opportunity-map: HTTP routes for the opportunity map.
// Same pattern as routes-intake.ts: registerOpportunityRoutes(register,
// helpers) registers through the injected register(), with NO import from
// server.ts. The server hook dynamic-imports this file inside try/catch.
//
// Routes:
//   GET /api/workspaces/:ws/opportunity
//   GET /api/workspaces/:ws/opportunity/next

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  OPPORTUNITY_MIN_PROCESSED,
  loadOpportunity,
  loadSuggestions,
} from "./opportunity.js";
import { getWorkspace } from "./store.js";
import type { Workspace } from "./types.js";

export type OpportunityRequestCtx = {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  header: (name: string) => string | undefined;
  readJson: () => Promise<unknown>;
};

export type OpportunityReply = {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
};

export type OpportunityHandler = (ctx: OpportunityRequestCtx) => Promise<OpportunityReply> | OpportunityReply;
export type OpportunityRegister = (method: string, pattern: string, handler: OpportunityHandler) => void;

export type OpportunityHelpers = {
  /** Workspace API key guard. Returns a reply to send when refused, else null. */
  guard?: (ctx: OpportunityRequestCtx, workspaceId: string) => Promise<OpportunityReply | null> | OpportunityReply | null;
  /** Resolves a workspace. */
  ensureWorkspace?: (workspaceId: string) => Workspace | undefined;
  readJson?: (req: IncomingMessage) => Promise<unknown>;
  sendJson?: (res: ServerResponse, status: number, body: unknown) => void;
};

class OpportunityError extends Error {}

function ok(json: unknown, status = 200): OpportunityReply {
  return { status, json };
}

function fail(status: number, error: string): OpportunityReply {
  return { status, json: { error } };
}

function defaultEnsureWorkspace(workspaceId: string): Workspace | undefined {
  return getWorkspace(workspaceId);
}

async function defaultGuard(): Promise<null> {
  return null;
}

export function registerOpportunityRoutes(register: OpportunityRegister, helpers: OpportunityHelpers = {}): void {
  const authorize = helpers.guard ?? defaultGuard;
  const ensure = helpers.ensureWorkspace ?? defaultEnsureWorkspace;

  register("GET", "/api/workspaces/:ws/opportunity", async (ctx) => {
    const ws = ctx.params.ws;
    const workspace = ensure(ws);
    if (!workspace) return fail(404, "workspace not found");
    const denied = await authorize(ctx, ws);
    if (denied) return denied;
    const category = ctx.query.get("category")?.trim() || undefined;
    const loaded = loadOpportunity(ws);
    const groups = category
      ? loaded.groups.filter((g) => g.category.toLowerCase() === category.toLowerCase())
      : loaded.groups;
    return ok({
      workspaceId: ws,
      processed: loaded.processed,
      minProcessed: OPPORTUNITY_MIN_PROCESSED,
      tooFew: loaded.processed < OPPORTUNITY_MIN_PROCESSED,
      groups,
    });
  });

  register("GET", "/api/workspaces/:ws/opportunity/next", async (ctx) => {
    const ws = ctx.params.ws;
    const workspace = ensure(ws);
    if (!workspace) return fail(404, "workspace not found");
    const denied = await authorize(ctx, ws);
    if (denied) return denied;
    const loaded = loadSuggestions(ws);
    const limitRaw = ctx.query.get("limit") ?? "";
    const limit = Number(limitRaw);
    const suggestions = Number.isFinite(limit) && limit > 0
      ? loaded.suggestions.slice(0, Math.floor(limit))
      : loaded.suggestions;
    return ok({ workspaceId: ws, suggestions });
  });
}

// ----------------------------------------------------------------- node:http

function safeHandler(handler: OpportunityHandler): OpportunityHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof OpportunityError) return fail(400, err.message);
      const message = err instanceof Error && err.message ? err.message : String(err);
      return fail(500, message);
    }
  };
}

type CompiledRoute = { method: string; re: RegExp; keys: string[]; handler: OpportunityHandler };

function compileRoutes(helpers: OpportunityHelpers): CompiledRoute[] {
  const routes: CompiledRoute[] = [];
  registerOpportunityRoutes((method, pattern, handler) => {
    const keys: string[] = [];
    const re = new RegExp(
      `^${pattern.replace(/:[^/]+/g, (token) => {
        keys.push(token.slice(1));
        return "([^/]+)";
      })}$`,
    );
    routes.push({ method, re, keys, handler: safeHandler(handler) });
  }, helpers);
  return routes;
}

async function defaultReadJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  return JSON.parse(text) as unknown;
}

/**
 * node:http adapter used by the single server.ts hook: matches an opportunity
 * route and sends its reply, returning true when one handled the request.
 */
export async function handleOpportunityRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  overrides: OpportunityHelpers = {},
): Promise<boolean> {
  const method = req.method ?? "GET";
  for (const route of compileRoutes(overrides)) {
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
    const ctx: OpportunityRequestCtx = {
      method,
      params,
      query: url.searchParams,
      header: (name) => {
        const value = req.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
      },
      readJson: async () => (overrides.readJson ? overrides.readJson(req) : defaultReadJson(req)),
    };
    const reply = await route.handler(ctx);
    if (reply.text !== undefined) {
      const payload = reply.text;
      res.writeHead(reply.status, {
        ...(reply.headers ?? {}),
        "content-type": reply.contentType ?? "text/plain; charset=utf-8",
        "content-length": String(Buffer.byteLength(payload)),
      });
      res.end(payload);
      return true;
    }
    if (overrides.sendJson) {
      overrides.sendJson(res, reply.status, reply.json ?? null);
      return true;
    }
    const payload = JSON.stringify(reply.json ?? null);
    res.writeHead(reply.status, {
      ...(reply.headers ?? {}),
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(payload)),
    });
    res.end(payload);
    return true;
  }
  return false;
}
