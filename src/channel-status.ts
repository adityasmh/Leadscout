// Order L54B-channel-status: pure channel status report (no network).
// Reads only adapter id/name/tier plus status().enabled/why, and from
// BrowserStatus only the backend ok-flags plus per-platform page counts.
// Never copies cookies, tokens, keys or URLs.
import type { BrowserStatus, ChannelAdapter } from "./channels/types.js";

export type ChannelStatusEntry = {
  id: string;
  name: string;
  tier: string;
  enabled: boolean;
  why?: string;
};

export type ChannelStatusBrowser = {
  backend: string;
  pagesThisHour: Record<string, number>;
};

export type ChannelStatusReport = {
  channels: ChannelStatusEntry[];
  enabledCount: number;
  totalCount: number;
  browser: ChannelStatusBrowser | null;
};

const STATUS_CHECK_FAILED = "status check failed";

const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2 };
const TIER_ORDER_FALLBACK = 99;

const BACKEND_OPENCLI = "opencli";
const BACKEND_CDP = "cdp";
const BACKEND_NONE = "none";
const BACKEND_JOINER = "+";

function tierRank(tier: string): number {
  return TIER_ORDER[tier] ?? TIER_ORDER_FALLBACK;
}

function backendName(status: BrowserStatus): string {
  const opencliOk = status.backends.opencli.ok === true;
  const cdpOk = status.backends.cdp.ok === true;
  if (opencliOk && cdpOk) return `${BACKEND_OPENCLI}${BACKEND_JOINER}${BACKEND_CDP}`;
  if (opencliOk) return BACKEND_OPENCLI;
  if (cdpOk) return BACKEND_CDP;
  return BACKEND_NONE;
}

function pagesThisHourOf(status: BrowserStatus): Record<string, number> {
  const pages: Record<string, number> = {};
  const used: Record<string, number> = status.usedThisHour ?? {};
  for (const [platform, count] of Object.entries(used)) {
    if (typeof count === "number" && Number.isFinite(count)) {
      pages[platform] = Math.max(0, Math.floor(count));
    }
  }
  return pages;
}

export function channelStatusReport(
  adapters: ChannelAdapter[],
  browserStatus?: BrowserStatus | null,
): ChannelStatusReport {
  const channels: ChannelStatusEntry[] = adapters.map((adapter) => {
    try {
      const status = adapter.status();
      const entry: ChannelStatusEntry = {
        id: adapter.id,
        name: adapter.name,
        tier: adapter.tier,
        enabled: status.enabled,
      };
      if (status.why !== undefined) entry.why = status.why;
      return entry;
    } catch {
      return {
        id: adapter.id,
        name: adapter.name,
        tier: adapter.tier,
        enabled: false,
        why: STATUS_CHECK_FAILED,
      };
    }
  });
  channels.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const enabledCount = channels.filter((c) => c.enabled).length;
  const browser: ChannelStatusBrowser | null =
    browserStatus === undefined || browserStatus === null
      ? null
      : { backend: backendName(browserStatus), pagesThisHour: pagesThisHourOf(browserStatus) };
  return { channels, enabledCount, totalCount: channels.length, browser };
}
