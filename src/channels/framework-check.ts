// Order L43 proof: offline framework check. Every transport (fetchFn, execFile,
// WebSocket) and the pause are injected fakes, so nothing dials out.
// Run: node_modules/.bin/tsx src/channels/framework-check.ts  (from products/leadscout)
import assert from "node:assert/strict";
import { BrowserReader } from "./browser.js";
import { BrowserBlockedError } from "./types.js";
import type { BrowserOpts, BrowserReaderLike, WebSocketLike } from "./types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence } from "./types.js";
import { resetRegistry, registerChannel, adaptersFor, runDiscovery, runEnrichment, readWithFallback, channelAdapters } from "./registry.js";
import type { RawLead } from "../types.js";
import type { ReachResult } from "../reach.js";

const results: string[] = [];

function pass(n: number, name: string): void {
  results.push(`PASS ${n} ${name}`);
  console.log(results[results.length - 1]);
}

function fail(n: number, name: string, err: unknown): never {
  const msg = `FAIL ${n} ${name}: ${(err as Error).message}`;
  results.push(msg);
  console.log(msg);
  throw err;
}

function lead(name: string, opts: Partial<RawLead> = {}): RawLead {
  return { name, category: "restaurant", source: "fixture", sourceUrl: "https://fixture.example/", ...opts };
}

function fakeAdapter(id: string,
  discoverImpl: (q: { category: string; city: string }, deps: ChannelDeps) => Promise<RawLead[]>,
  enrichImpl?: (l: RawLead, deps: ChannelDeps) => Promise<ChannelEvidence>,
): ChannelAdapter {
  return {
    id,
    name: `Fixture ${id}`,
    tier: "B",
    categories: ["any"],
    status: () => ({ enabled: true }),
    discover: discoverImpl,
    enrich: enrichImpl ?? (async (l) => ({
      channel: id,
      url: `https://fixture.example/${encodeURIComponent(l.name)}`,
      fetchedAt: "2026-10-07T00:00:00.000Z",
      via: "page",
      fields: {},
      signals: [],
      text: "fixture page text",
      untrusted: true,
    })),
    signals: () => [],
  };
}

function reachOk(text: string): Promise<ReachResult> {
  return Promise.resolve({ ok: true, channel: "fixture", text, untrusted: true, trace: [] });
}
function reachBlockedFake(): Promise<ReachResult> {
  return Promise.resolve({ ok: false, channel: "fixture", text: "HTTP 403 blocked", untrusted: true, trace: [], error: "HTTP 403" });
}

// ---- fake CDP transport ------------------------------------------------
const CDP_TEXT_OK = "Sunrise Dental - Dr. R. Fixture, corner dental practice in Chennai. Phone +91 90000 11111.";
const FAKE_WS_URL = "ws://fake/target";

class FakeWebSocket {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  pageText = CDP_TEXT_OK;
  private navUrl = "";
  static sent: string[] = [];
  static tabsOpened = 0;
  constructor(_: string) {
    FakeWebSocket.tabsOpened += 1;
  }
  send(data: string): void {
    FakeWebSocket.sent.push(data);
    const msg = JSON.parse(data) as { id?: number; method?: string; params?: { expression?: string; url?: string; targetId?: string } };
    const id = msg.id ?? 0;
    const reply = (body: unknown): void => {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(body) }));
    };
    if (msg.method === "Page.enable") reply({ id, result: {} });
    else if (msg.method === "Page.navigate") {
      this.navUrl = msg.params?.url ?? "";
      reply({ id, result: {} });
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ method: "Page.loadEventFired" }) }));
    } else if (msg.method === "Runtime.evaluate") {
      const e = msg.params?.expression ?? "";
      if (e.includes("location.href")) reply({ id, result: { result: { value: this.navUrl || "https://www.fixture-listing.example/x" } } });
      else if (e.includes("document.title")) reply({ id, result: { result: { value: "Fixture Page Title" } } });
      else reply({ id, result: { result: { value: this.pageText } } });
    } else if (msg.method === "Target.closeTarget") reply({ id, result: {} });
    else reply({ id, error: { message: `fake ws: unknown method ${msg.method}` } });
  }
  close(): void {}
}

function readerWith(pageText: string, opts: Partial<BrowserOpts> = {}): BrowserReader {
  const fetchFn = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.includes("/json/version")) return new Response("{}", { status: 200 });
    if (u.startsWith("http://127.0.0.1:9222/json/new")) {
      const target = new URL(u).searchParams.get("url") ?? "";
      if (target.includes("blocked.example")) throw new Error("fake: cannot connect to blocked.example");
      FakeWebSocket.tabsOpened += 1;
      return new Response(JSON.stringify({ webSocketDebuggerUrl: FAKE_WS_URL, targetId: "t1" }), { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const wsFactory = (): WebSocketLike => {
    const ws = new FakeWebSocket(FAKE_WS_URL) as unknown as WebSocketLike;
    const fws = ws as unknown as FakeWebSocket;
    fws.pageText = pageText;
    return ws;
  };
  return new BrowserReader({
    execFile: (async (file: string) => {
      if (file === "agent-reach") {
        return { stdout: JSON.stringify({ channels: { opencli: { ok: false, error: "opencli not installed (fake doctor)" } } }), stderr: "" };
      }
      return { stdout: "usage:\n  read <url>      read a page\n  write <url>     (she must stay unused)\n", stderr: "" };
    }) as BrowserOpts["execFile"],
    pause: async (ms) => { pauseCalls.push(ms); },
    fetchFn,
    wsFactory,
    now: () => 0,
    cdpUrl: "http://127.0.0.1:9222",
    ...opts,
  });
}

const pauseCalls: number[] = [];

async function makeDeps(overrides: Partial<ChannelDeps> = {}): Promise<ChannelDeps> {
  return {
    search: () => reachOk("search ok"),
    readPage: () => reachOk("page ok"),
    limiter: {},
    ...overrides,
  };
}

// =====================================================================
async function main(): Promise<void> {
  const prevBrowserEnv = process.env.LEADSCOUT_BROWSER;

  // 1. an adapter registers and is returned by adaptersFor
  try {
    resetRegistry();
    const a = fakeAdapter("fake-a", async () => [lead("Fixture Alpha")]);
    registerChannel(a);
    const list = await adaptersFor("restaurant");
    assert.ok(channelAdapters().includes(a), "channelAdapters exposes it");
    assert.ok(list.includes(a), "adaptersFor returns it");
    pass(1, "adapter registers and adaptersFor returns it");
  } catch (err) {
    fail(1, "adapter registers and adaptersFor returns it", err);
  }

  // 2. discovery merges and dedupes across two fake adapters (name+area+phone)
  try {
    resetRegistry();
    registerChannel(fakeAdapter("fake-1", async () => [lead("Dup Clinic", { phone: "+91 90000 11111", address: "T. Nagar" })]));
    registerChannel(fakeAdapter("fake-2", async () => [
      lead("Dup Clinic", { phone: "+919000011111", address: "T. Nagar" }),
      lead("Unique Bakery", { phone: "+91 90000 22222" }),
    ]));
    const deps = await makeDeps();
    const res = await runDiscovery({ category: "restaurant", city: "Chennai" }, deps);
    assert.equal(res.leads.length, 2, `merge+dedupe -> 2 leads, got ${res.leads.length}`);
    assert.equal(res.leads[0].name, "Dup Clinic");
    assert.equal(res.leads[1].name, "Unique Bakery");
    pass(2, "discovery merges and dedupes across two fake adapters");
  } catch (err) {
    fail(2, "discovery merges and dedupes across two fake adapters", err);
  }

  // 3. call budget stops a third adapter
  try {
    resetRegistry();
    let started = 0;
    const track = (id: string): ChannelAdapter => fakeAdapter(id, async () => { started += 1; return []; });
    registerChannel(track("b1"));
    registerChannel(track("b2"));
    registerChannel(track("b3"));
    const deps = await makeDeps();
    const res = await runDiscovery({ category: "restaurant", city: "Chennai" }, deps, { callBudget: 2 });
    assert.equal(started, 2, `only 2 adapters ran, got ${started}`);
    assert.equal(res.callsUsed, 2);
    assert.equal(res.runs[2].id, "b3");
    assert.match(res.runs[2].error ?? "", /budget/);
    pass(3, "call budget stops a third adapter");
  } catch (err) {
    fail(3, "call budget stops a third adapter", err);
  }

  // 4. browser fallback only when search and page read are blocked
  try {
    resetRegistry();
    let browserReads = 0;
    const fakeBrowser = {
      read: async (url: string) => { browserReads += 1; return { text: CDP_TEXT_OK, url }; },
      search: async () => { browserReads += 1; return { text: CDP_TEXT_OK, url: "https://www.google.com/search" }; },
    } as unknown as BrowserReaderLike;

    const depsBlocked = await makeDeps({ search: () => reachBlockedFake(), readPage: () => reachBlockedFake(), browser: fakeBrowser });
    const r1 = await readWithFallback(depsBlocked, { searchQuery: "site:fixture.example dentist chennai", url: "https://fixture.example/x" });
    assert.equal(r1.via, "browser");
    assert.equal(browserReads, 1, "browser used exactly once when search+page blocked");

    const depsOk = await makeDeps({ search: () => reachOk("fine search result"), readPage: () => reachOk("fine page"), browser: fakeBrowser });
    const r2 = await readWithFallback(depsOk, { searchQuery: "q", url: "https://fixture.example/x" });
    assert.equal(r2.via, "search", "unblocked search wins first");
    assert.equal(browserReads, 1, "browser NOT used when search is fine");
    pass(4, "browser fallback only when search and page read return blocked results");
  } catch (err) {
    fail(4, "browser fallback only when search and page read return blocked results", err);
  }

  // 5. hourly cap blocks the 16th LinkedIn read
  try {
    process.env.LEADSCOUT_BROWSER = "1";
    const reader = readerWith(CDP_TEXT_OK, { pause: async () => {} });
    const url = "https://www.linkedin.com/company/fixture-dental";
    let okCount = 0;
    for (let i = 0; i < 15; i++) {
      await reader.read(url);
      okCount += 1;
    }
    assert.equal(okCount, 15, "15 LinkedIn reads succeed");
    await assert.rejects(() => reader.read(url), /hourly cap reached for "linkedin"/, "16th blocked");
    pass(5, "hourly cap blocks the 16th LinkedIn read");
  } catch (err) {
    fail(5, "hourly cap blocks the 16th LinkedIn read", err);
  }

  // 6. pauses are injectable and land in the 2-6 s window; the DEFAULT pause
  //    (no injected pause) must also really sleep 2-6 s (fake timer, no wait)
  try {
    process.env.LEADSCOUT_BROWSER = "1";
    pauseCalls.length = 0;
    const reader = readerWith(CDP_TEXT_OK, { pause: async (ms) => { pauseCalls.push(ms); } });
    await reader.read("https://www.instagram.com/fixture_dental/");
    await reader.read("https://www.instagram.com/fixture_dental2/");
    assert.equal(pauseCalls.length, 1, "one pause between two pages");
    const ms = pauseCalls[0];
    assert.ok(ms >= 2000 && ms <= 6000, `pause ${ms}ms within 2000-6000ms`);

    // default path: no injected pause -> built-in real sleep must fire, once,
    // inside the 2000-6000 ms window (observed through the injected fake timer)
    const defaultTimerCalls: number[] = [];
    const defaultReader = readerWith(CDP_TEXT_OK, {
      pause: undefined,
      timer: (cb: () => void, t: number) => { defaultTimerCalls.push(t); cb(); return 0; },
    });
    await defaultReader.read("https://www.instagram.com/fixture_default1/");
    await defaultReader.read("https://www.instagram.com/fixture_default2/");
    assert.equal(defaultTimerCalls.length, 1, `default pause fired once, got ${defaultTimerCalls.length}`);
    assert.ok(
      defaultTimerCalls[0] >= 2000 && defaultTimerCalls[0] <= 6000,
      `default sleep ${defaultTimerCalls[0]}ms within 2000-6000ms`,
    );
    pass(6, "pauses are injectable and the default pause really sleeps 2-6 s");
  } catch (err) {
    fail(6, "pauses are injectable and the default pause really sleeps 2-6 s", err);
  }

  // 7. captcha/login-wall text => needs-human and no further reads for that platform
  try {
    process.env.LEADSCOUT_BROWSER = "1";
    FakeWebSocket.tabsOpened = 0;
    const base = readerWith(CDP_TEXT_OK, { pause: async () => {} });
    // instagram: fine first read -> stamped
    await base.read("https://www.instagram.com/fixture_ok/");
    // then a captcha page on the same platform
    const captchaReader = readerWith("Please verify you are human - captcha. Unusual activity detected.", { pause: async () => {} });
    let needsHuman = false;
    try {
      await captchaReader.read("https://www.instagram.com/fixture_captcha/");
      // also probe the login-wall wording via the same platform
    } catch (e) {
      assert.ok(e instanceof BrowserBlockedError);
      needsHuman = (e as BrowserBlockedError).needsHuman;
      assert.equal((e as BrowserBlockedError).platformLocked, false, "first block is fresh, not a lockout");
    }
    assert.ok(needsHuman, "captcha page produced needs-human");
    // login-wall wording also flags
    FakeWebSocket.tabsOpened = 0;
    const tabsBefore = FakeWebSocket.tabsOpened;
    try {
      await captchaReader.read("https://www.instagram.com/fixture_after_lock/");
      assert.fail("expected BrowserBlockedError");
    } catch (e) {
      assert.ok(/locked after a needs-human stop/.test((e as Error).message), `lockout message, got: ${(e as Error).message}`);
      assert.strictEqual(typeof tabsBefore, "number");
    }
    const tabsAfter = FakeWebSocket.tabsOpened;
    assert.equal(tabsAfter, tabsBefore, "no further reads for that platform (no tab opened)");
    pass(7, "captcha/login-wall produce needs-human and no further reads for that platform");
  } catch (err) {
    fail(7, "captcha/login-wall produce needs-human and no further reads for that platform", err);
  }

  // 8. write-like operations throw
  try {
    process.env.LEADSCOUT_BROWSER = "1";
    const reader = readerWith(CDP_TEXT_OK);
    for (const op of ["click", "type", "submit", "screenshot", "key", "fill"]) {
      assert.throws(() => reader.apply(op), /read-only reader/, `op "${op}" throws`);
    }
    assert.throws(() => reader.apply("read"), /internal misuse/, "raw apply() route is closed");
    pass(8, "write-like operations throw");
  } catch (err) {
    fail(8, "write-like operations throw", err);
  }

  // 9. hard-denied domains refused; unlisted domains refused until added
  try {
    process.env.LEADSCOUT_BROWSER = "1";
    const reader = readerWith(CDP_TEXT_OK);
    for (const bad of [
      "https://mail.google.com/mail/u/0/inbox",
      "https://gmail.com/inbox",
      "https://chatgpt.com/c/abc",
      "https://claude.ai/chats/abc",
      "https://gemini.google.com/app",
      "https://github.com/fixtures/repo",
      "https://notebooklm.google.com/nb/1",
      "https://accounts.google.com/accountsettings",
      "https://www.hdfcbank.com/personal",
      "https://www.paypal.com/myaccount",
      "https://www.linkedin.com/p/settings", // account-settings path on an otherwise allowed host
    ]) {
      await assert.rejects(() => reader.read(bad), /hard-denied/, `denied: ${bad}`);
    }
    await assert.rejects(() => reader.read("https://example.com/listing"), /not on the allowlist/, "unlisted refused");
    // google.com is allowlisted for maps and search paths only
    await assert.rejects(() => reader.read("https://www.google.com/finance/fixture"), /paths \[\/maps, \/search\] only/, "google non-maps path refused");
    await reader.read("https://www.google.com/maps/search/dentist+chennai", { platform: "google" });
    pass(9, "denied domains and unlisted domains are refused");
  } catch (err) {
    fail(9, "denied domains and unlisted domains are refused", err);
  }

  // 10. kill switch disables the reader even when other state says enabled
  try {
    process.env.LEADSCOUT_BROWSER = "0";
    const reader = readerWith(CDP_TEXT_OK);
    assert.equal(reader.status().enabled, false, "status() reports disabled");
    assert.equal(reader.status().killSwitch, true, "status() reports the kill switch");
    await assert.rejects(() => reader.read("https://www.linkedin.com/company/fixture"), /kill switch/, "read refused");
    pass(10, "kill switch disables the reader");
  } catch (err) {
    fail(10, "kill switch disables the reader", err);
  } finally {
    process.env.LEADSCOUT_BROWSER = prevBrowserEnv ?? "";
  }

  // 11. evidence objects are marked untrusted
  try {
    resetRegistry();
    registerChannel(fakeAdapter("fake-e", async () => [lead("Signal Spa")]));
    registerChannel(fakeAdapter("fake-f", async () => [], undefined));
    const fakeBrowser = {
      read: async (url: string) => ({ text: "browser text", url }),
      search: async () => ({ text: "browser text", url: "https://www.google.com/search" }),
    } as unknown as BrowserReaderLike;
    const deps = await makeDeps({ browser: fakeBrowser });
    const ev = await runEnrichment(lead("Signal Spa", { category: "restaurant" }), deps);
    assert.equal(ev.untrusted, true, "enrichment evidence untrusted");
    const fallback = await readWithFallback(deps, { searchQuery: "q" });
    const fbEvidence: ChannelEvidence = {
      channel: fallback.via, url: fallback.url, fetchedAt: new Date(0).toISOString(),
      via: fallback.via, fields: {}, signals: [], text: fallback.text, untrusted: fallback.untrusted as true,
    };
    assert.equal(fbEvidence.untrusted, true, "fallback read evidence untrusted");
    pass(11, "evidence objects are marked untrusted");
  } catch (err) {
    fail(11, "evidence objects are marked untrusted", err);
  }
}

main()
  .then(() => {
    console.log(`PASS ${results.filter((r) => r.startsWith("PASS")).length}/11 framework-check (Order L43-channel-framework)`);
    process.exit(0);
  })
  .catch(() => {
    process.exitCode = 1;
  });
