// Reference LLM adapter: a ~100 line HTTP server that turns Leadscout's tiny LLM contract into a call
// to the provider of your choice, using YOUR key. Leadscout never sees the provider key.
//
//   Leadscout  --POST /chat {prompt, system, taskHint}-->  this adapter  --provider API-->  OpenAI / Anthropic / ...
//   Leadscout  <--{answer, usage, model}-----------------  this adapter  <--------------
//
// Run:      npm run llm-adapter            (then set LEADSCOUT_LLM_URL=http://127.0.0.1:8787/chat in .env)
// Provider: LLM_PROVIDER=openai (default, any OpenAI-compatible API: OpenAI, OpenRouter, DeepSeek, Ollama, vLLM...)
//           LLM_PROVIDER=anthropic
// Env:      see .env.example, section "LLM adapter".
//
// Exported helpers are pure so adapters/llm-adapter-check.ts can test them without a network.
import { createServer } from "node:http";

export type ChatRequest = { prompt: string; system?: string; taskHint?: string };
export type ChatReply = {
  answer: string;
  usage?: { input_tokens: number; output_tokens: number };
  model?: string;
};

export type AdapterConfig = {
  provider: "openai" | "anthropic";
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const provider = String(env.LLM_PROVIDER ?? "openai").toLowerCase() === "anthropic" ? "anthropic" : "openai";
  return provider === "anthropic"
    ? {
        provider,
        model: env.LLM_MODEL || "claude-haiku-5-5",
        baseUrl: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
        apiKey: env.ANTHROPIC_API_KEY || "",
        maxTokens: Number(env.LLM_MAX_TOKENS) || 1024,
      }
    : {
        provider,
        model: env.LLM_MODEL || "gpt-4o-mini",
        baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        apiKey: env.OPENAI_API_KEY || "",
        maxTokens: Number(env.LLM_MAX_TOKENS) || 1024,
      };
}

/** Build the provider HTTP request (url + init) for one chat call. */
export function buildRequest(cfg: AdapterConfig, req: ChatRequest): { url: string; init: RequestInit } {
  if (cfg.provider === "anthropic") {
    return {
      url: `${cfg.baseUrl.replace(/\/$/, "")}/v1/messages`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: cfg.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          messages: [{ role: "user", content: req.prompt }],
        }),
      },
    };
  }
  return {
    url: `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        messages: [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }],
      }),
    },
  };
}

/** Turn the provider's JSON back into Leadscout's reply shape. */
export function parseReply(cfg: AdapterConfig, body: any): ChatReply {
  if (cfg.provider === "anthropic") {
    const text = Array.isArray(body?.content) ? body.content.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : "";
    return {
      answer: text,
      model: body?.model,
      ...(body?.usage ? { usage: { input_tokens: body.usage.input_tokens ?? 0, output_tokens: body.usage.output_tokens ?? 0 } } : {}),
    };
  }
  return {
    answer: String(body?.choices?.[0]?.message?.content ?? ""),
    model: body?.model,
    ...(body?.usage ? { usage: { input_tokens: body.usage.prompt_tokens ?? 0, output_tokens: body.usage.completion_tokens ?? 0 } } : {}),
  };
}

export async function chat(cfg: AdapterConfig, req: ChatRequest, fetchFn: typeof fetch = fetch): Promise<ChatReply> {
  if (!cfg.apiKey) throw new Error(`no API key set for provider "${cfg.provider}" (see .env.example)`);
  const { url, init } = buildRequest(cfg, req);
  const res = await fetchFn(url, init);
  if (!res.ok) throw new Error(`${cfg.provider} returned HTTP ${res.status}`);
  return parseReply(cfg, await res.json());
}

function main(): void {
  const cfg = configFromEnv();
  const port = Number(process.env.LLM_ADAPTER_PORT) || 8787;
  const token = process.env.LLM_ADAPTER_TOKEN || "";
  const server = createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, provider: cfg.provider, model: cfg.model });
    if (req.method !== "POST" || req.url !== "/chat") return send(404, { error: "POST /chat only" });
    if (token && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "bad token" });
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) return send(413, { error: "body too large" });
    }
    try {
      const body = JSON.parse(raw) as ChatRequest;
      if (typeof body.prompt !== "string") return send(400, { error: "prompt (string) is required" });
      send(200, await chat(cfg, body));
    } catch (err) {
      send(502, { error: (err as Error).message });
    }
  });
  // Loopback only: this process holds your provider key.
  server.listen(port, "127.0.0.1", () => console.log(`llm-adapter: ${cfg.provider}/${cfg.model} on http://127.0.0.1:${port}/chat`));
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) main();
