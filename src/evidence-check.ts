// src/evidence-check.ts - proof script for evidence.ts (Order L15)
// No network calls; runs against fake fixtures and an in-memory SQLite database.

// @ts-ignore node:sqlite is a Node 24 built-in; ambient types are not available in this environment.
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bizKey,
  buildEvidence,
  extractFacts,
  contentHash,
  saveEvidence,
  loadEvidence,
  cleanPageText,
} from "./evidence.js";
import type { RawLead, Enrichment } from "./types.js";
import type { Evidence, Verification } from "./types-v2.js";

type Fixture = {
  name: string;
  raw: RawLead;
  enrichment: Enrichment;
  pages: { url: string; body: string; fetchedAt: string }[];
  verification?: Verification;
  expected: Record<string, unknown>;
};

type Result = { check: string; fixture?: string; status: "PASS" | "FAIL"; error?: string };

const results: Result[] = [];

function getListingSource(field: string | undefined, raw: RawLead): string | undefined {
  switch (field) {
    case "name":
      return raw.name;
    case "phone":
      return raw.phone;
    case "website":
      return raw.website;
    case "email":
      return raw.email;
    case "address":
      return raw.address;
    case "area":
      return raw.city;
    case "no-website":
      return "No website on the public listing";
    default:
      return undefined;
  }
}

function buildFor(fixture: Fixture): Evidence[] {
  return buildEvidence(fixture.raw, fixture.enrichment, fixture.pages, fixture.verification);
}

// --------------------------------------------------------------- checks

function checkBizKey(fixture: Fixture): string | undefined {
  const key = bizKey(fixture.raw, fixture.enrichment.phones);
  if (key !== fixture.expected.bizKey) {
    return `expected bizKey "${fixture.expected.bizKey}", got "${key}"`;
  }
}

function checkSubstrings(fixture: Fixture): string | undefined {
  const evidence = buildFor(fixture);
  for (const item of evidence) {
    if (item.kind === "absence" || item.kind === "verification") continue;

    if (item.kind === "listing") {
      const source = getListingSource(item.field, fixture.raw);
      if (source === undefined) return `listing item ${item.id} has unknown field ${item.field}`;
      if (!source.includes(item.quote)) {
        return `listing ${item.id} (${item.field}) quote not in source: "${item.quote.slice(0, 60)}"`;
      }
      continue;
    }

    const page = fixture.pages.find((p) => p.url === item.url);
    if (!page) return `${item.kind} ${item.id} missing page ${item.url}`;

    if (item.kind === "page-text") {
      const cleaned = cleanPageText(page.body);
      if (!cleaned.includes(item.quote)) {
        return `page-text ${item.id} quote not in cleaned source: "${item.quote.slice(0, 60)}"`;
      }
    } else if (item.kind === "structured-data") {
      const scripts = page.body.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
      const found = scripts.some((script) => {
        const jsonText = script.replace(/<[^>]+>/g, "");
        return jsonText.includes(item.quote);
      });
      if (!found) {
        return `structured ${item.id} quote not found in any JSON-LD script: "${item.quote.slice(0, 60)}"`;
      }
    }
  }
}

function checkIds(fixture: Fixture): string | undefined {
  const evidence = buildFor(fixture);
  for (let i = 0; i < evidence.length; i += 1) {
    const expected = `E${i + 1}`;
    if (evidence[i].id !== expected) {
      return `position ${i} expected ${expected}, got ${evidence[i].id}`;
    }
  }
  const ids = new Set(evidence.map((i) => i.id));
  if (ids.size !== evidence.length) return "duplicate ids detected";
}

function checkNoWebsite(fixture: Fixture): string | undefined {
  if (!fixture.expected.hasNoWebsiteItem) return;
  const evidence = buildFor(fixture);
  const found = evidence.some((i) => i.kind === "listing" && i.field === "no-website");
  if (!found) return "missing no-website listing item";
}

function checkAbsence(fixture: Fixture): string | undefined {
  if (!fixture.expected.hasAbsenceItems) return;
  const evidence = buildFor(fixture);
  const absentSignals = new Set([
    "no-online-booking",
    "no-chat-widget",
    "no-contact-form",
    "no-analytics",
    "no-https",
    "not-mobile-friendly",
  ]);
  const signals = (fixture.enrichment.signals ?? []).filter((s) => absentSignals.has(s));
  for (const signal of signals) {
    const item = evidence.find((i) => i.field === `signal:${signal}`);
    if (!item) return `missing absence item for ${signal}`;
    if (!item.quote.includes(`Checked ${fixture.pages.length} page`)) {
      return `absence item for ${signal} does not name page count`;
    }
  }
}

function checkJsonLdRating(fixture: Fixture): string | undefined {
  if (fixture.expected.rating == null) return;
  const evidence = buildFor(fixture);
  const facts = extractFacts(evidence, fixture.raw);
  if (facts.rating?.value !== fixture.expected.rating) {
    return `expected rating ${fixture.expected.rating}, got ${facts.rating?.value}`;
  }
  if (facts.reviewCount?.value !== fixture.expected.reviewCount) {
    return `expected reviewCount ${fixture.expected.reviewCount}, got ${facts.reviewCount?.value}`;
  }
}

function checkPlainTextRating(fixture: Fixture): string | undefined {
  if (fixture.expected.hasRatingFact !== false) return;
  const evidence = buildFor(fixture);
  const facts = extractFacts(evidence, fixture.raw);
  if (facts.rating || facts.reviewCount) {
    return "plain-text rating produced a rating/reviewCount fact";
  }
}

function checkSince1998(fixture: Fixture): string | undefined {
  if (fixture.expected.sinceYear == null) return;
  const evidence = buildFor(fixture);
  const facts = extractFacts(evidence, fixture.raw);
  if (facts.sinceYear?.value !== fixture.expected.sinceYear) {
    return `expected sinceYear ${fixture.expected.sinceYear}, got ${facts.sinceYear?.value}`;
  }
  const item = evidence.find((i) => i.field === "since-year");
  if (!item || !facts.sinceYear?.evidence.includes(item.id)) {
    return "sinceYear does not cite the since-year item";
  }
}

function checkFutureYear(fixture: Fixture): string | undefined {
  if (fixture.expected.hasSinceYearFact !== false) return;
  const evidence = buildFor(fixture);
  const facts = extractFacts(evidence, fixture.raw);
  if (facts.sinceYear) return "future year produced a sinceYear fact";
}

function checkOwner(fixture: Fixture): string | undefined {
  const evidence = buildFor(fixture);
  const facts = extractFacts(evidence, fixture.raw);
  if (fixture.expected.owner != null) {
    if (facts.owner?.value !== fixture.expected.owner) {
      return `expected owner "${fixture.expected.owner}", got "${facts.owner?.value}"`;
    }
  }
  if (fixture.expected.hasOwnerFact === false && facts.owner) {
    return "unexpected owner fact";
  }
}

function checkCap(fixture: Fixture): string | undefined {
  if (fixture.expected.itemCount !== 14) return;
  const evidence = buildFor(fixture);
  if (evidence.length !== 14) {
    return `expected 14 items, got ${evidence.length}`;
  }
  const hasListing = evidence.some((i) => i.kind === "listing");
  const hasAbsence = evidence.some((i) => i.kind === "absence");
  const hasVerification = evidence.some((i) => i.kind === "verification");
  if (!hasListing) return "cap dropped all listing items";
  if (!hasAbsence) return "cap dropped all absence items";
  if (!hasVerification) return "cap dropped all verification items";
}

function checkHashOrder(fixture: Fixture): string | undefined {
  if (!fixture.expected.hashStable) return;
  const h1 = contentHash(fixture.pages);
  const shuffled = [...fixture.pages].reverse();
  const h2 = contentHash(shuffled);
  if (h1 !== h2) return "content hash changed when page order was reversed";
}

function checkRoundTrip(): string | undefined {
  const db = new DatabaseSync(":memory:");
  const raw: RawLead = {
    name: "Round Trip Test",
    category: "test",
    source: "test",
    sourceUrl: "https://roundtrip-test.example",
  };
  const enrichment: Enrichment = {
    summary: "round trip test",
    emails: [],
    phones: [],
    socials: {},
    signals: [],
  };
  const pages = [
    {
      url: "https://roundtrip-test.example/",
      body: "<!DOCTYPE html><html><head><title>Round Trip</title></head><body><p>Since 2015.</p></body></html>",
      fetchedAt: "2026-10-07T00:00:00.000Z",
    },
  ];
  const evidence = buildEvidence(raw, enrichment, pages);
  const hash = contentHash(pages);
  const key = bizKey(raw);
  saveEvidence(key, hash, evidence, db);
  const loaded = loadEvidence(key, db);
  if (!loaded) return "load returned undefined";
  if (loaded.hash !== hash) return "hash mismatch after round trip";
  if (loaded.evidence.length !== evidence.length) {
    return `evidence length mismatch: expected ${evidence.length}, got ${loaded.evidence.length}`;
  }
  for (let i = 0; i < evidence.length; i += 1) {
    if (loaded.evidence[i].id !== evidence[i].id) {
      return `id mismatch at index ${i}: expected ${evidence[i].id}, got ${loaded.evidence[i].id}`;
    }
  }
}

// --------------------------------------------------------------- runner

function runCheck(name: string, fixture: Fixture | undefined, fn: (f: Fixture) => string | undefined) {
  try {
    const error = fixture ? fn(fixture) : undefined;
    results.push({ check: name, fixture: fixture?.name, status: error ? "FAIL" : "PASS", error });
  } catch (err) {
    results.push({ check: name, fixture: fixture?.name, status: "FAIL", error: String(err) });
  }
}

function runGlobalCheck(name: string, fn: () => string | undefined) {
  try {
    const error = fn();
    results.push({ check: name, status: error ? "FAIL" : "PASS", error });
  } catch (err) {
    results.push({ check: name, status: "FAIL", error: String(err) });
  }
}

function isValidFixture(obj: unknown): obj is Fixture {
  if (!obj || typeof obj !== "object") return false;
  const f = obj as Partial<Fixture>;
  return (
    typeof f.name === "string" &&
    f.raw != null &&
    f.enrichment != null &&
    Array.isArray(f.pages) &&
    f.expected != null
  );
}

async function main() {
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures-v2", "evidence");
  const files = (await readdir(fixturesDir)).filter((f) => f.endsWith(".json"));
  const fixtures: Fixture[] = [];
  const skipped: string[] = [];
  for (const file of files.sort()) {
    const text = await readFile(join(fixturesDir, file), "utf-8");
    const parsed = JSON.parse(text) as unknown;
    if (isValidFixture(parsed)) {
      fixtures.push(parsed);
    } else {
      skipped.push(file);
    }
  }

  for (const fixture of fixtures) {
    runCheck("bizKey", fixture, checkBizKey);
    runCheck("substrings", fixture, checkSubstrings);
    runCheck("ids", fixture, checkIds);
    runCheck("noWebsite", fixture, checkNoWebsite);
    runCheck("absence", fixture, checkAbsence);
    runCheck("jsonLdRating", fixture, checkJsonLdRating);
    runCheck("plainTextRating", fixture, checkPlainTextRating);
    runCheck("sinceYear", fixture, checkSince1998);
    runCheck("futureYear", fixture, checkFutureYear);
    runCheck("owner", fixture, checkOwner);
    runCheck("cap", fixture, checkCap);
    runCheck("hashOrder", fixture, checkHashOrder);
  }

  runGlobalCheck("roundTrip", checkRoundTrip);

  for (const r of results) {
    const name = r.fixture ? `${r.check}/${r.fixture}` : r.check;
    console.log(`${r.status}: ${name}${r.error ? ` - ${r.error}` : ""}`);
  }

  if (skipped.length > 0) {
    console.log(`\nSKIPPED ${skipped.length} malformed fixture file(s): ${skipped.join(", ")}`);
  }

  const passCount = results.filter((r) => r.status === "PASS").length;
  const failCount = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n${failCount === 0 ? "ALL PASS" : "SOME FAILS"}: ${passCount} passed, ${failCount} failed`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
