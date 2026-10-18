// Offline check for the reference LLM adapter and for src/llm.ts URL handling.
// Run: npx tsx adapters/llm-adapter-check.ts
import assert from "node:assert/strict";
import { buildRequest, chat, configFromEnv, parseReply } from "./llm-adapter.js";
import { defaultLlm, llmUrl, DEFAULT_LLM_URL } from "../src/llm.js";

// --- OpenAI-compatible
const oa = configFromEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://x.example/v1/" });
const oaReq = buildRequest(oa, { prompt: "hi", system: "be brief" });
assert.equal(oaReq.url, "https://x.example/v1/chat/completions");
assert.equal((JSON.parse(String(oaReq.init.body)).messages as unknown[]).length, 2);
const oaReply = parseReply(oa, { model: "m", choices: [{ message: { content: "yo" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
assert.deepEqual(oaReply, { answer: "yo", model: "m", usage: { input_tokens: 3, output_tokens: 2 } });

// --- Anthropic
const an = configFromEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" });
const anReq = buildRequest(an, { prompt: "hi", system: "be brief" });
assert.equal(anReq.url, "https://api.anthropic.com/v1/messages");
assert.equal(JSON.parse(String(anReq.init.body)).system, "be brief");
const anReply = parseReply(an, { model: "m", content: [{ type: "text", text: "yo" }], usage: { input_tokens: 4, output_tokens: 1 } });
assert.deepEqual(anReply, { answer: "yo", model: "m", usage: { input_tokens: 4, output_tokens: 1 } });

// --- chat() with a fake fetch, and the missing-key guard
const fake = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })) as typeof fetch;
assert.equal((await chat(oa, { prompt: "p" }, fake)).answer, "ok");
await assert.rejects(() => chat(configFromEnv({}), { prompt: "p" }, fake), /no API key/);

// --- src/llm.ts: URL comes from LEADSCOUT_LLM_URL, falls back to the default, token is sent
assert.equal(llmUrl({}), DEFAULT_LLM_URL);
process.env.LEADSCOUT_LLM_URL = "http://llm.example/chat";
process.env.LEADSCOUT_LLM_TOKEN = "t0k";
let seen: { url: string; auth?: string } | undefined;
const spy = (async (url: string, init: RequestInit) => {
  seen = { url, auth: (init.headers as Record<string, string>).authorization };
  return new Response(JSON.stringify({ answer: "pong", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
}) as unknown as typeof fetch;
const out = await defaultLlm({ system: "s", prompt: "p" }, { fetchFn: spy });
assert.equal(out.text, "pong");
assert.deepEqual(seen, { url: "http://llm.example/chat", auth: "Bearer t0k" });

console.log("PASS llm-adapter-check");
