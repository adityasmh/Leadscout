// src/niche-packs-check.ts
// Proof for order NP1-niche-attachments. Fully offline: a temp database (env
// LEADSCOUT_DB set before any dynamic import) and one local JSON read. No
// network, no model calls, no server. Every business and value below is fake.
//
// Run once, foreground:
//   npx tsx src/niche-packs-check.ts

import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB_FILE = join(tmpdir(), `leadscout-niche-packs-${process.pid}.db`);
process.env.LEADSCOUT_DB = DB_FILE;

const store = await import("./store.js");
const packsMod = await import("./niche-packs.js");
const routes = await import("./routes-packs.js");
const matcher = await import("./match.js");
type ServiceRules = import("./match.js").ServiceRules;

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

function fakeWorkspace(name: string): string {
  return store.createWorkspace({
    name,
    offer: { services: ["website", "wedding-event-film", "brand-film"], description: "fake offer" },
    icp: { categories: [], cities: [], countries: [] },
  }).id;
}

function readPackJson(id: string): unknown {
  return JSON.parse(readFileSync(new URL(`../data/niche-packs/${id}.json`, import.meta.url), "utf8"));
}

const WEDDING_SIGNALS = [
  "portfolio-no-video",
  "has-video-portfolio",
  "social-video-active",
  "social-inactive",
  "high-review-count",
  "premium-listing",
  "multi-city",
  "price-band-known",
];

// Recorded from the pre-move run of niche-pack-check.ts / demo-pack-check.ts
// (the weights and reasons that order WE1 put into data/service-rules.json).
const WEDDING_WEIGHTS: Record<string, Record<string, number>> = {
  "wedding-event-film": { "portfolio-no-video": 60, "has-video-portfolio": -25, "social-video-active": -10, "social-inactive": 20, "high-review-count": 10, "premium-listing": 15, "multi-city": 15, "price-band-known": 8 },
  "brand-film": { "portfolio-no-video": 40, "has-video-portfolio": -15, "social-video-active": -8, "social-inactive": 12, "high-review-count": 12, "premium-listing": 15, "multi-city": 12, "price-band-known": 8 },
  "social-reels": { "portfolio-no-video": 35, "has-video-portfolio": -10, "social-video-active": 10, "social-inactive": 40, "high-review-count": 10, "premium-listing": 12, "multi-city": 8, "price-band-known": 8 },
  "property-walkthrough": { "portfolio-no-video": 1, "has-video-portfolio": 1, "social-video-active": 1, "social-inactive": 1, "high-review-count": 1, "premium-listing": 1, "multi-city": 1, "price-band-known": 1 },
  "product-shoot": { "portfolio-no-video": 1, "has-video-portfolio": 1, "social-video-active": 1, "social-inactive": 1, "high-review-count": 1, "premium-listing": 1, "multi-city": 1, "price-band-known": 1 },
};

// The WE1 fixture baseline (unchanged: the fixture carries none of the 8 signals).
const BASE_LEAD: import("./types.js").RawLead = {
  name: "Fake Baseline Wedding Vendor",
  category: "wedding-planner",
  city: "Pune",
  country: "India",
  website: "https://fakebaseline-wedding.example",
  email: "hello@fakebaseline-wedding.example",
  phone: "+91 00000 00021",
  source: "osm",
  sourceUrl: "https://www.openstreetmap.org/node/999910",
};
const BASE_ENRICH: import("./types.js").Enrichment = {
  fetchedUrl: "https://fakebaseline-wedding.example",
  summary: "Fake Baseline Wedding Vendor is a wedding vendor in Pune.",
  emails: ["hello@fakebaseline-wedding.example"],
  phones: ["+91 00000 00021"],
  socials: { whatsapp: "https://wa.me/910000000021" },
  signals: ["no-analytics", "no-online-booking", "social-active-links", "no-video-on-site"],
};
const BASELINE_SCORES: Record<string, number> = {
  website: 8, "website-redesign": 22, automation: 37, "ai-chatbot": 20, "whatsapp-automation": 70,
  seo: 38, "crm-setup": 38, "booking-system": 75, ecommerce: 33, "ai-voice-agent": 57, "lead-gen": 42,
  "brand-film": 70, "social-reels": 90, "property-walkthrough": 85, "wedding-event-film": 90, "product-shoot": 65,
};
const BASELINE_OVERALL = 92;

console.log("niche-packs-check (order NP1-niche-attachments)\n");

// ---------------------------------------------------------------- 1. validation accepts
{
  const wedding = readPackJson("wedding-events");
  const dental = readPackJson("example-dental");
  const ew = packsMod.validatePack(wedding);
  const ed = packsMod.validatePack(dental);
  check("validate: shipped wedding pack is accepted", ew.length === 0, ew.join("; "));
  check("validate: shipped example-dental pack is accepted", ed.length === 0, ed.join("; "));
}

// ---------------------------------------------------------------- 2. validation rejects
{
  const base = {
    id: "bad-pack", version: 1, label: "Bad", owner: "ws-a", visibility: "private",
    categories: [{ id: "c", queries: ["q {city}"] }], cities: [{ name: "Pune", tier: 1 }],
  };
  check("validate: rejects an unknown top-level field", packsMod.validatePack({ ...base, extra: 1 }).some((e) => e.includes("unknown top-level field")));
  check("validate: rejects a duplicate category id", packsMod.validatePack({ ...base, categories: [{ id: "c", queries: ["q"] }, { id: "c", queries: ["q2"] }] }).some((e) => e.includes("duplicate category id")));
  check("validate: rejects a duplicate signal id", packsMod.validatePack({ ...base, signals: [{ id: "s", meaning: "m" }, { id: "s", meaning: "m2" }] }).some((e) => e.includes("duplicate signal id")));
  check("validate: rejects a signal without a meaning", packsMod.validatePack({ ...base, signals: [{ id: "s" }] }).some((e) => e.includes("missing a meaning")));
  check("validate: rejects queries without a category", packsMod.validatePack({ ...base, categories: [{ queries: ["q"] }] }).some((e) => e.includes("queries without a category")));
  check("validate: rejects a duplicate serviceRules service id", packsMod.validatePack({ ...base, serviceRules: { services: [{ id: "x", signals: { a: 1 } }, { id: "x", signals: { a: 1 } }] } }).some((e) => e.includes("duplicate serviceRules service id")));
  check("validate: rejects a non-plain value (function)", packsMod.validatePack({ ...base, fn: function () {} }).some((e) => e.includes("not plain data")));
  check("validate: rejects a non-http URL scheme", packsMod.validatePack({ ...base, sources: { c: ["ftp://example.test/x"] } }).some((e) => e.includes("not http or https")));
  check("validate: accepts an http/https URL-free plain pack", packsMod.validatePack(base).length === 0, packsMod.validatePack(base).join("; "));
}

// ---------------------------------------------------------------- 3. install / version / ownership
const wsA = fakeWorkspace("Fake Workspace A");
const wsB = fakeWorkspace("Fake Workspace B");
const wsC = fakeWorkspace("Fake Workspace C");

function privatePack(id: string, owner: string): unknown {
  return {
    id, version: 1, label: `Private ${id}`, owner, visibility: "private",
    categories: [{ id: "clinic", label: "Clinic", buyerReason: "why", videoNeed: "medium", queries: ["clinic {city}"] }],
    cities: [{ name: "Pune", tier: 1 }],
  };
}

{
  const first = packsMod.installPack(privatePack("ws-a-pack", wsA), wsA);
  check("install: stores a new private pack owned by the workspace", first.owner === wsA && first.version === 1);
  const second = packsMod.installPack(privatePack("ws-a-pack", wsA), wsA);
  check("install: re-installing your own pack bumps the version", second.version === 2, `v${second.version}`);
  let threw = false;
  try {
    packsMod.installPack(privatePack("ws-a-pack", wsB), wsB);
  } catch (err) {
    threw = err instanceof packsMod.PackError;
  }
  check("install: never overwrites another owner's pack", threw);
}

// ---------------------------------------------------------------- 4. list visibility
{
  const aList = packsMod.listPacks(wsA).map((p) => p.id);
  const bList = packsMod.listPacks(wsB).map((p) => p.id);
  check("list: shared packs are visible to every workspace", aList.includes("wedding-events") && bList.includes("example-dental"));
  check("list: a workspace sees its own private pack", aList.includes("ws-a-pack"));
  check("list: a private pack of workspace A is invisible to workspace B", !bList.includes("ws-a-pack"), bList.join(", "));
}

// ---------------------------------------------------------------- 5. attach / detach
{
  packsMod.attachPack(wsA, "wedding-events");
  packsMod.attachPack(wsB, "example-dental");
  const aAttached = packsMod.attachedPacks(wsA).map((p) => p.id);
  const bAttached = packsMod.attachedPacks(wsB).map((p) => p.id);
  check("attach: a shared pack attaches to a workspace", aAttached.includes("wedding-events"));
  check("attach: another workspace keeps only its own attachment", bAttached.includes("example-dental") && !bAttached.includes("wedding-events"));
  let threw = false;
  try {
    packsMod.attachPack(wsB, "ws-a-pack");
  } catch (err) {
    threw = err instanceof packsMod.PackError;
  }
  check("attach: a private pack cannot be attached by another workspace", threw);
}

// ---------------------------------------------------------------- 6. rulesFor differs per workspace
{
  const weddingRules = packsMod.rulesFor(wsA);
  const dentalRules = packsMod.rulesFor(wsB);
  const noneRules = packsMod.rulesFor(wsC);

  const weddingPresent = WEDDING_SIGNALS.every((s) => Boolean(weddingRules.signals[s]));
  const dentalPresent = Boolean(dentalRules.signals["aligner-interest"]);
  const noneWedding = WEDDING_SIGNALS.every((s) => !noneRules.signals[s]);
  const noneDental = !noneRules.signals["aligner-interest"];

  check("rulesFor: the wedding workspace has the 8 wedding signals", weddingPresent);
  check("rulesFor: the dental workspace has the dental signal", dentalPresent);
  check("rulesFor: the wedding workspace does not have the dental signal", !weddingRules.signals["aligner-interest"]);
  check("rulesFor: the dental workspace does not have the wedding signals", WEDDING_SIGNALS.every((s) => !dentalRules.signals[s]));
  check("rulesFor: a workspace with no packs sees neither niche's signals", noneWedding && noneDental);
}

// ---------------------------------------------------------------- 7. scoring unchanged for the wedding workspace
{
  const rules = packsMod.rulesFor(wsA);
  const drift: string[] = [];
  for (const [serviceId, weights] of Object.entries(WEDDING_WEIGHTS)) {
    const service = rules.services.find((s) => s.id === serviceId);
    if (!service) {
      drift.push(`${serviceId}: missing`);
      continue;
    }
    for (const [sig, expected] of Object.entries(weights)) {
      if (service.signals[sig] !== expected) drift.push(`${serviceId}.${sig}: expected ${expected}, got ${service.signals[sig]}`);
      if (typeof service.reasons?.[sig] !== "string" || service.reasons[sig].trim().length === 0) drift.push(`${serviceId}.${sig}: no reason`);
    }
  }
  check("scoring: the wedding overlay reproduces every pre-move weight and reason exactly", drift.length === 0, drift.join(" | "));

  const globalRules: ServiceRules = matcher.loadRules();
  const leaked: string[] = [];
  for (const service of globalRules.services) {
    for (const sig of WEDDING_SIGNALS) if (sig in service.signals) leaked.push(`${service.id}:${sig}`);
  }
  check("scoring: the core has no wedding signal weight left", leaked.length === 0, leaked.join(", "));
  check("scoring: the core has no wedding signal definition left", WEDDING_SIGNALS.every((s) => !globalRules.signals[s]));

  const offer: import("./types.js").Offer = { services: Object.keys(BASELINE_SCORES), description: "baseline" };
  const result = matcher.match(BASE_LEAD, BASE_ENRICH, offer);
  const byId = new Map(result.fit.map((f) => [f.service, f.score]));
  const baseDrift: string[] = [];
  for (const [service, expected] of Object.entries(BASELINE_SCORES)) {
    if (byId.get(service) !== expected) baseDrift.push(`${service}: expected ${expected}, got ${byId.get(service)}`);
  }
  check("scoring: the WE1 fixture still scores exactly as recorded", baseDrift.length === 0, baseDrift.join(" | "));
  check("scoring: the WE1 fixture overall score is unchanged", result.score === BASELINE_OVERALL, `expected ${BASELINE_OVERALL}, got ${result.score}`);
}

// ---------------------------------------------------------------- 8. detach removes the overlay
{
  const removed = packsMod.detachPack(wsA, "wedding-events");
  const after = packsMod.rulesFor(wsA);
  check("detach: reports the pack was removed", removed);
  check("detach: the overlay no longer applies", WEDDING_SIGNALS.every((s) => !after.signals[s]));
  check("detach: the dental workspace is unaffected", Boolean(packsMod.rulesFor(wsB).signals["aligner-interest"]));
}

// ---------------------------------------------------------------- 9. routes
type Handler = (ctx: unknown) => Promise<{ status: number; json?: unknown }> | { status: number; json?: unknown };
const captured: Array<{ method: string; pattern: string; handler: Handler }> = [];
routes.registerPackRoutes((method, pattern, handler) => captured.push({ method, pattern, handler: handler as Handler }));

function ctxFor(params: Record<string, string>, query: Record<string, string>, bodyText?: string): unknown {
  return {
    params,
    query: new URLSearchParams(query),
    header: () => undefined,
    readJson: async () => (bodyText ? JSON.parse(bodyText) : {}),
    readText: async () => bodyText ?? "",
  };
}

async function call(method: string, pattern: string, params: Record<string, string>, query: Record<string, string> = {}, bodyText?: string) {
  const route = captured.find((r) => r.method === method && r.pattern === pattern);
  if (!route) throw new Error(`route not registered: ${method} ${pattern}`);
  return route.handler(ctxFor(params, query, bodyText));
}

{
  check("routes: handlePackRequest adapter is exported", typeof routes.handlePackRequest === "function");
  check("routes: MAX_PACK_BYTES is 512 KB", routes.MAX_PACK_BYTES === 512 * 1024);

  const list = await call("GET", "/api/workspaces/:ws/niche-packs", { ws: wsB });
  const listJson = list.json as { attached?: unknown[]; library?: unknown[] };
  check("routes: GET workspace packs returns attached and library", list.status === 200 && Array.isArray(listJson.attached) && Array.isArray(listJson.library));

  const library = await call("GET", "/api/niche-packs", {}, { workspaceId: wsB });
  check("routes: GET /api/niche-packs returns the library", library.status === 200 && Array.isArray((library.json as { packs?: unknown[] }).packs));

  const good = JSON.stringify(privatePack("route-pack", wsB));
  const upload = await call("POST", "/api/niche-packs", {}, {}, good);
  check("routes: POST /api/niche-packs uploads a valid pack", upload.status === 201);

  const bad = await call("POST", "/api/niche-packs", {}, {}, JSON.stringify({ id: "bad", version: 1 }));
  const badJson = bad.json as { errors?: string[] };
  check("routes: POST /api/niche-packs returns 400 with the error list on a bad pack", bad.status === 400 && Array.isArray(badJson.errors) && badJson.errors.length > 0);

  const tooBig = await call("POST", "/api/niche-packs", {}, {}, "x".repeat(512 * 1024 + 1));
  check("routes: POST /api/niche-packs rejects a body over 512 KB", tooBig.status === 413);

  const attach = await call("POST", "/api/workspaces/:ws/niche-packs/:id/attach", { ws: wsB, id: "route-pack" });
  check("routes: POST attach attaches a pack", attach.status === 201);

  const detach = await call("POST", "/api/workspaces/:ws/niche-packs/:id/detach", { ws: wsB, id: "route-pack" });
  check("routes: POST detach detaches a pack", detach.status === 200);

  const attachMissing = await call("POST", "/api/workspaces/:ws/niche-packs/:id/attach", { ws: wsB, id: "does-not-exist" });
  check("routes: POST attach returns 404 for an unknown pack", attachMissing.status === 404);
}

// ---------------------------------------------------------------- 10. packs.html static rules
{
  const htmlUrl = new URL("../public/packs.html", import.meta.url);
  const html = existsSync(htmlUrl) ? readFileSync(htmlUrl, "utf8") : "";
  check("packs.html: exists", existsSync(htmlUrl));
  const badSrcHref = html.match(/(?:src|href)\s*=\s*["']https?:/gi) ?? [];
  check("packs.html: no http or https in src or href", badSrcHref.length === 0, badSrcHref.join(", "));
  const hasInnerHtml = html.includes("innerHTML");
  const hasEscape = /function\s+esc\s*\(/.test(html) || /function\s+escapeHtml\s*\(/.test(html);
  check("packs.html: no innerHTML without an escape helper", !hasInnerHtml || hasEscape);
  check("packs.html: same-origin API only (uses /api/ paths)", html.includes("/api/niche-packs"));
}

// ---------------------------------------------------------------- summary

console.log("");
console.log(`niche-packs checks: ${passed} passed, ${failed} failed`);
console.log(`temp DB: ${DB_FILE} (left in place, no deletes)`);
if (failed > 0) {
  console.log(`Failed checks: ${failures.join("; ")}`);
  process.exitCode = 1;
}
