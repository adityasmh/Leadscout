// src/export-check.ts
// Self-contained PASS/FAIL harness for export.ts. No network calls.
// All fixtures are clearly fake: Acme Fake Co, example.invalid, +1-555-0100, etc.

import { exportRows } from "./export.js";
import type { Lead } from "./types.js";
import type { Dossier, LeadScore } from "./types-v2.js";

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    const message = err instanceof Error ? err.message : String(err);
    console.log(`FAIL ${name}: ${message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let leadCounter = 0;

function fakeLead(overrides: Partial<Lead> = {}): Lead {
  leadCounter += 1;
  return {
    id: `lead-${leadCounter}`,
    workspaceId: "ws-fake",
    name: `Acme Fake Co ${leadCounter}`,
    category: "clinic",
    source: "osm",
    sourceUrl: `https://www.openstreetmap.org/node/${leadCounter}`,
    summary: "Fake summary",
    emails: [],
    phones: [],
    socials: {},
    signals: [],
    score: 0,
    fit: [],
    angle: "",
    status: "new",
    notes: "",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Lead;
}

function fakeScore(overrides: Partial<LeadScore> = {}): LeadScore {
  return {
    total: 55,
    fit: 60,
    reach: 70,
    timing: 40,
    gate: "template",
    reasons: ["signal:has-phone"],
    ...overrides,
  };
}

function fakeDossier(overrides: Partial<Dossier> = {}): Dossier {
  return {
    leadId: "lead-1",
    workspaceId: "ws-fake",
    bizKey: "biz-1",
    level: 0,
    facts: {},
    gap: null,
    sayThis: null,
    pushback: null,
    offers: [],
    evidence: [],
    callStatus: "not-called",
    dropped: [],
    inputHash: "h1",
    promptVersion: "v1",
    tokensIn: 0,
    tokensOut: 0,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function cited<T>(value: T): { value: T; evidence: ["E1"] } {
  return { value, evidence: ["E1"] };
}

function csvLines(body: string): string[] {
  return body.replace(/\n$/, "").split("\n");
}

function parseCsvRow(row: string): string[] {
  const cols: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    const next = row[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        cols.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  cols.push(current);
  return cols;
}

// ---------------------------------------------------------------- checks

check("header row plus one row per lead per format", () => {
  const leadA = fakeLead({ id: "la", name: "Acme Fake Co A" });
  const leadB = fakeLead({ id: "lb", name: "Acme Fake Co B" });
  const extras = new Map([
    ["la", { score: fakeScore() }],
    ["lb", { score: fakeScore() }],
  ]);
  for (const format of ["generic", "hubspot", "zoho", "twenty"] as const) {
    const { body } = exportRows([leadA, leadB], extras, format);
    const lines = csvLines(body);
    assert(lines.length === 3, `${format}: expected header + 2 data lines, got ${lines.length}`);
  }
  const { body: jsonBody } = exportRows([leadA, leadB], extras, "jsonl");
  const lines = jsonBody.replace(/\n$/, "").split("\n").filter((l) => l !== "");
  assert(lines.length === 2, `jsonl: expected 2 lines, got ${lines.length}`);
});

check("hidden leads are skipped", () => {
  const visible = fakeLead({ id: "vis", name: "Visible Fake Co" });
  const hidden = fakeLead({ id: "hid", name: "Hidden Fake Co" });
  const extras = new Map([
    ["vis", { score: fakeScore({ gate: "template" }) }],
    ["hid", { score: fakeScore({ gate: "hidden" }) }],
  ]);
  for (const format of ["generic", "hubspot", "zoho", "twenty"] as const) {
    const { body } = exportRows([visible, hidden], extras, format);
    const lines = csvLines(body);
    assert(lines.length === 2, `${format}: expected 2 lines, got ${lines.length}`);
    assert(!body.includes("Hidden Fake Co"), `${format}: hidden lead name leaked into CSV`);
  }
  const { body: jsonBody } = exportRows([visible, hidden], extras, "jsonl");
  const lines = jsonBody.replace(/\n$/, "").split("\n").filter((l) => l !== "");
  assert(lines.length === 1, `jsonl: expected 1 line, got ${lines.length}`);
  assert(!jsonBody.includes("Hidden Fake Co"), "jsonl: hidden lead leaked");
});

check("commas, quotes and newlines are correctly quoted/escaped", () => {
  const lead = fakeLead({
    id: "special",
    name: "Acme, Inc.",
  });
  const dossier = fakeDossier({
    leadId: "special",
    gap: {
      headline: cited('Said "hello"\nand welcomed guests'),
      tag: "LEAKING",
    },
  });
  const extras = new Map([["special", { score: fakeScore(), dossier }]]);
  const { body } = exportRows([lead], extras, "generic");
  assert(body.includes('"Acme, Inc."'), "comma not quoted");
  assert(body.includes('"Said ""hello""'), "quotes not escaped");
  assert(/"[^"]*\nand[^"]*"/.test(body), "newline not preserved inside quotes");
});

check("formula-like value is neutralised with a leading apostrophe", () => {
  for (const prefix of ["=", "+", "-", "@"]) {
    const lead = fakeLead({ id: `formula-${prefix}`, name: `${prefix}HYPERLINK("bad")` });
    const extras = new Map([[`formula-${prefix}`, { score: fakeScore() }]]);
    const { body } = exportRows([lead], extras, "generic");
    assert(body.includes(`'${prefix}HYPERLINK`), `${prefix}: formula not neutralised`);
  }
});

check("characters = + - @ after the first char are not prefixed", () => {
  const lead = fakeLead({ id: "not-formula", name: "Price is 5+5 = 10" });
  const extras = new Map([["not-formula", { score: fakeScore() }]]);
  const { body } = exportRows([lead], extras, "generic");
  assert(!body.includes("'Price is 5+5 = 10"), "non-leading formula chars got an unwanted apostrophe");
});

check("lead with no dossier exports empty dossier columns", () => {
  const lead = fakeLead({ id: "nodossier", name: "No Dossier Fake Co" });
  const extras = new Map([["nodossier", { score: fakeScore() }]]);
  const { body } = exportRows([lead], extras, "generic");
  const lines = csvLines(body);
  assert(lines.length === 2, "expected header + 1 row");
  const headerCols = parseCsvRow(lines[0]);
  const rowCols = parseCsvRow(lines[1]);
  assert(headerCols.length === rowCols.length, "row column count does not match header");
  const gapIdx = headerCols.indexOf("gap_tag");
  assert(gapIdx !== -1, "missing gap_tag header");
  assert(rowCols[gapIdx] === "", `expected empty gap_tag, got ${rowCols[gapIdx]}`);
  const json = exportRows([lead], extras, "jsonl");
  const parsed = JSON.parse(json.body.trim());
  assert(parsed.dossier === null, "jsonl no-dossier lead should have null dossier");
});

check("duplicate evidence URLs collapse to unique", () => {
  const lead = fakeLead({ id: "dedupe", name: "Dedupe Fake Co" });
  const dossier = fakeDossier({
    leadId: "dedupe",
    evidence: [
      { id: "E1", kind: "listing", url: "https://a.example.invalid/1", quote: "q1", fetchedAt: "2026-01-01T00:00:00Z" },
      { id: "E2", kind: "page-text", url: "https://a.example.invalid/1", quote: "q2", fetchedAt: "2026-01-01T00:00:00Z" },
      { id: "E3", kind: "page-text", url: "https://b.example.invalid/2", quote: "q3", fetchedAt: "2026-01-01T00:00:00Z" },
    ],
  });
  const extras = new Map([["dedupe", { score: fakeScore(), dossier }]]);
  const { body } = exportRows([lead], extras, "generic");
  const lines = csvLines(body);
  const headerCols = parseCsvRow(lines[0]);
  const rowCols = parseCsvRow(lines[1]);
  const idx = headerCols.indexOf("evidence_urls");
  assert(idx !== -1, "missing evidence_urls header");
  const urls = rowCols[idx].split(";");
  assert(urls.length === 2, `expected 2 unique urls, got ${urls.length}`);
  assert(new Set(urls).size === urls.length, "evidence urls are not unique");
});

check("null quote shows 'price not set' and populated quote renders currency min-max", () => {
  const nullLead = fakeLead({ id: "quote-null", name: "Null Quote Fake Co" });
  const nullDossier = fakeDossier({
    leadId: "quote-null",
    offers: [
      {
        rank: 1,
        service: "website",
        title: "Website Redesign",
        description: cited("Build a new site."),
        whyItMatters: cited("Looks professional."),
        buildDays: [5, 10],
        quote: null,
        assumption: "Assumption A",
        doorOpener: false,
      },
    ],
  });
  const popLead = fakeLead({ id: "quote-pop", name: "Pop Quote Fake Co" });
  const popDossier = fakeDossier({
    leadId: "quote-pop",
    offers: [
      {
        rank: 1,
        service: "automation",
        title: "Automation",
        description: cited("Automate tasks."),
        whyItMatters: cited("Saves time."),
        buildDays: [2, 5],
        quote: { currency: "INR", min: 10000, max: 25000 },
        assumption: "Assumption B",
        doorOpener: false,
      },
    ],
  });
  const sameLead = fakeLead({ id: "quote-same", name: "Same Quote Fake Co" });
  const sameDossier = fakeDossier({
    leadId: "quote-same",
    offers: [
      {
        rank: 1,
        service: "crm-setup",
        title: "CRM Setup",
        description: cited("Set up CRM."),
        whyItMatters: cited("Track leads."),
        buildDays: [1, 1],
        quote: { currency: "USD", min: 500, max: 500 },
        assumption: "Assumption C",
        doorOpener: false,
      },
    ],
  });
  const extras = new Map([
    ["quote-null", { score: fakeScore(), dossier: nullDossier }],
    ["quote-pop", { score: fakeScore(), dossier: popDossier }],
    ["quote-same", { score: fakeScore(), dossier: sameDossier }],
  ]);
  const { body } = exportRows([nullLead, popLead, sameLead], extras, "generic");
  assert(body.includes("price not set"), "null quote did not render as 'price not set'");
  assert(body.includes("INR 10000-25000"), "populated quote did not render as currency min-max");
  assert(body.includes("USD 500-500"), "min===max quote did not render as currency n-n");
});

check("each JSONL line parses and has lead, score, dossier keys", () => {
  const lead = fakeLead({ id: "json", name: "JSON Fake Co" });
  const dossier = fakeDossier({ leadId: "json" });
  const extras = new Map([["json", { score: fakeScore(), dossier }]]);
  const { body, contentType } = exportRows([lead], extras, "jsonl");
  assert(contentType === "application/x-ndjson", "wrong jsonl content type");
  const lines = body.replace(/\n$/, "").split("\n").filter((l) => l !== "");
  assert(lines.length === 1, "expected 1 jsonl line");
  const parsed = JSON.parse(lines[0]);
  assert(parsed && typeof parsed === "object", "parsed line is not an object");
  assert("lead" in parsed, "missing lead key");
  assert("score" in parsed, "missing score key");
  assert("dossier" in parsed, "missing dossier key");
});

check("OSM attribution appears only for source: 'osm' leads", () => {
  const osmLead = fakeLead({ id: "osm", name: "OSM Fake Co", source: "osm" });
  const otherLead = fakeLead({ id: "other", name: "Other Fake Co", source: "manual" });
  const extras = new Map([
    ["osm", { score: fakeScore() }],
    ["other", { score: fakeScore() }],
  ]);
  const { body } = exportRows([osmLead, otherLead], extras, "generic");
  const lines = csvLines(body);
  const headerCols = parseCsvRow(lines[0]);
  const attrIdx = headerCols.indexOf("attribution");
  assert(attrIdx !== -1, "missing attribution header");
  const osmRow = parseCsvRow(lines[1]);
  const otherRow = parseCsvRow(lines[2]);
  assert(osmRow[attrIdx].includes("OpenStreetMap contributors"), "OSM lead missing attribution");
  assert(otherRow[attrIdx] === "", `non-OSM lead should have empty attribution, got ${otherRow[attrIdx]}`);
});

check("empty leads array yields header-only CSV and empty JSONL", () => {
  const extras = new Map();
  for (const format of ["generic", "hubspot", "zoho", "twenty"] as const) {
    const { body, contentType } = exportRows([], extras, format);
    assert(contentType === "text/csv; charset=utf-8", `${format}: wrong content type`);
    const lines = csvLines(body);
    assert(lines.length === 1, `${format}: expected 1 header line, got ${lines.length}`);
    assert(!body.includes("\r\n"), `${format}: body contains CRLF`);
  }
  const { body, contentType } = exportRows([], extras, "jsonl");
  assert(contentType === "application/x-ndjson", "jsonl: wrong content type");
  assert(body === "", "jsonl: expected empty body for empty leads");
});

check("carriage return / newline combinations are handled", () => {
  const lead = fakeLead({
    id: "crlf",
    name: "CRLF Fake Co",
    address: "Line 1\r\nLine 2",
  });
  const dossier = fakeDossier({
    leadId: "crlf",
    gap: {
      headline: cited("Saves time\nand money"),
      tag: "LEAKING",
    },
  });
  const extras = new Map([["crlf", { score: fakeScore(), dossier }]]);
  const { body } = exportRows([lead], extras, "generic");
  assert(body.includes("Line 1\r\nLine 2"), "CRLF inside value not preserved");
  assert(body.includes("Saves time\nand money"), "LF inside value not preserved");
  assert(!body.includes("\r\n\r\n"), "extra CRLF line breaks introduced");
  assert(!body.endsWith("\r\n"), "body ends with CRLF");
});

check("unicode and non-ASCII text passes through untouched", () => {
  const lead = fakeLead({
    id: "unicode",
    name: "क├ęम फेक कंपनी", // mixed unicode glyphs
    city: "Mumbai",
    address: "12 ₹ रोड, 日本",
  });
  const extras = new Map([["unicode", { score: fakeScore() }]]);
  const { body } = exportRows([lead], extras, "generic");
  assert(body.includes("क├ęम फेक कंपनी"), "unicode name not preserved");
  assert(body.includes("12 ₹ रोड, 日本"), "unicode address not preserved");
  assert(!body.startsWith("\uFEFF"), "body starts with BOM");
});

check("missing optional fields render as empty cells not undefined/null", () => {
  const lead = fakeLead({
    id: "missing",
    name: "Missing Fields Co",
    city: undefined,
    country: null as unknown as undefined,
    email: undefined,
    website: undefined,
  });
  const extras = new Map([["missing", { score: fakeScore() }]]);
  const { body } = exportRows([lead], extras, "generic");
  assert(!body.includes("undefined"), "body contains literal undefined");
  assert(!body.includes("null"), "body contains literal null");
});

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll export checks passed");
