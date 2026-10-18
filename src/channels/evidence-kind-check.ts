// src/channels/evidence-kind-check.ts
// L54F-evidence-kind-fix proof: channel evidence uses only real EvidenceKind values.
// Run: npx tsx src/channels/evidence-kind-check.ts
// Prints one PASS/FAIL line per check; exit code 1 when any check fails.
import { readFileSync } from "node:fs";
import { channelEvidenceFor } from "../research-channels.js";
import { registerChannel, resetRegistry } from "./registry.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence } from "./types.js";
import type { Evidence } from "../types-v2.js";
import type { RawLead } from "../types.js";

const REAL_KINDS: Array<Evidence["kind"]> = ["listing", "page-text", "structured-data", "absence", "verification"];
const FIXED_AT = "2026-10-08T00:00:00.000Z";
const CATEGORY = "evidence-kind-fixture-cat";

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function fixtureLead(): RawLead {
  return {
    name: "Fixture Biz",
    category: CATEGORY,
    city: "Pune",
    country: "IN",
    source: "fixture",
    sourceUrl: "https://fixture.example/node/1",
  };
}

function fakeDeps(): ChannelDeps {
  return {
    search: async () => ({ ok: false, channel: "fixture", text: "", untrusted: true, trace: [] }),
    readPage: async () => ({ ok: false, channel: "fixture", text: "", untrusted: true, trace: [] }),
    limiter: {},
  };
}

function fakeAdapter(id: string, via: ChannelEvidence["via"]): ChannelAdapter {
  return {
    id,
    name: `Fixture ${id}`,
    tier: "B",
    categories: [CATEGORY],
    status: () => ({ enabled: true }),
    discover: async () => [],
    enrich: async (lead: RawLead): Promise<ChannelEvidence> => {
      return {
        channel: id,
        url: `https://fixture.example/${id}/${encodeURIComponent(lead.name)}`,
        fetchedAt: FIXED_AT,
        via,
        fields: {},
        signals: [],
        text: `text from ${id} via ${via}`,
        untrusted: true,
      };
    },
    signals: () => [],
  };
}

// Source-level: research-channels.ts must not cast to Evidence["kind"] and must
// not contain a "channel" kind literal. Comments are stripped first so prose
// about channels cannot false-fail the check.
{
  const source = readFileSync(new URL("../research-channels.ts", import.meta.url), "utf8");
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const codeOnly = noBlockComments
    .split("\n")
    .map((line) => {
      const cut = line.indexOf("//");
      return cut < 0 ? line : line.slice(0, cut);
    })
    .join("\n");
  check(
    "source-no-kind-cast",
    /as\s+Evidence\s*\[\s*"kind"\s*\]/.test(codeOnly) === false,
    "found as Evidence[\"kind\"] cast",
  );
  check(
    "source-no-channel-literal",
    /["']channel["']/.test(codeOnly) === false,
    "found a \"channel\" literal",
  );
}

// Behaviour-level: one fake adapter per via value, mapping search->listing and
// page|browser->page-text; every kind real; channel id and URL still carried.
{
  const cases: Array<{ via: ChannelEvidence["via"]; want: Evidence["kind"] }> = [
    { via: "search", want: "listing" },
    { via: "page", want: "page-text" },
    { via: "browser", want: "page-text" },
  ];
  for (const c of cases) {
    resetRegistry();
    registerChannel(fakeAdapter(`fake-${c.via}`, c.via));
    const res = await channelEvidenceFor(fixtureLead(), fakeDeps());
    const got = res.evidence[0];
    const kinds = res.evidence.map((e) => e.kind).join(",");
    check(
      `via-${c.via}-kind`,
      got !== undefined && got.kind === c.want,
      `got ${kinds || "(none)"}, want ${c.want}`,
    );
    check(
      `via-${c.via}-kind-is-real`,
      res.evidence.length > 0 && res.evidence.every((e) => REAL_KINDS.includes(e.kind)),
      kinds,
    );
    check(
      `via-${c.via}-carries-channel-and-url`,
      got !== undefined && got.channel === `fake-${c.via}` && got.url.includes(`fake-${c.via}`),
      JSON.stringify(res.evidence.map((e) => ({ channel: e.channel, url: e.url }))),
    );
  }
}

if (failures > 0) {
  console.log(`DONE FAIL ${failures}`);
  process.exit(1);
}
console.log("DONE PASS");
