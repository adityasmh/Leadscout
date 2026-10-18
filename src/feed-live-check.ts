// src/feed-live-check.ts
// Order LG4-feed-live-wiring proof. Offline: temp database, fake niche pack,
// fake adapters, fake channel deps and a fake live-deps factory. No network,
// no model, no server service.
// Run: npx tsx src/feed-live-check.ts
//
// LEADSCOUT_DB is set to a temp file BEFORE any leadscout module is loaded, so
// the live data file is never opened. No src/company import is used, so the
// company sandbox import is not needed.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChannelAdapter, ChannelDeps, DiscoverQuery } from "./channels/types.js";
import type { DiscoveryResult } from "./channels/registry.js";
import type { Feed, FeedDeps } from "./feeds.js";
import type { NichePack } from "./niche-pack.js";
import type { RawLead } from "./types.js";
import type { ReachResult } from "./reach.js";

const DB_FILE = join(tmpdir(), `leadscout-feed-live-check-${randomUUID()}.db`);
process.env.LEADSCOUT_DB = DB_FILE;
process.env.LEADSCOUT_FEEDS_LIVE = "1";

let store!: typeof import("./store.js");
let feedsMod!: typeof import("./feeds.js");

// ------------------------------------------------------------------ harness

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`PASS ${name}`);
    })
    .catch((err: unknown) => {
      failed += 1;
      const message = err instanceof Error ? err.stack ?? err.message : String(err);
      console.log(`FAIL ${name}\n     ${message.split("\n").join("\n     ")}`);
    });
}

// ------------------------------------------------------------------ fixtures

const DAY1 = new Date("2026-10-12T08:00:00Z");
const DAY2 = new Date("2026-10-13T08:00:00Z");

const PACK: NichePack = {
  id: "live-pack",
  label: "Live Pack",
  categories: [
    { id: "wedding", label: "Wedding", aliases: [], buyerReason: "fake", videoNeed: "high", queries: ["fake {city}"] },
  ],
  cities: [{ name: "Fake City", tier: 1, areas: ["Area A", "Area B"] }],
  signals: [],
};

const SINGLE_PACK: NichePack = {
  ...PACK,
  id: "live-single-pack",
  cities: [{ name: "Fake City", tier: 1, areas: ["Only Area"] }],
};

function rawLead(name: string, phone: string): RawLead {
  return {
    name,
    category: "wedding",
    city: "Fake City",
    phone,
    source: "fake-live",
    sourceUrl: `https://example.invalid/live/${encodeURIComponent(name)}`,
  };
}

function fakeReachResult(): ReachResult {
  return { ok: true, channel: "fake", text: "fake page text", untrusted: true, trace: [] };
}

function fakeChannelDeps(): ChannelDeps {
  return {
    search: async () => fakeReachResult(),
    readPage: async () => fakeReachResult(),
    limiter: {},
  };
}

function makeGoodAdapter(id: string, leads: RawLead[]): ChannelAdapter & { calls: number; sawSearch: string } {
  return {
    id,
    name: id,
    tier: "A",
    categories: ["wedding"],
    calls: 0,
    sawSearch: "never-called",
    status: () => ({ enabled: true }),
    discover: async function (q: { category: string; city: string; area?: string; limit?: number }, deps: ChannelDeps) {
      this.calls += 1;
      this.sawSearch = typeof deps.search;
      void q;
      return leads;
    },
    enrich: async (lead: RawLead) => ({
      channel: id,
      url: lead.sourceUrl,
      fetchedAt: new Date().toISOString(),
      via: "search" as const,
      fields: {},
      signals: [],
      text: "fake evidence text",
      untrusted: true as const,
    }),
    signals: () => [],
  };
}

function makeBoomAdapter(): ChannelAdapter {
  return {
    id: "boom",
    name: "boom",
    tier: "B",
    categories: ["wedding"],
    status: () => ({ enabled: true }),
    discover: async () => {
      throw new Error("boom-source failed");
    },
    enrich: async (lead: RawLead) => ({
      channel: "boom",
      url: lead.sourceUrl,
      fetchedAt: new Date().toISOString(),
      via: "search" as const,
      fields: {},
      signals: [],
      text: "",
      untrusted: true as const,
    }),
    signals: () => [],
  };
}

function makeDisabledAdapter(): ChannelAdapter & { calls: number } {
  return {
    id: "disabled-fake",
    name: "disabled-fake",
    tier: "C",
    categories: ["wedding"],
    calls: 0,
    status: () => ({ enabled: false, why: "fake test off" }),
    discover: async function () {
      this.calls += 1;
      return [];
    },
    enrich: async (lead: RawLead) => ({
      channel: "disabled-fake",
      url: lead.sourceUrl,
      fetchedAt: new Date().toISOString(),
      via: "search" as const,
      fields: {},
      signals: [],
      text: "",
      untrusted: true as const,
    }),
    signals: () => [],
  };
}

function makeRestaurantAdapter(): ChannelAdapter {
  return {
    id: "restaurant-only",
    name: "restaurant-only",
    tier: "B",
    categories: ["restaurant"],
    status: () => ({ enabled: true }),
    discover: async () => [],
    enrich: async (lead: RawLead) => ({
      channel: "restaurant-only",
      url: lead.sourceUrl,
      fetchedAt: new Date().toISOString(),
      via: "search" as const,
      fields: {},
      signals: [],
      text: "",
      untrusted: true as const,
    }),
    signals: () => [],
  };
}

/** A runDiscovery fake that delegates to one fake adapter (proves the deps it
 *  receives are the ones the adapter sees). */
function delegatingDiscovery(adapter: ChannelAdapter): FeedDeps["runDiscovery"] {
  return async (q: DiscoverQuery, deps: ChannelDeps): Promise<DiscoveryResult> => {
    const found = await adapter.discover(q, deps);
    return { leads: found, runs: [{ id: adapter.id, ok: true, leads: found.length }], callsUsed: 1 };
  };
}

async function fakeProcessLeads(feed: Feed, leads: RawLead[]): Promise<string[]> {
  return leads.map((raw) => store.upsertLead({ ...raw, workspaceId: feed.workspaceId }).id);
}

function baseDeps(now: Date, pack: NichePack, overrides: Partial<FeedDeps> = {}): FeedDeps {
  return {
    now: () => now,
    loadPack: () => pack,
    processLeads: fakeProcessLeads,
    bizKeyOf: feedsMod.feedBizKey,
    ...overrides,
  };
}

function deliveredKeys(feedId: string): string[] {
  const rows = store.getDb().prepare("SELECT bizKey FROM delivered_leads WHERE feedId = ?").all(feedId) as Array<{
    bizKey: unknown;
  }>;
  return rows.map((r) => String(r.bizKey));
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  store = await import("./store.js");
  feedsMod = await import("./feeds.js");

  const workspace = store.createWorkspace({
    name: "Fake Live Feed Workspace",
    offer: { services: ["website"], description: "fake offer for checks only" },
    icp: { categories: ["wedding"], cities: ["Fake City"], countries: ["IN"] },
  });

  function makeFeed(name: string, perRunTarget: number): Feed {
    return feedsMod.createFeed({
      workspaceId: workspace.id,
      name,
      nichePackId: "live-pack",
      categories: ["wedding"],
      cities: ["Fake City"],
      perRunTarget,
      schedule: { kind: "daily" },
    });
  }

  // ---- (a) live deps factory ------------------------------------------------
  let factoryCalls = 0;
  const good = makeGoodAdapter("good-live", [rawLead("Live Biz One", "9111111111"), rawLead("Live Biz Two", "9222222222")]);
  feedsMod.setLiveDepsFactory(async () => {
    factoryCalls += 1;
    return fakeChannelDeps();
  });
  try {
    const feedA = makeFeed("Feed A live deps", 5);
    let runA!: import("./feeds.js").FeedRun;
    await check("(a) with LEADSCOUT_FEEDS_LIVE=1 and no injected deps the runner asks makeLiveDeps", async () => {
      runA = await feedsMod.runFeed(
        feedA.id,
        baseDeps(DAY1, PACK, { listAdapters: () => [good], runDiscovery: delegatingDiscovery(good) })
      );
      assert.equal(factoryCalls, 1, `factory called ${factoryCalls} times`);
      assert.equal(good.sawSearch, "function", `adapter saw search type ${good.sawSearch}`);
      assert.ok(runA.newLeads > 0, `expected leads, got ${runA.newLeads}`);
    });

    await check("(a2) injected channelDeps always win over the live factory", async () => {
      const feedA2 = makeFeed("Feed A2 injected wins", 5);
      const before = factoryCalls;
      await feedsMod.runFeed(
        feedA2.id,
        baseDeps(DAY1, PACK, {
          listAdapters: () => [good],
          runDiscovery: delegatingDiscovery(good),
          channelDeps: fakeChannelDeps(),
        })
      );
      assert.equal(factoryCalls, before, "factory must not be asked when deps are injected");
    });
  } finally {
    feedsMod.setLiveDepsFactory(undefined);
  }

  // ---- (b) failing adapter ---------------------------------------------------
  const boom = makeBoomAdapter();
  const feedB = makeFeed("Feed B failing adapter", 5);
  async function boomDiscovery(): Promise<DiscoveryResult> {
    return { leads: [], runs: [{ id: "boom", ok: false, error: "boom-source failed", leads: 0 }], callsUsed: 1 };
  }
  let runB1!: import("./feeds.js").FeedRun;
  await check("(b) a run whose only enabled adapter fails records a de-duplicated readable error", async () => {
    runB1 = await feedsMod.runFeed(feedB.id, baseDeps(DAY1, PACK, { listAdapters: () => [boom], runDiscovery: boomDiscovery }));
    assert.equal(runB1.newLeads, 0);
    assert.ok(runB1.error && /boom-source failed/.test(runB1.error), `error was ${runB1.error}`);
    assert.ok(runB1.error && /\(x2\)/.test(runB1.error), `identical messages must merge with a count: ${runB1.error}`);
    assert.ok(runB1.error && !/disabled/i.test(runB1.error), `no disabled noise expected: ${runB1.error}`);
    assert.ok((runB1.error ?? "").length < 500, `readable, got ${(runB1.error ?? "").length} chars`);
  });

  // ---- (c) retry after failure, idempotent after success ---------------------
  await check("(c) a second runFeed after the failed run starts a NEW run", async () => {
    const runB2 = await feedsMod.runFeed(feedB.id, baseDeps(DAY1, PACK, { listAdapters: () => [boom], runDiscovery: boomDiscovery }));
    assert.notEqual(runB2.id, runB1.id, "failed empty runs must never block a retry");
  });

  await check("(c2) a run that delivered leads is still returned idempotently", async () => {
    const feedC = makeFeed("Feed C idempotent success", 5);
    const deps = baseDeps(DAY1, PACK, { listAdapters: () => [good], runDiscovery: delegatingDiscovery(good) });
    const first = await feedsMod.runFeed(feedC.id, deps);
    assert.ok(first.newLeads > 0);
    const again = await feedsMod.runFeed(feedC.id, deps);
    assert.equal(again.id, first.id, "successful same-day runs stay idempotent");
  });

  // ---- (d) disabled adapters --------------------------------------------------
  const disabled = makeDisabledAdapter();
  const restaurantOnly = makeRestaurantAdapter();
  let discoveryCalled = false;
  const feedD = makeFeed("Feed D disabled skip", 5);
  await check("(d) disabled adapters are skipped and counted, never called", async () => {
    const runD = await feedsMod.runFeed(
      feedD.id,
      baseDeps(DAY1, PACK, {
        listAdapters: () => [disabled, restaurantOnly],
        runDiscovery: async () => {
          discoveryCalled = true;
          return { leads: [], runs: [], callsUsed: 0 };
        },
      })
    );
    assert.equal(discoveryCalled, false, "the runner must not run when no enabled adapter lists the category");
    assert.equal(disabled.calls, 0, "the disabled adapter itself is never invoked");
    assert.equal(runD.error, "skipped 1 disabled adapters", `one count line, got ${runD.error}`);
    assert.equal(runD.newLeads, 0);
    const again = await feedsMod.runFeed(
      feedD.id,
      baseDeps(DAY1, PACK, {
        listAdapters: () => [disabled, restaurantOnly],
        runDiscovery: async () => {
          discoveryCalled = true;
          return { leads: [], runs: [], callsUsed: 0 };
        },
      })
    );
    assert.equal(again.id, runD.id, "a skip-only run has no source errors, so it stands");
  });

  // ---- (e) error budget --------------------------------------------------------
  const feedE = makeFeed("Feed E error budget", 5);
  await check("(e) the error text stays under 2000 characters when 300 identical errors occur", async () => {
    const failing: DiscoveryResult = {
      leads: [],
      runs: Array.from({ length: 300 }, () => ({ id: "f", ok: false as const, error: "same failure", leads: 0 })),
      callsUsed: 1,
    };
    const runE = await feedsMod.runFeed(
      feedE.id,
      baseDeps(DAY1, SINGLE_PACK, { listAdapters: () => [good], runDiscovery: async () => failing })
    );
    assert.ok((runE.error ?? "").length < 2000, `error is ${(runE.error ?? "").length} chars`);
    assert.ok(/\(x300\)/.test(runE.error ?? ""), `identical errors must merge with a count: ${runE.error}`);
  });

  // ---- (f) quota + no repeats ---------------------------------------------------
  const five = makeGoodAdapter("five-live", [
    rawLead("Live Cap Biz 0", "9300000000"),
    rawLead("Live Cap Biz 1", "9311111111"),
    rawLead("Live Cap Biz 2", "9322222222"),
    rawLead("Live Cap Biz 3", "9333333333"),
    rawLead("Live Cap Biz 4", "9344444444"),
  ]);
  const feedF = makeFeed("Feed F quota", 3);
  await check("(f) an adapter returning 5 leads delivers up to perRunTarget, then none of the same", async () => {
    const deps1 = baseDeps(DAY1, PACK, { listAdapters: () => [five], runDiscovery: delegatingDiscovery(five) });
    const runF1 = await feedsMod.runFeed(feedF.id, deps1);
    assert.equal(runF1.newLeads, 3, `newLeads ${runF1.newLeads}`);
    assert.equal(runF1.delivered, 3);
    const keys1 = deliveredKeys(feedF.id);
    assert.equal(keys1.length, 3);
    const runF2 = await feedsMod.runFeed(feedF.id, baseDeps(DAY2, PACK, { listAdapters: () => [five], runDiscovery: delegatingDiscovery(five) }));
    const keys2 = deliveredKeys(feedF.id);
    assert.ok(keys2.length > keys1.length, "day 2 delivers the remainder");
    const overlap = keys2.filter((k) => keys1.includes(k));
    assert.equal(overlap.length, keys1.length, "day 1 deliveries remain stored");
    assert.equal(runF2.newLeads, keys2.length - keys1.length, "day 2 delivers only fresh leads");
    assert.ok(runF2.newLeads > 0 && runF2.newLeads <= 2, `day 2 delivers the 2 remaining, got ${runF2.newLeads}`);
  });

  // ---- (g) real factory shape ----------------------------------------------------
  await check("(g) makeLiveDeps builds real deps with no browser unless LEADSCOUT_BROWSER=1", async () => {
    const { makeLiveDeps } = await import("./channels/live-deps.js");
    const off = await makeLiveDeps({});
    assert.equal(typeof off.search, "function");
    assert.equal(typeof off.readPage, "function");
    assert.equal(off.browser, undefined);
    assert.equal(typeof off.limiter.sleep, "function");
    const on = await makeLiveDeps({ LEADSCOUT_BROWSER: "1" });
    assert.ok(on.browser, "LEADSCOUT_BROWSER=1 must include the BrowserReader");
  });
}

// ------------------------------------------------------------------ run

await main();

store.closeDb();
rmSync(DB_FILE, { force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
