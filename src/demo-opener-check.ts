// src/demo-opener-check.ts
// Offline proof for DEMO6-opener-and-reasons. No network, no model calls.
// Checks that the gap-free opener is built from the lead's top-ranked offer only,
// names the category in plain words, and that every video service carries a
// reason for every signal id in the rules table. A temp database path is set
// before the dynamic import so nothing ever touches the live product database.
//
// Run once, foreground: npx tsx src/demo-opener-check.ts
//
// Every business, address, email, number and domain below is clearly fake.

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB_PATH = join(tmpdir(), `leadscout-demo-opener-${process.pid}.db`);
process.env.LEADSCOUT_DB = DB_PATH;

const { buildTemplateDossier } = await import("./dossier.js");
const { loadRules } = await import("./match.js");
import type { DossierInput } from "./dossier.js";
import type { FitService, Lead } from "./types.js";
import type { Evidence, LeadScore, PriceBook, PriceItem } from "./types-v2.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `  :: ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- fixtures

const VIDEO_SERVICE_IDS = [
  "brand-film",
  "social-reels",
  "property-walkthrough",
  "wedding-event-film",
  "product-shoot",
];

const LABELS: Record<string, string> = {
  "brand-film": "Brand film",
  "social-reels": "Social reels",
  "property-walkthrough": "Property walkthrough",
  "wedding-event-film": "Wedding and event film",
  "product-shoot": "Product shoot",
  website: "Website",
};

const CATEGORIES = ["real-estate-developer", "restaurant", "hotel"];

function priceItem(service: string): PriceItem {
  return {
    service,
    label: LABELS[service] ?? service,
    description: `Fake fixture service: ${service}.`,
    buildDays: [1, 2],
    price: { currency: "INR", min: 1, max: 2 },
    assumption: "Fake fixture only.",
    doorOpener: false,
  };
}

function makeInput(
  serviceIds: string[],
  category: string,
  name: string,
  evidence: Evidence[] = [],
): DossierInput {
  const fit: FitService[] = serviceIds.map((service, i) => ({
    service,
    score: 90 - i,
    reason: "fake fixture reason",
  }));
  const lead = {
    id: `lead-${category}`,
    workspaceId: "ws-fixture",
    name,
    category,
    city: "Faketown",
    country: "India",
    source: "fixture",
    sourceUrl: "https://fixture.example/",
    summary: "Fake fixture lead for the opener check.",
    emails: ["hello@fixture.example"],
    phones: ["+91 00000 00000"],
    socials: {},
    signals: [],
    score: 60,
    fit,
    angle: "",
    status: "new",
    notes: "",
    createdAt: "2026-10-11T00:00:00.000Z",
  } as unknown as Lead;
  const priceBook: PriceBook = {
    workspaceId: "ws-fixture",
    version: 1,
    updatedAt: "2026-10-11T00:00:00.000Z",
    items: serviceIds.map(priceItem),
  };
  const score: LeadScore = {
    total: 60,
    fit: 70,
    reach: 80,
    timing: 50,
    gate: "template",
    reasons: [],
  };
  return {
    lead,
    evidence,
    facts: {},
    score,
    priceBook,
    explainer: null,
    workspaceName: "Fixture Workspace",
    offer: { services: serviceIds, description: "fake fixture offer" },
    senderName: undefined,
  };
}

// ---------------------------------------------------------------- 1. openers

for (const top of VIDEO_SERVICE_IDS) {
  const ordered = [top, ...VIDEO_SERVICE_IDS.filter((s) => s !== top)];
  for (const category of CATEGORIES) {
    const name = "Fake Fixture Business";
    const d = buildTemplateDossier(makeInput(ordered, category, name));
    const value = d.sayThis?.value ?? "";
    const lower = value.toLowerCase();

    check(`opener present for ${top}/${category}`, value !== "", value);
    check(`opener contains the lead name for ${top}/${category}`, value.includes(name), value);
    const idPattern = new RegExp(`\\b${category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    check(
      `opener never contains the dash-joined category id for ${top}/${category}`,
      !idPattern.test(value),
      value,
    );
    check(
      `opener never ends a list mid-word for ${top}/${category}`,
      value.endsWith("Do you have a minute?") && !value.includes(", Do you have a minute?"),
      value,
    );
    check(`opener under 240 characters for ${top}/${category}`, value.length < 240, `${value.length}`);
    check(
      `opener mentions only the top service for ${top}/${category}`,
      lower.includes(LABELS[top].toLowerCase()) &&
        ordered
          .filter((s) => s !== top)
          .every((other) => !lower.includes(LABELS[other].toLowerCase())),
      value,
    );
  }
}

// The plain category plural is spelled out, not the id.
{
  const d = buildTemplateDossier(
    makeInput(VIDEO_SERVICE_IDS, "real-estate-developer", "Fake Fixture Business"),
  );
  check(
    "category id pluralised to plain words: real estate developers",
    (d.sayThis?.value ?? "").includes("real estate developers"),
    d.sayThis?.value,
  );
}

// No mapped evidence -> no "and I noticed" clause.
{
  const d = buildTemplateDossier(
    makeInput(["brand-film", "social-reels"], "hotel", "Fake Fixture Business"),
  );
  check(
    "no evidence-backed observation -> clause omitted",
    !(d.sayThis?.value ?? "").includes("and I noticed"),
    d.sayThis?.value,
  );
}

// Mapped evidence -> "and I noticed" clause is present and plain.
{
  const evidence: Evidence[] = [
    {
      id: "E1",
      kind: "page-text",
      url: "https://fixture.example/",
      quote: "Fake fixture page text.",
      field: "signal:ecommerce",
      fetchedAt: "2026-10-11T00:00:00.000Z",
    },
  ];
  const d = buildTemplateDossier(
    makeInput(["brand-film"], "hotel", "Fake Fixture Business", evidence),
  );
  check(
    "evidence-backed observation -> clause present",
    (d.sayThis?.value ?? "").includes("and I noticed you already sell online"),
    d.sayThis?.value,
  );
}

// A non-video offer still produces a readable opener.
{
  const d = buildTemplateDossier(makeInput(["website"], "dental-clinic", "Fake Dental Clinic"));
  const value = d.sayThis?.value ?? "";
  check(
    "non-video offer (website) gives a readable opener",
    value !== "" &&
      value.includes("Fake Dental Clinic") &&
      value.includes("website") &&
      value.includes("dental clinics") &&
      value.endsWith("Do you have a minute?") &&
      value.length < 240,
    value,
  );
}

// ---------------------------------------------------------------- 2. reasons

const rules = loadRules();
const signalIds = Object.keys(rules.signals);

for (const id of VIDEO_SERVICE_IDS) {
  const service = rules.services.find((s) => s.id === id);
  const missing = signalIds.filter((sig) => {
    const reason = service?.reasons?.[sig];
    return typeof reason !== "string" || reason.trim() === "";
  });
  check(
    `reasons: ${id} has a reason for every signal id in signals`,
    !!service && missing.length === 0,
    missing.join(", "),
  );
  check(
    `reasons: ${id} reasons name only signals it weighs`,
    (service?.reasons ? Object.keys(service.reasons) : []).every(
      (sig) => sig in (service?.signals ?? {}),
    ),
    JSON.stringify(service?.reasons ? Object.keys(service.reasons).filter((sig) => !(sig in (service?.signals ?? {}))) : []),
  );
}

// ---------------------------------------------------------------- cleanup

if (existsSync(DB_PATH)) {
  try {
    unlinkSync(DB_PATH);
  } catch {
    /* temp file only; ignore */
  }
}

console.log("");
console.log(`Demo opener checks: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed checks: ${failures.join("; ")}`);
  process.exitCode = 1;
}
