// src/discover-check.ts
// Proof for L3-discover. Fixtures only (no real network calls unless --live is passed).
// Run: npx tsx src/discover-check.ts
// Live: npx tsx src/discover-check.ts --live

import {
  buildAddress,
  buildOverpassQuery,
  DEFAULT_OVERPASS_URLS,
  discover,
  loadCategories,
  OVERPASS_BUSY_MESSAGE,
  OVERPASS_MAX_ROUNDS,
  parseNominatim,
  parseOverpass,
  resolveCategory,
  resolveOverpassUrls,
  resolvePlace,
  selectorFragment,
  splitBbox,
  USER_AGENT,
  type DiscoverDeps,
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

// DISC1 keeps the user-facing message plain and moves the technical detail (URLs, HTTP
// status, attempt count) into the error's `detail` field. These checks read `detail`.
function errorDetail(err: unknown): string {
  return String((err as { detail?: unknown } | null)?.detail ?? "");
}

// ---------------------------------------------------------------- fake fetch

type FakeResponse = { status: number; ok: boolean; json: () => Promise<unknown> };
type Route = { match: (url: string, init?: RequestInit) => boolean; respond: () => FakeResponse };

function res(status: number, body: unknown): FakeResponse {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key === name);
    return found?.[1];
  }
  return (headers as Record<string, string>)[name];
}

function fakeFetch(routes: Route[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: typeof fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find((r) => r.match(url, init));
    if (!route) throw new Error(`fake fetch: no route for ${url}`);
    return route.respond() as Response;
  };
  return { fn, calls };
}

const noSleep = async (_ms: number): Promise<void> => {};

// ---------------------------------------------------------------- fixtures

// Clearly fake. Shape copied from a real Nominatim jsonv2 response.
const NOMINATIM_FIXTURE = [
  {
    place_id: 999001,
    lat: "18.5204",
    lon: "73.8567",
    display_name: "Pune, Maharashtra, India",
    boundingbox: ["18.40", "18.65", "73.75", "73.99"],
  },
];

// Clearly fake. Shape copied from a real Overpass `out center` response.
const OVERPASS_FIXTURE = {
  version: 0.6,
  elements: [
    {
      type: "node",
      id: 111,
      lat: 18.51,
      lon: 73.85,
      tags: {
        name: "Fake Dental Care",
        amenity: "dentist",
        "addr:housenumber": "12",
        "addr:street": "Fake Road",
        "addr:suburb": "Fake Nagar",
        "addr:city": "Pune",
        "addr:state": "Maharashtra",
        "addr:postcode": "411001",
        "contact:website": "https://fakedental.example",
        "contact:phone": "+91 00000 00001",
        "contact:email": "hello@fakedental.example",
      },
    },
    {
      type: "way",
      id: 222,
      center: { lat: 18.52, lon: 73.86 },
      tags: {
        name: "Fake Smile Clinic",
        healthcare: "dentist",
        phone: "+91 00000 00002",
        website: "https://fakesmile.example",
      },
    },
    { type: "node", id: 333, lat: 18.53, lon: 73.87, tags: { amenity: "dentist" } }, // no name -> dropped
    {
      type: "node",
      id: 444,
      lat: 18.51,
      lon: 73.85,
      tags: { name: "Fake Dental Care", amenity: "dentist", "addr:city": "Pune" }, // duplicate -> dropped
    },
  ],
};

const PUNE_QUERY = { category: "dental clinic", city: "Pune", country: "India" };

function routedFetch(overpassResponder: () => FakeResponse, counter?: { n: number }) {
  return fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    {
      match: (u, init) => u.includes("overpass") || init?.method === "POST",
      respond: () => {
        if (counter) counter.n++;
        return overpassResponder();
      },
    },
  ]);
}

// ---------------------------------------------------------------- 1. categories

const categories = loadCategories();
check("categories.json has 40+ categories", categories.length >= 40, `count=${categories.length}`);

const mappingCases: Array<[string, string]> = [
  ["dental clinic", `nwr["amenity"="dentist"]`],
  ["restaurant", `nwr["amenity"="restaurant"]`],
  ["gym", `nwr["leisure"="fitness_centre"]`],
  ["hotel", `nwr["tourism"="hotel"]`],
  ["real estate agent", `nwr["office"="estate_agent"]`],
];
for (const [cat, fragment] of mappingCases) {
  const def = resolveCategory(cat);
  const q = buildOverpassQuery(def.selectors, "18.4,73.75,18.65,73.99", 5);
  check(`category mapping: ${cat} -> ${fragment}`, q.includes(fragment), q.replace(/\n/g, " "));
}
check("category id resolves", resolveCategory("gym").id === "gym");
check("category lookup is case-insensitive", resolveCategory("GYM").id === "gym");
check("category alias resolves", resolveCategory("dentist").id === "dental-clinic");
check(
  "unknown category throws a clear error",
  (() => {
    try {
      resolveCategory("zzz-not-a-category");
      return false;
    } catch (err) {
      return /unknown category/i.test((err as Error).message);
    }
  })(),
);
check(
  "query asks Overpass for a 25 second timeout and the bbox",
  (() => {
    const q = buildOverpassQuery(resolveCategory("school").selectors, "1,2,3,4", 5);
    return q.includes("[timeout:25]") && q.includes("(1,2,3,4)") && q.startsWith("[out:json]");
  })(),
);
check('wildcard selector "shop" -> ["shop"]', selectorFragment({ shop: "*" }) === `["shop"]`);

// ---------------------------------------------------------------- 2. Nominatim

const place = parseNominatim(NOMINATIM_FIXTURE);
checkEq("Nominatim fixture: bbox reordered to south,west,north,east", place.bbox, "18.4,73.75,18.65,73.99");
check("Nominatim fixture: lat/lon parsed", place.lat === 18.5204 && place.lon === 73.8567);
check("Nominatim fixture: display name parsed", place.displayName === "Pune, Maharashtra, India");
check(
  "Nominatim empty result throws a clear error",
  (() => {
    try {
      parseNominatim([]);
      return false;
    } catch (err) {
      return /no matching place/i.test((err as Error).message);
    }
  })(),
);

// resolvePlace: URL, User-Agent, and the 1 request/second politeness limit.
{
  const nomFetch = fakeFetch([{ match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) }]);
  const sleeps: number[] = [];
  const deps: DiscoverDeps = { fetchFn: nomFetch.fn, sleepFn: async (ms) => { sleeps.push(ms); } };
  await resolvePlace("Pune, India", deps);
  const firstPlace = await resolvePlace("Pune, India", deps);
  checkEq("resolvePlace returns the parsed bbox", firstPlace.bbox, "18.4,73.75,18.65,73.99");
  check(
    "Nominatim request carries User-Agent Leadscout/0.1 and the place",
    headerValue(nomFetch.calls[0]?.init, "User-Agent") === USER_AGENT &&
      decodeURIComponent(nomFetch.calls[0]?.url ?? "").includes("Pune"),
    nomFetch.calls[0]?.url,
  );
  check(
    "Nominatim rate limit: second call waits ~1 second",
    sleeps.length > 0 && sleeps.every((ms) => ms > 0 && ms <= 1000),
    `sleeps=${JSON.stringify(sleeps)}`,
  );
}

// ---------------------------------------------------------------- 3. Overpass parsing

const leads = parseOverpass(OVERPASS_FIXTURE, "dental-clinic", PUNE_QUERY);
checkEq("Overpass fixture: nameless dropped + duplicate deduped -> 2 leads", leads.length, 2);
check("Overpass fixture: no lead without a name", leads.every((l) => !!l.name && l.name.length > 0));

const nodeLead = leads[0];
check("node: name", nodeLead?.name === "Fake Dental Care", nodeLead?.name);
check("node: category is the canonical category id", nodeLead?.category === "dental-clinic", nodeLead?.category);
checkEq("node: address built from addr tags", nodeLead?.address, "12 Fake Road, Fake Nagar, Maharashtra, 411001");
check("node: city from addr:city", nodeLead?.city === "Pune", nodeLead?.city);
check("node: country from query when no addr:country", nodeLead?.country === "India", nodeLead?.country);
check("node: lat/lon", nodeLead?.lat === 18.51 && nodeLead?.lon === 73.85, `${nodeLead?.lat},${nodeLead?.lon}`);
check("node: contact:phone fallback", nodeLead?.phone === "+91 00000 00001", nodeLead?.phone);
check("node: contact:email fallback", nodeLead?.email === "hello@fakedental.example", nodeLead?.email);
check("node: contact:website fallback", nodeLead?.website === "https://fakedental.example", nodeLead?.website);
checkEq("node: source", nodeLead?.source, "osm");
checkEq("node: sourceUrl is the OSM element URL", nodeLead?.sourceUrl, "https://www.openstreetmap.org/node/111");

const wayLead = leads[1];
check("way: parsed with centre lat/lon", wayLead?.name === "Fake Smile Clinic" && wayLead?.lat === 18.52 && wayLead?.lon === 73.86, `${wayLead?.lat},${wayLead?.lon}`);
checkEq("way: sourceUrl", wayLead?.sourceUrl, "https://www.openstreetmap.org/way/222");
check("way: plain phone tag", wayLead?.phone === "+91 00000 00002", wayLead?.phone);
check("way: plain website tag", wayLead?.website === "https://fakesmile.example", wayLead?.website);

check("address helper returns undefined when no addr tags", buildAddress({}) === undefined);

// tag fallbacks: direct tag wins over contact:*, name:en used when name is absent
{
  const pref = parseOverpass(
    {
      elements: [
        {
          type: "node",
          id: 9,
          lat: 1,
          lon: 2,
          tags: { "name:en": "Only English Name", website: "https://direct.example", "contact:website": "https://contact.example" },
        },
      ],
    },
    "clinic",
    { category: "clinic" },
  );
  check("website wins over contact:website", pref[0]?.website === "https://direct.example", pref[0]?.website);
  check("name:en used when name is absent", pref[0]?.name === "Only English Name", pref[0]?.name);
}

// dedupe by website host (different names, same site)
{
  const hostDedupe = parseOverpass(
    {
      elements: [
        { type: "node", id: 1, lat: 0, lon: 0, tags: { name: "Alpha Dental", website: "https://same.example" } },
        { type: "node", id: 2, lat: 0.1, lon: 0.1, tags: { name: "Beta Dental", website: "https://www.same.example/contact" } },
      ],
    },
    "dental-clinic",
    PUNE_QUERY,
  );
  checkEq("dedupe by website host", hostDedupe.length, 1);
}

// ---------------------------------------------------------------- 4. discover end to end (fixtures)

{
  const fetchAll = routedFetch(() => res(200, OVERPASS_FIXTURE));
  const all = await discover({ category: "dental clinic", city: "Pune", country: "India", limit: 5 }, { fetchFn: fetchAll.fn, sleepFn: noSleep });
  checkEq("discover: fixture -> 2 leads (dropped + deduped)", all.length, 2);
  check("discover: returns RawLead shaped records", all.every((l: RawLead) => l.source === "osm" && !!l.sourceUrl));
  const body = String(fetchAll.calls[1]?.init?.body ?? "");
  check(
    "discover: Overpass POST body carries the query",
    body.startsWith("data=") && decodeURIComponent(body).includes("[timeout:25]") && decodeURIComponent(body).includes(`["amenity"="dentist"]`),
  );
  checkEq("discover: Overpass call is a POST", fetchAll.calls[1]?.init?.method, "POST");
}

{
  const fetchLimited = routedFetch(() => res(200, OVERPASS_FIXTURE));
  const limited = await discover({ category: "dental clinic", city: "Pune", limit: 1 }, { fetchFn: fetchLimited.fn, sleepFn: noSleep });
  checkEq("discover: honours limit=1", limited.length, 1);
  checkEq("discover: limit keeps the first lead", limited[0]?.name, "Fake Dental Care");
}

// ---------------------------------------------------------------- 5. error paths (429 / 504 / failover)

{
  // Every mirror returns 429. discover retries the whole default mirror list for
  // OVERPASS_MAX_ROUNDS rounds, so the number of Overpass calls is mirrors x rounds.
  let overpass429Calls = 0;
  const sleeps: number[] = [];
  const counted = fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    {
      match: (u, init) => u.includes("overpass") || init?.method === "POST",
      respond: () => {
        overpass429Calls++;
        return res(429, {});
      },
    },
  ]);
  let message = "";
  let detail = "";
  try {
    await discover(
      { category: "clinic", city: "Pune", limit: 5 },
      { fetchFn: counted.fn, sleepFn: async (ms) => { sleeps.push(ms); } },
    );
  } catch (err) {
    message = (err as Error).message;
    detail = errorDetail(err);
  }
  check("429 fixture: plain message, attempts named in detail", message === "The free map service is busy right now. Try again in a few minutes." && /429/.test(detail) && /attempt\b/i.test(detail), `message=${message} detail=${detail}`);
  const expectedAttempts = DEFAULT_OVERPASS_URLS.length * OVERPASS_MAX_ROUNDS;
  check(
    "429: every mirror is retried in each round (calls = mirrors x rounds)",
    overpass429Calls === expectedAttempts,
    `calls=${overpass429Calls}, expected=${expectedAttempts} (mirrors=${DEFAULT_OVERPASS_URLS.length}, rounds=${OVERPASS_MAX_ROUNDS}), sleeps=${JSON.stringify(sleeps)}`,
  );
}

{
  // Every mirror returns 504. Nominatim must still resolve successfully.
  const f504 = fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    { match: (u, init) => u.includes("overpass") || init?.method === "POST", respond: () => res(504, {}) },
  ]);
  let detail = "";
  try {
    await discover({ category: "clinic", city: "Pune" }, { fetchFn: f504.fn, sleepFn: noSleep });
  } catch (err) {
    detail = errorDetail(err);
  }
  check("504 fixture: attempts named in detail", /504/.test(detail) && /attempt\b/i.test(detail), detail);
}

check(
  "discover without a place throws a clear error",
  await (async () => {
    try {
      const emptyFetch: typeof fetch = async () => res(200, {}) as Response;
      await discover({ category: "clinic" }, { fetchFn: emptyFetch, sleepFn: noSleep });
      return false;
    } catch (err) {
      return /city or country/i.test((err as Error).message);
    }
  })(),
);

// ---------------------------------------------------------------- 6. L36 proof: mirrors, tiling, cache

{
  // First mirror 504, second mirror succeeds.
  const failoverFetch = fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    { match: (u) => u.includes("overpass-api.de"), respond: () => res(504, {}) },
    { match: () => true, respond: () => res(200, OVERPASS_FIXTURE) },
  ]);
  const sleeps: number[] = [];
  const result = await discover(
    { category: "dental clinic", city: "Mumbai", country: "India", limit: 5 },
    { fetchFn: failoverFetch.fn, sleepFn: async (ms) => { sleeps.push(ms); } },
  );
  const overpassCalls = failoverFetch.calls.filter((c) => c.url.includes("overpass"));
  check("mirror failover: first 504 then second succeeds", result.length === 2, `result.length=${result.length}`);
  check("mirror failover: exactly 2 Overpass requests", overpassCalls.length === 2, `calls=${overpassCalls.length}`);
  check(
    "mirror failover: at least 1s politeness pause before the next mirror",
    sleeps.some((ms) => ms >= 1000),
    `sleeps=${JSON.stringify(sleeps)}`,
  );
}

{
  // All mirrors fail -> one clear error naming every attempted URL.
  const allFailFetch = fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    { match: () => true, respond: () => res(503, {}) },
  ]);
  let message = "";
  let detail = "";
  try {
    await discover({ category: "gym", city: "Pune" }, { fetchFn: allFailFetch.fn, sleepFn: noSleep });
  } catch (err) {
    message = (err as Error).message;
    detail = errorDetail(err);
  }
  const attemptCount = (detail.match(/attempt \d+:/g) ?? []).length;
  const expectedAttempts = DEFAULT_OVERPASS_URLS.length * OVERPASS_MAX_ROUNDS;
  check(
    "all mirrors fail: every attempt named, plain message and technical detail",
    attemptCount === expectedAttempts &&
      message === OVERPASS_BUSY_MESSAGE &&
      !/https?:\/\//.test(message) &&
      new RegExp(`failed after ${expectedAttempts} attempt\\(s\\)`).test(detail) &&
      DEFAULT_OVERPASS_URLS.every((url) => detail.includes(url)),
    `attempts=${attemptCount}/${expectedAttempts}, message=${message}, detail=${detail}`,
  );
}

{
  // Round-boundary pauses grow 2s then 5s and are injectable via sleepFn (politeness sleeps are separate).
  const sleeps: number[] = [];
  const backoffFetch = fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    { match: () => true, respond: () => res(502, {}) },
  ]);
  try {
    await discover({ category: "restaurant", city: "Pune" }, { fetchFn: backoffFetch.fn, sleepFn: async (ms) => { sleeps.push(ms); } });
  } catch { /* expected */ }
  const backoffSleeps = sleeps.filter((ms) => ms === 2000 || ms === 5000);
  checkEq("round pauses grow 2s then 5s", backoffSleeps, [2000, 5000]);
}

{
  // Env override of the mirror list, read at call time.
  const prev = process.env.LEADSCOUT_OVERPASS_URLS;
  process.env.LEADSCOUT_OVERPASS_URLS = "https://mirror-a.example/api/interpreter, https://mirror-b.example/api/interpreter";
  const urls = resolveOverpassUrls();
  check(
    "env override replaces default mirror list",
    urls.length === 2 && urls[0] === "https://mirror-a.example/api/interpreter" && urls[1] === "https://mirror-b.example/api/interpreter",
    JSON.stringify(urls),
  );
  if (prev === undefined) delete process.env.LEADSCOUT_OVERPASS_URLS;
  else process.env.LEADSCOUT_OVERPASS_URLS = prev;
}

{
  // Query is lighter: timeout and out center tags limit (limit*3).
  const q = buildOverpassQuery(resolveCategory("dental clinic").selectors, "18.4,73.75,18.65,73.99", 10);
  check(
    "query contains [timeout:25] and out center tags <limit*3>",
    q.includes("[timeout:25]") && q.includes("out center tags 30") && q.includes("30"),
    q.replace(/\n/g, " "),
  );
}

{
  // Explicit check for the task wording: `out center tags <limit*3>`.
  const q = buildOverpassQuery(resolveCategory("dental clinic").selectors, "18.4,73.75,18.65,73.99", 10);
  check(
    "query uses `out center tags <limit*3>`",
    /out center tags 30\b/.test(q),
    q.replace(/\n/g, " "),
  );
}

{
  // Tiling: force 4 tiles with a tiny threshold, return one unique element per tile plus a duplicate.
  const threshold = 0.001;
  const tiles = splitBbox("18.4,73.75,18.65,73.99", threshold);
  checkEq("large bbox splits into 4 tiles", tiles.length, 4);
  const elementsByTile = new Map<string, unknown[]>();
  tiles.forEach((tile, i) => {
    elementsByTile.set(tile, [
      { type: "node", id: 1000 + i, lat: 18.5, lon: 73.8, tags: { name: `Tile ${i}` } },
    ]);
  });
  // Deliberate duplicate id to prove tile-level dedupe by type:id.
  elementsByTile.get(tiles[tiles.length - 1])?.push({
    type: "node",
    id: 1000,
    lat: 18.5,
    lon: 73.8,
    tags: { name: "Tile 0 duplicate" },
  });

  let tileIndex = 0;
  const tilingFetch = fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    {
      match: (_u, init) => init?.method === "POST",
      respond: () => {
        const tile = tiles[tileIndex++];
        return res(200, { elements: tile ? elementsByTile.get(tile) ?? [] : [] });
      },
    },
  ]);
  const result = await discover(
    { category: "hotel", city: "Pune", country: "India", limit: 10 },
    { fetchFn: tilingFetch.fn, sleepFn: noSleep, tileAreaThresholdDeg2: threshold },
  );
  check("tiling merges tile responses", result.length === tiles.length, `result.length=${result.length}`);
  check(
    "tiling dedupes by element identity",
    !result.some((l) => l.name === "Tile 0 duplicate"),
    JSON.stringify(result.map((l) => l.name)),
  );
}

{
  // Cache: first call populates, second call issues zero fetch requests.
  const cacheFetch = fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    { match: (_u, init) => init?.method === "POST", respond: () => res(200, OVERPASS_FIXTURE) },
  ]);
  const key = { category: "hotel", city: "Delhi", country: "India", limit: 5 };
  await discover(key, { fetchFn: cacheFetch.fn, sleepFn: noSleep });
  const before = cacheFetch.calls.length;
  const cached = await discover(key, { fetchFn: cacheFetch.fn, sleepFn: noSleep });
  const after = cacheFetch.calls.length;
  check("cache hit makes no request", before === after, `before=${before} after=${after}`);
  checkEq("cache hit returns cached leads", cached.length, 2);
}

// ---------------------------------------------------------------- 7. Tester edge cases (L36)

{
  // A fetch timeout (AbortError from AbortSignal.timeout) must advance to the next mirror.
  const timeoutFetch = fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    {
      match: (u) => u.includes("overpass-api.de"),
      respond: () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    },
    { match: () => true, respond: () => res(200, OVERPASS_FIXTURE) },
  ]);
  const result = await discover(
    { category: "dental clinic", city: "Timeoutville", country: "India", limit: 5 },
    { fetchFn: timeoutFetch.fn, sleepFn: noSleep },
  );
  check(
    "timeout on first mirror advances to the next mirror",
    result.length === 2,
    `result.length=${result.length}`,
  );
}

{
  // A non-retryable status (400) fails fast after exactly one Overpass attempt.
  let overpassCalls = 0;
  const badFetch = fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    {
      match: (_u, init) => init?.method === "POST",
      respond: () => {
        overpassCalls++;
        return res(400, {});
      },
    },
  ]);
  let detail = "";
  try {
    await discover({ category: "gym", city: "BadRequestville" }, { fetchFn: badFetch.fn, sleepFn: noSleep });
  } catch (err) {
    detail = errorDetail(err);
  }
  check(
    "non-retryable 400 fails fast after one attempt",
    overpassCalls === 1 && /400/.test(detail),
    `calls=${overpassCalls}, detail=${detail}`,
  );
}

{
  // An env override with only whitespace/empty entries falls back to the defaults.
  const prev = process.env.LEADSCOUT_OVERPASS_URLS;
  process.env.LEADSCOUT_OVERPASS_URLS = "  , ,  ";
  const urls = resolveOverpassUrls();
  checkEq("empty env override falls back to default mirrors", urls, DEFAULT_OVERPASS_URLS);
  if (prev === undefined) delete process.env.LEADSCOUT_OVERPASS_URLS;
  else process.env.LEADSCOUT_OVERPASS_URLS = prev;
}

{
  // deps.overpassUrls is used when the env override is absent.
  const prev = process.env.LEADSCOUT_OVERPASS_URLS;
  delete process.env.LEADSCOUT_OVERPASS_URLS;
  const custom = ["https://custom-mirror.example/api/interpreter"];
  const urls = resolveOverpassUrls(custom);
  checkEq("deps.overpassUrls used when env is unset", urls, custom);
  if (prev !== undefined) process.env.LEADSCOUT_OVERPASS_URLS = prev;
}

{
  // Cache TTL: an entry older than 10 minutes is re-fetched.
  let overpassCalls = 0;
  const ttlFetch = fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    {
      match: (_u, init) => init?.method === "POST",
      respond: () => {
        overpassCalls++;
        return res(200, OVERPASS_FIXTURE);
      },
    },
  ]);
  let clock = 1_000_000;
  const key = { category: "dental clinic", city: "Ttlville", country: "India", limit: 5 };
  await discover(key, { fetchFn: ttlFetch.fn, sleepFn: noSleep, now: () => clock });
  const afterFirst = overpassCalls;
  clock += 10 * 60 * 1000 + 1;
  await discover(key, { fetchFn: ttlFetch.fn, sleepFn: noSleep, now: () => clock });
  const afterExpiry = overpassCalls;
  check(
    "cache expires after 10 minutes and re-fetches",
    afterFirst === 1 && afterExpiry === 2,
    `first=${afterFirst}, expiry=${afterExpiry}`,
  );
}

{
  // Cache key is normalised: differing case/whitespace on (category, city) shares one entry.
  let overpassCalls = 0;
  const normFetch = fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    {
      match: (_u, init) => init?.method === "POST",
      respond: () => {
        overpassCalls++;
        return res(200, OVERPASS_FIXTURE);
      },
    },
  ]);
  await discover(
    { category: "dental clinic", city: "Normville", country: "India", limit: 5 },
    { fetchFn: normFetch.fn, sleepFn: noSleep },
  );
  const afterFirst = overpassCalls;
  const cached = await discover(
    { category: "DENTAL CLINIC", city: "  normville  ", country: "India", limit: 5 },
    { fetchFn: normFetch.fn, sleepFn: noSleep },
  );
  check(
    "cache key is case/space normalised",
    overpassCalls === afterFirst && cached.length === 2,
    `calls=${overpassCalls}, cached=${cached.length}`,
  );
}

// ---------------------------------------------------------------- 8. L39 proof: bbox order, dental selectors, empty results

{
  // Nominatim returns boundingbox as south, north, west, east with all four values
  // distinct. discover must feed Overpass south, west, north, east; a swapped or
  // naive passthrough order produces a different (wrong-area) query and fails here.
  const reordered = parseNominatim([
    {
      place_id: 999002,
      lat: "0.35",
      lon: "0.45",
      display_name: "ZeroResultville, test data",
      boundingbox: ["0.1", "0.6", "0.2", "0.7"], // south, north, west, east — all distinct
    },
  ]);
  checkEq(
    "L39: Nominatim s,n,w,e [0.1,0.6,0.2,0.7] -> Overpass s,w,n,e 0.1,0.2,0.6,0.7",
    reordered.bbox,
    "0.1,0.2,0.6,0.7",
  );
  const q = buildOverpassQuery(resolveCategory("dental clinic").selectors, reordered.bbox, 8);
  check(
    "L39: dental query carries amenity=dentist and healthcare=dentist on the reordered bbox",
    q.includes(`nwr["amenity"="dentist"](0.1,0.2,0.6,0.7);`) &&
      q.includes(`nwr["healthcare"="dentist"](0.1,0.2,0.6,0.7);`),
    q.replace(/\n/g, " "),
  );
}

{
  // An empty but successful Overpass result must be re-fetchable on a later call.
  // Old behaviour cached the empty list, so the second call made no request and
  // silently returned [] again. New behaviour only caches non-empty results.
  const emptyFetch = fakeFetch([
    { match: (u) => u.includes("nominatim"), respond: () => res(200, NOMINATIM_FIXTURE) },
    {
      match: (_u, init) => init?.method === "POST",
      respond: () => res(200, { version: 0.6, elements: [] }),
    },
  ]);
  let message = "";
  try {
    await discover({ category: "dental clinic", city: "Emptyville", country: "India", limit: 5 }, { fetchFn: emptyFetch.fn, sleepFn: noSleep });
    await discover({ category: "dental clinic", city: "Emptyville", country: "India", limit: 5 }, { fetchFn: emptyFetch.fn, sleepFn: noSleep });
  } catch (err) {
    message = (err as Error).message;
  }
  const overpassCalls = emptyFetch.calls.filter((c) => (c.init as RequestInit | undefined)?.method === "POST").length;
  check(
    "L39: empty result is never cached — second call re-fetches",
    message === "" && overpassCalls === 2,
    `calls=${overpassCalls}, error=${message}`,
  );
}

// ---------------------------------------------------------------- summary

console.log("");
console.log(`Fixtures: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed checks: ${failures.join("; ")}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------- live

if (process.argv.includes("--live")) {
  console.log("");
  console.log("--- LIVE: dental clinic, Pune, limit 5 (real network) ---");
  try {
    const live = await discover({ category: "dental clinic", city: "Pune", country: "India", limit: 5 });
    console.log(JSON.stringify(live, null, 2));
    console.log(`LIVE: ${live.length} lead(s) returned`);
  } catch (err) {
    console.log(`LIVE FAILED (network may be blocked in this environment): ${(err as Error).message}`);
  }
}
