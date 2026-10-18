// Order L54B-channel-status: offline proof with fake adapters (no server).
import { channelStatusReport } from "../channel-status.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelAdapter } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, "..");
const EXPECTED_TOTAL = 3;
const EXPECTED_ENABLED = 1;
const DISABLED_REASON = "missing api key";
const THROWING_MESSAGE = "status check failed";
const EXIT_OK = 0;
const EXIT_FAIL = 1;

function fakeAdapter(overrides: Partial<ChannelAdapter> & Pick<ChannelAdapter, "id" | "name" | "tier" | "status">): ChannelAdapter {
  return {
    categories: [],
    discover: async () => [],
    enrich: async () => {
      throw new Error("not used in status report");
    },
    signals: () => [],
    ...overrides,
  };
}

let failures = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`PASS: ${name} (${detail})`);
  } else {
    failures += 1;
    console.log(`FAIL: ${name} (${detail})`);
  }
}

// Three fakes in an order that is NOT sorted: C first, then A, then B.
const throwingAdapter = fakeAdapter({
  id: "b-throwing",
  name: "B Throwing",
  tier: "B",
  status: () => {
    throw new Error("boom");
  },
});
const disabledAdapter = fakeAdapter({
  id: "a-disabled",
  name: "A Disabled",
  tier: "A",
  status: () => ({ enabled: false, why: DISABLED_REASON }),
});
const enabledAdapter = fakeAdapter({
  id: "c-enabled",
  name: "C Enabled",
  tier: "C",
  status: () => ({ enabled: true }),
});
const adapters: ChannelAdapter[] = [enabledAdapter, throwingAdapter, disabledAdapter];

const plain = channelStatusReport(adapters);
check(
  "counts are right",
  plain.totalCount === EXPECTED_TOTAL && plain.enabledCount === EXPECTED_ENABLED,
  `total=${plain.totalCount} enabled=${plain.enabledCount}`,
);

const disabled = plain.channels.find((c) => c.id === "a-disabled");
check(
  "disabled carries reason",
  disabled !== undefined && disabled.enabled === false && disabled.why === DISABLED_REASON,
  `why=${disabled?.why ?? "missing"}`,
);

const throwing = plain.channels.find((c) => c.id === "b-throwing");
check(
  "throwing reported disabled",
  throwing !== undefined && throwing.enabled === false && throwing.why === THROWING_MESSAGE,
  `why=${throwing?.why ?? "missing"}`,
);

const orderIds = plain.channels.map((c) => c.id).join(",");
check(
  "sorting by tier then id",
  orderIds === "a-disabled,b-throwing,c-enabled",
  `order=${orderIds}`,
);

const browserFixture = {
  enabled: true,
  killSwitch: false,
  backends: {
    opencli: { ok: true },
    cdp: { ok: false, why: "off", url: "http://127.0.0.1:9222" },
  },
  caps: { other: 60 },
  usedThisHour: { linkedin: 2, other: 1 },
  lockedPlatforms: [],
  pageLog: [],
  cookie: "session=abc-fake",
  token: "secret-fake-123",
};
const withBrowser = channelStatusReport(adapters, browserFixture);
const dumped = JSON.stringify(withBrowser);
check(
  "browser secrets never leak",
  !dumped.includes("session=abc-fake") &&
    !dumped.includes("secret-fake-123") &&
    !dumped.includes("cookie") &&
    !dumped.includes("token") &&
    !dumped.includes("127.0.0.1:9222") &&
    withBrowser.browser !== null &&
    withBrowser.browser.backend === "opencli" &&
    withBrowser.browser.pagesThisHour["linkedin"] === 2,
  `browser=${JSON.stringify(withBrowser.browser)}`,
);

check("browser null when none given", plain.browser === null, `browser=${String(plain.browser)}`);

const serverSrc = readFileSync(join(SRC_DIR, "server.ts"), "utf8");
check(
  "server has channels adapters route",
  serverSrc.includes("/api/channels/adapters"),
  "contains /api/channels/adapters",
);
const healthAt = serverSrc.indexOf('parts[1] === "health"');
const healthSlice = healthAt >= 0 ? serverSrc.slice(healthAt, healthAt + 1200) : "";
check(
  "server health answers channels",
  healthSlice.includes("channels"),
  "health block mentions channels",
);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? EXIT_OK : EXIT_FAIL);
