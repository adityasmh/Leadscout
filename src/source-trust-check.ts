// src/source-trust-check.ts
// Order ST1-source-trust: offline proof for source trust scoring.
//
// No network, no live DB, no real data file: LEADSCOUT_SOURCE_TRUST_PATH points
// at a temp file under os.tmpdir(). Prints PASS/FAIL per item and a summary.
// Run (once, foreground):
//   npx tsx src/source-trust-check.ts

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "source-trust-check-"));
const storeFile = join(tmpRoot, "data", "source-trust.json");
process.env.LEADSCOUT_SOURCE_TRUST_PATH = storeFile;

const st = await import("./source-trust.js");
const { registerChannel, resetRegistry, adaptersFor } = await import("./channels/registry.js");

// Each isolated block gets its own temp store file, so persisted outcomes from
// one block never leak into another.
let storeSeq = 0;
function freshStore(): void {
  storeSeq += 1;
  process.env.LEADSCOUT_SOURCE_TRUST_PATH = join(tmpRoot, "data", `source-trust-${storeSeq}.json`);
  st.resetSourceTrust();
}

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes += 1;
    console.log(`PASS ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

// ---------------------------------------------------------------- seed values
check("seed: pseudo-observations weight is 4", st.pseudoObservations() === 4, `weight=${st.pseudoObservations()}`);
check("seed: half life is 30 days", st.halfLifeDays() === 30, `halfLife=${st.halfLifeDays()}`);

// --------------------------------------------------- exact Beta update math
{
  const p1 = st.betaPosterior({ alpha: 2, beta: 2 }, 1, 0);
  check("beta update exact: {2,2} + 1 ok = {3,2}", p1.alpha === 3 && p1.beta === 2, `alpha=${p1.alpha} beta=${p1.beta}`);
  check("beta mean exact: {3,2} = 0.6", near(st.betaMean(p1), 0.6), `mean=${st.betaMean(p1)}`);
  const p2 = st.betaPosterior({ alpha: 2, beta: 2 }, 0.5, 0);
  check("beta update exact with decayed half weight: {2.5,2}", near(p2.alpha, 2.5) && p2.beta === 2, `alpha=${p2.alpha} beta=${p2.beta}`);
  const p3 = st.betaPosterior({ alpha: 2, beta: 2 }, 0, 3);
  check("beta update exact: {2,2} + 3 fail = {2,5}", p3.alpha === 2 && p3.beta === 5, `alpha=${p3.alpha} beta=${p3.beta}`);
}

// ---------------------------------------------------------------- time decay
{
  const now = new Date("2026-10-12T00:00:00Z");
  const w0 = st.decayWeight("2026-10-12T00:00:00Z", now);
  const w30 = st.decayWeight("2026-09-12T00:00:00Z", now);
  const w60 = st.decayWeight("2026-08-13T00:00:00Z", now);
  check("decay: age 0 -> weight 1", near(w0, 1), `w=${w0}`);
  check("decay: half life 30d -> weight 0.5", near(w30, 0.5, 1e-6), `w=${w30}`);
  check("decay: two half lives -> weight 0.25", near(w60, 0.25, 1e-6), `w=${w60}`);
  check("decay: future time clamps to 1", st.decayWeight("2027-01-01T00:00:00Z", now) === 1);
}

// ---------------------------------------------------------- persistence + reuse
{
  st.resetSourceTrust();
  const o = st.recordOutcome({ channel: "justdial", category: "Dentist", field: "phone", ok: true, at: "2026-10-12T00:00:00Z" });
  check("recordOutcome normalises category to lower case", o.category === "dentist", `category=${o.category}`);
  check("store file written by recordOutcome", existsSync(storeFile));
  const raw = readFileSync(storeFile, "utf8");
  const parsed = JSON.parse(raw) as { outcomes: unknown[] };
  check("store file is valid JSON with one outcome", Array.isArray(parsed.outcomes) && parsed.outcomes.length === 1);
  check("store file is compact JSON (no pretty newlines)", !raw.includes("\n"), `len=${raw.length}`);
  // Reload from disk after clearing caches.
  st.resetSourceTrust();
  const t = st.trust("justdial", "dentist", { now: new Date("2026-10-12T00:00:00Z") });
  check("trust reloads persisted outcomes", t.hasData && t.checks === 1, `checks=${t.checks}`);
}

// --------------------------------------------------------- small-sample shrink
{
  freshStore();
  const now = new Date("2026-10-12T00:00:00Z");
  // Category "a": one success. Category "b": nine failures. The channel average
  // is low, so the one-sample category must shrink toward it.
  st.recordOutcome({ channel: "shrink-ch", category: "a", field: "phone", ok: true, at: now.toISOString() });
  for (let i = 0; i < 9; i++) {
    st.recordOutcome({ channel: "shrink-ch", category: "b", field: "phone", ok: false, at: now.toISOString() });
  }
  const ta = st.trust("shrink-ch", "a", { now });
  const rawCatMean = (4 * 0.5 + 1) / (4 + 1); // 0.6
  const channelMean = (4 * 0.5 + 1) / (4 + 10); // 0.2142857
  check("shrink: category sample pulled below its raw rate", ta.score < rawCatMean, `score=${ta.score.toFixed(4)} raw=${rawCatMean}`);
  check("shrink: category sample pulled above the channel average", ta.score > channelMean, `score=${ta.score.toFixed(4)} channel=${channelMean.toFixed(4)}`);
  check("shrink: confidence grows with sample size", ta.confidence > 0 && ta.confidence < 0.5, `confidence=${ta.confidence.toFixed(4)}`);
  const tb = st.trust("shrink-ch", "b", { now });
  check("shrink: many-failure category is lower than few-success category", tb.score < ta.score, `a=${ta.score.toFixed(4)} b=${tb.score.toFixed(4)}`);
}

// -------------------------------------------------- no-data -> hasData false
{
  freshStore();
  const t = st.trust("justdial", "restaurant", { now: new Date() });
  check("no data: hasData false", t.hasData === false, `score=${t.score.toFixed(4)}`);
}

// -------------------------------------------------------- adaptersFor ranking
function fakeAdapter(id: string) {
  return {
    id,
    name: id,
    tier: "A" as const,
    categories: ["dentist", "clinic", "any"],
    status: () => ({ enabled: true }),
    discover: async () => [],
    enrich: async () => ({
      channel: id,
      url: "",
      fetchedAt: new Date().toISOString(),
      via: "page" as const,
      fields: {},
      signals: [],
      text: "",
      untrusted: true as const,
    }),
    signals: () => [],
  };
}

async function main(): Promise<void> {
  resetRegistry();
  registerChannel(fakeAdapter("ch-alpha"));
  registerChannel(fakeAdapter("ch-beta"));

  // No data -> existing (registration) order preserved.
  {
    freshStore();
    const order = (await adaptersFor("clinic")).map((a) => a.id);
    check("no data: adaptersFor keeps the existing order", order.join(",") === "ch-alpha,ch-beta", order.join(","));
  }

  // ch-alpha keeps failing for dentists -> it must drop below ch-beta.
  {
    freshStore();
    const now = new Date();
    for (let i = 0; i < 20; i++) {
      st.recordOutcome({ channel: "ch-alpha", category: "dentist", field: "phone", ok: false, at: now.toISOString() });
    }
    const order = (await adaptersFor("dentist")).map((a) => a.id);
    check("ranking changes when a channel keeps failing", order.join(",") === "ch-beta,ch-alpha", order.join(","));
  }

  // ch-alpha recovers with successes -> it must rise back to the front.
  {
    const now = new Date();
    for (let i = 0; i < 40; i++) {
      st.recordOutcome({ channel: "ch-alpha", category: "dentist", field: "phone", ok: true, at: now.toISOString() });
    }
    const order = (await adaptersFor("dentist")).map((a) => a.id);
    check("ranking recovers when the channel starts passing again", order.join(",") === "ch-alpha,ch-beta", order.join(","));
  }

  // rankAdapters returns undefined (fallback) when no adapter has data.
  {
    freshStore();
    const res = st.rankAdapters([{ id: "ch-alpha" }, { id: "ch-beta" }], "restaurant", { now: new Date() });
    check("rankAdapters falls back (undefined) with no data", res === undefined);
  }

  // ------------------------------------------------------------- explain text
  {
    freshStore();
    const now = new Date("2026-10-12T00:00:00Z");
    for (let i = 0; i < 3; i++) {
      st.recordOutcome({ channel: "justdial", category: "dentist", field: "phone", ok: true, at: now.toISOString() });
    }
    st.recordOutcome({ channel: "justdial", category: "dentist", field: "phone", ok: false, at: now.toISOString() });
    const sentence = st.explain("justdial", "dentist", { now });
    check(
      "explain: plain UI sentence with name, percent, field, category, checks, window",
      sentence === "JustDial: 75 percent of phone numbers verified for dentists (4 checks, last 30 days)",
      sentence
    );
    const empty = st.explain("zomato", "restaurant", { now });
    check("explain: no-data sentence is honest", empty.includes("no checks recorded"), empty);
  }

  // ------------------------------------------- outcomesFromVerification adapter
  {
    freshStore();
    const verification: import("./types-v2.js").Verification = {
      bizKey: "",
      checkedAt: "2026-10-12T00:00:00Z",
      website: "alive",
      emails: [
        { value: "a@fixture.example", result: "ok" },
        { value: "b@fixture.example", result: "no-mx" },
      ],
      phones: [
        { value: "+919876500001", result: "mobile" },
        { value: "000", result: "invalid" },
      ],
      whatsapp: false,
      contactable: true,
      reasons: [],
    };
    const lead = { category: "dentist", verification };
    const outcomes = st.outcomesFromVerification(lead, { channel: "justdial" });
    check("outcomesFromVerification: website + 2 emails + 2 phones -> 5 records", outcomes.length === 5, `n=${outcomes.length}`);
    check("outcomesFromVerification: website alive is ok", outcomes.find((o) => o.field === "website")?.ok === true);
    check("outcomesFromVerification: no-mx email is not ok", outcomes.filter((o) => o.field === "email" && !o.ok).length === 1);
    check("outcomesFromVerification: invalid phone is not ok", outcomes.filter((o) => o.field === "phone" && !o.ok).length === 1);
    const dupes = st.outcomesFromVerification(lead, { channel: "justdial", duplicatePhones: ["+919876500001"] });
    check("outcomesFromVerification: duplicate phone marked not ok", dupes.filter((o) => o.field === "phone" && !o.ok).length === 2);
    const none = st.outcomesFromVerification({ category: "dentist" }, { channel: "justdial" });
    check("outcomesFromVerification: no verification -> no records", none.length === 0);
  }

  // --------------------------------------------------------- operator flag
  {
    freshStore();
    const o = st.flagWrongContact("lead-1", "justdial", "phone", { category: "dentist", at: "2026-10-12T00:00:00Z" });
    check("flagWrongContact: records a negative outcome", o.ok === false && o.field === "phone" && o.category === "dentist", JSON.stringify(o));
    const o2 = st.flagWrongContact("lead-2", "zomato", "phone");
    check("flagWrongContact: 3-arg call falls back to category any", o2.category === "any", o2.category);
  }

  // -------------------------------------------------------- atomic write crash
  {
    const target = join(tmpRoot, "atomic.json");
    st.atomicWriteJsonSync(target, { v: 1 });
    const before = readFileSync(target, "utf8");
    check("atomic write: first write is valid JSON", JSON.parse(before).v === 1);

    let threw = false;
    try {
      st.atomicWriteJsonSync(target, { v: 2 }, {
        writeFileFn: (p: string, d: string, e: BufferEncoding) => {
          writeFileSync(p, "{\"partial\":", e); // simulate a crash mid-write
          throw new Error("simulated crash during write");
        },
      });
    } catch {
      threw = true;
    }
    check("atomic write: injected write crash throws", threw);
    check("atomic write: target unchanged after write crash", readFileSync(target, "utf8") === before);
    check("atomic write: no temp file left after write crash", readdirSync(tmpRoot).filter((f) => f.endsWith(".tmp")).length === 0);

    let threw2 = false;
    try {
      st.atomicWriteJsonSync(target, { v: 3 }, {
        renameFn: () => {
          throw new Error("simulated crash during rename");
        },
      });
    } catch {
      threw2 = true;
    }
    check("atomic write: injected rename crash throws", threw2);
    check("atomic write: target unchanged after rename crash", readFileSync(target, "utf8") === before);
    check("atomic write: no temp file left after rename crash", readdirSync(tmpRoot).filter((f) => f.endsWith(".tmp")).length === 0);
    check("atomic write: target is still valid JSON", JSON.parse(readFileSync(target, "utf8")).v === 1);
  }

  console.log("");
  console.log(`Summary: ${passes} passed, ${failures} failed`);
  if (failures === 0) {
    console.log("PASS source-trust-check (Order ST1-source-trust)");
  } else {
    console.log(`FAIL source-trust-check (Order ST1-source-trust): ${failures} item(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`FAIL source-trust-check: ${(err as Error).message}`);
  process.exitCode = 1;
});
