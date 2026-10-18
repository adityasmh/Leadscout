// src/fc-reader-check.ts
// ORDER_FC1 offline proof for the Firecrawl fallback reader. Fake page fetches and a fake
// Firecrawl endpoint serve every call; the cache and budget live in temp folders. No network.
//
// Run once: npx tsx src/fc-reader-check.ts

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFirecrawl } from "./fc-reader.js";

const KEY = "FAKEKEY_fc1_offline_000";

let passCount = 0;
let failCount = 0;
function check(name: string, ok: boolean): void {
  if (ok) {
    passCount++;
    console.log("PASS " + name);
  } else {
    failCount++;
    console.log("FAIL " + name);
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fc-reader-check-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function futureIso(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

function htmlWithVisible(chars: number): string {
  return `<html><head><style>body{color:red}</style><script>var x=1;</script></head><body>${"word ".repeat(chars)}</body></html>`;
}

function enabledEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { LEADSCOUT_FIRECRAWL: "1", FIRECRAWL_API_KEY: KEY, ...extra };
}

type FirecrawlFake = {
  fn: typeof fetch;
  counter: { scrape: number; usage: number };
};

function makeFirecrawlFetch(opts: {
  remaining?: number;
  periodEnd?: string;
  scrapeStatus?: number;
  scrapeThrow?: boolean;
  markdown?: string;
} = {}): FirecrawlFake {
  const counter = { scrape: 0, usage: 0 };
  const fn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/v1/team/credit-usage")) {
      counter.usage++;
      return jsonResponse({
        data: {
          remaining_credits: opts.remaining ?? 1000,
          billing_period_end: opts.periodEnd ?? futureIso(),
        },
      });
    }
    if (url.includes("/v1/scrape")) {
      counter.scrape++;
      if (opts.scrapeThrow) throw new Error("fake firecrawl network failure");
      if ((opts.scrapeStatus ?? 200) >= 400) return new Response("fake error", { status: opts.scrapeStatus });
      return jsonResponse({ success: true, data: { markdown: opts.markdown ?? "# Fake Clinic\n\nFake markdown body." } });
    }
    return new Response("unexpected", { status: 404 });
  };
  return { fn, counter };
}

function pageFetch(html: string, status = 200): typeof fetch {
  return async () => new Response(html, { status, headers: { "content-type": "text/html" } });
}

async function main(): Promise<void> {
  const returnedBodies: string[] = [];

  // 1. Off by default: no env, or env without the key, returns the very same function.
  {
    const base: typeof fetch = async () => new Response("ok");
    const noEnv = withFirecrawl(base, { env: {} });
    const noKey = withFirecrawl(base, { env: { LEADSCOUT_FIRECRAWL: "1" } });
    check("off by default (no env) returns same function object", noEnv === base);
    check("off when FIRECRAWL_API_KEY missing returns same function object", noKey === base);
  }

  // 2. Thin page -> exactly one paid call, returns synthetic markdown html.
  {
    const dir = tempDir();
    const cache = join(dir, "cache");
    const budget = join(dir, "budget.json");
    const { fn, counter } = makeFirecrawlFetch({ markdown: "# Fake Clinic\n\nFake markdown body." });
    const wrapped = withFirecrawl(pageFetch(htmlWithVisible(50)), {
      fetchFn: fn,
      cacheDir: cache,
      budgetFile: budget,
      env: enabledEnv({ FIRECRAWL_DAILY_CAP: "10" }),
    });
    const res = await wrapped("https://fake-clinic-a.example/");
    const body = await res.text();
    returnedBodies.push(body);
    check("thin page triggers exactly one paid call", counter.scrape === 1);
    check(
      "thin page returns markdown as status-200 text/html",
      res.status === 200 && body.includes("Fake markdown body") && (res.headers.get("content-type") ?? "").includes("text/html")
    );

    const files = readdirSync(cache);
    check("paid result cached at one sha1 file", files.length === 1 && files[0].endsWith(".json"));
    cleanup(dir);
  }

  // 3. Healthy page -> zero paid calls, original response untouched.
  {
    const dir = tempDir();
    const { fn, counter } = makeFirecrawlFetch();
    const html = htmlWithVisible(600);
    const wrapped = withFirecrawl(pageFetch(html), {
      fetchFn: fn,
      cacheDir: join(dir, "cache"),
      budgetFile: join(dir, "budget.json"),
      env: enabledEnv({ FIRECRAWL_DAILY_CAP: "10" }),
    });
    const res = await wrapped("https://fake-clinic-b.example/");
    const body = await res.text();
    returnedBodies.push(body);
    check("healthy page triggers no paid call", counter.scrape === 0);
    check("healthy page returns the original response unchanged", body === html);
    cleanup(dir);
  }

  // 4. Same page twice -> one paid call total (cache hit).
  {
    const dir = tempDir();
    const { fn, counter } = makeFirecrawlFetch({ markdown: "CACHED_MARKDOWN" });
    const wrapped = withFirecrawl(pageFetch(htmlWithVisible(50)), {
      fetchFn: fn,
      cacheDir: join(dir, "cache"),
      budgetFile: join(dir, "budget.json"),
      env: enabledEnv({ FIRECRAWL_DAILY_CAP: "10" }),
    });
    const first = await (await wrapped("https://fake-clinic-c.example/")).text();
    const second = await (await wrapped("https://fake-clinic-c.example/")).text();
    returnedBodies.push(first, second);
    check("same page twice costs exactly one paid call (cache)", counter.scrape === 1);
    check("second read served from cache", first.includes("CACHED_MARKDOWN") && second.includes("CACHED_MARKDOWN"));
    cleanup(dir);
  }

  // 5. HTTP 403 triggers a paid call; HTTP 404 does not.
  {
    const dir = tempDir();
    const { fn, counter } = makeFirecrawlFetch({ markdown: "BLOCKED_MARKDOWN" });
    const wrapped = withFirecrawl(
      (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("clinic-d")) return new Response(htmlWithVisible(600), { status: 403 });
        return new Response(htmlWithVisible(50), { status: 404 });
      }) as typeof fetch,
      { fetchFn: fn, cacheDir: join(dir, "cache"), budgetFile: join(dir, "budget.json"), env: enabledEnv({ FIRECRAWL_DAILY_CAP: "10" }) }
    );
    const blocked = await wrapped("https://fake-clinic-d.example/");
    const blockedBody = await blocked.text();
    returnedBodies.push(blockedBody);
    check("HTTP 403 triggers one paid call", counter.scrape === 1);
    check("HTTP 403 returns the markdown", blockedBody.includes("BLOCKED_MARKDOWN"));

    const notFound = await wrapped("https://fake-clinic-e.example/");
    const notFoundStatus = notFound.status;
    check("HTTP 404 triggers no paid call even when thin", counter.scrape === 1);
    check("HTTP 404 returns the original 404 response", notFoundStatus === 404);
    cleanup(dir);
  }

  // 6. Social and directory hosts never trigger a paid call.
  {
    const dir = tempDir();
    const { fn, counter } = makeFirecrawlFetch();
    const wrapped = withFirecrawl(pageFetch(htmlWithVisible(50)), {
      fetchFn: fn,
      cacheDir: join(dir, "cache"),
      budgetFile: join(dir, "budget.json"),
      env: enabledEnv({ FIRECRAWL_DAILY_CAP: "10" }),
    });
    for (const url of [
      "https://www.facebook.com/",
      "https://www.instagram.com/",
      "https://www.justdial.com/",
      "https://www.practo.com/",
      "https://www.youtube.com/",
      "https://www.linkedin.com/",
      "https://www.google.com/",
    ]) {
      const body = await (await wrapped(url)).text();
      returnedBodies.push(body);
    }
    check("social and directory hosts never trigger a paid call", counter.scrape === 0);
    cleanup(dir);
  }

  // 7a. Reserve stops paid calls and returns the original response.
  {
    const dir = tempDir();
    const { fn, counter } = makeFirecrawlFetch({ remaining: 100 });
    const html = htmlWithVisible(50);
    const wrapped = withFirecrawl(pageFetch(html), {
      fetchFn: fn,
      cacheDir: join(dir, "cache"),
      budgetFile: join(dir, "budget.json"),
      env: enabledEnv({ FIRECRAWL_DAILY_CAP: "10" }),
    });
    const res = await wrapped("https://fake-clinic-f.example/");
    const body = await res.text();
    returnedBodies.push(body);
    check("reserve stops paid calls", counter.scrape === 0);
    check("reserve returns the original response", body === html);
    cleanup(dir);
  }

  // 7b. Daily cap stops paid calls and returns the original response.
  {
    const dir = tempDir();
    const { fn, counter } = makeFirecrawlFetch();
    const wrapped = withFirecrawl(pageFetch(htmlWithVisible(50)), {
      fetchFn: fn,
      cacheDir: join(dir, "cache"),
      budgetFile: join(dir, "budget.json"),
      env: enabledEnv({ FIRECRAWL_DAILY_CAP: "1" }),
    });
    const first = await (await wrapped("https://fake-clinic-g.example/")).text();
    const secondRes = await wrapped("https://fake-clinic-h.example/");
    const second = await secondRes.text();
    returnedBodies.push(first, second);
    check("daily cap allows the first paid call", counter.scrape === 1 && first.includes("Fake markdown body"));
    check("daily cap stops further paid calls and returns original", secondRes.status === 200 && second === htmlWithVisible(50));
    cleanup(dir);
  }

  // 8. Per-process cap stops paid calls.
  {
    const dir = tempDir();
    const { fn, counter } = makeFirecrawlFetch();
    const html = htmlWithVisible(50);
    const wrapped = withFirecrawl(pageFetch(html), {
      fetchFn: fn,
      cacheDir: join(dir, "cache"),
      budgetFile: join(dir, "budget.json"),
      env: enabledEnv({ FIRECRAWL_DAILY_CAP: "10", FIRECRAWL_MAX_PER_RUN: "1" }),
    });
    const first = await (await wrapped("https://fake-clinic-i.example/")).text();
    const second = await (await wrapped("https://fake-clinic-j.example/")).text();
    returnedBodies.push(first, second);
    check("per-process cap allows only one paid call", counter.scrape === 1);
    check("per-process cap returns the original response for the second", second === html);
    cleanup(dir);
  }

  // 9. Firecrawl error returns the original response without throwing.
  {
    const dir = tempDir();
    const { fn, counter } = makeFirecrawlFetch({ scrapeStatus: 500 });
    const html = htmlWithVisible(50);
    const wrapped = withFirecrawl(pageFetch(html), {
      fetchFn: fn,
      cacheDir: join(dir, "cache"),
      budgetFile: join(dir, "budget.json"),
      env: enabledEnv({ FIRECRAWL_DAILY_CAP: "10" }),
    });
    let threw = false;
    let body = "";
    let status = 0;
    try {
      const res = await wrapped("https://fake-clinic-k.example/");
      status = res.status;
      body = await res.text();
    } catch {
      threw = true;
    }
    returnedBodies.push(body);
    check("Firecrawl HTTP error does not throw", !threw);
    check("Firecrawl HTTP error returns the original response", status === 200 && body === html && counter.scrape === 1);

    const dir2 = tempDir();
    const throwing = makeFirecrawlFetch({ scrapeThrow: true });
    const wrapped2 = withFirecrawl(pageFetch(html), {
      fetchFn: throwing.fn,
      cacheDir: join(dir2, "cache"),
      budgetFile: join(dir2, "budget.json"),
      env: enabledEnv({ FIRECRAWL_DAILY_CAP: "10" }),
    });
    let threw2 = false;
    let body2 = "";
    try {
      body2 = await (await wrapped2("https://fake-clinic-l.example/")).text();
    } catch {
      threw2 = true;
    }
    returnedBodies.push(body2);
    check("Firecrawl network throw does not throw into the pipeline", !threw2);
    check("Firecrawl network throw returns the original response", body2 === html);
    cleanup(dir);
    cleanup(dir2);
  }

  // 10. The API key never appears in any returned value, cache file or budget file.
  {
    const dir = tempDir();
    const cache = join(dir, "cache");
    const budget = join(dir, "budget.json");
    const { fn } = makeFirecrawlFetch({ markdown: "KEY_SCAN_MARKDOWN" });
    const wrapped = withFirecrawl(pageFetch(htmlWithVisible(50)), {
      fetchFn: fn,
      cacheDir: cache,
      budgetFile: budget,
      env: enabledEnv({ FIRECRAWL_DAILY_CAP: "10" }),
    });
    const body = await (await wrapped("https://fake-clinic-m.example/")).text();
    returnedBodies.push(body);

    const cacheText = readdirSync(cache)
      .map((f) => readFileSync(join(cache, f), "utf8"))
      .join("\n");
    const budgetText = readFileSync(budget, "utf8");
    const returnedText = returnedBodies.join("\n");
    check("API key absent from returned values", !returnedText.includes(KEY));
    check("API key absent from cache files", !cacheText.includes(KEY));
    check("API key absent from budget file", !budgetText.includes(KEY));
    cleanup(dir);
  }

  console.log("");
  console.log(`RESULT ${failCount === 0 ? "PASS" : "FAIL"} (${passCount} passed, ${failCount} failed)`);
  if (failCount > 0) process.exitCode = 1;
}

await main();
