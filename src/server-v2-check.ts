// L18 server-wiring check: wave 2 routes, auth, lead gate, optout, metering.
// Temp database, HTTP server on a random port, fake llm injected through the
// exported test hook from server.ts, no real network. Prints PASS/FAIL per item
// and stops the server at the end.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore node:sqlite has no ambient types in this environment (same as store.ts).
import { DatabaseSync } from "node:sqlite";

const ROOT = mkdtempSync(join(tmpdir(), "leadscout-server-v2-"));
const LEGACY_DB = join(ROOT, "legacy.db");
const MAIN_DB = join(ROOT, "main.db");

// Set the temp database BEFORE importing the store (which other wave 2 modules call at import time).
process.env.LEADSCOUT_DB = LEGACY_DB;

// ------------------------------------------------------------------ harness

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  const line = condition ? `PASS ${name}` : `FAIL ${name}${detail ? `: ${detail}` : ""}`;
  console.log(line);
  if (!condition) failed = true;
}

type Res = { status: number; body: unknown; text: string };
async function call(method: string, path: string, body?: unknown, key?: string): Promise<Res> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text) as unknown; } catch { /* not json */ }
  return { status: res.status, body: parsed, text };
}

function num(value: unknown, fallback = -1): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}
function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ------------------------------------------------------- 1. legacy DB opens

{
  const legacy = new DatabaseSync(LEGACY_DB);
  // Wave 1 schema: a leads table WITHOUT a gate column, one row already stored.
  legacy.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, offer TEXT NOT NULL, icp TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE leads (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
      address TEXT, city TEXT, country TEXT, lat REAL, lon REAL, phone TEXT, email TEXT, website TEXT,
      source TEXT NOT NULL, sourceUrl TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new', notes TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL,
      normName TEXT NOT NULL DEFAULT '', normCity TEXT NOT NULL DEFAULT '', websiteHost TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO workspaces (id, name, offer, icp, createdAt) VALUES
      ('ws-legacy', 'Legacy Fake Co', '{}', '{}', '2026-01-01T00:00:00Z');
    INSERT INTO leads (id, workspaceId, name, category, source, sourceUrl, createdAt) VALUES
      ('lead-legacy', 'ws-legacy', 'Legacy Fake Cafe', 'cafe', 'osm', 'https://osm.example.invalid/1', '2026-01-01T00:00:00Z');
  `);
  legacy.close();
}

const store = await import("./store.js");
const serverMod = await import("./server.js");
const { createServer } = serverMod;

const legacyInfo = store.getDb().prepare("PRAGMA table_info(leads)").all() as Array<{ name: string }>;
check("old DB opens and gate column is added on first open", legacyInfo.some((c) => c.name === "gate"));
check("legacy row still readable with gate default 'template'", (() => {
  const legacy = store.getLead("ws-legacy", "lead-legacy");
  return legacy !== undefined && legacy.name === "Legacy Fake Cafe" && legacy.gate === "template";
})());
{
  // Re-running the ensure step must not raise a duplicate-column error.
  store.closeDb();
  let ok = true;
  try { store.getDb(); } catch { ok = false; }
  check("ALTER TABLE is idempotent (reopen does not duplicate gate)", ok);
}
store.closeDb();
process.env.LEADSCOUT_DB = MAIN_DB;

// ------------------------------------------------------- fixtures + server

const access = await import("./access.js");
const compliance = await import("./compliance.js");
const dossierStore = await import("./dossier.js");

const ws = store.createWorkspace({
  name: "Fake Growth Co",
  offer: { services: ["website", "automation", "ai-chatbot"], description: "Fake offer for checks only" },
  icp: { categories: ["clinic", "cafe"], cities: ["Fake City"], countries: ["IN"] },
});

const hiddenLead = store.upsertLead({
  workspaceId: ws.id, name: "Fake Hidden Clinic", category: "clinic", city: "Fake City",
  source: "osm", sourceUrl: "https://osm.example.invalid/hidden", gate: "hidden",
  website: "https://example-optout.test",
});
const leadA = store.upsertLead({
  workspaceId: ws.id, name: "Fake Sample Cafe A", category: "cafe", city: "Fake City",
  phone: "+919000000001", email: "fake-a@example-a.test", website: "http://example-a.test",
  signals: ["no-https"], // absence evidence -> OUTDATED gap at level 0
  source: "osm", sourceUrl: "https://osm.example.invalid/a",
});
const leadB = store.upsertLead({
  workspaceId: ws.id, name: "Fake Sample Clinic B", category: "clinic", city: "Fake City",
  phone: "+919000000002", source: "osm", sourceUrl: "https://osm.example.invalid/b",
});
// Second workspace for the wrong-workspace-key check.
const ws2 = store.createWorkspace({
  name: "Other Fake Tenant",
  offer: { services: ["website"], description: "x" },
  icp: { categories: [], cities: [], countries: [] },
});
// Key of a different workspace for the auth matrix, created while keys are still off.
const otherKey = access.createApiKey(ws2.id, ["read"]);

let llmCalls = 0;
const fakeLlm = async (req: { system: string; prompt: string; taskHint?: string }) => {
  llmCalls++;
  // Echo the draft embedded in the prompt (same trick dossier-check uses) so the
  // rewrite stays fully cited and level 1 is reached.
  const at = req.prompt.indexOf("DRAFT TO REWRITE");
  const start = req.prompt.indexOf("{", at);
  const end = req.prompt.lastIndexOf("}");
  const draft = JSON.parse(req.prompt.slice(start, end + 1)) as {
    gap?: unknown; sayThis?: unknown; pushback?: unknown;
    offers: Array<{ service: string; description: unknown; whyItMatters: unknown }>;
  };
  return {
    text: JSON.stringify({
      gap: draft.gap, sayThis: draft.sayThis, pushback: draft.pushback,
      offers: draft.offers.map((o) => ({ service: o.service, description: o.description, whyItMatters: o.whyItMatters })),
    }),
    tokensIn: 120, tokensOut: 60, model: "fake-model",
  };
};
let fakeFetchCalls = 0;
const fakeFetchFn = (async (input: unknown) => {
  fakeFetchCalls++;
  // Deliberately refuse: the fake fetch is the injected boundary, no endpoint is reached.
  return new Response("fake: network disabled in checks", { status: 503 });
}) as unknown as typeof fetch;
serverMod.setTestHooks({ llm: fakeLlm, fetchFn: fakeFetchFn });

const server = createServer();
let PORT = 0;
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    PORT = typeof address === "object" && address ? address.port : 0;
    resolve();
  });
});
check("server listens on a random port", PORT > 0);

const base = (p: string) => `/api/workspaces/${ws.id}${p}`;

// ------------------------------------------------------- 2. hidden gate filter

{
  const def = await call("GET", base("/leads"));
  const defLeads = asRecords(obj(def.body).leads);
  const withHidden = await call("GET", base("/leads?includeHidden=1"));
  const withLeads = asRecords(obj(withHidden.body).leads);
  const ids = (list: Array<Record<string, unknown>>) => list.map((l) => l.id);
  check("hidden leads excluded from the default list", ids(defLeads).includes(hiddenLead.id) === false, JSON.stringify(ids(defLeads)));
  check("hidden lead total excludes hidden rows", num(obj(def.body).total) === 2, `total=${String(obj(def.body).total)}`);
  check("includeHidden=1 shows the hidden lead", ids(withLeads).includes(hiddenLead.id) && ids(withLeads).includes(leadA.id), JSON.stringify(ids(withLeads)));
  check("includeHidden=1 total includes hidden rows", num(obj(withHidden.body).total) === 3);

  // store-level assertion too
  const straight = store.listLeads({ workspaceId: ws.id }).leads.map((l) => l.id);
  const incl = store.listLeads({ workspaceId: ws.id, includeHidden: true }).leads.map((l) => l.id);
  check("store listLeads honours includeHidden", !straight.includes(hiddenLead.id) && incl.includes(hiddenLead.id));
}

// ------------------------------------------------------- 3. dossier routes

const getA = await call("GET", base(`/leads/${leadA.id}/dossier`));
const getAUnknown = await call("GET", base(`/leads/nope/dossier`));
check("dossier GET good -> 200 with branding + score + verification", getA.status === 200
  && obj(obj(getA.body).branding).displayName === "Fake Growth Co"
  && typeof obj(getA.body).score === "object", `status=${getA.status}`);
check("dossier GET unknown lead -> 404", getAUnknown.status === 404, `status=${getAUnknown.status}`);

const postA1 = await call("POST", base(`/leads/${leadA.id}/dossier`));
const a1 = obj(postA1.body);
const a1Dossier = obj(a1.dossier);
check("dossier POST reaches level 1 with the fake llm", num(a1Dossier.level) === 1, `level=${String(a1Dossier.level)} note=${String(a1.note)}`);
check("dossier POST level-1 note mentions the model polish", /level 1|polish|model|token/i.test(String(a1.note)), String(a1.note));
check("fake llm hook was actually used", llmCalls >= 1, `calls=${llmCalls}`);

const postA2 = await call("POST", base(`/leads/${leadA.id}/dossier`));
check("dossier POST with same inputHash keeps the stored dossier (no second polish)", String(obj(postA2.body).note).length > 0
  && num(obj(obj(postA2.body).dossier).level) === 1
  && obj(postA2.body).note !== a1.note, `note=${String(obj(postA2.body).note)}`);

// PATCH dossier: good + bad
{
  const good = await call("PATCH", base(`/leads/${leadA.id}/dossier`), { callStatus: "called" });
  check("dossier PATCH good -> 200 with callStatus", good.status === 200 && obj(good.body).callStatus === "called", `status=${good.status}`);
  const bad = await call("PATCH", base(`/leads/${leadA.id}/dossier`), { callStatus: "nonsense" });
  check("dossier PATCH bad callStatus -> 400", bad.status === 400, `status=${bad.status}`);
}

// Usage after the level-1 dossier: dossiers + tokens metered.
{
  const usage = obj(obj((await call("GET", base("/usage"))).body).usage);
  check("dossiers usage metered for the level-1 post", num(usage.dossiers) === 1, `dossiers=${String(usage.dossiers)}`);
  check("tokens metered from the fake model usage", num(usage.tokensIn) === 120 && num(usage.tokensOut) === 60,
    `tokensIn=${String(usage.tokensIn)} tokensOut=${String(usage.tokensOut)}`);
}

// Limit reached -> level 0 only, honest note.
{
  const admin = process.env.LEADSCOUT_ADMIN_TOKEN ?? "";
  process.env.LEADSCOUT_ADMIN_TOKEN = "fake-admin-token";
  const noToken = await call("PUT", base("/limits"), { dossiersPerMonth: 1 });
  check("PUT limits without admin token -> 403", noToken.status === 403, `status=${noToken.status}`);
  const badAdmin = await call("PUT", base("/limits"), { dossiersPerMonth: 1 }, "not-the-admin-token");
  check("PUT limits with the wrong admin token -> 403", badAdmin.status === 403, `status=${badAdmin.status}`);
  const okAdmin = await call("PUT", base("/limits"), { dossiersPerMonth: 1 }, "fake-admin-token");
  check("PUT limits with admin token -> 200", okAdmin.status === 200, `status=${okAdmin.status}`);
  const postB = await call("POST", base(`/leads/${leadB.id}/dossier`));
  const bDossier = obj(obj(postB.body).dossier);
  check("dossier POST when the limit is reached still returns a level 0 dossier", postB.status === 200 && num(bDossier.level) === 0,
    `status=${postB.status} level=${String(bDossier.level)}`);
  check("limit note says the limit was reached", /limit/i.test(String(obj(postB.body).note)), String(obj(postB.body).note));
  const restored = await call("PUT", base("/limits"), { dossiersPerMonth: 100, leadsPerMonth: 1000, exportsPerMonth: 1000, apiCallsPerMonth: 10000 }, "fake-admin-token");
  check("limits restored", restored.status === 200);
}

// Discover 429 when the monthly lead limit is exhausted.
{
  const setLow = await call("PUT", base("/limits"), { leadsPerMonth: 0 }, "fake-admin-token");
  if (setLow.status !== 200) check("discover limit setup", false, `PUT limits failed`);
  const refused = await call("POST", base("/discover"), { category: "cafe", city: "Fake City", limit: 5 });
  check("discover refused with 429 + plain message when the lead limit is used up", refused.status === 429
    && /limit/i.test(String(obj(refused.body).error)), `status=${refused.status} body=${refused.text}`);
  const restore = await call("PUT", base("/limits"), { leadsPerMonth: 1000 }, "fake-admin-token");
  if (restore.status !== 200) check("discover limit restore", false, `PUT limits failed`);
  const badDiscover = await call("POST", base("/discover"), {});
  check("discover bad body -> 400", badDiscover.status === 400, `status=${badDiscover.status}`);
  const fine = await call("POST", base("/discover"), { category: "cafe", city: "Fake City", limit: 1 });
  check("discover good -> 202 with jobId", fine.status === 202 && typeof obj(fine.body).jobId === "string", `status=${fine.status}`);
  // Let the background pipeline run against the fake fetchFn, then require that the
  // fake boundary was used (every network attempt is refused there; nothing real is hit).
  await new Promise((resolve) => setTimeout(resolve, 500));
  check("background discover routes every fetch through the injected fake fetchFn", fakeFetchCalls >= 1, `fakeFetchCalls=${fakeFetchCalls}`);
}

// ------------------------------------------------------- 4. price book and branding

{
  const bad = await call("PUT", base("/pricebook"), { items: "nonsense" });
  check("pricebook PUT bad body -> 400", bad.status === 400, `status=${bad.status}`);
  const before = obj((await call("GET", base("/pricebook"))).body);
  const items = asRecords(before.items);
  check("pricebook GET returns the default book", Array.isArray(items) && items.length > 0,
    `items=${String(items.length)}`);
  const custom = {
    items: [
      {
        service: "website", label: "Starter website", description: "A simple one page website.",
        buildDays: [7, 14], price: { currency: "INR", min: 1000, max: 2000 },
        assumption: "Content provided by the business.", doorOpener: false,
      },
      {
        service: "ai-chatbot", label: "Booking helper chat", description: "A small assistant for enquiries.",
        buildDays: null, price: null, assumption: "Uses public page text only.", doorOpener: true,
      },
    ],
  };
  const put = await call("PUT", base("/pricebook"), custom);
  check("pricebook PUT good -> 200 (version bumped)", put.status === 200 && num(obj(put.body).version) === 1, `status=${put.status}`);
  const after = obj((await call("GET", base("/pricebook"))).body);
  const afterItems = asRecords(after.items);
  check("pricebook round trip keeps the custom item and quote", num(afterItems[0]?.price ? num(obj(afterItems[0].price).min) : -1) === 1000
    && String(afterItems[0]?.label) === "Starter website", JSON.stringify(afterItems[0]));

  const badBrand = await call("PUT", base("/branding"), { accent: "#123456" });
  check("branding PUT missing displayName -> 400", badBrand.status === 400, `status=${badBrand.status}`);
  const branding = {
    displayName: "Fake Growth Co display", logoUrl: "https://example-growth.test/logo.png", accent: "#7a2ff2",
    contactLine: "fake@example-growth.test", reportFooter: "Fake footer", senderName: "Fake Sender", hidePoweredBy: true,
  };
  const putBrand = await call("PUT", base("/branding"), branding);
  check("branding PUT good -> 200", putBrand.status === 200 && obj(putBrand.body).displayName === "Fake Growth Co display", `status=${putBrand.status}`);
  const gotBrand = await call("GET", base("/branding"));
  check("branding round trip (accent, senderName, hidePoweredBy)", obj(gotBrand.body).accent === "#7a2ff2"
    && obj(gotBrand.body).hidePoweredBy === true && obj(gotBrand.body).senderName === "Fake Sender", gotBrand.text.slice(0, 120));
}

// ------------------------------------------------------- 5. keys

let writeKey = "";
let readKey = "";
{
  const bad = await call("POST", base("/keys"), { scopes: [] });
  check("keys POST with empty scopes -> 400", bad.status === 400, `status=${bad.status}`);
  const created = await call("POST", base("/keys"), { scopes: ["read", "write"] });
  writeKey = String(obj(created.body).key ?? "");
  const created2 = await call("POST", base("/keys"), { scopes: ["read"] });
  readKey = String(obj(created2.body).key ?? "");
  check("key creation returns ls_ key once", created.status === 201 && writeKey.startsWith("ls_") && readKey.startsWith("ls_"), `status=${created.status}`);
  const listed = await call("GET", base("/keys"));
  check("keys GET lists keys without the secret", listed.status === 200
    && asRecords(listed.body).length >= 2
    && !listed.text.includes(`"${writeKey}"`), listed.text.slice(0, 120));
  const thrownAway = await call("POST", base("/keys"), { scopes: ["read"] });
  const revokedOne = await call("DELETE", base(`/keys/${obj(thrownAway.body).id ?? ""}`));
  check("keys DELETE revokes", revokedOne.status === 200 && access.verifyApiKey(String(obj(thrownAway.body).key)) === null, `status=${revokedOne.status}`);
  const gone = await call("DELETE", base("/keys/nope"));
  check("keys DELETE unknown id -> 404", gone.status === 404, `status=${gone.status}`);
}

// ------------------------------------------------------- 6. optout (public)

{
  const page = await fetch(`http://127.0.0.1:${PORT}/optout`);
  const html = await page.text();
  check("GET /optout serves public/optout.html", page.status === 200 && /<form|input|html/i.test(html), `status=${page.status}`);
  const bad = await call("POST", "/api/optout", { kind: "email" });
  check("optout missing value -> 400", bad.status === 400, `status=${bad.status}`);
  const good = await call("POST", "/api/optout", { value: "optout@example-optout.test", note: "fake pub" });
  check("optout good -> 200 stored as global public-form", good.status === 200 && obj(good.body).ok === true
    && compliance.listOptOuts("global").some((o) => o.value.includes("example-optout.test") && o.source === "public-form"),
    `status=${good.status} body=${good.text}`);
  // Sliding window: two earlier hits (bad counts too), so 8 more are allowed, the 11th is blocked.
  for (let i = 0; i < 8; i++) await call("POST", "/api/optout", { value: `opt${i}@example-optout.test` });
  const eleventh = await call("POST", "/api/optout", { value: "person@example-optout.test" });
  check("11th optout within the hour -> 429", eleventh.status === 429, `status=${eleventh.status}`);
}

// ------------------------------------------------------- 7. export every format

{
  const formats = ["generic", "hubspot", "zoho", "twenty", "jsonl"];
  for (const format of formats) {
    const res = await call("GET", `${base("/export")}?format=${format}`);
    const includesHidden = typeof res.text === "string" && res.text.includes("example-optout.test");
    check(`export format ${format} excludes the opted-out lead`, res.status === 200 && res.text.length > 0 && !includesHidden,
      `status=${res.status} hidden=${includesHidden}`);
  }
  const bad = await call("GET", `${base("/export")}?format=excel`);
  check("export unknown format -> 400", bad.status === 400, `status=${bad.status}`);
}

// ------------------------------------------------------- 8. share + report

{
  const bad = await call("POST", base("/share"), { leadIds: "not-a-list" });
  check("share bad leadIds -> 400", bad.status === 400, `status=${bad.status}`);
  const good = await call("POST", base("/share"), { leadIds: [leadA.id], days: 7 });
  const token = String(obj(good.body).token ?? "");
  check("share good -> token + url", good.status === 200 && token.length > 10 && String(obj(good.body).url).includes(token), `status=${good.status}`);
  const report = await call("GET", `/api/report/${token}`);
  const rb = obj(report.body);
  check("report is public, read-only, branded and lists the dossier", report.status === 200
    && obj(rb.branding).displayName === "Fake Growth Co display"
    && Array.isArray(rb.dossiers) && rb.dossiers.length === 1
    && Array.isArray(rb.explainers), `status=${report.status}`);
  const notReadOnly = await call("POST", `/api/report/${token}`);
  check("report rejects POST (read-only)", notReadOnly.status === 405 || notReadOnly.status === 404, `status=${notReadOnly.status}`);
  const expired = await call("GET", "/api/report/fake-token-nope");
  check("unknown report token -> 404", expired.status === 404, `status=${expired.status}`);
}

// ------------------------------------------------------- 9. usage grows + no double metering

{
  const usage = obj(obj((await call("GET", base("/usage"))).body).usage);
  check("exports counter grows after the export calls above", num(usage.exports) === 5, `exports=${String(usage.exports)}`);
  check("no double metering of pipeline-owned events (discovered/enriched stay 0)",
    num(usage.discovered) === 0 && num(usage.enriched) === 0,
    `discovered=${String(usage.discovered)} enriched=${String(usage.enriched)}`);
}

// ------------------------------------------------------- 10. auth matrix

{
  const usageBefore = num(obj(obj((await call("GET", base("/usage"))).body).usage).apiCalls);
  // Keys off: a request that carries a key still meters apiCalls and must be validated.
  const keyed = await call("GET", base("/leads"), undefined, writeKey);
  check("keys off: valid key still meters apiCalls", keyed.status === 200
    && num(obj(obj((await call("GET", base("/usage"))).body).usage).apiCalls) === usageBefore + 1, `status=${keyed.status}`);
  const bogus = await call("GET", base("/leads"), undefined, "ls_bogus-key-0000000000000000000000000000");
  check("keys off: presented-but-invalid key -> 401", bogus.status === 401, `status=${bogus.status}`);

  // Keys on.
  process.env.LEADSCOUT_REQUIRE_KEYS = "1";
  const noKey = await call("GET", base("/leads"));
  check("keys on: workspace route without key -> 401", noKey.status === 401, `status=${noKey.status}`);
  const readOnlyGet = await call("GET", base("/leads"), undefined, readKey);
  check("keys on: read key on GET -> 200", readOnlyGet.status === 200, `status=${readOnlyGet.status}`);
  const readOnlyPut = await call("PUT", base("/branding"), { displayName: "x" }, readKey);
  check("keys on: read-only key on PUT -> 403", readOnlyPut.status === 403, `status=${readOnlyPut.status}`);
  const writePut = await call("PUT", base("/branding"), { displayName: "Fake Growth Co display" }, writeKey);
  check("keys on: write key on PUT -> 200", writePut.status === 200, `status=${writePut.status}`);
  const other = await call("GET", base("/leads"), undefined, otherKey.key);
  check("keys on: another workspace's key -> 403", other.status === 403, `status=${other.status}`);
  const healthPublic = await call("GET", "/api/health");
  check("health stays public with keys on", healthPublic.status === 200 && obj(healthPublic.body).ok === true);
  delete process.env.LEADSCOUT_REQUIRE_KEYS;
}

// ------------------------------------------------------- health + static + shutdown

{
  const health = await call("GET", "/api/health");
  check("health ok", health.status === 200 && obj(health.body).ok === true);
  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  check("static / still served", page.status === 200 && (await page.text()).includes("<html"));
}
await new Promise<void>((resolve) => server.close(() => resolve()));
check("server stopped", true);

store.closeDb();
rmSync(ROOT, { recursive: true, force: true });
if (failed) {
  console.log("server-v2-check FAILED");
  process.exit(1);
} else {
  console.log("server-v2-check PASSED");
}
