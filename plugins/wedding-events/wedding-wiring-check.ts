// Order WEW-wiring proof: offline check that the wedding & event channel
// adapters built by orders WE2..WE9 are registered and usable by the runner
// for the wedding/event niche (niche pack, signals, discovery run).
//
// Everything is injected: the fake search only answers the web-search discovery
// adapter's own queries, the fake readPage serves clearly fake fixtures
// (fixture-shared-vendor.example and the two directory card shapes), so nothing
// dials out. Does not import src/company/, so no sandbox preamble is needed.
//
// Run (from the repo root):
//   npx tsx plugins/wedding-events/wedding-wiring-check.ts

import "../../src/channels/index.js"; // side-effect: self-registers every channel adapter

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { channelAdapters, adaptersFor, runDiscovery } from "../../src/channels/registry.js";
import { buildQueries as websearchBuildQueries } from "./ch-websearch-discovery.js";
import type { ChannelAdapter, ChannelDeps } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import type { ReachResult } from "../../src/reach.js";

// ---- the adapters this order wires (WE2..WE9) -------------------------------

const WIRED: { file: string; id: string; env: string }[] = [
  { file: "ch-wedmegood.js", id: "ch-wedmegood", env: "CHANNEL_CH_WEDMEGOOD" },
  { file: "ch-weddingwire-in.js", id: "ch-weddingwire-in", env: "CHANNEL_CH_WEDDINGWIRE_IN" },
  { file: "ch-weddingsutra.js", id: "ch-weddingsutra", env: "CHANNEL_CH_WEDDINGSUTRA" },
  { file: "ch-venues.js", id: "ch-venues", env: "CHANNEL_CH_VENUES" },
  { file: "ch-expos-awards.js", id: "ch-expos-awards", env: "CHANNEL_CH_EXPOS_AWARDS" },
  { file: "ch-event-organisers.js", id: "ch-event-organisers", env: "CHANNEL_CH_EVENT_ORGANISERS" },
  { file: "ch-instagram-vendors.js", id: "ch-instagram-vendors", env: "CHANNEL_CH_INSTAGRAM_VENDORS" },
  { file: "ch-websearch-discovery.js", id: "ch-websearch-discovery", env: "CHANNEL_CH_WEBSEARCH_DISCOVERY" },
];

const CATEGORIES = ["wedding-planner", "banquet-hall", "event-company"];
const WEBSEARCH_ID = "ch-websearch-discovery";

const channelDirs = ["./", "../browser-social/", "../../src/channels/"].map((d) => fileURLToPath(new URL(d, import.meta.url)));

// ---- fixtures (clearly fake; real directory card shapes) --------------------

const SHARED_NAME = "Fixture Shared Vendor";

// WedMeGood card: [[Name](profile-url "Name") ...]  (no price label -> no area
// field, so the lead carries the query city only).
const WEDMEGOOD_PAGE =
  `[[${SHARED_NAME}](https://www.wedmegood.com/profile/Fixture-Shared-Vendor-1 "${SHARED_NAME}") 4.9(10 reviews)](https://www.wedmegood.com/profile/Fixture-Shared-Vendor-1)\n`;

// WeddingWire card: [Name](...--e<id>) with a "· <city>" location line (no
// comma -> area stays undefined, city falls back to the query city).
const WEDDINGWIRE_PAGE =
  `[${SHARED_NAME}](https://www.weddingwire.in/wedding-planners/mumbai/fixture-shared-vendor--e12345)\n`
  + `· Mumbai\n`;

// Web-search candidate page: schema.org LocalBusiness JSON-LD.
const WEBSEARCH_PAGE =
  `<html><head><title>${SHARED_NAME}</title>`
  + `<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"${SHARED_NAME}","address":"Mumbai"}</script>`
  + `</head><body><h1>${SHARED_NAME}</h1><p>Wedding planner in Mumbai.</p></body></html>`;

const WEBSEARCH_URL = "https://fixture-shared-vendor.example/";
const NO_CARDS = "No vendor listings on this page.";

const WEBSEARCH_QUERIES = new Set(websearchBuildQueries({ category: "wedding-planner", city: "Mumbai" }));

// ---- fakes ------------------------------------------------------------------

function ok(text: string): Promise<ReachResult> {
  return Promise.resolve({ ok: true, channel: "fixture", text, untrusted: true, trace: [] });
}
function blocked(): Promise<ReachResult> {
  return Promise.resolve({ ok: false, channel: "fixture", text: "HTTP 403 blocked", untrusted: true, trace: [], error: "HTTP 403" });
}

function fakeSearch(query: string): Promise<ReachResult> {
  if (WEBSEARCH_QUERIES.has(query)) {
    return Promise.resolve({
      ok: true, channel: "fixture", text: "search results", untrusted: true, trace: [],
      results: [{ title: SHARED_NAME, url: WEBSEARCH_URL, untrusted: true }],
    });
  }
  return blocked(); // every other channel's search is blocked
}

function fakeReadPage(url: string): Promise<ReachResult> {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { /* not a URL */ }
  if (host.endsWith("wedmegood.com")) {
    return /[?&]page=1\b/.test(url) ? ok(WEDMEGOOD_PAGE) : ok(NO_CARDS);
  }
  if (host.endsWith("weddingwire.in")) {
    return /[?&]page=/.test(url) ? ok(NO_CARDS) : ok(WEDDINGWIRE_PAGE);
  }
  if (host === "fixture-shared-vendor.example") return ok(WEBSEARCH_PAGE);
  return ok(NO_CARDS);
}

function fakeDeps(): ChannelDeps {
  return {
    search: fakeSearch,
    readPage: fakeReadPage,
    limiter: { sleep: async () => { /* no-op: offline */ } },
    now: () => Date.parse("2026-10-12T00:00:00Z"),
  };
}

// ---- pass / fail bookkeeping ------------------------------------------------

let passed = 0;
function pass(n: number, name: string): void {
  passed += 1;
  console.log(`PASS ${n} ${name}`);
}
function fail(n: number, name: string, err: unknown): void {
  console.log(`FAIL ${n} ${name}: ${(err as Error).message}`);
  throw err;
}

function byId(id: string): ChannelAdapter | undefined {
  return channelAdapters().find((a) => a.id === id);
}

async function main(): Promise<void> {
  // save + clear the wired env vars first so "off by default" is meaningful
  const saved = new Map<string, string | undefined>();
  for (const w of WIRED) {
    saved.set(w.env, process.env[w.env]);
    delete process.env[w.env];
  }

  // The import specifier uses a ".js" suffix (ES modules), but the sources on
  // disk are ".ts"; a wired file counts as present when either exists.
  const onDisk = (file: string): boolean =>
    channelDirs.some((d) => existsSync(`${d}${file}`) || existsSync(`${d}${file.replace(/\.js$/, ".ts")}`));
  const existing = WIRED.filter((w) => onDisk(w.file));
  const missing = WIRED.filter((w) => !onDisk(w.file));
  console.log(`wired adapters present on disk: ${existing.length}/${WIRED.length}`);
  if (missing.length) console.log(`skipped (missing on disk): ${missing.map((w) => w.file).join(", ")}`);

  try {
    // 1. each existing adapter is registered exactly once
    try {
      for (const w of existing) {
        const count = channelAdapters().filter((a) => a.id === w.id).length;
        assert.equal(count, 1, `${w.file} (${w.id}) registered ${count} time(s), want exactly 1`);
      }
      pass(1, `each of the ${existing.length} wired adapter file(s) on disk is registered exactly once`);
    } catch (err) {
      fail(1, "each wired adapter is registered exactly once", err);
    }

    // 2. adaptersFor returns >=3 per category, web-search included
    try {
      for (const cat of CATEGORIES) {
        const list = await adaptersFor(cat);
        assert.ok(list.length >= 3, `adaptersFor("${cat}") returned ${list.length}, want >= 3`);
        assert.ok(list.some((a) => a.id === WEBSEARCH_ID), `adaptersFor("${cat}") must include ${WEBSEARCH_ID}`);
        for (const a of list) {
          assert.ok(a.categories.includes(cat) || a.categories.includes("any"), `${a.id} offered for "${cat}" without declaring it`);
        }
      }
      pass(2, `adaptersFor each of wedding-planner/banquet-hall/event-company returns >= 3 adapters incl web-search`);
    } catch (err) {
      fail(2, "adaptersFor returns >= 3 adapters incl web-search per niche category", err);
    }

    // 3. all wired adapters are disabled by default
    try {
      for (const w of existing) {
        const a = byId(w.id);
        assert.ok(a, `${w.id} not registered`);
        assert.equal(a.status().enabled, false, `${w.id} is enabled without ${w.env}`);
      }
      pass(3, "all wired adapters are disabled by default (env-gated, integrations OFF)");
    } catch (err) {
      fail(3, "all wired adapters are disabled by default", err);
    }

    // 4. forced-on runDiscovery merges the shared business into one lead
    try {
      for (const w of WIRED) process.env[w.env] = "1";
      const deps = fakeDeps();

      // prove the same business is offered by at least two channels
      const producers: string[] = [];
      for (const id of ["ch-wedmegood", "ch-weddingwire-in", WEBSEARCH_ID]) {
        const a = byId(id);
        assert.ok(a, `${id} not registered`);
        const own = await a.discover({ category: "wedding-planner", city: "Mumbai", limit: 20 }, deps);
        if (own.some((l) => l.name === SHARED_NAME)) producers.push(id);
      }
      assert.ok(producers.length >= 2, `shared business produced by only: [${producers.join(", ")}]`);

      const budget = 60;
      const result = await runDiscovery({ category: "wedding-planner", city: "Mumbai", limit: 20 }, deps, { callBudget: budget });
      assert.ok(result.callsUsed <= budget, `callsUsed ${result.callsUsed} exceeds budget ${budget}`);
      const shared = result.leads.filter((l: RawLead) => l.name === SHARED_NAME);
      assert.equal(shared.length, 1, `shared business appears ${shared.length} time(s), want 1 merged lead`);
      pass(4, `forced-on runDiscovery merges the same business from ${producers.length} channels into one lead (callsUsed ${result.callsUsed}/${budget})`);
    } catch (err) {
      fail(4, "forced-on runDiscovery returns merged, de-duplicated leads within budget", err);
    } finally {
      for (const w of WIRED) {
        const v = saved.get(w.env);
        if (v === undefined) delete process.env[w.env]; else process.env[w.env] = v;
      }
    }

    // 5. a category no adapter declares returns [] without a throw
    try {
      const cat = "pet-grooming-no-channel";
      assert.ok(channelAdapters().every((a) => !a.categories.includes(cat)), `some adapter declares "${cat}"`);
      const result = await runDiscovery({ category: cat, city: "Mumbai" }, fakeDeps());
      assert.deepEqual(result.leads, [], "runDiscovery returned leads for an unclaimed category");
      pass(5, "a category with no dedicated adapter returns [] without a throw");
    } catch (err) {
      fail(5, "a category with no adapter returns [] without a throw", err);
    }
  } finally {
    for (const w of WIRED) {
      const v = saved.get(w.env);
      if (v === undefined) delete process.env[w.env]; else process.env[w.env] = v;
    }
  }

  console.log(`PASS ${passed}/5 wedding-wiring-check (Order WEW-wiring)`);
}

main().catch((err) => {
  console.log(`FAIL: ${(err as Error).message}`);
  process.exitCode = 1;
});
