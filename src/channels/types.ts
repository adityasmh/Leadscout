// Shared channel-framework types (Order L43). Reuses RawLead from types.ts exactly.
import type { RawLead } from "../types.js";
import type { ReachDeps, ReachResult } from "../reach.js";

export type DiscoverQuery = { category: string; city: string; area?: string; limit?: number };

export type ChannelEvidence = {
  channel: string;
  url: string;
  fetchedAt: string;
  via: "search" | "page" | "browser";
  fields: Record<string, string | number | undefined>;
  signals: string[];
  text: string;
  untrusted: true;
};

export type ChannelStatus = { enabled: boolean; why?: string };

// search/readPage are reach.ts functions (Order L32), injected so tests run offline.
export type ReachSearchFn = (query: string, deps?: ReachDeps) => Promise<ReachResult>;
export type ReachReadPageFn = (url: string, deps?: ReachDeps) => Promise<ReachResult>;

// limiter.sleep is injectable so the random 2-6 s browser pause never blocks tests.
export type ChannelLimiter = { sleep?: (ms: number) => Promise<void> };

export type ChannelDeps = {
  search: ReachSearchFn;
  readPage: ReachReadPageFn;
  browser?: BrowserReaderLike;
  fetchFn?: typeof fetch;
  now?: () => number;
  limiter: ChannelLimiter;
};

export type ChannelAdapter = {
  id: string;
  name: string;
  tier: "A" | "B" | "C";
  categories: string[];
  status(): ChannelStatus;
  discover(q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]>;
  enrich(lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence>;
  signals(text: string): string[];
};

export type BrowserReadResult = { text: string; url: string; title?: string };

// Structural type so ChannelDeps does not depend on the class (no cycle).
export type BrowserReaderLike = {
  read(url: string, opts?: BrowserReadOpts): Promise<BrowserReadResult>;
  search(site: string, query: string): Promise<BrowserReadResult>;
  status(): BrowserStatus;
};

export type BrowserPageLogEntry = { platform: string; url: string; time: string };

export type BrowserStatus = {
  enabled: boolean;
  killSwitch: boolean;
  backends: { opencli: { ok: boolean; why?: string; commands?: string[] }; cdp: { ok: boolean; why?: string; url: string } };
  caps: Record<string, number>;
  usedThisHour: Record<string, number>;
  lockedPlatforms: string[];
  pageLog: BrowserPageLogEntry[];
};

export type BrowserOpts = {
  fetchFn?: typeof fetch;
  execFile?: import("../reach.js").ReachExecFile;
  wsFactory?: (url: string) => WebSocketLike;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  // setTimeout-like, injectable ONLY so checks can assert the built-in default
  // pause really sleeps 2-6 s without waiting; production uses the real timer.
  timer?: (callback: () => void, ms: number) => unknown;
  cdpUrl?: string;
};

export type BrowserReadOpts = { platform?: string; reason?: string };

// Node 24 global WebSocket, minimally typed.
export type WebSocketLike = {
  send(data: string): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror?: unknown;
};

// Thrown when a page looks like a login wall / captcha / checkpoint / unusual activity,
// or when a platform is locked out after such a stop.
export class BrowserBlockedError extends Error {
  needsHuman: true;
  platform: string;
  platformLocked: boolean; // true when this read was refused because the platform was already needs-human
  constructor(message: string, platform: string, platformLocked: boolean) {
    super(message);
    this.name = "BrowserBlockedError";
    this.needsHuman = true;
    this.platform = platform;
    this.platformLocked = platformLocked;
  }
}

// True when a search/page-read result should fall through to the browser reader:
// 403, 429, captcha, or an empty body. Never on normal content.
export function reachBlocked(r: { ok: boolean; text: string; error?: string }): boolean {
  if (!r.ok) return true;
  if (r.text.trim() === "") return true;
  const hay = `${r.text.slice(0, 2000)} ${r.error ?? ""}`.toLowerCase();
  if (/\b403\b/.test(hay) || /\b429\b/.test(hay) || /forbidden/.test(hay) || /too many requests/.test(hay)) return true;
  return /captcha|rate limit|unusual activity|verify you are human|blocked/.test(hay);
}
