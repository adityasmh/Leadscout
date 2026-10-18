// Proof harness for L9 explainer.ts. Fake LLM only; temp database; no network.

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmFn } from "./types-v2.js";

const tmpDir = mkdtempSync(join(tmpdir(), "leadscout-explainer-check-"));
process.env.LEADSCOUT_DB = join(tmpDir, "test.db");

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "fixtures-v2", "explainer");

const { getExplainer, markReviewed, listExplainers, EXPLAINER_PROMPT_VERSION } = await import("./explainer.js");
const { closeDb } = await import("./store.js");

const checks: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string): boolean {
  checks.push({ name, ok: condition, detail });
  const status = condition ? "PASS" : "FAIL";
  console.log(`${status}: ${name}${detail ? ` (${detail})` : ""}`);
  return condition;
}

function fail(name: string, detail: string): boolean {
  return check(name, false, detail);
}

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

function makeLlm(text: string | (() => string)) {
  let calls = 0;
  let lastPrompt = "";
  const llm: LlmFn = async (req) => {
    calls += 1;
    lastPrompt = req.prompt;
    const answer = typeof text === "function" ? text() : text;
    return {
      text: answer,
      tokensIn: Math.ceil(req.prompt.length / 4),
      tokensOut: Math.ceil(answer.length / 4),
      model: "fake-llm",
    };
  };
  return {
    llm,
    get calls() { return calls; },
    get lastPrompt() { return lastPrompt; },
  };
}

let firstFake = makeLlm(readFixture("sample-valid.json"));
let savedRowId = "";

// 1. First call generates and saves a row.
{
  const before = listExplainers().length;
  const result = await getExplainer("demo-category", "FA", { llm: firstFake.llm, allowGenerate: true });
  const after = listExplainers().length;
  check("first-call-saves", result !== null && after === before + 1, `rows=${after}`);
  if (result) savedRowId = result.id;
  check("first-call-one-llm", firstFake.calls === 1, `calls=${firstFake.calls}`);
  check("first-call-prompt-under-budget", firstFake.lastPrompt.length < 3200, `chars=${firstFake.lastPrompt.length}`);
}

// 2. Second call for the same key makes zero LLM calls and returns the same row.
{
  const result2 = await getExplainer("demo-category", "FA", { llm: firstFake.llm, allowGenerate: true });
  check("second-call-cached", result2 !== null && result2.id === savedRowId, `id=${result2?.id ?? "null"}`);
  check("second-call-zero-llm", firstFake.calls === 1, `calls=${firstFake.calls}`);
}

// 3. A different country produces a new row.
{
  const other = await getExplainer("demo-category", "FB", { llm: firstFake.llm, allowGenerate: true });
  check("different-country-new-row", other !== null && other.id !== savedRowId, `id=${other?.id ?? "null"}`);
  check("different-country-extra-row", listExplainers().length === 2, `rows=${listExplainers().length}`);
  check("different-country-one-more-llm", firstFake.calls === 2, `calls=${firstFake.calls}`);
}

// 4. Invalid answers are refused, nothing is saved, exactly one LLM call each.
const invalidCases = [
  { name: "digit", fixture: "bad-digit.json", key: ["bad-digit", "FA"] },
  { name: "unknown-service", fixture: "bad-service.json", key: ["bad-service", "FA"] },
  { name: "business-name", fixture: "bad-name.json", key: ["bad-name", "FA"] },
  { name: "too-many-bullets", fixture: "bad-too-many.json", key: ["bad-too-many", "FA"] },
] as const;

for (const { name, fixture, key } of invalidCases) {
  const fake = makeLlm(readFixture(fixture));
  const before = listExplainers().length;
  const result = await getExplainer(key[0], key[1], { llm: fake.llm, allowGenerate: true });
  const after = listExplainers().length;
  check(`invalid-${name}-refused`, result === null, `result=${result}`);
  check(`invalid-${name}-no-save`, after === before, `rows=${after}`);
  check(`invalid-${name}-one-llm`, fake.calls === 1, `calls=${fake.calls}`);
}

// 5. allowGenerate: false returns null with zero calls.
{
  const fake = makeLlm(readFixture("sample-valid.json"));
  const result = await getExplainer("no-generate", "FA", { llm: fake.llm, allowGenerate: false });
  check("allowGenerate-false-null", result === null, `result=${result}`);
  check("allowGenerate-false-zero-llm", fake.calls === 0, `calls=${fake.calls}`);
}

// 6. markReviewed sets the review flag; unknown id is a no-op.
{
  const ok = markReviewed(savedRowId);
  const reviewed = await getExplainer("demo-category", "FA", { allowGenerate: false });
  check("markReviewed-known", ok === true && reviewed?.reviewed === true, `reviewed=${reviewed?.reviewed}`);
  const unknown = markReviewed("00000000-0000-0000-0000-000000000000");
  check("markReviewed-unknown-noop", unknown === false, `returned=${unknown}`);
}

// 7. Prompt stays under 3,200 characters (already captured in case 1).
check("prompt-under-3200", firstFake.lastPrompt.length < 3200, `chars=${firstFake.lastPrompt.length}`);

// 8. Default-llm path when the default adapter is unavailable returns null and does not throw.
// The module ./llm.js exists in this checkout, so we make the default fetcher fail to simulate
// an unavailable default llm; the function must catch the error and return null.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("router unreachable in harness");
  };
  let threw = false;
  let result: Awaited<ReturnType<typeof getExplainer>> = null;
  try {
    result = await getExplainer("default-unavailable", "FA", { allowGenerate: true });
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = originalFetch;
  }
  check("default-llm-unavailable-null", result === null, `result=${result}`);
  check("default-llm-unavailable-no-throw", threw === false, `threw=${threw}`);
}

// Sanity: listExplainers on a non-empty table returns rows; EXPLAINER_PROMPT_VERSION is exported.
check("prompt-version-exported", typeof EXPLAINER_PROMPT_VERSION === "string" && EXPLAINER_PROMPT_VERSION.length > 0, EXPLAINER_PROMPT_VERSION);
check("listExplainers-returns-rows", listExplainers().length === 2, `rows=${listExplainers().length}`);

closeDb();
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup failures */ }

const failures = checks.filter((c) => !c.ok);
const overall = failures.length === 0 ? "PASS" : "FAIL";
console.log(`\n${overall}: ${checks.length - failures.length}/${checks.length} checks passed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail ?? ""}`);
  process.exit(1);
}
