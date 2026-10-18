// src/channels/live-deps.ts
// Order LG4-feed-live-wiring: build the real ChannelDeps for a live feed run.
//
// Same sources the live probe uses (see src/channel-probe.ts `buildLiveDeps`,
// which this module mirrors without editing it): `search` from src/reach.ts
// `searchWeb`, page reads from `readPage`, a real-timer limiter, and the
// BrowserReader only when LEADSCOUT_BROWSER=1.
//
// No top-level side effects and no network at import: the reach and browser
// modules are dynamically imported inside `makeLiveDeps`, so importing this
// file never dials out. Everything live stays OFF by default; callers switch
// it on with env LEADSCOUT_FEEDS_LIVE=1 (feeds.ts) and LEADSCOUT_BROWSER=1.

import type { ChannelDeps } from "./types.js";

export type LiveDepsEnv = Record<string, string | undefined>;

/** Real-timer limiter: the shared per-host spacing adapters rely on. */
function realLimiter(): ChannelDeps["limiter"] {
  return { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
}

/** The operator's own logged-in browser, only when they opted in with
 *  LEADSCOUT_BROWSER=1. LEADSCOUT_BROWSER=0 is a hard kill switch. */
async function maybeBrowser(env: LiveDepsEnv): Promise<ChannelDeps["browser"]> {
  if (env.LEADSCOUT_BROWSER !== "1") return undefined;
  const { BrowserReader } = await import("./browser.js");
  return new BrowserReader({});
}

/** Build real ChannelDeps. Nothing dials out until an adapter runs. */
export async function makeLiveDeps(env: LiveDepsEnv = process.env as LiveDepsEnv): Promise<ChannelDeps> {
  const { searchWeb, readPage } = await import("../reach.js");
  const browser = await maybeBrowser(env);
  return {
    search: (query, deps) => searchWeb(query, deps),
    readPage: (url, deps) => readPage(url, deps),
    browser,
    limiter: realLimiter(),
  };
}
