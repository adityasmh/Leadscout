// Proof harness for tenant.ts price book + branding.
// Uses a temp database via LEADSCOUT_DB set before importing any module that opens the DB.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "leadscout-tenant-check-"));
const dbPath = join(tmpDir, "test.db");
process.env.LEADSCOUT_DB = dbPath;

const { getPriceBook, setPriceBook, priceFor, getBranding, setBranding } = await import("./tenant.js");
const { createWorkspace, closeDb } = await import("./store.js");
import type { PriceItem, Branding } from "./types-v2.js";

const SERVICE_IDS = [
  "website",
  "website-redesign",
  "automation",
  "ai-chatbot",
  "whatsapp-automation",
  "seo",
  "crm-setup",
  "booking-system",
  "ecommerce",
  "ai-voice-agent",
  "lead-gen",
];

const checks: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
  checks.push({ name, ok: condition, detail });
  const status = condition ? "PASS" : "FAIL";
  console.log(`${status}: ${name}${detail ? ` (${detail})` : ""}`);
  return condition;
}

function fail(name: string, detail: string) {
  return check(name, false, detail);
}

function assertThrows(name: string, fn: () => void, expectField: string) {
  try {
    fn();
    return check(name, false, `expected error for ${expectField} but none thrown`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return check(name, msg.includes(expectField), `error: ${msg}`);
  }
}

// ------------------------------------------------------------------ fixtures

function makeWs(name: string) {
  return createWorkspace({
    name,
    offer: { services: ["website"], description: "fake offer" },
    icp: { categories: ["dental"], cities: ["Mumbai"], countries: ["IN"] },
  });
}

function baseItem(service: string, overrides: Partial<PriceItem> = {}): PriceItem {
  return {
    service,
    label: service,
    description: "fake description",
    buildDays: null,
    price: null,
    assumption: "Price not set yet; final quote after a short call.",
    doorOpener: false,
    ...overrides,
  };
}

function baseBranding(overrides: Partial<Branding> = {}): Branding {
  return {
    displayName: "Fake Workspace",
    hidePoweredBy: false,
    ...overrides,
  };
}

// ------------------------------------------------------------------ scenarios

// 1. Default book has every listed service with null prices and exactly one door-opener.
{
  const book = getPriceBook("missing-ws-1");
  const services = book.items.map((i) => i.service);
  const allListed = SERVICE_IDS.every((id) => services.includes(id));
  const freeAudit = book.items.find((i) => i.service === "free-audit");
  const regularItems = book.items.filter((i) => i.service !== "free-audit");
  const allNullPrices = regularItems.every((i) => i.price === null);
  const doorOpeners = book.items.filter((i) => i.doorOpener).length;

  check("default-book-lists-services", allListed, `services=${services.length}`);
  check("default-book-free-audit-present", !!freeAudit);
  check("default-book-null-prices", allNullPrices);
  check("default-book-one-door-opener", doorOpeners === 1, `doorOpeners=${doorOpeners}`);
  check("default-book-version-zero", book.version === 0, `version=${book.version}`);
}

// 2. Set and get round trip.
{
  const ws = makeWs("Round-trip Workspace");
  const custom: PriceItem[] = [
    baseItem("website", {
      label: "Custom website",
      price: { currency: "INR", min: 10_000, max: 50_000 },
      buildDays: [5, 10],
    }),
    baseItem("free-audit", { doorOpener: true, price: { currency: "INR", min: 0, max: 0 } }),
  ];
  const saved = setPriceBook(ws.id, custom);
  const fetched = getPriceBook(ws.id);
  check("round-trip-saved", saved.items.length === custom.length);
  check("round-trip-fetched", JSON.stringify(fetched.items) === JSON.stringify(custom));
}

// 3. Version bumps on each set.
{
  const ws = makeWs("Version Workspace");
  const v1 = setPriceBook(ws.id, [baseItem("website")]);
  const v2 = setPriceBook(ws.id, [baseItem("website"), baseItem("seo")]);
  const v3 = getPriceBook(ws.id);
  check("version-first-set", v1.version === 1, `version=${v1.version}`);
  check("version-bumps", v2.version === v1.version + 1, `v2=${v2.version}`);
  check("version-read-bumps", v3.version === v2.version, `v3=${v3.version}`);
}

// 4. Two workspaces keep separate books and branding.
{
  const a = makeWs("Workspace A");
  const b = makeWs("Workspace B");
  setPriceBook(a.id, [baseItem("website", { label: "A website" })]);
  setPriceBook(b.id, [baseItem("seo", { label: "B SEO" })]);
  setBranding(a.id, baseBranding({ displayName: "Brand A", accent: "#abc" }));
  setBranding(b.id, baseBranding({ displayName: "Brand B", accent: "#aabbcc" }));
  const bookA = getPriceBook(a.id);
  const bookB = getPriceBook(b.id);
  const brandA = getBranding(a.id);
  const brandB = getBranding(b.id);
  check("isolation-a-book", priceFor(bookA, "website")?.label === "A website");
  check("isolation-b-book", priceFor(bookB, "seo")?.label === "B SEO");
  check("isolation-a-brand", brandA.displayName === "Brand A" && brandA.accent === "#abc");
  check("isolation-b-brand", brandB.displayName === "Brand B" && brandB.accent === "#aabbcc");
}

// 5. Each validation rule rejects a bad item with a message naming the field.
{
  const ws = makeWs("Validation Workspace");
  assertThrows("validate-empty-service", () => setPriceBook(ws.id, [baseItem("")]), "service");
  assertThrows("validate-duplicate-service", () => setPriceBook(ws.id, [baseItem("website"), baseItem("website")]), "unique");
  assertThrows("validate-bad-buildDays", () => setPriceBook(ws.id, [baseItem("website", { buildDays: [-1, 3] as any })]), "buildDays");
  assertThrows("validate-price-min-max", () => setPriceBook(ws.id, [baseItem("website", { price: { currency: "INR", min: 500, max: 100 } })]), "price");
  assertThrows("validate-price-max-cap", () => setPriceBook(ws.id, [baseItem("website", { price: { currency: "INR", min: 100_000_000, max: 100_000_000 } })]), "price.max");
  assertThrows("validate-currency", () => setPriceBook(ws.id, [baseItem("website", { price: { currency: "Rupees", min: 1, max: 2 } })]), "price.currency");
  assertThrows("validate-empty-assumption", () => setPriceBook(ws.id, [baseItem("website", { assumption: "" })]), "assumption");
  assertThrows("validate-long-assumption", () => setPriceBook(ws.id, [baseItem("website", { assumption: "x".repeat(201) })]), "assumption");
  assertThrows("validate-too-many-door-openers", () =>
    setPriceBook(ws.id, [
      baseItem("a", { doorOpener: true }),
      baseItem("b", { doorOpener: true }),
      baseItem("c", { doorOpener: true }),
      baseItem("d", { doorOpener: true }),
    ]), "door-openers");
}

// 6. priceFor finds and misses.
{
  const ws = makeWs("PriceFor Workspace");
  setPriceBook(ws.id, [baseItem("website", { label: "Found" }), baseItem("seo")]);
  const book = getPriceBook(ws.id);
  check("priceFor-find", priceFor(book, "website")?.label === "Found");
  check("priceFor-miss", priceFor(book, "missing-service") === undefined);
}

// 7. Branding rejects http: logo, bad colour and markup characters.
{
  const ws = makeWs("Branding Validation Workspace");
  assertThrows("branding-http-logo", () => setBranding(ws.id, baseBranding({ logoUrl: "http://example.com/logo.png" })), "https");
  assertThrows("branding-bad-accent", () => setBranding(ws.id, baseBranding({ accent: "#gggggg" })), "accent");
  assertThrows("branding-markup", () => setBranding(ws.id, baseBranding({ contactLine: "<script>" })), "<");
  assertThrows("branding-displayName-empty", () => setBranding(ws.id, baseBranding({ displayName: "" })), "displayName");
  assertThrows("branding-displayName-long", () => setBranding(ws.id, baseBranding({ displayName: "x".repeat(81) })), "displayName");
  assertThrows("branding-text-long", () => setBranding(ws.id, baseBranding({ contactLine: "x".repeat(301) })), "contactLine");
}

// ------------------------------------------------------------------ summary

closeDb();
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup failures */ }

const failures = checks.filter((c) => !c.ok);
const overall = failures.length === 0 ? "PASS" : "FAIL";
console.log(`\n${overall}: ${checks.length - failures.length}/${checks.length} checks passed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail ?? ""}`);
  process.exit(1);
}
