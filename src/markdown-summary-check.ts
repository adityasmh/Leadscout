// src/markdown-summary-check.ts
// MD1 markdown-summary proof: never store raw reader markdown as a summary.
// Offline, pure, table-driven. Run: npx tsx src/markdown-summary-check.ts

type EnrichModule = {
  stripMarkdown?: (text: string) => string;
  enrichFromPages?: (lead: FakeLead, pages: Array<{ url: string; text: string }>) => { summary: string };
};

type FakeLead = { name: string; category: string; city?: string; country?: string; source: string; sourceUrl: string };

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  :: ${detail}` : ""}`);
  }
}

function hasStrip(mod: EnrichModule | null): mod is EnrichModule & { stripMarkdown: (text: string) => string } {
  return mod !== null && typeof mod.stripMarkdown === "function";
}

function canSummarize(
  mod: EnrichModule | null,
): mod is EnrichModule & { enrichFromPages: (lead: FakeLead, pages: Array<{ url: string; text: string }>) => { summary: string } } {
  return mod !== null && typeof mod.enrichFromPages === "function";
}

const REAL_EXAMPLE =
  "[90 00 100 200](tel:9000100200)[sales@fakerealty.example](mailto:sales@fakerealty.example) * [](https://www.facebook.com/fixture-developers/) * [About Us](https://fakerealty.example/about-us/) ...";

const REAL_SENTENCE =
  "Fake Dental Care in Pune offers gentle family dentistry with same-day root canals and clear braces for busy parents.";

function fakeLead(): FakeLead {
  return { name: "Fake Dental Care", category: "dental-clinic", city: "Pune", country: "India", source: "osm", sourceUrl: "https://fake.example/1" };
}

const mod = (await import("./enrich.js").catch(() => null)) as EnrichModule | null;

// ---- stripMarkdown table ----
const stripCases: Array<{ name: string; input: unknown; run: (strip: (text: string) => string) => boolean; detail: (strip: (text: string) => string) => string }> = [
  {
    name: "strip: real example keeps none of '](', 'tel:', 'mailto:', 'http', '*'",
    input: REAL_EXAMPLE,
    run: (strip) => {
      const out = strip(REAL_EXAMPLE);
      return !out.includes("](") && !out.includes("tel:") && !out.includes("mailto:") && !out.includes("http") && !out.includes("*");
    },
    detail: (strip) => JSON.stringify(strip(REAL_EXAMPLE).slice(0, 160)),
  },
  {
    name: "strip: nested links unwrap to labels without urls",
    input: "[see [inner label](https://inner.example/x) here](https://outer.example/y)",
    run: (strip) => {
      const out = strip("[see [inner label](https://inner.example/x) here](https://outer.example/y)");
      return !out.includes("](") && !out.includes("http") && out.includes("inner label");
    },
    detail: (strip) => JSON.stringify(strip("[see [inner label](https://inner.example/x) here](https://outer.example/y)")),
  },
  {
    name: "strip: image markup removed entirely",
    input: "Hello ![alt text](https://img.example/x.png) world",
    run: (strip) => {
      const out = strip("Hello ![alt text](https://img.example/x.png) world");
      return !out.includes("![") && !out.includes("http") && out.includes("Hello") && out.includes("world");
    },
    detail: (strip) => JSON.stringify(strip("Hello ![alt text](https://img.example/x.png) world")),
  },
  {
    name: "strip: table row keeps words without pipes",
    input: "| Fake Dental | Pune | Dentist |",
    run: (strip) => {
      const out = strip("| Fake Dental | Pune | Dentist |");
      return !out.includes("|") && out.includes("Fake Dental") && out.includes("Pune");
    },
    detail: (strip) => JSON.stringify(strip("| Fake Dental | Pune | Dentist |")),
  },
  {
    name: "strip: non-string input returns ''",
    input: 12345,
    run: (strip) => strip(12345 as unknown as string) === "" && strip(undefined as unknown as string) === "",
    detail: (strip) => JSON.stringify(strip(12345 as unknown as string)),
  },
];

for (const item of stripCases) {
  if (!hasStrip(mod)) {
    check(item.name, false, "stripMarkdown is not exported by enrich.js");
  } else {
    try {
      check(item.name, item.run(mod.stripMarkdown), item.detail(mod.stripMarkdown));
    } catch (error) {
      check(item.name, false, `threw: ${String(error)}`);
    }
  }
}

// ---- summary table (via enrichFromPages) ----
const summaryCases: Array<{ name: string; run: () => { ok: boolean; detail: string } }> = [
  {
    name: "summary: nav links plus a real sentence yields that sentence",
    run: () => {
      if (!canSummarize(mod)) return { ok: false, detail: "enrichFromPages missing" };
      const text = `[Home](https://fake-nav.example/) [About Us](https://fake-nav.example/about) [Contact](https://fake-nav.example/contact) ${REAL_SENTENCE}`;
      const summary = mod.enrichFromPages(fakeLead(), [{ url: "https://fake-nav.example/", text }]).summary;
      const ok = summary.includes("gentle family dentistry") && !summary.includes("](") && !summary.includes("http");
      return { ok, detail: JSON.stringify(summary.slice(0, 160)) };
    },
  },
  {
    name: "summary: navigation-only page yields empty summary",
    run: () => {
      if (!canSummarize(mod)) return { ok: false, detail: "enrichFromPages missing" };
      const text = "[Home](https://fake-nav.example/) [About Us](https://fake-nav.example/about) [Contact](https://fake-nav.example/contact)";
      const summary = mod.enrichFromPages(fakeLead(), [{ url: "https://fake-nav.example/", text }]).summary;
      return { ok: summary === "", detail: JSON.stringify(summary.slice(0, 120)) };
    },
  },
  {
    name: "summary: length at most 280 and cut at a word boundary",
    run: () => {
      if (!canSummarize(mod)) return { ok: false, detail: "enrichFromPages missing" };
      const longBits = "Fake Dental Care in Pune offers gentle family dentistry with painless root canals, digital xrays, braces, implants, crowns, cleaning, whitening, kids dentistry, senior care, emergency slots, online booking, weekend hours, insurance help, calm rooms, kind staff, and honest prices for every single family visiting our clinic daily.";
      const summary = mod.enrichFromPages(fakeLead(), [{ url: "https://fake-long.example/", text: longBits }]).summary;
      const wordCut = summary.length < longBits.length ? /[A-Za-z0-9]$/.test(summary) && /[A-Za-z0-9]/.test(longBits[summary.length] ?? " ") === false : true;
      return { ok: summary.length <= 280 && wordCut, detail: `len=${summary.length} ${JSON.stringify(summary.slice(-60))}` };
    },
  },
  {
    name: "summary: sentences under 40 chars are excluded",
    run: () => {
      if (!canSummarize(mod)) return { ok: false, detail: "enrichFromPages missing" };
      const text = `Hi there. ${REAL_SENTENCE}`;
      const summary = mod.enrichFromPages(fakeLead(), [{ url: "https://fake-short.example/", text }]).summary;
      return { ok: !summary.includes("Hi there") && summary.includes("gentle family dentistry"), detail: JSON.stringify(summary.slice(0, 160)) };
    },
  },
  {
    name: "summary: sentences under 5 letter-words are excluded",
    run: () => {
      if (!canSummarize(mod)) return { ok: false, detail: "enrichFromPages missing" };
      const text = `Call now 12345 today ok yes. ${REAL_SENTENCE}`;
      const summary = mod.enrichFromPages(fakeLead(), [{ url: "https://fake-words.example/", text }]).summary;
      return { ok: !summary.includes("Call now 12345") && summary.includes("gentle family dentistry"), detail: JSON.stringify(summary.slice(0, 160)) };
    },
  },
];

for (const item of summaryCases) {
  try {
    const result = item.run();
    check(item.name, result.ok, result.detail);
  } catch (error) {
    check(item.name, false, `threw: ${String(error)}`);
  }
}

console.log(`--- markdown-summary-check: ${passed} passed, ${failed} failed ---`);
if (failed > 0) process.exitCode = 1;
