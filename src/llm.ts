// src/llm.ts
// The ONLY place Leadscout talks to a language model. It is used just to "polish" dossiers;
// everything else (discovery, scoring, evidence, call sheets) works without any model.
//
// Contract (any server that speaks this works, see adapters/llm-adapter.ts for a ready-made one):
//   POST ${LEADSCOUT_LLM_URL}                       default http://127.0.0.1:8787/chat
//   headers: content-type: application/json         (+ Authorization: Bearer ${LEADSCOUT_LLM_TOKEN} when set)
//   body:    { "prompt": string, "system": string, "taskHint"?: string }
//   reply:   { "answer": string, "usage"?: { input_tokens, output_tokens } | { prompt_tokens, completion_tokens }, "model"?: string }
//
// Turn the model off entirely with LEADSCOUT_LLM_OFF=1 (template dossiers only).
// No real network happens unless the caller provides fetchFn or the global fetch is used.

import type { LlmFn } from "./types-v2.js";

export const DEFAULT_LLM_URL = "http://127.0.0.1:8787/chat";
const DEFAULT_TIMEOUT_MS = 60000;

/** Resolved on every call so tests and operators can change the env without a restart. */
export function llmUrl(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.LEADSCOUT_LLM_URL ?? "").trim() || DEFAULT_LLM_URL;
}

function llmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LEADSCOUT_LLM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

type RouterUsage =
  | { input_tokens?: number; output_tokens?: number }
  | { prompt_tokens?: number; completion_tokens?: number }
  | null
  | undefined;

type RouterResponse = {
  answer?: string;
  usage?: RouterUsage;
};

type LlmResult = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model?: string;
  estimated?: boolean;
};

function parseUsage(usage: RouterUsage): { inTokens: number; outTokens: number } | null {
  if (!usage || typeof usage !== "object") return null;
  if ("input_tokens" in usage && typeof usage.input_tokens === "number") {
    return {
      inTokens: usage.input_tokens,
      outTokens:
        "output_tokens" in usage && typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : 0,
    };
  }
  if ("prompt_tokens" in usage && typeof usage.prompt_tokens === "number") {
    return {
      inTokens: usage.prompt_tokens,
      outTokens:
        "completion_tokens" in usage && typeof usage.completion_tokens === "number"
          ? usage.completion_tokens
          : 0,
    };
  }
  return null;
}

async function callRouter(
  fetchFn: typeof fetch,
  req: { system: string; prompt: string; taskHint?: string }
): Promise<RouterResponse & { model?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), llmTimeoutMs());

  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = String(process.env.LEADSCOUT_LLM_TOKEN ?? "").trim();
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetchFn(llmUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: req.prompt,
        system: req.system,
        taskHint: req.taskHint,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`llm endpoint returned ${res.status}`);
  }

  return (await res.json()) as RouterResponse & { model?: string };
}

function estimateTokens(req: { system: string; prompt: string }, text: string): LlmResult {
  const promptChars = req.system.length + req.prompt.length;
  return {
    text,
    tokensIn: Math.ceil(promptChars / 4),
    tokensOut: Math.ceil(text.length / 4),
    estimated: true,
  };
}

/** Factory that returns a LlmFn using the supplied fetch implementation. */
export function makeDefaultLlm(fetchFn?: typeof fetch): LlmFn {
  const fetcher = fetchFn ?? globalThis.fetch;

  return async function defaultLlmFn(req) {
    const body = await callRouter(fetcher, req);
    const text = typeof body.answer === "string" ? body.answer : "";
    const usage = parseUsage(body.usage);

    if (usage) {
      return {
        text,
        tokensIn: usage.inTokens,
        tokensOut: usage.outTokens,
        model: body.model,
        estimated: false,
      };
    }

    return estimateTokens(req, text);
  };
}

/**
 * Default LLM instance. Accepts an optional second argument with an injectable
 * fetchFn so tests and callers can avoid real network traffic.
 */
export async function defaultLlm(
  req: { system: string; prompt: string; taskHint?: string },
  opts?: { fetchFn?: typeof fetch }
): Promise<LlmResult> {
  const fetcher = opts?.fetchFn ?? globalThis.fetch;
  const body = await callRouter(fetcher, req);
  const text = typeof body.answer === "string" ? body.answer : "";
  const usage = parseUsage(body.usage);

  if (usage) {
    return {
      text,
      tokensIn: usage.inTokens,
      tokensOut: usage.outTokens,
      model: body.model,
      estimated: false,
    };
  }

  return estimateTokens(req, text);
}
