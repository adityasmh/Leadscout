// Order CW1-wire-all-channels proof: offline wiring check.
//
// Imports the runner (channels/index.js) and the registry, then asserts every
// adapter file wired into index.ts registered exactly once, ids are unique, and
// every adapter is OFF by default (env unset). Finally prints a per-category
// coverage table from india-sources.ts. Fails ONLY on duplicate ids, import-time
// errors, or an adapter that is enabled by default.
//
// Fully offline: no network, no live DB. Run (once, foreground):
//   npx tsx src/channel-wiring-check.ts
import { channelAdapters, resetRegistry, adaptersFor } from "./channels/registry.js";
import { indiaChannels } from "./india-sources.js";

// Every adapter module that channels/index.ts wires (order added by CW1).
// google, justdial and practo were already wired before CW1; they are counted
// separately so a duplicate among the CW1 set is still detectable.
const WIRED: string[] = [
  "../plugins/india-directories/acres99.js",
  "./channels/company-intel.js",
  "./channels/devforums.js",
  "../plugins/browser-social/facebook.js",
  "../plugins/india-directories/indiamart.js",
  "../plugins/browser-social/instagram.js",
  "../plugins/india-directories/jobs-india.js",
  "../plugins/browser-social/linkedin.js",
  "../plugins/india-directories/lybrate.js",
  "../plugins/india-directories/magicbricks.js",
  "../plugins/india-directories/naukri.js",
  "../plugins/india-directories/nobroker.js",
  "./channels/podcasts.js",
  "../plugins/india-directories/sharechat.js",
  "../plugins/india-directories/sulekha.js",
  "../plugins/india-directories/swiggy.js",
  "../plugins/india-directories/travel.js",
  "../plugins/india-directories/udaan.js",
  "../plugins/india-directories/urbancompany.js",
  "./channels/youtube.js",
  "../plugins/india-directories/zomato.js",
];

const PRE_WIRED = ["../plugins/browser-social/google.js", "../plugins/india-directories/justdial.js", "../plugins/india-directories/practo.js"];

// Environment variables that switch the wired integrations ON. They are cleared
// for the default-off assertion; the operator's original values are restored.
const ENABLE_ENV = [
  "LEADSCOUT_BROWSER",
  "LEADSCOUT_INDIA_TIER_C",
  "LEADSCOUT_PRACTO",
  "LEADSCOUT_LYBRATE",
  "LEADSCOUT_COMPANY_INTEL",
  "LEADSCOUT_DEVFORUMS",
  "LEADSCOUT_SHARECHAT_ENABLED",
  "LEADSCOUT_CH_PODCASTS",
  "LEADSCOUT_YOUTUBE",
  "GOOGLE_PLACES_API_KEY",
];

let failures = 0;

function pass(name: string): void {
  console.log(`PASS ${name}`);
}

function fail(name: string, detail?: string): void {
  failures += 1;
  console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

/** Adapter ids exported by a module namespace (objects with id + discover + enrich). */
function adapterIdsOf(mod: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const value of Object.values(mod)) {
    if (
      value && typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string" &&
      typeof (value as { discover?: unknown }).discover === "function" &&
      typeof (value as { enrich?: unknown }).enrich === "function"
    ) {
      ids.push((value as { id: string }).id);
    }
  }
  return ids;
}

async function main(): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const name of ENABLE_ENV) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }

  try {
    // 1. the runner imports without an import-time error
    resetRegistry();
    let importError: Error | undefined;
    try {
      await import("./channels/index.js");
    } catch (err) {
      importError = err as Error;
    }
    if (importError) fail("import channels/index.js (and the registry)", importError.message);
    else pass("import channels/index.js (and the registry) without error");

    // 2. every wired adapter file is registered (exactly) once
    const wiredIds: string[] = [];
    const notRegisteredByIndex: string[] = [];
    for (const spec of [...PRE_WIRED, ...WIRED]) {
      const before = channelAdapters().length;
      const mod = (await import(spec)) as Record<string, unknown>;
      const after = channelAdapters().length;
      const ids = adapterIdsOf(mod);
      wiredIds.push(...ids);
      if (after > before) {
        // index.ts had not imported it, so it registered only now
        notRegisteredByIndex.push(`${spec} (registered late; not imported by channels/index.js)`);
      } else if (ids.length === 0) {
        notRegisteredByIndex.push(`${spec} (exports no adapter / does not call registerChannel)`);
      }
    }
    if (notRegisteredByIndex.length === 0) pass("every wired adapter file registered exactly once");
    else fail("every wired adapter file registered exactly once", notRegisteredByIndex.join("; "));

    // 3. ids are unique across all wired adapters
    const registeredIds = channelAdapters().map((a) => a.id);
    const dupes = wiredIds.filter((id, i) => wiredIds.indexOf(id) !== i);
    const unique = new Set(wiredIds);
    if (dupes.length === 0 && unique.size === wiredIds.length && registeredIds.length === new Set(registeredIds).size) {
      pass(`ids are unique (${registeredIds.length} adapters registered)`);
    } else {
      fail("ids are unique", dupes.length ? `duplicate id(s): ${[...new Set(dupes)].join(", ")}` : "duplicate ids in registry");
    }

    // 4. every adapter is disabled by default (env unset) with a plain why
    const enabledByDefault: string[] = [];
    const noWhy: string[] = [];
    for (const a of channelAdapters()) {
      let st: { enabled: boolean; why?: string };
      try {
        st = a.status();
      } catch (err) {
        enabledByDefault.push(`${a.id} (status() threw: ${(err as Error).message})`);
        continue;
      }
      if (st.enabled) enabledByDefault.push(a.id);
      else if (!st.why || !st.why.trim()) noWhy.push(a.id);
    }
    if (enabledByDefault.length === 0) pass("every adapter is disabled by default (env unset)");
    else fail("every adapter is disabled by default (env unset)", enabledByDefault.join(", "));
    if (noWhy.length === 0) pass("every disabled adapter reports a plain why");
    else fail("every disabled adapter reports a plain why", noWhy.join(", "));

    // 5. coverage table: canonical category -> number of adapters listing it
    console.log("");
    console.log("Coverage (adaptersFor per canonical category):");
    const canonical = indiaChannels().canonicalCategories;
    for (const category of canonical) {
      const list = await adaptersFor(category);
      console.log(`  ${category}: ${list.length}`);
    }
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  console.log("");
  if (failures === 0) {
    console.log("PASS channel-wiring-check (Order CW1-wire-all-channels)");
  } else {
    console.log(`FAIL channel-wiring-check (Order CW1-wire-all-channels): ${failures} item(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`FAIL channel-wiring-check: ${(err as Error).message}`);
  process.exitCode = 1;
});
