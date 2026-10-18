// src/channels/pipeline-wiring-check.ts
// Order L54G-pipeline-channels proof: offline, temp database, no network, no live
// keys. Run (once, foreground):
//   npx tsx src/channels/pipeline-wiring-check.ts
// Prints one PASS/FAIL line per check; exit code 1 when any check fails.
// First import is the sandbox-company-root bootstrap (PITFALLS #1): this check
// reaches the store through pipeline.js, so COMPANY_ROOT must be sandboxed
// before any static import is evaluated.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelDepsForJob } from "../pipeline-channels.js";
import { channelAdapters, registerChannel, resetRegistry } from "./registry.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence } from "./types.js";
import type { ReachApi } from "../research.js";

const tmpDir = mkdtempSync(join(tmpdir(), "leadscout-l54g-check-"));
process.env.LEADSCOUT_DB = join(tmpDir, "check.db");

const MIN_ADAPTERS = 30;
const E2E_URL = "https://example.invalid/fixture-channel-evidence";
const E2E_CATEGORY = "dental-clinic";
const E2E_TIME = "2026-10-08T00:00:00.000Z";

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function fixtureDeps(): ChannelDeps {
  return {
    search: async () => ({ ok: false, channel: "fixture", text: "", untrusted: true, trace: [] }),
    readPage: async () => ({ ok: false, channel: "fixture", text: "", untrusted: true, trace: [] }),
    limiter: {},
  };
}

function e2eAdapter(): ChannelAdapter {
  return {
    id: "fixture-e2e",
    name: "Fixture E2E",
    tier: "C",
    categories: [E2E_CATEGORY],
    status: () => ({ enabled: true }),
    discover: async () => [],
    enrich: async (): Promise<ChannelEvidence> => ({
      channel: "fixture-e2e",
      url: E2E_URL,
      fetchedAt: E2E_TIME,
      via: "page",
      fields: {},
      signals: ["has-website"],
      text: "fixture channel text",
      untrusted: true,
    }),
    signals: () => ["has-website"],
  };
}

const e2eReach: ReachApi = {
  reachStatus: async () => ({ available: true, channels: {} }),
  readPage: async () => ({ ok: false, channel: "fixture", text: "", untrusted: true, trace: [] }),
  searchWeb: async () => ({ ok: false, channel: "fixture", text: "", untrusted: true, trace: [] }),
  readFeed: async () => ({ ok: false, channel: "fixture", text: "", untrusted: true, trace: [] }),
  socialSearch: async () => ({ ok: false, channel: "fixture", text: "", untrusted: true, trace: [] }),
};

// End-to-end: one offline job with injected fakes, copying the offline setup
// that pipeline-check.ts uses (workspace, job, fake discover/enrich/match/
// verify/score/evidence/dossier, reach + primary research mode). Returns whether
// the job finished done and whether the dossier evidence saw the fixture URL.
async function runE2EJob(
  mods: typeof import("../pipeline.js") & typeof import("../store.js"),
  withChannels: boolean,
): Promise<{ done: boolean; sawUrl: boolean }> {
  resetRegistry();
  const seen: string[] = [];
  if (withChannels) registerChannel(e2eAdapter());
  const ws = mods.createWorkspace({
    name: "L54G E2E",
    offer: { services: ["website"], description: "e2e offer" },
    icp: { categories: [E2E_CATEGORY], cities: ["Mumbai"], countries: ["IN"] },
  });
  const job = mods.createJob(ws.id, { category: E2E_CATEGORY, city: "Mumbai", limit: 2 });
  await mods.runJob(ws.id, job.id, {
    discover: async () => [{
      name: "E2E Dental", category: E2E_CATEGORY, city: "Mumbai", country: "IN",
      phone: "+919876543210", source: "osm", sourceUrl: "https://osm.org/node/9",
    }],
    enrich: async (lead) => ({
      summary: `E2E summary for ${lead.name}`, emails: [], phones: ["+919876543210"], socials: {}, signals: [],
    }),
    match: () => ({ score: 80, fit: [{ service: "website", score: 80, reason: "e2e" }], angle: "e2e angle" }),
    verify: async () => ({
      bizKey: "", checkedAt: E2E_TIME, website: "alive", emails: [], phones: [],
      whatsapp: false, contactable: true, reasons: [],
    }),
    scoreLead: () => ({ total: 80, fit: 80, reach: 50, timing: 50, gate: "template", reasons: [] }),
    buildEvidence: () => [],
    buildTemplateDossier: (input) => {
      for (const e of input.evidence) seen.push(e.url);
      return {
        leadId: input.lead.id, workspaceId: input.lead.workspaceId, bizKey: "e2e", level: 0,
        facts: {}, gap: null, sayThis: null, pushback: null, offers: [], evidence: input.evidence,
        callStatus: "not-called", dropped: [], inputHash: "", promptVersion: "v1",
        tokensIn: 0, tokensOut: 0, createdAt: E2E_TIME,
      };
    },
    reach: e2eReach,
    researchMode: "primary",
    ...(withChannels ? { channelDeps: fixtureDeps() } : {}),
  });
  const finalJob = mods.listJobs(ws.id).find((j) => j.id === job.id);
  return { done: finalJob?.status === "done", sawUrl: seen.some((u) => u.includes("example.invalid")) };
}

async function main(): Promise<void> {
  try {
    const nullRes = await channelDepsForJob(null, {});
    check("null-gives-empty", Object.keys(nullRes).length === 0, JSON.stringify(nullRes));

    const offRes = await channelDepsForJob(undefined, {});
    check("no-injected-no-flag-gives-empty", Object.keys(offRes).length === 0, JSON.stringify(offRes));

    const fake = fixtureDeps();
    const injRes = await channelDepsForJob(fake, {});
    check("injected-returned-same-object", injRes.deps === fake);
    const count = channelAdapters().length;
    check("registry-over-30", count > MIN_ADAPTERS, `count=${count}`);
    resetRegistry();

    let liveThrew = false;
    let liveOut: Awaited<ReturnType<typeof channelDepsForJob>> | undefined;
    try {
      liveOut = await channelDepsForJob(undefined, { LEADSCOUT_CHANNELS_LIVE: "1" });
    } catch {
      liveThrew = true;
    }
    check("live-never-throws", liveThrew === false);
    check("live-deps-or-note", liveOut !== undefined && (liveOut.deps !== undefined || liveOut.note !== undefined),
      JSON.stringify({ hasDeps: liveOut?.deps !== undefined, note: liveOut?.note }));

    const pipelineText = readFileSync(new URL("../pipeline.ts", import.meta.url), "utf8");
    const spread = "...(channel.deps ? { channelDeps: channel.deps } : {})";
    const spreadCount = pipelineText.split(spread).length - 1;
    check("pipeline-calls-channelDepsForJob", pipelineText.includes("channelDepsForJob"));
    check("pipeline-guarded-spreads-both-calls", spreadCount >= 2, `count=${spreadCount}`);

    const pipeline = await import("../pipeline.js");
    const store = await import("../store.js");
    const mods = { ...pipeline, ...store };
    const withOn = await runE2EJob(mods, true);
    check("e2e-with-channels-url-present", withOn.done && withOn.sawUrl, `done=${withOn.done} sawUrl=${withOn.sawUrl}`);
    const withOff = await runE2EJob(mods, false);
    check("e2e-without-channels-url-absent", withOff.done && !withOff.sawUrl, `done=${withOff.done} sawUrl=${withOff.sawUrl}`);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup failure */ }
  }

  if (failures > 0) {
    console.log(`DONE FAIL ${failures}`);
    process.exit(1);
  }
  console.log("DONE PASS");
}

main().catch((err) => {
  console.error("check crashed:", err);
  process.exit(1);
});
