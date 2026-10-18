// Order CW2-channel-probe proof: offline check for the channel probe.
//
// Fully offline: every outside integration is an injected fake. No network, no
// live DB, no .env, no ops script, no service. It writes only to os.tmpdir().
//
// Run (once, foreground):
//   npx tsx src/channel-probe-check.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classify,
  enableEnvFor,
  parseArgs,
  probeAdapters,
  renderMatrix,
  routeFor,
  runCli,
  writeMatrixJson,
} from "./channel-probe.js";
import type { ProbeObservation, ProbeResult, ProbeRow } from "./channel-probe.js";
import { BrowserBlockedError } from "./channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence } from "./channels/types.js";
import type { RawLead } from "./types.js";

// ---- tiny test harness ------------------------------------------------------

let failures = 0;
async function item(n: number, name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${n} ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${n} ${name}: ${(err as Error).message}`);
  }
}

// ---- fakes ------------------------------------------------------------------

function rawLead(name: string, sourceUrl: string): RawLead {
  return { name, category: "clinic", source: "fake", sourceUrl };
}

function evidence(fields: number, via: ChannelEvidence["via"] = "page"): ChannelEvidence {
  const f: Record<string, string> = {};
  for (let i = 0; i < fields; i += 1) f[`field${i}`] = `value${i}`;
  return {
    channel: "fake",
    url: "https://example.test/a",
    fetchedAt: new Date(0).toISOString(),
    via,
    fields: f,
    signals: [],
    text: "fake evidence text",
    untrusted: true,
  };
}

function fakeAdapter(spec: {
  id: string;
  categories?: string[];
  host?: string;
  discover?: ChannelAdapter["discover"];
  enrich?: ChannelAdapter["enrich"];
}): ChannelAdapter {
  const a: ChannelAdapter = {
    id: spec.id,
    name: spec.id,
    tier: "B",
    categories: spec.categories ?? ["clinic", "any"],
    status: () => ({ enabled: true }),
    discover: spec.discover ?? (async () => []),
    enrich: spec.enrich ?? (async () => evidence(0)),
    signals: () => [],
  };
  if (spec.host) (a as { host?: string }).host = spec.host;
  return a;
}

type ReachLike = { ok: boolean; channel: string; text: string; untrusted: true; error?: string; trace: never[] };
const okPage = (text: string): ReachLike => ({ ok: true, channel: "web", text, untrusted: true, trace: [] });
const badPage = (error: string, text = ""): ReachLike => ({ ok: false, channel: "web", text, untrusted: true, error, trace: [] });
/** A search result, so the backend name ("exa_search") is attributed, not "web". */
const badSearch = (error: string, text = ""): ReachLike => ({ ok: false, channel: "exa_search", text, untrusted: true, error, trace: [] });

function makeDeps(over: Partial<ChannelDeps> = {}): ChannelDeps {
  return {
    search: over.search ?? (async () => okPage("search results")),
    readPage: over.readPage ?? (async () => okPage("page text")),
    browser: over.browser,
    fetchFn: over.fetchFn,
    now: over.now ?? (() => 0),
    limiter: over.limiter ?? {},
  };
}

function makeBrowser(): NonNullable<ChannelDeps["browser"]> {
  return {
    read: async (url) => ({ text: "browser page text", url, title: "Fixture" }),
    search: async (_site, q) => ({ text: `browser results for ${q}`, url: "browser://search" }),
    status: () => ({
      enabled: true,
      killSwitch: false,
      backends: { opencli: { ok: false }, cdp: { ok: false, url: "" } },
      caps: {},
      usedThisHour: {},
      lockedPlatforms: [],
      pageLog: [],
    }),
  };
}

// ---- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "channel-probe-check-"));
  const savedLybrate = process.env.LEADSCOUT_LYBRATE;
  const savedTierC = process.env.LEADSCOUT_INDIA_TIER_C;

  try {
    // 1. classify() + routeFor(): exactly one verdict and route per case.
    await item(1, "classify/routeFor map every verdict exactly once", () => {
      const cases: { obs: ProbeObservation; verdict: string; route: string }[] = [
        { obs: { leads: 1, leadsWithSource: 1, fields: 2 }, verdict: "OK", route: "direct" },
        { obs: { leads: 1, leadsWithSource: 1, fields: 3, viaBrowser: true }, verdict: "OK", route: "browser" },
        { obs: { leads: 1, leadsWithSource: 1, fields: 0 }, verdict: "PARTIAL", route: "direct" },
        { obs: { leads: 0, leadsWithSource: 0, fields: 0, blocked: { kind: "403", on: "page" } }, verdict: "BLOCKED", route: "vps-browser" },
        { obs: { leads: 0, leadsWithSource: 0, fields: 0, searchLimited: { backend: "exa_search", reason: "429" } }, verdict: "SEARCH-LIMITED", route: "retry-later" },
        { obs: { leads: 0, leadsWithSource: 0, fields: 0, browserBlocked: true }, verdict: "NEEDS-LOGIN", route: "vps-browser" },
        { obs: { leads: 0, leadsWithSource: 0, fields: 0 }, verdict: "NO-DATA", route: "fix" },
        { obs: { notApplicable: true, leads: 0, leadsWithSource: 0, fields: 0 }, verdict: "NOT-APPLICABLE", route: "skip" },
        { obs: { leads: 0, leadsWithSource: 0, fields: 0, error: "boom" }, verdict: "ERROR", route: "fix" },
      ];
      for (const c of cases) {
        const got = classify(c.obs);
        assert.equal(got.verdict, c.verdict, `verdict for ${JSON.stringify(c.obs)}`);
        assert.equal(got.route, c.route, `route for ${c.verdict}`);
        assert.equal(got.route, routeFor(got.verdict, { viaBrowser: c.obs.viaBrowser }), `routeFor(${c.verdict})`);
      }
      assert.equal(routeFor("OK", { viaBrowser: true }), "browser", "OK via browser");
      assert.equal(routeFor("OK", { viaBrowser: false }), "direct", "OK direct");
    });

    // 2. OK direct: one lead with name+source, two enrich fields.
    await item(2, "probeAdapters: OK direct adapter", async () => {
      const a = fakeAdapter({
        id: "ok-direct",
        discover: async () => [rawLead("Bright Clinic", "https://example.test/bright")],
        enrich: async () => evidence(2),
      });
      const r = await probeAdapters({ category: "clinic", city: "Pune", adapters: [a], deps: makeDeps() });
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].verdict, "OK");
      assert.equal(r.rows[0].route, "direct");
      assert.equal(r.rows[0].leads, 1);
      assert.equal(r.rows[0].fields, 2);
      assert.ok(r.probedAt, "probedAt set");
    });

    // 3. OK browser: content only through the BrowserReader -> route browser.
    await item(3, "probeAdapters: OK only via BrowserReader -> route browser", async () => {
      const a = fakeAdapter({
        id: "ok-browser",
        discover: async (_q, deps) => {
          await deps.browser!.read("https://example.test/x");
          return [rawLead("Web Clinic", "https://example.test/x")];
        },
        enrich: async () => evidence(2, "browser"),
      });
      const r = await probeAdapters({ category: "clinic", adapters: [a], deps: makeDeps({ browser: makeBrowser() }) });
      assert.equal(r.rows[0].verdict, "OK");
      assert.equal(r.rows[0].route, "browser");
    });

    // 4. PARTIAL: leads but empty enrich.
    await item(4, "probeAdapters: PARTIAL (leads, empty enrich)", async () => {
      const a = fakeAdapter({
        id: "partial",
        discover: async () => [rawLead("Quiet Clinic", "https://example.test/q")],
        enrich: async () => evidence(0),
      });
      const r = await probeAdapters({ category: "clinic", adapters: [a], deps: makeDeps() });
      assert.equal(r.rows[0].verdict, "PARTIAL");
      assert.equal(r.rows[0].route, "direct");
    });

    // 5. BLOCKED: a SITE page 403 is recorded, route vps-browser. PR2: only a
    //    read of the site's own page can give BLOCKED (never a search answer).
    await item(5, "probeAdapters: BLOCKED records the site page read and kind", async () => {
      const a = fakeAdapter({
        id: "blocked",
        discover: async (_q, deps) => {
          await deps.readPage("https://blocked.example/clinic");
          return [];
        },
      });
      const r = await probeAdapters({ category: "clinic", adapters: [a], deps: makeDeps({ readPage: async () => badPage("403 Forbidden") }) });
      assert.equal(r.rows[0].verdict, "BLOCKED");
      assert.equal(r.rows[0].route, "vps-browser");
      assert.deepEqual(r.rows[0].blocked, { kind: "403", on: "page" });
    });

    // 6. NEEDS-LOGIN: BrowserBlockedError and login-wall text both map here.
    await item(6, "probeAdapters: NEEDS-LOGIN on browser wall and login text", async () => {
      const a = fakeAdapter({
        id: "needs-login",
        discover: async () => {
          throw new BrowserBlockedError("log in to continue", "fixture", false);
        },
      });
      const r = await probeAdapters({ category: "clinic", adapters: [a], deps: makeDeps() });
      assert.equal(r.rows[0].verdict, "NEEDS-LOGIN");
      assert.equal(r.rows[0].route, "vps-browser");

      const b = fakeAdapter({
        id: "needs-login-text",
        discover: async (_q, deps) => {
          await deps.search("site:x clinic");
          return [];
        },
      });
      const r2 = await probeAdapters({ category: "clinic", adapters: [b], deps: makeDeps({ search: async () => okPage("Please log in to continue") }) });
      assert.equal(r2.rows[0].verdict, "NEEDS-LOGIN");
      assert.equal(r2.rows[0].route, "vps-browser");
    });

    // 7. NO-DATA: page read fine, zero leads.
    await item(7, "probeAdapters: NO-DATA (clean read, zero leads)", async () => {
      const a = fakeAdapter({ id: "no-data", discover: async () => [] });
      const r = await probeAdapters({ category: "clinic", adapters: [a], deps: makeDeps() });
      assert.equal(r.rows[0].verdict, "NO-DATA");
      assert.equal(r.rows[0].route, "fix");
    });

    // 8. NOT-APPLICABLE: adapter does not list the category -> no calls.
    await item(8, "probeAdapters: NOT-APPLICABLE makes no outside calls", async () => {
      let calls = 0;
      const a = fakeAdapter({
        id: "restaurant-only",
        categories: ["restaurant"],
        discover: async () => {
          calls += 1;
          return [rawLead("x", "https://example.test/x")];
        },
      });
      const r = await probeAdapters({ category: "clinic", adapters: [a], deps: makeDeps() });
      assert.equal(r.rows[0].verdict, "NOT-APPLICABLE");
      assert.equal(r.rows[0].route, "skip");
      assert.equal(calls, 0, "discover not called");
    });

    // 9. ERROR: exception message preserved.
    await item(9, "probeAdapters: ERROR keeps the message", async () => {
      const a = fakeAdapter({
        id: "erroring",
        discover: async () => {
          throw new Error("kaboom");
        },
      });
      const r = await probeAdapters({ category: "clinic", adapters: [a], deps: makeDeps() });
      assert.equal(r.rows[0].verdict, "ERROR");
      assert.equal(r.rows[0].route, "fix");
      assert.match(r.rows[0].reason, /kaboom/);
    });

    // 10. 6-call cap: the 7th outside call throws; base sees exactly 6.
    await item(10, "probeAdapters: outside-call cap of 6", async () => {
      let baseCalls = 0;
      const deps = makeDeps({
        search: async () => {
          baseCalls += 1;
          return okPage("hit");
        },
      });
      const a = fakeAdapter({
        id: "chatty",
        discover: async (_q, d) => {
          for (let i = 0; i < 8; i += 1) await d.search(`q${i}`);
          return [];
        },
      });
      const r = await probeAdapters({ category: "clinic", adapters: [a], deps });
      assert.equal(baseCalls, 6, "base search called exactly 6 times");
      assert.equal(r.rows[0].verdict, "ERROR");
      assert.match(r.rows[0].reason, /cap/i);
    });

    // 11. 3-consecutive-BLOCKED-per-host stop cuts the run short.
    await item(11, "probeAdapters: stop a host after 3 consecutive BLOCKED", async () => {
      const calls: Record<string, number> = {};
      const mk = (id: string): ChannelAdapter =>
        fakeAdapter({
          id,
          host: "h1",
          discover: async (_q, deps) => {
            calls[id] = (calls[id] ?? 0) + 1;
            await deps.readPage("https://h1/x");
            return [];
          },
        });
      const adapters = [mk("b1"), mk("b2"), mk("b3"), mk("b4")];
      const r = await probeAdapters({ category: "clinic", adapters, deps: makeDeps({ readPage: async () => badPage("429 too many requests") }) });
      assert.equal(r.rows.length, 4);
      assert.ok(r.rows.every((x) => x.verdict === "BLOCKED"), "all rows BLOCKED");
      assert.equal(calls.b1, 1);
      assert.equal(calls.b4, undefined, "4th adapter never probed");
      assert.match(r.rows[3].reason, /stopped after 3/);
    });

    // 12. enable variable is set inside the process for the run only.
    await item(12, "enable env var is applied then restored; never in the injected env", async () => {
      process.env.LEADSCOUT_LYBRATE = "orig";
      let seen: string | undefined;
      const a = fakeAdapter({
        id: "lybrate",
        discover: async () => {
          seen = process.env.LEADSCOUT_LYBRATE;
          return [];
        },
      });
      const injectedEnv: Record<string, string | undefined> = {};
      await probeAdapters({ category: "clinic", adapters: [a], deps: makeDeps(), env: injectedEnv, live: true });
      assert.equal(seen, "1", "adapter saw the enable var set to 1");
      assert.equal(process.env.LEADSCOUT_LYBRATE, "orig", "restored after the adapter");
      assert.equal(injectedEnv.LEADSCOUT_LYBRATE, undefined, "not written into the injected env object");
      assert.equal(enableEnvFor("lybrate"), "LEADSCOUT_LYBRATE");
    });

    // 13. atomic JSON write to a temp path; no temp file left behind.
    await item(13, "writeMatrixJson is atomic and leaves no temp file", () => {
      const jsonPath = join(tmpRoot, "data", "channel-matrix.json");
      const result: ProbeResult = {
        probedAt: "2026-01-01T00:00:00.000Z",
        category: "clinic",
        city: "Pune",
        rows: [
          { adapter: "justdial", verdict: "OK", route: "direct", leads: 1, fields: 2, reason: "ok", probeTime: "2026-01-01T00:00:00.000Z" },
        ],
      };
      writeMatrixJson(jsonPath, result);
      assert.ok(existsSync(jsonPath), "json written");
      const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as ProbeResult;
      assert.equal(parsed.probedAt, result.probedAt);
      assert.equal(parsed.rows.length, 1);
      assert.equal(parsed.rows[0].adapter, "justdial");
      const leftovers = readdirSync(join(tmpRoot, "data")).filter((f) => f.endsWith(".tmp"));
      assert.equal(leftovers.length, 0, `no temp files: ${leftovers.join(", ")}`);
    });

    // 14. renderMatrix lists table rows and the direct enable env vars.
    await item(14, "renderMatrix lists the direct adapters' enable env vars", () => {
      const rows: ProbeRow[] = [
        { adapter: "justdial", verdict: "OK", route: "direct", leads: 2, fields: 3, reason: "ok", probeTime: "t1" },
        { adapter: "zomato", verdict: "BLOCKED", route: "vps-browser", leads: 0, fields: 0, reason: "blocked", probeTime: "t2" },
      ];
      const md = renderMatrix(rows, { probedAt: "t0", category: "restaurant", city: "Delhi" });
      assert.match(md, /\| Adapter \| Verdict \| Route \|/);
      assert.match(md, /`justdial`: set `LEADSCOUT_INDIA_TIER_C=1`/);
    });

    // 15. --live refuses unless LEADSCOUT_PROBE_LIVE=1; writes nothing.
    await item(15, "--live refuses without LEADSCOUT_PROBE_LIVE=1", async () => {
      const mdPath = join(tmpRoot, "live.md");
      const jsonPath = join(tmpRoot, "live.json");
      const errs: string[] = [];
      const code = await runCli(["--category", "clinic", "--city", "Pune", "--live"], {
        env: {},
        adapters: [],
        deps: makeDeps(),
        outPath: mdPath,
        jsonPath,
        err: (s) => errs.push(s),
        out: () => {},
      });
      assert.equal(code, 2, "refusal exit code");
      assert.ok(errs.some((e) => e.includes("LEADSCOUT_PROBE_LIVE")), "message names the gate");
      assert.equal(existsSync(mdPath), false, "no markdown written");
      assert.equal(existsSync(jsonPath), false, "no json written");
    });

    // 16. --only restricts the run; parseArgs reads the flags.
    await item(16, "--only selects a subset; parseArgs parses flags", async () => {
      const parsed = parseArgs(["--category", "clinic", "--city", "Pune", "--only", "keep,drop", "--out", "x.md"]);
      assert.equal(parsed.category, "clinic");
      assert.equal(parsed.city, "Pune");
      assert.deepEqual(parsed.only, ["keep", "drop"]);
      assert.equal(parsed.out, "x.md");
      const keep = fakeAdapter({ id: "keep", discover: async () => [rawLead("K", "https://example.test/k")], enrich: async () => evidence(2) });
      const drop = fakeAdapter({ id: "drop", discover: async () => [rawLead("D", "https://example.test/d")], enrich: async () => evidence(2) });
      const r = await probeAdapters({ category: "clinic", adapters: [keep, drop], deps: makeDeps(), only: ["keep"] });
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].adapter, "keep");
    });

    // ---- PR2-probe-truth: six new offline cases ------------------------------

    // 17. A search-backend 429 is SEARCH-LIMITED with route retry-later, never BLOCKED.
    await item(17, "PR2: search-backend 429 -> SEARCH-LIMITED, never BLOCKED", async () => {
      const a = fakeAdapter({
        id: "search-limited",
        discover: async (_q, d) => {
          await d.search("site:blocked.example clinic");
          return [];
        },
      });
      const r = await probeAdapters({
        category: "clinic",
        adapters: [a],
        deps: makeDeps({ search: async () => badSearch("429 Too Many Requests") }),
        cooldownMs: 0,
      });
      assert.equal(r.rows[0].verdict, "SEARCH-LIMITED");
      assert.notEqual(r.rows[0].verdict, "BLOCKED");
      assert.equal(r.rows[0].route, "retry-later");
      assert.equal(r.rows[0].blocked, undefined, "no site block recorded");
      assert.match(r.rows[0].reason, /search backend exa_search/i);
    });

    // 18. A site page 403 is BLOCKED (the site's own page, not a search answer).
    await item(18, "PR2: site page 403 -> BLOCKED", async () => {
      const a = fakeAdapter({
        id: "site-blocked",
        discover: async (_q, d) => {
          await d.readPage("https://blocked.example/x");
          return [];
        },
      });
      const r = await probeAdapters({
        category: "clinic",
        adapters: [a],
        deps: makeDeps({ readPage: async () => badPage("403 Forbidden") }),
        cooldownMs: 0,
      });
      assert.equal(r.rows[0].verdict, "BLOCKED");
      assert.equal(r.rows[0].route, "vps-browser");
      assert.deepEqual(r.rows[0].blocked, { kind: "403", on: "page" });
    });

    // 19. A nav "Log in" link with 3 valid leads on the adapter's own site and 4
    //     fields can never be NEEDS-LOGIN -> OK.
    await item(19, "PR2: nav login link + 3 valid leads + 4 fields -> OK", async () => {
      const leads = [
        rawLead("Alpha Weddings", "https://www.justdial.com/mumbai/alpha"),
        rawLead("Beta Events", "https://justdial.com/mumbai/beta"),
        rawLead("Gamma Planners", "https://m.justdial.com/mumbai/gamma"),
      ];
      const a = fakeAdapter({
        id: "justdial",
        discover: async (_q, d) => {
          await d.readPage("https://www.justdial.com/mumbai/wedding-planners");
          return leads;
        },
        enrich: async () => evidence(4),
      });
      const r = await probeAdapters({
        category: "clinic",
        adapters: [a],
        deps: makeDeps({
          readPage: async () =>
            okPage("Justdial Home Listings Log in | Sign up | About us. Ask a Question. Categories: wedding planners in Mumbai with phone and reviews."),
        }),
        cooldownMs: 0,
      });
      assert.equal(r.rows[0].verdict, "OK");
      assert.equal(r.rows[0].validLeads, 3);
      assert.equal(r.rows[0].fields, 4);
    });

    // 20. A real login form (password input) with 0 fields -> NEEDS-LOGIN.
    await item(20, "PR2: real login form with 0 fields -> NEEDS-LOGIN", async () => {
      const a = fakeAdapter({
        id: "login-wall",
        discover: async (_q, d) => {
          await d.readPage("https://login.example/account");
          return [rawLead("Hidden Clinic", "https://login.example/x")];
        },
        enrich: async () => evidence(0),
      });
      const r = await probeAdapters({
        category: "clinic",
        adapters: [a],
        deps: makeDeps({
          readPage: async () =>
            okPage('Sign in to your account <input type="password" name="password"> Email Password Forgot password?'),
        }),
        cooldownMs: 0,
      });
      assert.equal(r.rows[0].verdict, "NEEDS-LOGIN");
      assert.equal(r.rows[0].route, "vps-browser");
    });

    // 21. Generic search hits on another host -> validLeads 0 and not OK.
    await item(21, "PR2: generic hits on another host -> validLeads 0, not OK", async () => {
      const a = fakeAdapter({
        id: "practo",
        discover: async () => [
          rawLead("Generic Hit One", "https://somewhere-else.test/a"),
          rawLead("Generic Hit Two", "https://another-site.test/b"),
        ],
        enrich: async () => evidence(3),
      });
      const r = await probeAdapters({ category: "clinic", adapters: [a], deps: makeDeps(), cooldownMs: 0 });
      assert.equal(r.rows[0].validLeads, 0);
      assert.notEqual(r.rows[0].verdict, "OK");
      assert.equal(r.rows[0].verdict, "PARTIAL");
    });

    // 22. The retry runs once after the (0 second) cooldown and stops after 2 tries.
    await item(22, "PR2: SEARCH-LIMITED retried once after cooldown, max 2 tries", async () => {
      let searchCalls = 0;
      const slept: number[] = [];
      const a = fakeAdapter({
        id: "retry-limited",
        discover: async (_q, d) => {
          await d.search("site:x clinic");
          return [];
        },
      });
      const r = await probeAdapters({
        category: "clinic",
        adapters: [a],
        deps: makeDeps({
          search: async () => {
            searchCalls += 1;
            return badSearch("429 quota exhausted for this key");
          },
        }),
        cooldownMs: 0,
        sleep: async (ms) => {
          slept.push(ms);
        },
      });
      assert.equal(searchCalls, 2, "exactly two tries total");
      assert.equal(slept.length, 1, "one cooldown wait before the retry");
      assert.equal(slept[0], 0, "the test cooldown is 0 seconds");
      assert.equal(r.rows[0].verdict, "SEARCH-LIMITED");
      assert.equal(r.rows[0].route, "retry-later");
      assert.ok(r.searchQuota && r.searchQuota.length >= 1, "search quota status present");
      assert.equal(r.searchQuota![0].backend, "exa_search");
      assert.equal(r.searchQuota![0].limitedCalls, 2, "both calls counted as limited");
    });

    // 23. renderMatrix shows the new columns and the Search quota status block.
    await item(23, "PR2: markdown has Valid leads / Search backend and quota block", () => {
      const rows: ProbeRow[] = [
        { adapter: "justdial", verdict: "OK", route: "direct", leads: 3, validLeads: 3, fields: 4, searchBackend: "exa_search", reason: "ok", probeTime: "t1" },
        { adapter: "practo", verdict: "SEARCH-LIMITED", route: "retry-later", leads: 0, validLeads: 0, fields: 0, searchBackend: "exa_search", reason: "limit", probeTime: "t2" },
      ];
      const md = renderMatrix(rows, { probedAt: "t0", searchQuota: [{ backend: "exa_search", limitedCalls: 5 }] });
      assert.match(md, /\| Adapter \| Verdict \| Route \| Leads \| Valid leads \| Fields \| Search backend \|/);
      assert.match(md, /## Search quota status/);
      assert.match(md, /exa_search: 5 search call\(s\) returned a limit/);
      assert.match(md, /the search provider quota is exhausted; discovery by search cannot run until it resets or a paid key is set/);
    });
  } finally {
    if (savedLybrate === undefined) delete process.env.LEADSCOUT_LYBRATE;
    else process.env.LEADSCOUT_LYBRATE = savedLybrate;
    if (savedTierC === undefined) delete process.env.LEADSCOUT_INDIA_TIER_C;
    else process.env.LEADSCOUT_INDIA_TIER_C = savedTierC;
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log("");
  if (failures === 0) {
    console.log("PASS channel-probe-check (Order CW2-channel-probe)");
  } else {
    console.log(`FAIL channel-probe-check (Order CW2-channel-probe): ${failures} item(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`FAIL channel-probe-check: ${(err as Error).message}`);
  process.exitCode = 1;
});
