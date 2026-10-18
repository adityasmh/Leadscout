// src/routes-packs.ts
// Order NP1: HTTP routes for niche packs as attachments. Same module pattern as
// routes-calls.ts: export `registerPackRoutes(register, helpers)` and the
// node:http adapter `handlePackRequest(req, res, url)`. This file never imports
// server.ts; the single server hook dynamic-imports it. Node 24 built-ins only.
//
// Routes (workspace API key guard, the same one the other workspace routes use):
//   GET    /api/niche-packs?workspaceId=      -> the pack library
//   POST   /api/niche-packs                   -> upload a pack JSON (<= 512 KB)
//   GET    /api/workspaces/:ws/niche-packs    -> { attached, library }
//   POST   /api/workspaces/:ws/niche-packs/:id/attach
//   POST   /api/workspaces/:ws/niche-packs/:id/detach
//
// Every handler returns a reply; nothing throws into the server.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getWorkspace } from "./store.js";
import {
  PackError,
  attachPack,
  attachedPacks,
  detachPack,
  installPack,
  listPacks,
} from "./niche-packs.js";

/** A pack upload may not exceed this many bytes (order NP1). */
export const MAX_PACK_BYTES = 512 * 1024;

export type PackRequestCtx = {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  header: (name: string) => string | undefined;
  readJson: () => Promise<unknown>;
  readText: () => Promise<string>;
};

export type PackReply = {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
};

export type PackHandler = (ctx: PackRequestCtx) => Promise<PackReply> | PackReply;
export type PackRegister = (method: string, pattern: string, handler: PackHandler) => void;
export type PackHelpers = { now?: () => Date };

function ok(json: unknown, status = 200): PackReply {
  return { status, json };
}

function fail(status: number, error: string, errors?: string[]): PackReply {
  return { status, json: errors && errors.length > 0 ? { error, errors } : { error } };
}

/** The workspace API key guard, identical in behaviour to server.ts/routes-calls.ts. */
async function guard(ctx: PackRequestCtx, workspaceId: string): Promise<PackReply | null> {
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

async function guardAnyWorkspace(ctx: PackRequestCtx): Promise<PackReply | null> {
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
  if (!key) return fail(401, "authorization required");
  const verified = access.verifyApiKey(key);
  if (!verified) return fail(401, "invalid or revoked API key");
  if (ctx.method !== "GET" && !verified.scopes.includes("write")) {
    return fail(403, "this key is read-only; a write-scoped key is needed for this request");
  }
  return null;
}

function workspaceOr404(workspaceId: string): PackReply | null {
  if (!getWorkspace(workspaceId)) return fail(404, "workspace not found");
  return null;
}

/** Registers every niche-pack route with the given `register(method, pattern, handler)`. */
export function registerPackRoutes(register: PackRegister, helpers: PackHelpers = {}): void {
  void helpers;

  register("GET", "/api/niche-packs", (ctx) => {
    const workspaceId = ctx.query.get("workspaceId") ?? undefined;
    return ok({ packs: listPacks(workspaceId) });
  });

  register("POST", "/api/niche-packs", async (ctx) => {
    const denied = await guardAnyWorkspace(ctx);
    if (denied) return denied;
    let text: string;
    try {
      text = await ctx.readText();
    } catch (err) {
      return fail(400, err instanceof Error ? err.message : String(err));
    }
    if (Buffer.byteLength(text, "utf8") > MAX_PACK_BYTES) {
      return fail(413, `pack is larger than ${MAX_PACK_BYTES} bytes`);
    }
    let body: unknown;
    try {
      body = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      return fail(400, "body must be valid JSON");
    }
    const owner =
      (typeof (body as { owner?: unknown }).owner === "string" && (body as { owner: string }).owner) ||
      ctx.query.get("owner") ||
      "shared";
    try {
      return ok({ pack: installPack(body, owner) }, 201);
    } catch (err) {
      if (err instanceof PackError) return fail(400, "invalid niche pack", err.errors);
      return fail(400, err instanceof Error ? err.message : String(err));
    }
  });

  register("GET", "/api/workspaces/:ws/niche-packs", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    return ok({ attached: attachedPacks(ws), library: listPacks(ws) });
  });

  register("POST", "/api/workspaces/:ws/niche-packs/:id/attach", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    try {
      return ok({ attached: attachPack(ws, ctx.params.id) }, 201);
    } catch (err) {
      if (err instanceof PackError) return fail(404, err.errors.join("; "), err.errors);
      return fail(400, err instanceof Error ? err.message : String(err));
    }
  });

  register("POST", "/api/workspaces/:ws/niche-packs/:id/detach", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = workspaceOr404(ws);
    if (missing) return missing;
    const denied = await guard(ctx, ws);
    if (denied) return denied;
    const removed = detachPack(ws, ctx.params.id);
    if (!removed) return fail(404, "pack was not attached to this workspace");
    return ok({ detached: ctx.params.id });
  });
}

// ----------------------------------------------------------------- node:http

function safeHandler(handler: PackHandler): PackHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof PackError) return fail(400, err.message, err.errors);
      const message = err instanceof Error && err.message ? err.message : String(err);
      return fail(500, message);
    }
  };
}

type CompiledRoute = { method: string; re: RegExp; keys: string[]; handler: PackHandler };

function compileRoutes(): CompiledRoute[] {
  const routes: CompiledRoute[] = [];
  registerPackRoutes((method, pattern, handler) => {
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

function sendReply(res: ServerResponse, reply: PackReply): void {
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
 * node:http adapter used by the single server.ts hook: matches a niche-pack route
 * and sends its reply, returning true when a route handled the request. Returns
 * false (and writes nothing) when the path is not a niche-pack route.
 */
export async function handlePackRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
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
    const ctx: PackRequestCtx = {
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
