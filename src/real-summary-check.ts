// src/real-summary-check.ts
// MD2 real-summary proof: a lead summary must describe the business, not copy navigation.
// Offline, pure functions plus the injected-fetch-free public API of enrich.js.
// Run: node_modules/.bin/tsx.cmd src/real-summary-check.ts

import { enrichFromPages, stripMarkdown, summarize } from "./enrich.js";

type Lead = {
  name: string;
  category: string;
  city?: string;
  country?: string;
  source: string;
  sourceUrl: string;
};

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

function fakeLead(): Lead {
  return {
    name: "Fake Example Co",
    category: "real-estate",
    city: "Mumbai",
    country: "India",
    source: "osm",
    sourceUrl: "https://fake.example/1",
  };
}

function summaryForText(text: string): string {
  return enrichFromPages(fakeLead(), [{ url: "https://fake.example/", text }]).summary;
}

// ---- fixtures built from the five navigation-menu examples (order MD2) ----

const FIXTURE_EVENTS_NAV =
  "Skip to content About Us Events Management Company Wedding Planners Corporate Events " +
  "Social Events Gallery Blog Contact Us Follow Us Facebook Instagram Search Sitemap";

const FIXTURE_BUILDER_NAV =
  "X x About Us Our Projects Our Initiatives Buyers Guide Blog Careers Contact Us " +
  "Privacy Policy Terms Facebook Linkedin Search Sitemap Menu Services Projects";

const FIXTURE_RESTAURANT_NAV =
  "Home About Us Contact Wedding Planners Reservations Press Gallery Back Food Drinks " +
  "Desserts Events Blog Privacy Terms Facebook Instagram Search Sitemap Menu";

const FIXTURE_BAKERY_NAV =
  "T&C apply Our stores 9000100400 Deliver to Set location About Us Contact Us Menu " +
  "Products Blog Privacy Terms Search Sitemap Order Online Cakes Desserts";

const FIXTURE_ESTATES_NAV =
  "Club Premium Investors Contact Us Residential Commercial Retail Lifestyle Sunteck " +
  "international About Us Blog Careers Privacy Terms Sitemap Search Menu Services";

const NAV_TEXTS: Array<{ name: string; text: string }> = [
  { name: "FixtureEvents", text: FIXTURE_EVENTS_NAV },
  { name: "FixtureBuilder", text: FIXTURE_BUILDER_NAV },
  { name: "FixtureRestaurant", text: FIXTURE_RESTAURANT_NAV },
  { name: "FixtureBakery", text: FIXTURE_BAKERY_NAV },
  { name: "FixtureEstates", text: FIXTURE_ESTATES_NAV },
];

const REAL_PARAGRAPH =
  "Fixture Realty is a Mumbai property developer that builds homes for families across the suburbs. " +
  "It offers two and three bedroom apartments with parks, schools and shops nearby for daily life. " +
  "The team manages bookings, site visits and loans so buyers can move in without delay.";

const OG_SIXTY = "Fake Dental Care is a family dentistry clinic in Pune for all ages.";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function htmlWithMeta(og: string | null, meta: string | null, bodyText: string): string {
  const tags: string[] = [];
  if (og !== null) tags.push(`<meta property="og:description" content="${escapeHtml(og)}">`);
  if (meta !== null) tags.push(`<meta name="description" content="${escapeHtml(meta)}">`);
  return `<html><head><title>Fake Example Co</title>${tags.join("")}</head><body><p>${escapeHtml(bodyText)}</p></body></html>`;
}

// ---- 1. navigation-only text gives an empty summary ----

for (const nav of NAV_TEXTS) {
  const summary = summaryForText(nav.text);
  check(`nav-only empty: ${nav.name}`, summary === "", JSON.stringify(summary.slice(0, 120)));
}

// ---- 2. the real paragraph is chosen when it follows the menu ----

{
  const mixed = `${FIXTURE_EVENTS_NAV}\n\n${REAL_PARAGRAPH}`;
  const summary = summaryForText(mixed);
  check(
    "real paragraph after menu is chosen",
    summary.includes("Mumbai property developer") && !summary.includes("Skip to content"),
    JSON.stringify(summary.slice(0, 160)),
  );
}

// ---- 3. an og:description of 60 characters wins over a longer paragraph ----

{
  const longParagraph =
    "Fake Dental Care is a Pune clinic that offers checkups, cleaning, braces, implants, crowns, whitening, " +
    "kids dentistry, senior care, emergency slots, weekend hours and honest prices for every family visiting daily.";
  const html = htmlWithMeta(OG_SIXTY, null, `${FIXTURE_EVENTS_NAV} ${longParagraph}`);
  const summary = summarize(html);
  check(
    "og:description of 60 chars wins over longer paragraph",
    summary.includes("family dentistry") && summary.length >= 40,
    JSON.stringify(summary.slice(0, 160)),
  );
}

// ---- 4. a meta description that is only navigation is skipped ----

{
  const navMeta = "Home About Us Contact Services Blog Privacy Terms Sitemap Search Menu Login Follow";
  const html = htmlWithMeta(null, navMeta, REAL_PARAGRAPH);
  const summary = summarize(html);
  check(
    "meta navigation-only description is skipped",
    !summary.includes("Sitemap Search Menu") && summary.includes("Mumbai property developer"),
    JSON.stringify(summary.slice(0, 160)),
  );
}

// ---- 5. the result never starts with Home About Us Contact together ----

{
  const summaries = [
    ...NAV_TEXTS.map((nav) => summaryForText(nav.text)),
    summaryForText(`${FIXTURE_EVENTS_NAV}\n\n${REAL_PARAGRAPH}`),
    summarize(htmlWithMeta(OG_SIXTY, null, REAL_PARAGRAPH)),
  ];
  const bad = summaries.filter((s) => /Home.*About Us.*Contact/i.test(s.slice(0, 80)));
  check(
    "never starts with Home About Us Contact together",
    bad.length === 0,
    JSON.stringify(bad.map((s) => s.slice(0, 80))),
  );
}

// ---- 6. length at most 280 ----

{
  const longReal =
    "Fake Example Co is a Mumbai builder that designs homes, shops and offices with parks, schools, clubs, pools, gyms, " +
    "halls, gardens, lifts, parking, security, power backup, water supply, maintenance staff, event spaces, guest rooms, " +
    "senior zones, kids zones, jogging tracks, cycle tracks and honest prices for every single family visiting daily.";
  const summary = summaryForText(longReal);
  const wordCut = summary.length < stripMarkdown(longReal).length
    ? /[A-Za-z0-9]$/.test(summary)
    : true;
  check(
    "length at most 280 and cut at word boundary",
    summary.length <= 280 && wordCut,
    `len=${summary.length} ${JSON.stringify(summary.slice(-60))}`,
  );
}

console.log(`--- real-summary-check: ${passed} passed, ${failed} failed ---`);
if (failed > 0) process.exitCode = 1;
