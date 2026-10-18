// src/discover-resilience-check.ts
// Offline proof for ORDER DISC1-discovery-resilience. Fake fetch only, no network, no DB.
// Run: npx tsx src/discover-resilience-check.ts

import {
  DEFAULT_OVERPASS_URLS,
  OVERPASS_BACKOFF_MS,
  OVERPASS_BUSY_MESSAGE,
  OverpassUnavailableError,
  fetchOverpassWithFailover,
  orderOverpassUrls,
  overpassUserAgent,
  resetOverpassFailures,
  resolveOverpassUrls,
} from "./discover.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  :: ${detail}` : ""}`);
  }
}

function checkEq(name: string, actual: unknown, expected: unknown): void {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// ---------------------------------------------------------------- fake fetch

type FakeResponse = { status: number; ok: boolean; json: () => Promise<unknown> };

function res(status: number, body: unknown): FakeResponse {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

type Call = { url: string; init?: RequestInit };

function makeFetch(handler: (url: string, callIndex: number) => FakeResponse): {
  fn: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, calls.length - 1) as unknown as Response;
  }) as typeof fetch;
  return { fn, calls };
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([k]) => k === name)?.[1];
  return (headers as Record<string, string>)[name];
}

function sleepRecorder(): { fn: (ms: number) => Promise<void>; sleeps: number[] } {
  const sleeps: number[] = [];
  return { fn: async (ms: number) => { sleeps.push(ms); }, sleeps };
}

// ---------------------------------------------------------------- fixtures (clearly fake)

const ELEMENTS_B = [
  { type: "node", id: 1, lat: 0, lon: 0, tags: { name: "Fake Resilient Dental" } },
];

const A = "https://a.example/api/interpreter";
const B = "https://b.example/api/interpreter";
const C = "https://c.example/api/interpreter";

// Isolate from any ambient env override for the deterministic mirror lists below.
const savedEnv = process.env.LEADSCOUT_OVERPASS_URLS;
delete process.env.LEADSCOUT_OVERPASS_URLS;

// ---------------------------------------------------------------- 1. first mirror 504, second 200

{
  resetOverpassFailures();
  const f = makeFetch((url) => {
    if (url === A) return res(504, {});
    if (url === B) return res(200, { elements: ELEMENTS_B });
    return res(500, {});
  });
  const sleep = sleepRecorder();
  const result = await fetchOverpassWithFailover("dummy", {
    fetchFn: f.fn,
    sleepFn: sleep.fn,
    overpassUrls: [A, B],
  });
  checkEq("first mirror 504, second 200 -> second mirror's data", result.elements, ELEMENTS_B);
  checkEq("first mirror 504, second 200 -> sourceUrl is the second mirror", result.sourceUrl, B);
}

// ------------------------------------- 2. round 1 all fail, third mirror answers in round 2

{
  resetOverpassFailures();
  let cHits = 0;
  const f = makeFetch((url) => {
    if (url === C) {
      cHits++;
      return cHits >= 2 ? res(200, { elements: ELEMENTS_B }) : res(500, {});
    }
    return res(500, {});
  });
  const sleep = sleepRecorder();
  const result = await fetchOverpassWithFailover("dummy", {
    fetchFn: f.fn,
    sleepFn: sleep.fn,
    overpassUrls: [A, B, C],
  });
  checkEq("round 1 all fail, third mirror answers in round 2 -> data", result.elements, ELEMENTS_B);
  checkEq("round 1 all fail, third mirror answers in round 2 -> sourceUrl is the third mirror", result.sourceUrl, C);
  check("round 1 all fail, third mirror answers in round 2 -> waited after round 1",
    sleep.sleeps.includes(2000), JSON.stringify(sleep.sleeps));
}

// ---------------------------------------------------------------- 3. all mirrors fail -> plain message + detail

{
  resetOverpassFailures();
  const f = makeFetch(() => res(500, {}));
  const sleep = sleepRecorder();
  let thrown: unknown;
  try {
    await fetchOverpassWithFailover("dummy", {
      fetchFn: f.fn,
      sleepFn: sleep.fn,
      overpassUrls: [A, B],
    });
  } catch (err) {
    thrown = err;
  }
  const err = thrown as OverpassUnavailableError;
  check("all mirrors fail -> throws OverpassUnavailableError", err instanceof OverpassUnavailableError);
  checkEq("all mirrors fail -> plain user message in `message`", err?.message, OVERPASS_BUSY_MESSAGE);
  check("all mirrors fail -> main message has no URL stack", !/https?:\/\//.test(String(err?.message ?? "")));
  check(
    "all mirrors fail -> technical detail in `detail`",
    /HTTP 500/.test(String(err?.detail ?? "")) && String(err?.detail).includes(A) && String(err?.detail).includes(B),
    String(err?.detail ?? ""),
  );
  check("rounds grow 2000ms then 5000ms", sleep.sleeps.includes(2000) && sleep.sleeps.includes(5000), JSON.stringify(sleep.sleeps));
}

// ---------------------------------------------------------------- 4. headers on every Overpass request

{
  resetOverpassFailures();
  const f = makeFetch((url) => (url === A ? res(504, {}) : res(200, { elements: ELEMENTS_B })));
  const sleep = sleepRecorder();
  await fetchOverpassWithFailover("dummy", { fetchFn: f.fn, sleepFn: sleep.fn, overpassUrls: [A, B] });
  const everyHasHeaders =
    f.calls.length > 0 &&
    f.calls.every((c) => {
      const ua = headerValue(c.init, "User-Agent");
      return (
        typeof ua === "string" &&
        ua.startsWith("Leadscout/1.0 (+") &&
        headerValue(c.init, "Accept") === "application/json" &&
        headerValue(c.init, "Content-Type") === "application/x-www-form-urlencoded"
      );
    });
  check("every Overpass request carries descriptive User-Agent, Accept, Content-Type", everyHasHeaders,
    JSON.stringify(f.calls.map((c) => ({ ua: headerValue(c.init, "User-Agent"), accept: headerValue(c.init, "Accept") }))));
  check("User-Agent default contact is local", overpassUserAgent().includes("local"), overpassUserAgent());
}

// ---------------------------------------------------------------- 5. recently failed mirror is tried last next search

{
  resetOverpassFailures();
  const first = makeFetch((url) => (url === A ? res(504, {}) : res(200, { elements: ELEMENTS_B })));
  const firstSleep = sleepRecorder();
  const r1 = await fetchOverpassWithFailover("dummy", { fetchFn: first.fn, sleepFn: firstSleep.fn, overpassUrls: [A, B] });
  checkEq("search 1 succeeds on mirror B", r1.sourceUrl, B);

  const ordered = orderOverpassUrls([A, B], Date.now());
  checkEq("recently failed A sorts after healthy B", ordered, [B, A]);

  const second = makeFetch((url) => (url === B ? res(500, {}) : res(200, { elements: ELEMENTS_B })));
  const secondSleep = sleepRecorder();
  const r2 = await fetchOverpassWithFailover("dummy", { fetchFn: second.fn, sleepFn: secondSleep.fn, overpassUrls: [A, B] });
  checkEq("search 2 tries healthy mirror B before recently-failed A", second.calls[0]?.url, B);
  checkEq("search 2 falls through to A", second.calls[1]?.url, A);
  checkEq("search 2 succeeds on A (previously failed, now last)", r2.sourceUrl, A);
}

// ---------------------------------------------------------------- 6. env list overrides the default list

{
  resetOverpassFailures();
  const X = "https://x.example/api/interpreter";
  const Y = "https://y.example/api/interpreter";
  const prev = process.env.LEADSCOUT_OVERPASS_URLS;
  process.env.LEADSCOUT_OVERPASS_URLS = `${X}, ${Y}`;
  try {
    checkEq("resolveOverpassUrls uses env list", resolveOverpassUrls(), [X, Y]);
    check("env list differs from defaults", !DEFAULT_OVERPASS_URLS.includes(X));
    const f = makeFetch(() => res(200, { elements: ELEMENTS_B }));
    const sleep = sleepRecorder();
    const r = await fetchOverpassWithFailover("dummy", { fetchFn: f.fn, sleepFn: sleep.fn });
    checkEq("search uses env mirror first", f.calls[0]?.url, X);
    checkEq("search returns env mirror data", r.sourceUrl, X);
  } finally {
    if (prev === undefined) delete process.env.LEADSCOUT_OVERPASS_URLS;
    else process.env.LEADSCOUT_OVERPASS_URLS = prev;
  }
}

// ---------------------------------------------------------------- 7. default list + backoff schedule

{
  check("default mirror list includes the three added mirrors",
    DEFAULT_OVERPASS_URLS.includes("https://overpass.kumi.systems/api/interpreter") &&
    DEFAULT_OVERPASS_URLS.includes("https://lz4.overpass-api.de/api/interpreter") &&
    DEFAULT_OVERPASS_URLS.includes("https://z.overpass-api.de/api/interpreter"),
    JSON.stringify(DEFAULT_OVERPASS_URLS));
  checkEq("backoff schedule is 2s/5s/12s", OVERPASS_BACKOFF_MS, [2000, 5000, 12000]);
}

if (savedEnv === undefined) delete process.env.LEADSCOUT_OVERPASS_URLS;
else process.env.LEADSCOUT_OVERPASS_URLS = savedEnv;

console.log("");
console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
