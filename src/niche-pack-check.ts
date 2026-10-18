// src/niche-pack-check.ts
// Proof for order WE1-niche-pack (wedding and event niche pack). Fully offline:
// no network and no model calls. match() is pure and the pack loader only reads
// JSON from disk. Order NP1 moved the eight wedding signals into the pack
// overlay, so this check reads them through rulesFor() on a temp database (env
// LEADSCOUT_DB); the live data database is never opened.
//
// Run once, foreground:
//   npx tsx src/niche-pack-check.ts
// Record the pre-edit baseline (a throwaway run done BEFORE service-rules.json
// was edited, as the order asks):
//   npx tsx src/niche-pack-check.ts --record
//
// Every business, address, email, number and domain below is clearly fake.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveSignals, loadRules, match, type ServiceRules } from "./match.js";
import {
  allHuntTargets,
  categoryVideoNeed,
  expandQueries,
  loadNichePack,
  nextHuntTargets,
  queryPlaceholders,
  isCityFree,
  type NichePack,
} from "./niche-pack.js";
import { attachPack, rulesFor } from "./niche-packs.js";
import type { Enrichment, Offer, RawLead } from "./types.js";

// Temp database only, set before the first getDb() call (attachPack/rulesFor).
// The live data database is never opened.
const CHECK_DB = join(tmpdir(), `leadscout-niche-pack-check-${process.pid}.db`);
process.env.LEADSCOUT_DB = CHECK_DB;
const CHECK_WORKSPACE = "niche-pack-check-workspace";

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

// ---------------------------------------------------------------- fixture

const FAKE_SOURCE_URL = "https://www.openstreetmap.org/node/999910";

// Baseline fixture and numbers captured from a throwaway `--record` run BEFORE
// service-rules.json was edited.
const BASE_LEAD: RawLead = {
  name: "Fake Baseline Wedding Vendor",
  category: "wedding-planner",
  city: "Pune",
  country: "India",
  website: "https://fakebaseline-wedding.example",
  email: "hello@fakebaseline-wedding.example",
  phone: "+91 00000 00021",
  source: "osm",
  sourceUrl: FAKE_SOURCE_URL,
};
const BASE_ENRICH: Enrichment = {
  fetchedUrl: "https://fakebaseline-wedding.example",
  summary: "Fake Baseline Wedding Vendor is a wedding vendor in Pune.",
  emails: ["hello@fakebaseline-wedding.example"],
  phones: ["+91 00000 00021"],
  socials: { whatsapp: "https://wa.me/910000000021" },
  signals: ["no-analytics", "no-online-booking", "social-active-links", "no-video-on-site"],
};

const BASELINE_SCORES: Record<string, number> = {
  website: 8,
  "website-redesign": 22,
  automation: 37,
  "ai-chatbot": 20,
  "whatsapp-automation": 70,
  seo: 38,
  "crm-setup": 38,
  "booking-system": 75,
  ecommerce: 33,
  "ai-voice-agent": 57,
  "lead-gen": 42,
  "brand-film": 70,
  "social-reels": 90,
  "property-walkthrough": 85,
  "wedding-event-film": 90,
  "product-shoot": 65,
};
const BASELINE_OVERALL = 92;

const NEW_SIGNALS = [
  "portfolio-no-video",
  "has-video-portfolio",
  "social-video-active",
  "social-inactive",
  "high-review-count",
  "premium-listing",
  "multi-city",
  "price-band-known",
];
const WEIGHTED_SERVICES = ["wedding-event-film", "brand-film", "social-reels"];
const CANONICAL_CATEGORIES = [
  "wedding-planner",
  "event-company",
  "banquet-hall",
  "wedding-decorator",
  "caterer",
  "bridal-wear",
  "makeup-artist",
  "photographer",
  "dj-entertainer",
  "florist",
  "invitation-designer",
  "destination-wedding-agent",
  "jewellery-store",
];

const rules: ServiceRules = loadRules();

// ---------------------------------------------------------------- --record mode

if (process.argv.includes("--record")) {
  const offer: Offer = { services: rules.services.map((s) => s.id), description: "all services" };
  const result = match(BASE_LEAD, BASE_ENRICH, offer);
  const scores: Record<string, number> = {};
  for (const fit of result.fit) scores[fit.service] = fit.score;
  console.log("PRE-EDIT BASELINE for the WE1 fixture lead (record mode)");
  console.log("signals: " + JSON.stringify(effectiveSignals(BASE_LEAD, BASE_ENRICH)));
  console.log("scores: " + JSON.stringify(scores, null, 2));
  console.log("overall: " + result.score);
  process.exit(0);
}

console.log("niche-pack-check (order WE1-niche-pack)\n");

// ---------------------------------------------------------------- 1. pack loads

let pack: NichePack;
let loadOk = true;
try {
  pack = loadNichePack("wedding-events");
} catch (err) {
  loadOk = false;
  pack = null as unknown as NichePack;
  check("pack: data/niche-packs/wedding-events.json loads and validates", false, (err as Error).message);
}
if (loadOk) {
  check("pack: data/niche-packs/wedding-events.json loads and validates", pack.id === "wedding-events" && !!pack.label);
  const ids = pack.categories.map((c) => c.id);
  const missing = CANONICAL_CATEGORIES.filter((id) => !ids.includes(id));
  check("pack: all 13 canonical category ids are present", missing.length === 0, missing.join(", "));
  check("pack: 12 cities, all with a tier", pack.cities.length === 12 && pack.cities.every((c) => typeof c.tier === "number"));
  const badReason = pack.categories.filter((c) => typeof c.buyerReason !== "string" || c.buyerReason.trim().length === 0);
  check("pack: every category has a buyerReason", badReason.length === 0, badReason.map((c) => c.id).join(", "));
  const badQueries = pack.categories.filter((c) => !Array.isArray(c.queries) || c.queries.length < 6 || c.queries.length > 10);
  check("pack: every category has 6 to 10 queries", badQueries.length === 0, badQueries.map((c) => c.id).join(", "));
  const badNeeds = pack.categories.filter((c) => !["high", "medium", "low"].includes(c.videoNeed));
  check("pack: every category has a videoNeed of high, medium or low", badNeeds.length === 0, badNeeds.map((c) => c.id).join(", "));
  const badPlaceholders: string[] = [];
  for (const c of pack.categories) {
    for (const q of c.queries) {
      const tokens = queryPlaceholders(q);
      for (const token of tokens) if (token !== "city" && token !== "area") badPlaceholders.push(`${c.id}: ${q}`);
    }
  }
  check("pack: every query uses only {city}/{area} placeholders", badPlaceholders.length === 0, badPlaceholders.join(" | "));
  const cityFree = pack.categories.flatMap((c) => c.queries).filter((q) => isCityFree(q));
  check("pack: city-free queries exist and are accepted by design", cityFree.length > 0, `${cityFree.length} city-free queries`);
  const hasAreas = pack.cities.every((c) => Array.isArray(c.areas) && (c.areas as string[]).length > 0);
  check("pack: every city has areas for the {area} placeholder", hasAreas);
  check("pack: seasonality reuses the season-calendar shape", !!pack.seasonality && Array.isArray(pack.seasonality.peakMonths) && pack.seasonality.peakMonths.length > 0);
  check("pack: the 8 shared signals are declared with a meaning", NEW_SIGNALS.every((id) => pack.signals.some((s) => s.id === id && s.meaning.length > 0)));
}
const pack2: NichePack = pack;

// ---------------------------------------------------------------- 2. expandQueries

{
  const filled = expandQueries(pack2, { category: "wedding-planner", city: "Pune", area: "Baner" });
  check("expandQueries: fills {city} and {area}", filled.some((q) => q.includes("Baner") && q.includes("Pune")), JSON.stringify(filled.slice(0, 3)));
  check("expandQueries: no placeholder survives", filled.every((q) => !/\{(?:city|area)\}/i.test(q)), JSON.stringify(filled));
  const noArea = expandQueries(pack2, { category: "wedding-planner", city: "Pune" });
  check("expandQueries: works without an area", noArea.length > 0 && noArea.every((q) => !/\{area\}/i.test(q)), JSON.stringify(noArea));
  let callsWithDupes = 0;
  let calls = 0;
  for (const c of pack2.categories) for (const city of pack2.cities) for (const area of city.areas ?? [undefined]) {
    calls++;
    const phrases = expandQueries(pack2, { category: c.id, city: city.name, area });
    if (new Set(phrases.map((q) => q.toLowerCase())).size !== phrases.length) callsWithDupes++;
  }
  check("expandQueries: no duplicate phrase within any single category/city/area call", callsWithDupes === 0, `${callsWithDupes} of ${calls} calls`);

  // direct de-duplication test on a synthetic pack (same phrase twice -> one).
  const dupPack = {
    id: "dup",
    label: "Dup",
    categories: [{ id: "x", label: "X", aliases: [], buyerReason: "why", videoNeed: "high", queries: ["a {city} {area}", "a {city} {area}", "b {city}", "c only"] }],
    cities: [],
    signals: [],
  } as unknown as NichePack;
  const deduped = expandQueries(dupPack, { category: "x", city: "Pune", area: "Baner" });
  check("expandQueries: identical filled phrases collapse to one", deduped.length === 3 && deduped[0] === "a Pune Baner", JSON.stringify(deduped));
  const dedupedNoArea = expandQueries(dupPack, { category: "x", city: "Pune" });
  check("expandQueries: area-only query is dropped without an area", dedupedNoArea.length === 2 && dedupedNoArea.every((q) => !q.includes("Baner")), JSON.stringify(dedupedNoArea));
}

// ---------------------------------------------------------------- 3. nextHuntTargets

{
  const all = allHuntTargets(pack2);
  check("nextHuntTargets: full canonical list is non-empty and ordered", all.length === pack2.categories.length * pack2.cities.length * 4, `${all.length}`);
  const fresh = nextHuntTargets(pack2, []);
  check("nextHuntTargets: empty history returns the whole list", fresh.length === all.length && fresh[0].category === all[0].category && fresh[0].city === all[0].city && fresh[0].area === all[0].area, JSON.stringify(fresh[0]));
  const afterOne = nextHuntTargets(pack2, [all[0]]);
  check("nextHuntTargets: skips a hunted target and rotates", afterOne.length === all.length - 1 && afterOne[0].category === all[1].category && afterOne[0].city === all[1].city && afterOne[0].area === all[1].area, JSON.stringify(afterOne[0]));
  const middle = all[Math.floor(all.length / 2)];
  const afterMiddle = nextHuntTargets(pack2, [middle]);
  check("nextHuntTargets: skips a target in the middle of the order", !afterMiddle.some((t) => t.category === middle.category && t.city === middle.city && t.area === middle.area), JSON.stringify(middle));
  const history: Array<{ category: string; city: string; area?: string }> = [];
  const firsts: string[] = [];
  for (let i = 0; i < 5; i++) {
    const next = nextHuntTargets(pack2, history);
    firsts.push(`${next[0].category}|${next[0].city}|${next[0].area}`);
    history.push(next[0]);
  }
  check("nextHuntTargets: the first target advances each time (rotation)", new Set(firsts).size === firsts.length, firsts.join(" -> "));
  check("nextHuntTargets: accepts string history too", nextHuntTargets(pack2, [`${all[0].category}|${all[0].city}|${all[0].area ?? ""}`]).length === all.length - 1);
}

// ---------------------------------------------------------------- 4. categoryVideoNeed

{
  check("categoryVideoNeed: wedding-planner is high", categoryVideoNeed(pack2, "wedding-planner") === "high");
  check("categoryVideoNeed: caterer is medium", categoryVideoNeed(pack2, "caterer") === "medium");
  check("categoryVideoNeed: invitation-designer is low", categoryVideoNeed(pack2, "invitation-designer") === "low");
  let threw = false;
  try {
    categoryVideoNeed(pack2, "not-a-category");
  } catch {
    threw = true;
  }
  check("categoryVideoNeed: unknown category throws", threw);
}

// ---------------------------------------------------------------- 5. service-rules signals
// Order NP1: the eight wedding signals live in the pack overlay
// (data/niche-packs/wedding-events.json -> serviceRules), not in the global
// data/service-rules.json. Read them through the product's own merge function
// (rulesFor) on a temp database, exactly as a wedding workspace would.

attachPack(CHECK_WORKSPACE, "wedding-events");
const packRules: ServiceRules = rulesFor(CHECK_WORKSPACE);

for (const id of NEW_SIGNALS) {
  const info = packRules.signals[id];
  check(`rules: signal "${id}" exists with a phrase and kind gap/positive`, !!info && typeof info.phrase === "string" && (info.kind === "gap" || info.kind === "positive"), JSON.stringify(info));
}
check(
  "rules: none of the 8 shared signals is defined in the global data/service-rules.json",
  NEW_SIGNALS.every((id) => !rules.signals[id]),
  NEW_SIGNALS.filter((id) => rules.signals[id]).join(", "),
);
for (const serviceId of WEIGHTED_SERVICES) {
  const service = packRules.services.find((s) => s.id === serviceId);
  const weighted = NEW_SIGNALS.every((sig) => typeof service?.signals[sig] === "number");
  const reasoned = NEW_SIGNALS.every((sig) => typeof service?.reasons?.[sig] === "string" && (service.reasons[sig] as string).trim().length > 0 && !/[.!?]$/.test((service.reasons[sig] as string).trim()));
  check(`rules: ${serviceId} weights all 8 shared signals`, !!service && weighted, JSON.stringify(service?.signals));
  check(`rules: ${serviceId} has a no-full-stop reason for each shared signal`, !!service && reasoned);
}
{
  const offenders: string[] = [];
  for (const service of rules.services) {
    if (WEIGHTED_SERVICES.includes(service.id)) continue;
    for (const sig of NEW_SIGNALS) if (sig in service.signals) offenders.push(`${service.id}:${sig}`);
  }
  check("rules: no other service weights a shared signal (only the three named)", offenders.length === 0, offenders.join(", "));
}

// ---------------------------------------------------------------- 6. existing services unchanged

{
  const offer: Offer = { services: Object.keys(BASELINE_SCORES), description: "baseline" };
  const result = match(BASE_LEAD, BASE_ENRICH, offer);
  const byId = new Map(result.fit.map((f) => [f.service, f.score]));
  const drift: string[] = [];
  for (const [service, expected] of Object.entries(BASELINE_SCORES)) {
    const got = byId.get(service);
    if (got !== expected) drift.push(`${service}: expected ${expected}, got ${got}`);
  }
  check("baseline: every existing service keeps its pre-edit score", drift.length === 0, drift.join(" | "));
  check("baseline: overall score is unchanged", result.score === BASELINE_OVERALL, `expected ${BASELINE_OVERALL}, got ${result.score}`);
  check("baseline: fixture carries none of the new signals", NEW_SIGNALS.every((s) => !effectiveSignals(BASE_LEAD, BASE_ENRICH).includes(s)));
}

// ---------------------------------------------------------------- 7. categories.json

{
  let categoriesData: { categories: Array<{ id: string; selectors?: unknown }> } | null = null;
  try {
    categoriesData = JSON.parse(readFileSync(new URL("../data/categories.json", import.meta.url), "utf8")) as typeof categoriesData;
  } catch (err) {
    check("categories.json: parses as valid JSON", false, (err as Error).message);
  }
  if (categoriesData) {
    check("categories.json: parses as valid JSON", Array.isArray(categoriesData.categories));
    const ids = categoriesData.categories.map((c) => c.id);
    check("categories.json: ids are unique", new Set(ids).size === ids.length);
    const missing = CANONICAL_CATEGORIES.filter((id) => !ids.includes(id));
    check("categories.json: every canonical wedding/event category has an entry", missing.length === 0, missing.join(", "));
    const byId = new Map(categoriesData.categories.map((c) => [c.id, c]));
    const withSelectors = ["caterer", "photographer", "bridal-wear", "florist", "jewellery-store", "wedding-planner", "event-company", "banquet-hall"];
    const missingSelectors = withSelectors.filter((id) => {
      const s = byId.get(id)?.selectors;
      return !Array.isArray(s) || s.length === 0;
    });
    check("categories.json: tagged categories carry selectors", missingSelectors.length === 0, missingSelectors.join(", "));
    const noTag = ["wedding-decorator", "makeup-artist", "dj-entertainer", "invitation-designer", "destination-wedding-agent"];
    const wrongEmpty = noTag.filter((id) => {
      const s = byId.get(id)?.selectors;
      return s !== undefined && (!Array.isArray(s) || s.length !== 0);
    });
    check("categories.json: no-tag categories keep empty selectors", wrongEmpty.length === 0, wrongEmpty.join(", "));
    const bridal = byId.get("bridal-wear")?.selectors as Array<Record<string, string>> | undefined;
    check(
      "categories.json: bridal-wear uses the ~regex name selector",
      !!bridal && bridal.some((s) => typeof s.name === "string" && s.name.startsWith("~")),
      JSON.stringify(bridal),
    );
  }
}

// ---------------------------------------------------------------- summary

console.log("");
console.log(`niche pack checks: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed checks: ${failures.join("; ")}`);
  process.exitCode = 1;
}
