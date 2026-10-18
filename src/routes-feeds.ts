// src/routes-feeds.ts
// Order LG1-feed-engine: HTTP routes for lead feeds. Same module pattern as
// routes-calls.ts: export `registerFeedRoutes(register, helpers)` where
// `register(method, pathPattern, handler)`. This file never imports server.ts;
// the server hook only dynamic-imports it and calls `handleFeedRequest`.
// Node 24 built-ins only.
//
// Routes:
//   GET    /api/feeds?workspaceId=        -> list feeds
//   POST   /api/feeds                     -> create a feed (201)
//   GET    /api/feeds/due                 -> feeds due now (the ops scheduler calls this)
//   GET    /api/feeds/:id                 -> one feed
//   POST   /api/feeds/:id/run             -> run the feed now (returns the run row)
//   POST   /api/feeds/:id/enable          -> enable
//   POST   /api/feeds/:id/disable         -> disable
//   GET    /api/feeds/:id/runs            -> run history (newest first)
//
// A path this module does not own makes `handleFeedRequest` return false.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createFeed,
  dueFeeds,
  getFeed,
  listFeedRuns,
  listFeeds,
  runFeed,
  setFeedEnabled,
  type FeedDeps,
  type FeedSchedule,
} from "./feeds.js";

export type FeedRequestCtx = {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  readJson: () => Promise<unknown>;
};

export type FeedReply = {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
};

export type FeedHandler = (ctx: FeedRequestCtx) => Promise<FeedReply> | FeedReply;
export type FeedRegister = (method: string, pattern: string, handler: FeedHandler) => void;
export type FeedHelpers = { now?: () => Date };
export type FeedRouteDeps = FeedDeps;

function ok(json: unknown, status = 200): FeedReply {
  return { status, json };
}

function fail(status: number, error: string): FeedReply {
  return { status, json: { error } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => String(v));
}

function parseSchedule(value: unknown): FeedSchedule | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "daily") return { kind: "daily" };
  if (value.kind === "weekly") {
    const weekday = Number(value.weekday);
    if (!Number.isFinite(weekday)) return undefined;
    return { kind: "weekly", weekday: ((Math.floor(weekday) % 7) + 7) % 7 };
  }
  return undefined;
}

type CreateResult = { input: Parameters<typeof createFeed>[0] } | { error: string };

function parseCreate(body: Record<string, unknown>): CreateResult {
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const name = typeof body.name === "string" ? body.name : "";
  const nichePackId = typeof body.nichePackId === "string" ? body.nichePackId : "";
  if (!workspaceId) return { error: "workspaceId is required" };
  if (!name) return { error: "name is required" };
  if (!nichePackId) return { error: "nichePackId is required" };
  const perRunTarget = Number(body.perRunTarget);
  if (!Number.isFinite(perRunTarget) || perRunTarget <= 0) return { error: "perRunTarget must be a positive number" };
  const schedule = parseSchedule(body.schedule);
  if (!schedule) return { error: "schedule must be {kind:'daily'} or {kind:'weekly',weekday:0-6}" };
  return {
    input: {
      workspaceId,
      name,
      nichePackId,
      categories: stringArray(body.categories) ?? [],
      cities: stringArray(body.cities) ?? [],
      perRunTarget: Math.floor(perRunTarget),
      schedule,
      enabled: body.enabled === false ? false : undefined,
    },
  };
}

async function readObject(ctx: FeedRequestCtx): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await ctx.readJson();
  } catch {
    throw new Error("body must be valid JSON");
  }
  if (!isRecord(body)) throw new Error("body must be a JSON object");
  return body;
}

/** Registers every feed route with the given `register(method, pattern, handler)`. */
export function registerFeedRoutes(register: FeedRegister, helpers: FeedHelpers = {}, deps: FeedRouteDeps = {}): void {
  const now = () => (helpers.now ? helpers.now() : new Date());

  // NOTE: registered before /api/feeds/:id so the literal "due" wins.
  register("GET", "/api/feeds/due", () => ok({ feeds: dueFeeds(now()) }));

  register("GET", "/api/feeds", (ctx) => {
    const workspaceId = ctx.query.get("workspaceId") ?? undefined;
    return ok({ feeds: listFeeds(workspaceId ? { workspaceId } : {}) });
  });

  register("POST", "/api/feeds", async (ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readObject(ctx);
    } catch (err) {
      return fail(400, err instanceof Error ? err.message : String(err));
    }
    const parsed = parseCreate(body);
    if ("error" in parsed) return fail(400, parsed.error);
    try {
      return ok(createFeed(parsed.input), 201);
    } catch (err) {
      return fail(400, err instanceof Error ? err.message : String(err));
    }
  });

  register("GET", "/api/feeds/:id", (ctx) => {
    const feed = getFeed(ctx.params.id);
    return feed ? ok(feed) : fail(404, "feed not found");
  });

  register("GET", "/api/feeds/:id/runs", (ctx) => {
    if (!getFeed(ctx.params.id)) return fail(404, "feed not found");
    return ok({ runs: listFeedRuns(ctx.params.id) });
  });

  register("POST", "/api/feeds/:id/run", async (ctx) => {
    if (!getFeed(ctx.params.id)) return fail(404, "feed not found");
    try {
      const run = await runFeed(ctx.params.id, { ...deps, now: deps.now ?? now });
      return ok(run, 201);
    } catch (err) {
      return fail(500, err instanceof Error ? err.message : String(err));
    }
  });

  register("POST", "/api/feeds/:id/enable", (ctx) => {
    const feed = setFeedEnabled(ctx.params.id, true);
    return feed ? ok(feed) : fail(404, "feed not found");
  });

  register("POST", "/api/feeds/:id/disable", (ctx) => {
    const feed = setFeedEnabled(ctx.params.id, false);
    return feed ? ok(feed) : fail(404, "feed not found");
  });
}

// ----------------------------------------------------------------- node:http

type CompiledRoute = { method: string; re: RegExp; keys: string[]; handler: FeedHandler };

function compileRoutes(deps: FeedRouteDeps): CompiledRoute[] {
  const routes: CompiledRoute[] = [];
  registerFeedRoutes(
    (method, pattern, handler) => {
      const keys: string[] = [];
      const re = new RegExp(
        `^${pattern.replace(/:[^/]+/g, (token) => {
          keys.push(token.slice(1));
          return "([^/]+)";
        })}$`
      );
      routes.push({ method, re, keys, handler });
    },
    {},
    deps
  );
  return routes;
}

function sendReply(res: ServerResponse, reply: FeedReply): void {
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
 * node:http adapter used by the single server.ts hook: matches a feed route and
 * sends its reply, returning true when a feed route handled the request. Returns
 * false (and writes nothing) when the path is not a feed route.
 */
export async function handleFeedRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: FeedRouteDeps = {}
): Promise<boolean> {
  const method = req.method ?? "GET";
  for (const route of compileRoutes(deps)) {
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
    const ctx: FeedRequestCtx = {
      method,
      params,
      query: url.searchParams,
      readJson: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (text === "") return {};
        return JSON.parse(text) as unknown;
      },
    };
    let reply: FeedReply;
    try {
      reply = await route.handler(ctx);
    } catch (err) {
      reply = fail(500, err instanceof Error ? err.message : String(err));
    }
    sendReply(res, reply);
    return true;
  }
  return false;
}
