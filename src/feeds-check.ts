// src/feeds-check.ts
// Order LG1-feed-engine proof. Offline: temp database, fake niche pack, fake
// channel runner and fake pipeline. No network, no model, no server service.
// Run: npx tsx src/feeds-check.ts
//
// LEADSCOUT_DB is set to a temp file BEFORE any leadscout module is loaded, so
// the live data file is never opened. No src/company import is used, so the
// company sandbox import is not needed.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import type { Feed, FeedDeps } from "./feeds.js";
import type { NichePack } from "./niche-pack.js";
import type { RawLead } from "./types.js";

const DB_FILE = join(tmpdir(), `leadscout-feeds-check-${randomUUID()}.db`);
process.env.LEADSCOUT_DB = DB_FILE;

let store: typeof import("./store.js");
let feedsMod: typeof import("./feeds.js");
let routes: typeof import("./routes-feeds.js");

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

const DAY1 = new Date("2026-10-12T08:00:00Z"); // Monday
const DAY2 = new Date("2026-10-13T08:00:00Z"); // Tuesday
const DAY3 = new Date("2026-10-14T08:00:00Z"); // Wednesday

const PACK: NichePack = {
  id: "fake-pack",
  label: "Fake Pack",
  categories: [
    { id: "wedding", label: "Wedding", aliases: [], buyerReason: "fake", videoNeed: "high", queries: ["fake {city}"] },
  ],
  cities: [{ name: "Fake City", tier: 1, areas: ["Area A", "Area B", "Area C", "Area D"] }],
  signals: [],
};

const queried: string[] = [];

function rawLead(name: string, city: string, area: string | undefined, phone: string): RawLead {
  return {
    name,
    category: "wedding",
    city,
    phone,
    source: "fake",
    sourceUrl: `https://example.invalid/${encodeURIComponent(area ?? city)}/${encodeURIComponent(name)}`,
  };
}

/** Three shared leads per area (same bizKey everywhere) plus fourteen area-unique leads. */
async function fakeDiscovery(q: { category: string; city: string; area?: string; limit?: number }) {
  queried.push(`${q.city}|${q.area ?? ""}`);
  if (q.area === "Area A") throw new Error("boom: Area A source failed");
  const leads: RawLead[] = [];
  for (let n = 0; n < 3; n++) leads.push(rawLead(`Shared Biz ${n}`, q.city, q.area, `900000000${n}`));
  const tag = (q.area ?? q.city).replace(/\s+/g, "");
  for (let n = 0; n < 14; n++) leads.push(rawLead(`Fake ${tag} Biz ${n}`, q.city, q.area, `${n}${tag.length}000000`));
  return { leads, runs: [{ id: "fake", ok: true, leads: leads.length }], callsUsed: 1 };
}

const visitedTargets: string[] = [];

/** Big runner for the hard-limit checks: one hundred unique leads per target. */
async function bigDiscovery(q: { category: string; city: string; area?: string; limit?: number }) {
  visitedTargets.push(`${q.city}|${q.area ?? ""}`);
  const leads: RawLead[] = [];
  const tag = (q.area ?? q.city).replace(/\s+/g, "");
  for (let n = 0; n < 100; n++) leads.push(rawLead(`Big ${tag} Biz ${n}`, q.city, q.area, `${tag.length}${n}000000000`));
  return { leads, runs: [{ id: "big", ok: true, leads: leads.length }], callsUsed: 1 };
}

async function fakeProcessLeads(feed: Feed, leads: RawLead[]): Promise<string[]> {
  return leads.map((raw) => store.upsertLead({ ...raw, workspaceId: feed.workspaceId }).id);
}

function depsFor(now: Date, overrides: Partial<FeedDeps> = {}): FeedDeps {
  return {
    now: () => now,
    loadPack: () => PACK,
    runDiscovery: fakeDiscovery,
    processLeads: fakeProcessLeads,
    bizKeyOf: feedsMod.feedBizKey,
    ...overrides,
  };
}

function deliveredKeys(feedId: string): string[] {
  const rows = store.getDb().prepare("SELECT bizKey FROM delivered_leads WHERE feedId = ?").all(feedId) as Array<{ bizKey: unknown }>;
  return rows.map((r) => String(r.bizKey));
}
function deliveredCount(feedId: string): number {
  const row = store.getDb().prepare("SELECT COUNT(*) AS n FROM delivered_leads WHERE feedId = ?").get(feedId) as { n?: unknown } | undefined;
  return Number(row?.n ?? 0);
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  store = await import("./store.js");
  feedsMod = await import("./feeds.js");
  routes = await import("./routes-feeds.js");

  const workspace = store.createWorkspace({
    name: "Fake Feed Workspace",
    offer: { services: ["website"], description: "fake offer for checks only" },
    icp: { categories: ["wedding"], cities: ["Fake City"], countries: ["IN"] },
  });

  const feed = feedsMod.createFeed({
    workspaceId: workspace.id,
    name: "Fake Wedding Feed",
    nichePackId: "fake-pack",
    categories: ["wedding"],
    cities: ["Fake City"],
    perRunTarget: 10,
    schedule: { kind: "daily" },
  });

  await check("createFeed stores the feed with target 10 and a daily schedule", () => {
    assert.equal(feed.perRunTarget, 10);
    assert.equal(feed.schedule.kind, "daily");
    assert.equal(feed.enabled, true);
    assert.equal(feed.cursor.hunted.length, 0);
    const listed = feedsMod.listFeeds({ workspaceId: workspace.id });
    assert.ok(listed.some((f) => f.id === feed.id));
  });

  let run1!: import("./feeds.js").FeedRun;
  await check("runFeed on day 1 honours the quota and records the failing source", async () => {
    run1 = await feedsMod.runFeed(feed.id, depsFor(DAY1));
    assert.equal(run1.status, "done");
    assert.equal(run1.delivered, 10, `delivered ${run1.delivered}`);
    assert.equal(run1.newLeads, 10);
    assert.ok(run1.error && /Area A/.test(run1.error), `error was ${run1.error}`);
    assert.equal(deliveredCount(feed.id), 10);
  });

  await check("a second runFeed on the same day is idempotent (returns the earlier run)", async () => {
    const again = await feedsMod.runFeed(feed.id, depsFor(DAY1));
    assert.equal(again.id, run1.id);
    assert.equal(deliveredCount(feed.id), 10, "no extra delivery on the same day");
  });

  const run1Keys = deliveredKeys(feed.id);
  const queriedBeforeRun2 = queried.length;

  let run2!: import("./feeds.js").FeedRun;
  await check("runFeed on day 2 delivers no repeats and rotates to fresh areas", async () => {
    run2 = await feedsMod.runFeed(feed.id, depsFor(DAY2));
    assert.equal(run2.status, "done");
    assert.equal(run2.delivered, 10, `delivered ${run2.delivered}`);
    const run2Keys = deliveredKeys(feed.id);
    assert.equal(run2Keys.length, 20);
    assert.equal(new Set(run2Keys).size, 20, "no repeated bizKey across runs");
    const run1Set = new Set(run1Keys);
    const fresh = run2Keys.filter((k) => !run1Set.has(k));
    assert.equal(fresh.length, 10, "day 2 added ten leads never delivered before");
    assert.equal(run1Keys.filter((k) => run2Keys.includes(k)).length, 10, "day 1 deliveries remain");
    const run2Queried = queried.slice(queriedBeforeRun2);
    assert.ok(!run2Queried.includes("Fake City|Area A"), `day 2 must not re-hunt Area A: ${run2Queried.join(", ")}`);
    assert.ok(!run2Queried.includes("Fake City|Area B"), `day 2 must not re-hunt Area B: ${run2Queried.join(", ")}`);
    assert.ok(run2Queried.includes("Fake City|Area C"), "day 2 rotates to Area C");
  });

  await check("the feed cursor rotates the hunted targets", () => {
    const current = feedsMod.getFeed(feed.id);
    assert.ok(current);
    const hunted = current.cursor.hunted;
    assert.ok(hunted.some((h) => h.endsWith("|area a")));
    assert.ok(hunted.some((h) => h.endsWith("|area b")));
    assert.ok(hunted.some((h) => h.endsWith("|area c")));
    assert.ok(current.cursor.hunted.length >= 3);
  });

  // ---- hard limits -------------------------------------------------------
  const capFeed = feedsMod.createFeed({
    workspaceId: workspace.id,
    name: "Fake Cap Feed",
    nichePackId: "fake-pack",
    categories: ["wedding"],
    cities: ["Fake City"],
    perRunTarget: 500,
    schedule: { kind: "daily" },
  });
  await check("at most 200 raw candidates are collected per run", async () => {
    const run = await feedsMod.runFeed(capFeed.id, depsFor(DAY1, { runDiscovery: bigDiscovery }));
    assert.equal(run.found, 200, `found ${run.found}`);
    assert.equal(run.newLeads, 200, `newLeads ${run.newLeads}`);
    assert.equal(run.delivered, 200);
  });

  const targetCapFeed = feedsMod.createFeed({
    workspaceId: workspace.id,
    name: "Fake Target Cap Feed",
    nichePackId: "fake-pack",
    categories: ["wedding"],
    cities: ["Fake City"],
    perRunTarget: 100000,
    schedule: { kind: "daily" },
  });
  await check("at most 40 hunt targets are visited per run (2 here)", async () => {
    visitedTargets.length = 0;
    const run = await feedsMod.runFeed(targetCapFeed.id, depsFor(DAY1, { runDiscovery: bigDiscovery, maxTargets: 2 }));
    assert.equal(run.found, 200, `found ${run.found}`); // 2 targets x 100 leads
    assert.equal(visitedTargets.length, 2, `visited ${visitedTargets.length} targets`);
  });

  // ---- scheduling --------------------------------------------------------
  const dailyFeed = feedsMod.createFeed({
    workspaceId: workspace.id,
    name: "Fake Daily Feed",
    nichePackId: "fake-pack",
    categories: ["wedding"],
    cities: ["Fake City"],
    perRunTarget: 3,
    schedule: { kind: "daily" },
  });
  const weeklyFeed = feedsMod.createFeed({
    workspaceId: workspace.id,
    name: "Fake Weekly Feed",
    nichePackId: "fake-pack",
    categories: ["wedding"],
    cities: ["Fake City"],
    perRunTarget: 3,
    schedule: { kind: "weekly", weekday: DAY3.getUTCDay() },
  });
  const disabledFeed = feedsMod.createFeed({
    workspaceId: workspace.id,
    name: "Fake Disabled Feed",
    nichePackId: "fake-pack",
    categories: ["wedding"],
    cities: ["Fake City"],
    perRunTarget: 3,
    schedule: { kind: "daily" },
  });

  await check("dueFeeds respects daily and weekly schedules and the enabled flag", () => {
    feedsMod.setFeedEnabled(disabledFeed.id, false);
    assert.equal(feedsMod.getFeed(disabledFeed.id)?.enabled, false);

    const due3 = feedsMod.dueFeeds(DAY3).map((f) => f.id);
    assert.ok(due3.includes(dailyFeed.id), "daily feed is due on day 3");
    assert.ok(due3.includes(weeklyFeed.id), "weekly feed matched on its weekday");
    assert.ok(!due3.includes(disabledFeed.id), "disabled feed is never due");

    const due2 = feedsMod.dueFeeds(DAY2).map((f) => f.id);
    assert.ok(!due2.includes(weeklyFeed.id), "weekly feed is not due on another weekday");
  });

  await check("a feed that already ran today is not due again", async () => {
    await feedsMod.runFeed(dailyFeed.id, depsFor(DAY3));
    const due3 = feedsMod.dueFeeds(DAY3).map((f) => f.id);
    assert.ok(!due3.includes(dailyFeed.id), "ran today, so not due");
    const due4 = feedsMod.dueFeeds(new Date("2026-10-15T08:00:00Z")).map((f) => f.id);
    assert.ok(due4.includes(dailyFeed.id), "due the next day");
  });

  // ---- routes ------------------------------------------------------------
  await check("the routes answer: create, list, get, due, run, list runs, unknown path", async () => {
    let routeDeps: FeedDeps = depsFor(DAY3);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void routes
        .handleFeedRequest(req, res, url, routeDeps)
        .then((handled) => {
          if (!handled) {
            res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "not found" }));
          }
        })
        .catch((err: unknown) => {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const created = await fetch(`${base}/api/feeds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          name: "Route Feed",
          nichePackId: "fake-pack",
          categories: ["wedding"],
          cities: ["Fake City"],
          perRunTarget: 5,
          schedule: { kind: "daily" },
        }),
      });
      assert.equal(created.status, 201);
      const feedBody = (await created.json()) as { id: string };
      assert.ok(feedBody.id);

      const list = await fetch(`${base}/api/feeds?workspaceId=${workspace.id}`);
      assert.equal(list.status, 200);
      const listBody = (await list.json()) as { feeds: Array<{ id: string }> };
      assert.ok(listBody.feeds.some((f) => f.id === feedBody.id));

      const one = await fetch(`${base}/api/feeds/${feedBody.id}`);
      assert.equal(one.status, 200);
      assert.equal(((await one.json()) as { id: string }).id, feedBody.id);

      const due = await fetch(`${base}/api/feeds/due`);
      assert.equal(due.status, 200);
      assert.ok(Array.isArray(((await due.json()) as { feeds: unknown[] }).feeds));

      const runRes = await fetch(`${base}/api/feeds/${feedBody.id}/run`, { method: "POST" });
      assert.equal(runRes.status, 201);
      assert.equal(((await runRes.json()) as { feedId: string }).feedId, feedBody.id);

      const runs = await fetch(`${base}/api/feeds/${feedBody.id}/runs`);
      assert.equal(runs.status, 200);
      const runsBody = (await runs.json()) as { runs: unknown[] };
      assert.ok(runsBody.runs.length >= 1);

      const missing = await fetch(`${base}/api/feeds/does-not-exist`);
      assert.equal(missing.status, 404);

      const notOwned = await fetch(`${base}/api/not-a-feed-route`);
      assert.equal(notOwned.status, 404, "a path this module does not own falls through");
    } finally {
      routeDeps = {};
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

// ------------------------------------------------------------------ run

await main();

store.closeDb();
rmSync(DB_FILE, { force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
