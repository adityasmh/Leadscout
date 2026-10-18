// src/demo-pack-check.ts
// Proof for the DEMO1 video/film production service pack. Offline: no network, no model calls.
// The enrich() checks inject a fake fetchFn, so they never touch the network. match() is pure.
// The SQLite path is pointed at a temp file (never the real product database).
//
// Run once, foreground: npx tsx src/demo-pack-check.ts
//
// Every business, address, email, number and domain below is clearly fake (.example).

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveSignals, loadRules, match } from "./match.js";
import { enrich, type FetchFn } from "./enrich.js";
import type { Enrichment, Offer, RawLead } from "./types.js";

const DB_PATH = join(tmpdir(), `leadscout-demo-pack-${process.pid}.db`);
process.env.LEADSCOUT_DB = DB_PATH;

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

// ---------------------------------------------------------------- helpers

const FAKE_SOURCE_URL = "https://www.openstreetmap.org/node/999777";

type FakeSite = { fn: FetchFn; calls: string[] };

/** A fetch that answers robots.txt with 404 and every other URL with one fake HTML page. */
function fakeSite(html: string): FakeSite {
  const calls: string[] = [];
  const fn: FetchFn = async (...args: Parameters<FetchFn>) => {
    const input = args[0];
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as Request).url);
    calls.push(url);
    if (url.endsWith("/robots.txt")) {
      return new Response("", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
  return { fn, calls };
}

// ---------------------------------------------------------------- fixtures

const DEV_HTML =
  `<html lang="en"><head><title>Fixture Realty Developers</title>` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<meta name="description" content="Fixture Realty Developers builds fake homes in Fake Nagar, Pune, India.">` +
  `</head><body><h1>Fixture Realty Developers</h1><p>Fake project details only.</p></body></html>`;

const HOTEL_HTML =
  `<html lang="en"><head><title>Fixture Grand Hotel</title>` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<meta name="description" content="Fixture Grand Hotel is a fake hotel in Fake Nagar, Pune, India.">` +
  `</head><body><h1>Fixture Grand Hotel</h1>` +
  `<iframe src="https://www.youtube.com/embed/FIXTURE123"></iframe>` +
  `<a href="https://www.facebook.com/fixturegrand">Facebook</a>` +
  `</body></html>`;

const DEV_LEAD: RawLead = {
  name: "Fixture Realty Developers",
  category: "real-estate-developer",
  city: "Pune",
  country: "India",
  website: "https://fixture-realty.example",
  email: "hello@fixture-realty.example",
  phone: "+91 00000 00011",
  source: "osm",
  sourceUrl: FAKE_SOURCE_URL,
};

const HOTEL_LEAD: RawLead = {
  name: "Fixture Grand Hotel",
  category: "hotel",
  city: "Pune",
  country: "India",
  website: "https://fixture-grand.example",
  email: "hello@fixture-grand.example",
  phone: "+91 00000 00012",
  source: "osm",
  sourceUrl: FAKE_SOURCE_URL,
};

const REST_LEAD: RawLead = {
  name: "Fixture Spice Restaurant",
  category: "restaurant",
  city: "Pune",
  country: "India",
  email: "hello@fixture-spice.example",
  phone: "+91 00000 00013",
  source: "osm",
  sourceUrl: FAKE_SOURCE_URL,
};

// Baseline fixture and numbers captured from a throwaway run BEFORE this pack was added.
const BASE_LEAD: RawLead = {
  name: "Fake Baseline Clinic",
  category: "clinic",
  city: "Pune",
  country: "India",
  website: "https://fakebaseline.example",
  email: "hello@fakebaseline.example",
  phone: "+91 00000 00009",
  source: "osm",
  sourceUrl: "https://www.openstreetmap.org/node/999900",
};
const BASE_ENRICH: Enrichment = {
  fetchedUrl: "https://fakebaseline.example",
  summary: "Fake Baseline Clinic is a clinic in Pune.",
  emails: ["hello@fakebaseline.example"],
  phones: ["+91 00000 00009"],
  socials: {},
  signals: ["no-online-booking", "no-analytics"],
};
const BASELINE_SCORES: Record<string, number> = {
  "booking-system": 83,
  "ai-voice-agent": 72,
  "crm-setup": 43,
  automation: 40,
  seo: 40,
  "lead-gen": 34,
  "website-redesign": 30,
  "whatsapp-automation": 27,
  "ai-chatbot": 24,
  website: 20,
  ecommerce: 8,
};
const BASELINE_OVERALL = 83;

const NEW_SERVICES = ["brand-film", "social-reels", "property-walkthrough", "wedding-event-film", "product-shoot"];
const OFFER: Offer = { services: [...NEW_SERVICES], description: "video and film production" };

// ---------------------------------------------------------------- 1. rules

const rules = loadRules();

check("rules: no-video-on-site is defined as a gap with a phrase", rules.signals["no-video-on-site"]?.kind === "gap" && !!rules.signals["no-video-on-site"]?.phrase);
check("rules: no-video-on-site is listed in searchOrder", rules.searchOrder.includes("no-video-on-site"));

const categoriesData = JSON.parse(
  readFileSync(new URL("../data/categories.json", import.meta.url), "utf8"),
) as { categories: Array<{ id: string }> };
const knownCategories = new Set(categoriesData.categories.map((c) => c.id));

for (const id of NEW_SERVICES) {
  const service = rules.services.find((s) => s.id === id);
  check(`rules: ${id} exists`, !!service);
  check(
    `rules: ${id} has a one-sentence pitch with no full stop`,
    !!service && typeof service.pitch === "string" && service.pitch.trim().length > 0 && !/[.!?]$/.test(service.pitch.trim()),
    JSON.stringify(service?.pitch),
  );
  check(
    `rules: ${id} has categories`,
    !!service && Array.isArray(service.categories) && service.categories.length > 0,
    JSON.stringify(service?.categories),
  );
  check(
    `rules: ${id} has at least one signal weight`,
    !!service && Object.keys(service.signals ?? {}).length > 0,
    JSON.stringify(service?.signals),
  );
  const missing = (service?.categories ?? []).filter((c) => !knownCategories.has(c));
  check(`rules: ${id} categories all exist in categories.json`, missing.length === 0, missing.join(", "));
  const reasonWithoutSignal = Object.keys(service?.reasons ?? {}).filter((sig) => !(sig in (service?.signals ?? {})));
  check(`rules: ${id} reasons only name its own signals`, reasonWithoutSignal.length === 0, reasonWithoutSignal.join(", "));
}

// ---------------------------------------------------------------- 2. enrich detector

const devSite = fakeSite(DEV_HTML);
const devEnrich = await enrich(DEV_LEAD, { fetchFn: devSite.fn });
check(
  "enrich: alive site with no video gets no-video-on-site",
  devEnrich.signals.includes("no-video-on-site"),
  JSON.stringify(devEnrich.signals),
);

const hotelSite = fakeSite(HOTEL_HTML);
const hotelEnrich = await enrich(HOTEL_LEAD, { fetchFn: hotelSite.fn });
check(
  "enrich: site with a youtube embed does NOT get no-video-on-site",
  !hotelEnrich.signals.includes("no-video-on-site"),
  JSON.stringify(hotelEnrich.signals),
);

const restSite = fakeSite("unused");
const restEnrich = await enrich(REST_LEAD, { fetchFn: restSite.fn });
check(
  "enrich: no-website lead falls through to no-website, never to no-video-on-site",
  restEnrich.signals.includes("no-website") && !restEnrich.signals.includes("no-video-on-site"),
  JSON.stringify(restEnrich.signals),
);
check("enrich: no-website lead made no network call", restSite.calls.length === 0, JSON.stringify(restSite.calls));

// ---------------------------------------------------------------- 3. match fixtures

const devMatch = match(DEV_LEAD, devEnrich, OFFER);
const devTop = devMatch.fit[0]?.service;
check(
  "match: real-estate-developer top service is property-walkthrough or brand-film",
  devTop === "property-walkthrough" || devTop === "brand-film",
  `top=${devTop} fit=${JSON.stringify(devMatch.fit.map((f) => [f.service, f.score]))}`,
);

const hotelMatch = match(HOTEL_LEAD, hotelEnrich, OFFER);
const hotelSignals = effectiveSignals(HOTEL_LEAD, hotelEnrich);
check("match: hotel has no no-video-on-site signal", !hotelSignals.includes("no-video-on-site"), JSON.stringify(hotelSignals));
check(
  "match: hotel gets NO no-video-on-site reason",
  hotelMatch.fit.every((f) => !f.reason.toLowerCase().includes("no video")),
  JSON.stringify(hotelMatch.fit.map((f) => f.reason)),
);

const restMatch = match(REST_LEAD, restEnrich, OFFER);
check(
  "match: restaurant top service is social-reels",
  restMatch.fit[0]?.service === "social-reels",
  `top=${restMatch.fit[0]?.service} fit=${JSON.stringify(restMatch.fit.map((f) => [f.service, f.score]))}`,
);

// ---------------------------------------------------------------- 4. existing services unchanged

{
  const baseline = match(BASE_LEAD, BASE_ENRICH, { services: Object.keys(BASELINE_SCORES), description: "baseline" });
  const byId = new Map(baseline.fit.map((f) => [f.service, f.score]));
  const drift: string[] = [];
  for (const [service, expected] of Object.entries(BASELINE_SCORES)) {
    const got = byId.get(service);
    if (got !== expected) drift.push(`${service}: expected ${expected}, got ${got}`);
  }
  check("baseline: every existing service keeps its pre-pack score", drift.length === 0, drift.join(" | "));
  check("baseline: overall score is unchanged", baseline.score === BASELINE_OVERALL, `expected ${BASELINE_OVERALL}, got ${baseline.score}`);
}

// ---------------------------------------------------------------- cleanup and summary

if (existsSync(DB_PATH)) {
  try {
    unlinkSync(DB_PATH);
  } catch {
    /* temp file only; ignore */
  }
}

console.log("");
console.log(`Demo pack checks: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed checks: ${failures.join("; ")}`);
  process.exitCode = 1;
}
