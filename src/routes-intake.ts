// src/routes-intake.ts
// Order L30-wiring-3: expose the intake interview, brief-driven discovery, the
// lookalike profile and channel/reader status through the server. ALL new logic
// lives here; server.ts only dynamic-imports this file from one hook.
//
// Shape: `registerIntakeRoutes(register, helpers)` registers the routes through
// the injected `register(method, pathPattern, handler)` and optional helpers
// (key check, JSON reader, send JSON, workspace resolver, model fn, fetchFn), so
// this file never imports `server.ts`. `handleIntakeRequest(req, res, url)` is
// the node:http adapter the server hook calls (same shape as routes-calls.ts).
//
// Node 24 built-ins only. Every outside call (lookalike example fetch) goes
// through an injected `fetchFn`; the route is offline unless one is configured.
//
// Routes (workspace key guard, the same one the other workspace routes use):
//   GET    /api/workspaces/:ws/intake
//   GET    /api/workspaces/:ws/intake/next
//   POST   /api/workspaces/:ws/intake/answer
//   POST   /api/workspaces/:ws/intake/refine   (501 when no model fn is available)
//   GET    /api/workspaces/:ws/brief
//   PUT    /api/workspaces/:ws/brief
//   POST   /api/workspaces/:ws/brief/run       (brief -> discovery jobs)
//   POST   /api/workspaces/:ws/lookalike/profile
//   GET    /api/channels/status                (names/tier/enabled/reason, no secrets)

import type { IncomingMessage, ServerResponse } from "node:http";
import { createJob, getDb, getWorkspace } from "./store.js";
import type { JobQuery, Workspace } from "./types.js";
import {
  briefToQueries,
  loadBrief,
  nextQuestions,
  refineWithModel,
  saveBrief,
  type IntakeState,
  type TargetBrief,
} from "./intake.js";
import { buildProfile, type LookalikeExample, type LookalikeProfile } from "./lookalike.js";

// --------------------------------------------------------------------- types

export type IntakeRequestCtx = {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  header: (name: string) => string | undefined;
  readJson: () => Promise<unknown>;
};

export type IntakeReply = {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
};

export type IntakeHandler = (ctx: IntakeRequestCtx) => Promise<IntakeReply> | IntakeReply;
export type IntakeRegister = (method: string, pattern: string, handler: IntakeHandler) => void;

export type IntakeHelpers = {
  /** Workspace API key guard. Returns a reply to send when refused, else null. */
  guard?: (ctx: IntakeRequestCtx, workspaceId: string) => Promise<IntakeReply | null> | IntakeReply | null;
  /** Reads the JSON request body. */
  readJson?: (req: IncomingMessage) => Promise<unknown>;
  /** Sends a JSON reply. */
  sendJson?: (res: ServerResponse, status: number, body: unknown) => void;
  /** Resolves a workspace, creating the `default` one when needed. */
  ensureWorkspace?: (workspaceId: string) => Workspace | undefined;
  /** Model function for POST intake/refine; absent => 501. */
  refineModel?: (req: { system: string; prompt: string; taskHint?: string }) => Promise<{ text: string }>;
  /** Injected fetch for lookalike example reads (tests run offline). */
  fetchFn?: typeof fetch;
  now?: () => Date;
};

// ------------------------------------------------------------------ helpers

class IntakeError extends Error {}

function ok(json: unknown, status = 200): IntakeReply {
  return { status, json };
}

function fail(status: number, error: string): IntakeReply {
  return { status, json: { error } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The in-memory interview state per workspace. The interview is a live session
// shape; the frozen result is the Target Brief (persisted by intake.ts).
const intakeStates = new Map<string, IntakeState>();

// Injected fetch for the node adapter (the check configures one so it is offline).
let configuredFetchFn: typeof fetch | undefined;

/** Injects shared options for the node adapter. The check uses it to stay offline. */
export function configureIntake(options: { fetchFn?: typeof fetch } = {}): void {
  configuredFetchFn = options.fetchFn;
}

/** The workspace API key guard, identical in behaviour to server.ts. */
async function defaultGuard(ctx: IntakeRequestCtx, workspaceId: string): Promise<IntakeReply | null> {
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

/** Resolves a workspace, creating an id `default` one on first use. */
function defaultEnsureWorkspace(workspaceId: string): Workspace | undefined {
  const existing = getWorkspace(workspaceId);
  if (existing) return existing;
  if (workspaceId !== "default") return undefined;
  const now = new Date().toISOString();
  getDb()
    .prepare("INSERT OR IGNORE INTO workspaces (id, name, offer, icp, createdAt) VALUES (?, ?, ?, ?, ?)")
    .run(
      "default",
      "Default Workspace",
      JSON.stringify({ services: [], description: "" }),
      JSON.stringify({ categories: [], cities: [], countries: [] }),
      now,
    );
  return getWorkspace("default");
}

async function readObject(ctx: IntakeRequestCtx): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await ctx.readJson();
  } catch {
    throw new IntakeError("body must be valid JSON");
  }
  if (!isRecord(body)) throw new IntakeError("body must be a JSON object");
  return body;
}

function stateFor(workspaceId: string): IntakeState {
  let state = intakeStates.get(workspaceId);
  if (!state) {
    state = { workspaceId, answers: {} };
    intakeStates.set(workspaceId, state);
  }
  return state;
}

// ------------------------------------------------------------ registration

/**
 * Registers every intake/brief/lookalike/channels route with the given
 * `register(method, pattern, handler)`. Handlers share the workspace key guard
 * and never throw into the server (the adapter maps IntakeError to 400).
 */
export function registerIntakeRoutes(register: IntakeRegister, helpers: IntakeHelpers = {}): void {
  const authorize = helpers.guard ?? defaultGuard;
  const ensure = helpers.ensureWorkspace ?? defaultEnsureWorkspace;
  const fetchFn = helpers.fetchFn ?? configuredFetchFn;

  const missingWorkspace = (ws: string): IntakeReply | null => (ensure(ws) ? null : fail(404, "workspace not found"));

  const intakeView = (ws: string, state: IntakeState): IntakeReply =>
    ok({ workspaceId: ws, questions: nextQuestions(state), answers: state.answers, industry: state.industry });

  register("GET", "/api/workspaces/:ws/intake", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = missingWorkspace(ws);
    if (missing) return missing;
    const denied = await authorize(ctx, ws);
    if (denied) return denied;
    return intakeView(ws, stateFor(ws));
  });

  register("GET", "/api/workspaces/:ws/intake/next", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = missingWorkspace(ws);
    if (missing) return missing;
    const denied = await authorize(ctx, ws);
    if (denied) return denied;
    return intakeView(ws, stateFor(ws));
  });

  register("POST", "/api/workspaces/:ws/intake/answer", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = missingWorkspace(ws);
    if (missing) return missing;
    const denied = await authorize(ctx, ws);
    if (denied) return denied;
    const body = await readObject(ctx);
    const state = stateFor(ws);
    if (typeof body.id === "string") {
      state.answers[body.id] = body.value as string | number | string[];
    } else if (isRecord(body.answers)) {
      for (const [id, value] of Object.entries(body.answers)) {
        state.answers[id] = value as string | number | string[];
      }
    } else {
      throw new IntakeError("id or answers is required");
    }
    if (typeof body.industry === "string") state.industry = body.industry;
    return ok({ ok: true, workspaceId: ws, answers: state.answers, questions: nextQuestions(state) });
  });

  register("POST", "/api/workspaces/:ws/intake/refine", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = missingWorkspace(ws);
    if (missing) return missing;
    const denied = await authorize(ctx, ws);
    if (denied) return denied;
    const state = stateFor(ws);
    try {
      const body = await ctx.readJson();
      if (isRecord(body)) {
        if (isRecord(body.answers)) {
          for (const [id, value] of Object.entries(body.answers)) {
            state.answers[id] = value as string | number | string[];
          }
        }
        if (typeof body.industry === "string") state.industry = body.industry;
      }
    } catch {
      // body is optional for refine
    }
    const modelFn = helpers.refineModel;
    if (typeof modelFn !== "function") return fail(501, "model function is not available");
    const questions = await refineWithModel(state, modelFn);
    return ok({ workspaceId: ws, questions });
  });

  register("GET", "/api/workspaces/:ws/brief", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = missingWorkspace(ws);
    if (missing) return missing;
    const denied = await authorize(ctx, ws);
    if (denied) return denied;
    return ok({ workspaceId: ws, brief: loadBrief(ws) ?? null });
  });

  register("PUT", "/api/workspaces/:ws/brief", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = missingWorkspace(ws);
    if (missing) return missing;
    const denied = await authorize(ctx, ws);
    if (denied) return denied;
    const body = await readObject(ctx);
    const candidate = isRecord(body.brief) ? body.brief : body;
    const brief = candidate as unknown as TargetBrief;
    if (!isRecord(brief) || !Array.isArray(brief.sections) || !isRecord(brief.meta)) {
      throw new IntakeError("brief must have sections[] and meta");
    }
    saveBrief(ws, brief);
    return ok({ workspaceId: ws, brief });
  });

  register("POST", "/api/workspaces/:ws/brief/run", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = missingWorkspace(ws);
    if (missing) return missing;
    const denied = await authorize(ctx, ws);
    if (denied) return denied;
    const brief = loadBrief(ws);
    if (!brief) return fail(404, "brief not found");
    const compiled = briefToQueries(brief);
    const jobs = compiled.queries.map((q) => {
      // Extra keys ride along in the stored job query JSON (JobQuery has no
      // exclusions field and store.ts must not be edited); the pipeline reads
      // only category/city/country/limit.
      const query = {
        ...q,
        exclusions: compiled.exclusions,
        signalPriorities: compiled.signalPriorities,
        scoringWeights: compiled.scoringWeights,
      } as unknown as JobQuery;
      return createJob(ws, query);
    });
    return ok({ workspaceId: ws, jobs, queries: compiled.queries, exclusions: compiled.exclusions }, 201);
  });

  register("POST", "/api/workspaces/:ws/lookalike/profile", async (ctx) => {
    const ws = ctx.params.ws;
    const missing = missingWorkspace(ws);
    if (missing) return missing;
    const denied = await authorize(ctx, ws);
    if (denied) return denied;
    const body = await readObject(ctx);
    const examples = Array.isArray(body.examples) ? (body.examples as LookalikeExample[]) : [];
    let profile: LookalikeProfile;
    try {
      profile = await buildProfile(examples, { fetchFn });
    } catch (err) {
      throw new IntakeError(err instanceof Error ? err.message : String(err));
    }
    return ok({ workspaceId: ws, profile });
  });

  // Public, read-only: names, tier, enabled flag and reason plus the browser
  // reader status. Never values, tokens or cookies. 501 when the module is missing.
  register("GET", "/api/channels/status", async () => {
    let registry: typeof import("./channels/registry.js");
    try {
      await import("./channels/index.js");
      registry = await import("./channels/registry.js");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(501, `channels module is not available (./channels/registry.js): ${message}`);
    }
    const channels = registry.channelAdapters().map((adapter) => {
      const status = adapter.status();
      return {
        id: adapter.id,
        name: adapter.name,
        tier: adapter.tier,
        enabled: status.enabled,
        reason: status.why ?? null,
      };
    });
    let browser: unknown = null;
    try {
      const { BrowserReader } = await import("./channels/browser.js");
      const status = new BrowserReader().status();
      browser = {
        enabled: status.enabled,
        killSwitch: status.killSwitch,
        caps: status.caps,
        usedThisHour: status.usedThisHour,
        lockedPlatforms: status.lockedPlatforms,
        backends: {
          opencli: { ok: status.backends.opencli.ok, why: status.backends.opencli.why ?? null },
          cdp: { ok: status.backends.cdp.ok, why: status.backends.cdp.why ?? null },
        },
      };
    } catch {
      browser = null;
    }
    return ok({ channels, browser });
  });
}

// ----------------------------------------------------------------- node:http

function safeHandler(handler: IntakeHandler): IntakeHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof IntakeError) return fail(400, err.message);
      const message = err instanceof Error && err.message ? err.message : String(err);
      return fail(500, message);
    }
  };
}

type CompiledRoute = { method: string; re: RegExp; keys: string[]; handler: IntakeHandler };

function compileRoutes(helpers: IntakeHelpers): CompiledRoute[] {
  const routes: CompiledRoute[] = [];
  registerIntakeRoutes((method, pattern, handler) => {
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

function sendReply(res: ServerResponse, reply: IntakeReply, sendJson?: (res: ServerResponse, status: number, body: unknown) => void): void {
  if (reply.text !== undefined) {
    const payload = reply.text;
    res.writeHead(reply.status, {
      ...(reply.headers ?? {}),
      "content-type": reply.contentType ?? "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(payload)),
    });
    res.end(payload);
    return;
  }
  if (sendJson) {
    sendJson(res, reply.status, reply.json ?? null);
    return;
  }
  const payload = JSON.stringify(reply.json ?? null);
  res.writeHead(reply.status, {
    ...(reply.headers ?? {}),
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

async function defaultReadJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  return JSON.parse(text) as unknown;
}

/**
 * node:http adapter used by the single server.ts hook: matches an intake route
 * and sends its reply, returning true when one handled the request. Returns
 * false (and writes nothing) when the path is not an intake route.
 */
export async function handleIntakeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  overrides: IntakeHelpers = {},
): Promise<boolean> {
  const helpers: IntakeHelpers = { ...overrides, fetchFn: overrides.fetchFn ?? configuredFetchFn };
  const method = req.method ?? "GET";
  for (const route of compileRoutes(helpers)) {
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
    const ctx: IntakeRequestCtx = {
      method,
      params,
      query: url.searchParams,
      header: (name) => {
        const value = req.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
      },
      readJson: async () => (helpers.readJson ? helpers.readJson(req) : defaultReadJson(req)),
    };
    const reply = await route.handler(ctx);
    sendReply(res, reply, helpers.sendJson);
    return true;
  }
  return false;
}
