// src/demo-discover-check.ts
// ORDER_DEMO3-discovery-quality proof. Offline: injected transport only, no network.
// Run: npx tsx src/demo-discover-check.ts

import {
  buildOverpassQuery,
  completenessScore,
  discover,
  hasWebsiteTag,
  resolveCategory,
  selectorFragment,
  type DiscoverDeps,
  type DiscoverQuery,
} from "./discover.js";
import type { RawLead } from "./types.js";

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

function checkEq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const noSleep = async (_ms: number): Promise<void> => {};

// ---------------------------------------------------------------- fake transport

type FakeResponse = { status: number; ok: boolean; json: () => Promise<unknown> };

function res(status: number, body: unknown): FakeResponse {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// Clearly fake. Shape copied from a real Nominatim jsonv2 response. bbox area 0.0874 -> 1 tile.
const NOMINATIM_FIXTURE = [
  {
    place_id: 990001,
    lat: "19.0",
    lon: "72.9",
    display_name: "Fakeville, test data",
    boundingbox: ["18.89", "19.27", "72.77", "73.05"], // south, north, west, east
  },
];

function fakeFetch(overpassBody: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("nominatim")) return res(200, NOMINATIM_FIXTURE) as unknown as Response;
    return res(200, overpassBody) as unknown as Response;
  }) as typeof fetch;
  return { fn, calls };
}

let seq = 0;
function el(name: string, tags: Record<string, unknown> = {}): unknown {
  seq += 1;
  return { type: "node", id: 90000 + seq, lat: 19 + seq * 0.0001, lon: 72.9 + seq * 0.0001, tags: { name, ...tags } };
}

function namedFixture(count: number, label: string, tags: Record<string, unknown> = {}): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) out.push(el(`Fake ${label} ${i + 1}`, { ...tags }));
  return out;
}

/** Run discover against the injected transport and return the decoded Overpass POST query plus leads. */
async function capturedPost(
  category: string,
  place: string,
  limit: number,
  elements: unknown[] = [],
  extra: Partial<DiscoverQuery> = {},
): Promise<{ leads: RawLead[]; query: string }> {
  const f = fakeFetch({ version: 0.6, elements });
  const leads = await discover(
    { category, city: place, country: "India", limit, ...extra },
    { fetchFn: f.fn, sleepFn: noSleep } as DiscoverDeps,
  );
  const post = f.calls.find((c) => (c.init as RequestInit | undefined)?.method === "POST");
  const rawBody = String((post?.init as RequestInit | undefined)?.body ?? "");
  const query = decodeURIComponent(rawBody.replace(/^data=/, ""));
  return { leads, query };
}

// ---------------------------------------------------------------- 1. recorded baselines (pre-edit code)

// Recorded from the pre-edit buildOverpassQuery: dental-clinic and cafe, limit 20 (out cap = 60),
// bbox from the fixture above. These must stay byte-identical.
const DENTAL_BASELINE = `[out:json][timeout:25];\n(\n  nwr["amenity"="dentist"](18.89,72.77,19.27,73.05);\n  nwr["healthcare"="dentist"](18.89,72.77,19.27,73.05);\n);\nout center tags 60;`;
const CAFE_BASELINE = `[out:json][timeout:25];\n(\n  nwr["amenity"="cafe"](18.89,72.77,19.27,73.05);\n);\nout center tags 60;`;

console.log("--- existing categories keep byte-identical queries ---");
{
  const dental = await capturedPost("dental-clinic", "Baselineville", 20);
  checkEq("dental-clinic query is byte-identical to the recorded baseline", dental.query, DENTAL_BASELINE);
  const cafe = await capturedPost("cafe", "Baselineville", 20);
  checkEq("cafe query is byte-identical to the recorded baseline", cafe.query, CAFE_BASELINE);
}

// ---------------------------------------------------------------- 2. selector syntax (~ regex, *, escaping)

console.log("--- selector syntax ---");
check('"*" still means the key exists', selectorFragment({ office: "*" }) === `["office"]`);
checkEq("plain equality selector is unchanged", selectorFragment({ amenity: "dentist" }), `["amenity"="dentist"]`);
check(
  "regex value becomes a case-insensitive Overpass regex",
  selectorFragment({ name: "~Developers|Builders" }) === `["name"~"Developers|Builders",i]`,
  selectorFragment({ name: "~Developers|Builders" }),
);
check(
  'regex escapes embedded quotes and backslashes safely',
  selectorFragment({ name: '~A"B\\C' }) === '["name"~"A\\"B\\\\C",i]',
  selectorFragment({ name: '~A"B\\C' }),
);
{
  const q = buildOverpassQuery(resolveCategory("real-estate-developer").selectors, "1,2,3,4", 5);
  check(
    "real-estate-developer query uses office=company + the name regex + craft=builder",
    q.includes(`nwr["office"="company"]["name"~"Developers|Builders|Realty|Realtors|Constructions|Properties|Infra|Housing|Estates|Homes",i](1,2,3,4);`) &&
      q.includes(`nwr["craft"="builder"](1,2,3,4);`),
    q.replace(/\n/g, " "),
  );
}
{
  const q = buildOverpassQuery(resolveCategory("wedding-planner").selectors, "1,2,3,4", 5);
  check(
    "wedding-planner query combines shop=wedding, a wildcard office and a wildcard shop under a name regex",
    q.includes(`nwr["shop"="wedding"](1,2,3,4);`) &&
      q.includes(`nwr["office"]["name"~"Wedding|Weddings|Planner|Planners",i](1,2,3,4);`) &&
      q.includes(`nwr["shop"]["name"~"Wedding|Weddings|Planner|Planners",i](1,2,3,4);`),
    q.replace(/\n/g, " "),
  );
}

// ---------------------------------------------------------------- 3. every named category returns leads

console.log("--- named categories return leads ---");
const NAMED: Array<[string, string]> = [
  ["real-estate-developer", "Real Estate"],
  ["builder", "Builder"],
  ["wedding-planner", "Wedding"],
  ["event-company", "Event"],
  ["banquet-hall", "Banquet"],
  ["resort", "Resort"],
  ["clothing-store", "Clothing Store"],
  ["clothing-shop", "Clothing Shop"],
];
for (const [cat, label] of NAMED) {
  const { leads, query } = await capturedPost(cat, `Named-${cat}`, 10, namedFixture(6, label, { shop: "clothes" }));
  check(
    `named category ${cat} returns > 0 leads and a non-empty query`,
    leads.length > 0 && query.includes("out center tags"),
    `leads=${leads.length}`,
  );
}

// ---------------------------------------------------------------- 4. jewellery-shop vs jewellery-store

console.log("--- jewellery alias / id resolution ---");
check("id jewellery-store resolves to jewellery-store", resolveCategory("jewellery-store").id === "jewellery-store");
check("label 'Jewellery store' resolves to jewellery-store", resolveCategory("Jewellery store").id === "jewellery-store");
check("spelling 'jewellery store' resolves to the same id", resolveCategory("jewellery store").id === "jewellery-store");
check("underscore spelling 'jewellery_store' resolves to the same id", resolveCategory("jewellery_store").id === "jewellery-store");
check("id jewellery-shop resolves to jewellery-shop", resolveCategory("jewellery-shop").id === "jewellery-shop");
check("spelling 'jewellery shop' resolves to jewellery-shop", resolveCategory("jewellery shop").id === "jewellery-shop");
{
  const a = resolveCategory("jewelry store").id;
  const b = resolveCategory("jewelry store").id;
  check(
    "shared alias 'jewelry store' resolves deterministically to a jewellery category",
    a === b && (a === "jewellery-shop" || a === "jewellery-store"),
    `id=${a}`,
  );
}
{
  const qShop = buildOverpassQuery(resolveCategory("jewellery-shop").selectors, "1,2,3,4", 5);
  const qStore = buildOverpassQuery(resolveCategory("jewellery-store").selectors, "1,2,3,4", 5);
  check("jewellery-shop and jewellery-store emit byte-identical queries", qShop === qStore, `${qShop} != ${qStore}`);
}
{
  const fixture = namedFixture(6, "Jewellery", { shop: "jewelry" });
  const shop = await capturedPost("jewellery-shop", "JewelTowns", 10, fixture);
  const store = await capturedPost("jewellery-store", "JewelTownb", 10, fixture);
  check("jewellery-shop returns leads", shop.leads.length > 0, `leads=${shop.leads.length}`);
  check("jewellery-store returns leads", store.leads.length > 0, `leads=${store.leads.length}`);
  check("both jewellery categories return the same lead names", JSON.stringify(shop.leads.map((l) => l.name)) === JSON.stringify(store.leads.map((l) => l.name)));
}

// ---------------------------------------------------------------- 5. requireWebsite ranking

console.log("--- requireWebsite ranking ---");
// 8 clearly fake objects, mixed completeness. Only the website ones survive requireWebsite.
const COMPLETENESS_FIXTURE: unknown[] = [
  el("Fake No Site One", { phone: "+91 00000 00011" }),
  el("Fake No Site Two", { email: "two@fakenosite.example" }),
  el("Fake Website Basic", { website: "https://fw-basic.example" }),
  el("Fake Website Phone", { website: "https://fw-phone.example", phone: "+91 00000 00012" }),
  el("Fake Website Full", {
    website: "https://fw-full.example",
    phone: "+91 00000 00013",
    email: "hello@fw-full.example",
    opening_hours: "Mo-Sa 09:00-18:00",
    "addr:housenumber": "1",
    "addr:street": "Fake Street",
    brand: "FakeBrand",
    wikidata: "Q123",
  }),
  el("Fake Website Addr", { website: "https://fw-addr.example", "addr:city": "Fakeville" }),
  el("Fake No Site Three", {}),
  el("Fake Website Email", { website: "https://fw-email.example", email: "hi@fw-email.example" }),
  el("Fake Url Only", { url: "https://fw-url.example" }),
];
{
  const f = fakeFetch({ version: 0.6, elements: COMPLETENESS_FIXTURE });
  const leads = await discover(
    { category: "hotel", city: "Rankville", country: "India", limit: 6, requireWebsite: true },
    { fetchFn: f.fn, sleepFn: noSleep } as DiscoverDeps,
  );
  const post = f.calls.find((c) => (c.init as RequestInit | undefined)?.method === "POST");
  const query = decodeURIComponent(String((post?.init as RequestInit | undefined)?.body ?? "").replace(/^data=/, ""));
  check("requireWebsite keeps only leads with a website tag", leads.length > 0 && leads.every((l) => Boolean(l.website)), JSON.stringify(leads.map((l) => l.name)));
  check("requireWebsite drops every object without a website", leads.every((l) => !l.name.startsWith("Fake No Site")), JSON.stringify(leads.map((l) => l.name)));
  check("url-only object counts as a website", leads.some((l) => l.name === "Fake Url Only" && l.website === "https://fw-url.example"));
  check("requireWebsite ranks the most complete business first", leads[0]?.name === "Fake Website Full", `first=${leads[0]?.name}`);
  check(
    "requireWebsite respects the limit",
    leads.length <= 6,
    `leads=${leads.length}`,
  );
  check(
    "requireWebsite fetch cap is min(limit*6,1000) -> out center tags 36",
    query.includes("out center tags 36"),
    query.replace(/\n/g, " "),
  );
}
{
  // Deterministic order: a second run with the same fixture returns the same head.
  const f2 = fakeFetch({ version: 0.6, elements: COMPLETENESS_FIXTURE });
  const leads2 = await discover(
    { category: "hotel", city: "Rankville2", country: "India", limit: 6, requireWebsite: true },
    { fetchFn: f2.fn, sleepFn: noSleep } as DiscoverDeps,
  );
  check("requireWebsite order is deterministic", leads2.map((l) => l.name).join("|") === ["Fake Website Full", "Fake Website Email", "Fake Website Phone", "Fake Website Addr", "Fake Url Only", "Fake Website Basic"].join("|"), JSON.stringify(leads2.map((l) => l.name)));
}
{
  // requireWebsite absent -> no website filter at all (no default change).
  const f3 = fakeFetch({ version: 0.6, elements: COMPLETENESS_FIXTURE });
  const leads3 = await discover(
    { category: "hotel", city: "Plainville", country: "India", limit: 20 },
    { fetchFn: f3.fn, sleepFn: noSleep } as DiscoverDeps,
  );
  check("without requireWebsite no lead is dropped for a missing website", leads3.some((l) => l.name.startsWith("Fake No Site")), JSON.stringify(leads3.map((l) => l.name)));
}

// ---------------------------------------------------------------- 6. minCompleteness / completeness scoring

console.log("--- minCompleteness and completeness scoring ---");
check("completenessScore: no tags scores 0", completenessScore({}) === 0);
check("completenessScore: full object scores 22", completenessScore({ website: "x", phone: "p", email: "e", opening_hours: "h", "addr:city": "c", brand: "b", wikidata: "Q" }) === 22);
check("hasWebsiteTag: url counts", hasWebsiteTag({ url: "https://x.example" }) === true);
check("hasWebsiteTag: nothing -> false", hasWebsiteTag({ phone: "p" }) === false);
{
  const f = fakeFetch({ version: 0.6, elements: COMPLETENESS_FIXTURE });
  const leads = await discover(
    { category: "hotel", city: "Minville", country: "India", limit: 20, minCompleteness: 12 },
    { fetchFn: f.fn, sleepFn: noSleep } as DiscoverDeps,
  );
  const allowed = new Set(["Fake Website Full", "Fake Website Phone", "Fake Website Email"]);
  check(
    "minCompleteness drops objects below the score",
    leads.length === 3 && leads.every((l) => allowed.has(l.name)),
    JSON.stringify(leads.map((l) => l.name)),
  );
}

// ---------------------------------------------------------------- summary

console.log("");
console.log(`Demo discover checks: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed checks: ${failures.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("RESULT: PASS");
}
