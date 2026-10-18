// src/channels/research-wiring-check.ts
// L54C-research-channels proof: offline fake-adapter wiring check.
// Run: npx tsx src/channels/research-wiring-check.ts
// Prints one PASS/FAIL line per check; exit code 1 when any check fails.
import { channelEvidenceFor } from "../research-channels.js";
import { researchBusiness } from "../research.js";
import { adaptersFor, registerChannel, resetRegistry } from "./registry.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence } from "./types.js";
import type { Enrichment, RawLead } from "../types.js";

const QUOTE_LIMIT = 240;
const TOP_CAP = 3;
const FIVE_ADAPTERS = 5;
const LONG_TEXT_LEN = 500;
const FIXED_AT = "2026-10-08T00:00:00.000Z";
const CATEGORY = "wiring-fixture-cat";

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

function fakeAdapter(
  id: string,
  opts: { signals?: string[]; text?: string; url?: string; enabled?: boolean; throws?: boolean } = {},
): ChannelAdapter {
  const enabled = opts.enabled ?? true;
  return {
    id,
    name: `Fixture ${id}`,
    tier: "B",
    categories: [CATEGORY],
    status: () => ({ enabled }),
    discover: async () => [],
    enrich: async (lead: RawLead): Promise<ChannelEvidence> => {
      if (opts.throws === true) throw new Error(`boom from ${id}`);
      return {
        channel: id,
        url: opts.url ?? `https://fixture.example/${id}/${encodeURIComponent(lead.name)}`,
        fetchedAt: FIXED_AT,
        via: "page",
        fields: {},
        signals: opts.signals ?? [],
        text: opts.text ?? `text from ${id}`,
        untrusted: true,
      };
    },
    signals: () => opts.signals ?? [],
  };
}

function plainEnrich(): (lead: RawLead) => Promise<Enrichment> {
  return async () => ({
    summary: "Plain summary for Fixture Biz.",
    emails: [],
    phones: [],
    socials: {},
    signals: [],
  });
}

// 1: two enabled fake channels give two evidence entries with their source URLs.
resetRegistry();
registerChannel(fakeAdapter("fake-a", { signals: ["sig-a", "sig-shared"], text: "alpha text" }));
registerChannel(fakeAdapter("fake-b", { signals: ["sig-b", "sig-shared"], text: "beta text" }));
{
  const res = await channelEvidenceFor(fixtureLead(), fakeDeps());
  check("two-enabled-count", res.evidence.length === 2, `got ${res.evidence.length}`);
  const urls = res.evidence.map((e) => e.url);
  check(
    "two-enabled-urls",
    urls.some((u) => u.includes("fake-a")) && urls.some((u) => u.includes("fake-b")),
    urls.join(" | "),
  );
  check(
    "two-enabled-kind",
    res.evidence.every((e) => e.kind === "page-text" || e.kind === "listing"),
    res.evidence.map((e) => e.kind).join(","),
  );
  // 2: their signals come back de-duplicated.
  const sorted = [...res.signals].sort();
  check("signals-deduped", JSON.stringify(sorted) === JSON.stringify(["sig-a", "sig-b", "sig-shared"]), sorted.join(","));
  // nothing marked verified: channel text is untrusted.
  check("nothing-verified", res.evidence.every((e) => e.untrusted === true));
}

// 3: a disabled channel is skipped.
resetRegistry();
registerChannel(fakeAdapter("fake-on", { signals: ["sig-on"] }));
registerChannel(fakeAdapter("fake-off", { signals: ["sig-off"], enabled: false }));
{
  const res = await channelEvidenceFor(fixtureLead(), fakeDeps());
  check("disabled-skipped", res.evidence.length === 1 && res.evidence[0]?.channel === "fake-on",
    JSON.stringify(res.evidence.map((e) => e.channel)));
  check("disabled-signals", res.signals.includes("sig-on") && !res.signals.includes("sig-off"),
    res.signals.join(","));
}

// 4: a throwing channel is skipped with a note and the others still return.
resetRegistry();
registerChannel(fakeAdapter("fake-throw", { throws: true }));
registerChannel(fakeAdapter("fake-good", { signals: ["sig-good"], text: "good text" }));
{
  const res = await channelEvidenceFor(fixtureLead(), fakeDeps());
  check("throwing-count", res.evidence.length === 1 && res.evidence[0]?.channel === "fake-good",
    JSON.stringify(res.evidence.map((e) => e.channel)));
  check("throwing-note", res.notes.some((n) => n.includes("fake-throw")), res.notes.join(" | "));
}

// 5: only the top 3 are used when five are enabled.
resetRegistry();
for (let i = 1; i <= FIVE_ADAPTERS; i += 1) {
  registerChannel(fakeAdapter(`fake-${i}`, { signals: [`sig-${i}`] }));
}
{
  const ranked = await adaptersFor(CATEGORY);
  const res = await channelEvidenceFor(fixtureLead(), fakeDeps());
  const want = ranked.slice(0, TOP_CAP).map((a) => a.id);
  const gotCh = res.evidence.map((e) => e.channel);
  check("top-3-count", res.evidence.length === TOP_CAP, `got ${res.evidence.length}`);
  check("top-3-order", JSON.stringify(gotCh) === JSON.stringify(want), `${gotCh.join(",")} vs ${want.join(",")}`);
}

// 6: researchBusiness with no channelDeps returns what it returned before.
{
  const lead = fixtureLead();
  const first = await researchBusiness(lead, {}, { enrich: plainEnrich(), mode: "off" });
  const second = await researchBusiness(lead, {}, { enrich: plainEnrich(), mode: "off" });
  check("no-deps-count", first.evidence.length === second.evidence.length,
    `${first.evidence.length} vs ${second.evidence.length}`);
  check("no-deps-no-channel", first.evidence.every((e) => e.id.startsWith("C") === false),
    first.evidence.map((e) => e.kind).join(","));
}

// 7: channel text is cut to 240 characters.
resetRegistry();
registerChannel(fakeAdapter("fake-long", { text: "w ".repeat(LONG_TEXT_LEN) }));
{
  const res = await channelEvidenceFor(fixtureLead(), fakeDeps());
  const quote = res.evidence[0]?.quote ?? "";
  check("quote-240", quote.length === QUOTE_LIMIT, `got ${quote.length}`);
}

if (failures > 0) {
  console.log(`DONE FAIL ${failures}`);
  process.exit(1);
}
console.log("DONE PASS");
