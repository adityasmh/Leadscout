// L27-wiring-2 check: outreach, billing, extra sources, settings/dossier statics and health
// integrations, all offline. Temp database, random port, injected fake fetch/transport.
// For every new route it prints PASS/FAIL for the happy path, missing key refused and unknown
// workspace 404. Prints PASS/FAIL per item and stops the server at the end.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "leadscout-l27-"));
// Set the temp database BEFORE importing the store (other modules open it at import time).
process.env.LEADSCOUT_DB = join(ROOT, "check.db");

// Make the integration checks deterministic regardless of the host shell.
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.GOOGLE_PLACES_API_KEY;
delete process.env.LEADSCOUT_SEND_ENABLED;
delete process.env.LEADSCOUT_SMTP_URL;
delete process.env.LEADSCOUT_REQUIRE_KEYS;

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  const line = condition ? `PASS ${name}` : `FAIL ${name}${detail ? `: ${detail}` : ""}`;
  console.log(line);
  if (!condition) failed = true;
}

type Res = { status: number; body: unknown; text: string };
function parse(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return text; }
}
async function call(method: string, path: string, body?: unknown, key?: string, raw = false): Promise<Res> {
  const headers: Record<string, string> = { "content-type": raw ? "text/csv" : "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const payload = body === undefined ? undefined : raw ? String(body) : JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, body: parse(text), text };
}
function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const store = await import("./store.js");
const serverMod = await import("./server.js");
const access = await import("./access.js");
const billing = await import("./billing.js");

// Every outside call is refused at the injected boundary; nothing real is reached.
let fakeFetchCalls = 0;
const fakeFetch = (async () => {
  fakeFetchCalls++;
  return new Response("offline", { status: 503 });
}) as unknown as typeof fetch;
let transported = 0;
const fakeTransport = async (_draft: { to: string }): Promise<unknown> => {
  transported++;
  return { ok: true, response: "fake transport" };
};
serverMod.setTestHooks({ fetchFn: fakeFetch });

const ws = store.createWorkspace({
  name: "Fake L27 Workspace",
  offer: { services: ["website", "automation"], description: "Fake offer for checks only" },
  icp: { categories: ["cafe"], cities: ["Fake City"], countries: ["IN"] },
});
billing.setWorkspacePlan(ws.id, "starter");
const lead = store.upsertLead({
  workspaceId: ws.id,
  name: "Fake L27 Cafe",
  category: "cafe",
  city: "Fake City",
  email: "fake-l27@example-lead.test",
  phone: "+919000000042",
  source: "osm",
  sourceUrl: "https://osm.example.invalid/l27",
});

const server = serverMod.createServer();
let PORT = 0;
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    PORT = typeof address === "object" && address ? address.port : 0;
    resolve();
  });
});
const base = (p: string) => `/api/workspaces/${ws.id}${p}`;
check("server listens on a random port", PORT > 0, `port=${PORT}`);

// ------------------------------------------------------- outreach
{
  const draft = await call("POST", base(`/leads/${lead.id}/outreach`), { channel: "email" });
  check("POST outreach happy path returns an email draft", draft.status === 200
    && obj(obj(draft.body).draft).channel === "email", `status=${draft.status} body=${draft.text.slice(0, 120)}`);
  const badChannel = await call("POST", base(`/leads/${lead.id}/outreach`), { channel: "carrier-pigeon" });
  check("POST outreach unknown channel -> 400", badChannel.status === 400, `status=${badChannel.status}`);
  const missing = await call("POST", base("/leads/nope/outreach"), { channel: "email" });
  check("POST outreach unknown lead -> 404", missing.status === 404, `status=${missing.status}`);
}

// ------------------------------------------------------- dry-run send (sending OFF by default)
{
  const send = await call("POST", base(`/leads/${lead.id}/outreach/send`), {});
  check("POST outreach/send dry run returns dryRun true", send.status === 200
    && obj(send.body).dryRun === true && obj(send.body).sent === false, `status=${send.status} body=${send.text.slice(0, 160)}`);
  check("dry-run send reached no outside transport", transported === 0, `transported=${transported}`);
}

// ------------------------------------------------------- pricebook + usage happy path
{
  const usage = await call("GET", base("/usage"));
  check("GET usage happy path -> 200 with usage + limits", usage.status === 200
    && typeof obj(usage.body).usage === "object" && typeof obj(usage.body).limits === "object", `status=${usage.status}`);
  const book = await call("GET", base("/pricebook"));
  check("GET pricebook happy path -> 200 with items", book.status === 200 && Array.isArray(obj(book.body).items), `status=${book.status}`);
  const put = await call("PUT", base("/pricebook"), { items: obj(book.body).items });
  check("PUT pricebook happy path -> 200", put.status === 200, `status=${put.status}`);
}

// ------------------------------------------------------- invoices
let invoiceNumberForAuth = "";
{
  const created = await call("POST", base("/invoices"), {});
  const invoice = obj(created.body);
  const invoiceNumber = typeof invoice.invoiceNumber === "string" ? invoice.invoiceNumber : "";
  invoiceNumberForAuth = invoiceNumber;
  check("POST invoices happy path builds for a period -> 201", created.status === 201 && invoiceNumber.length > 0,
    `status=${created.status} body=${created.text.slice(0, 120)}`);

  const list = await call("GET", base("/invoices"));
  check("GET invoices lists the built invoice", list.status === 200
    && Array.isArray(obj(list.body).invoices)
    && (obj(list.body).invoices as unknown[]).some((i) => obj(i).invoiceNumber === invoiceNumber), `status=${list.status}`);

  const html = await fetch(`http://127.0.0.1:${PORT}${base(`/invoices/${encodeURIComponent(invoiceNumber)}.html`)}`);
  const htmlText = await html.text();
  check("GET invoice .html happy path -> printable page", html.status === 200
    && (html.headers.get("content-type") ?? "").includes("text/html") && htmlText.includes(invoiceNumber), `status=${html.status}`);

  const fetchCallsBeforePay = fakeFetchCalls;
  const pay = await call("POST", base(`/invoices/${encodeURIComponent(invoiceNumber)}/pay-link`), { provider: "razorpay" });
  check("POST invoice pay-link with no keys -> enabled false (offline)", pay.status === 200 && obj(pay.body).enabled === false,
    `status=${pay.status} body=${pay.text.slice(0, 120)}`);
  check("pay-link with no provider keys made no outside call", fakeFetchCalls === fetchCallsBeforePay,
    `before=${fetchCallsBeforePay} after=${fakeFetchCalls}`);

  const badProvider = await call("POST", base(`/invoices/${encodeURIComponent(invoiceNumber)}/pay-link`), { provider: "paypal" });
  check("POST invoice pay-link unknown provider -> 400", badProvider.status === 400, `status=${badProvider.status}`);

  const missingHtml = await call("GET", base("/invoices/no-such-invoice.html"));
  check("GET unknown invoice .html -> 404", missingHtml.status === 404, `status=${missingHtml.status}`);
}

// ------------------------------------------------------- CSV import
{
  const csv = "name,category,phone,website\nFake CSV Cafe,cafe,+919000000043,http://csv-example.test\n";
  const imported = await call("POST", base("/import-csv"), csv, undefined, true);
  check("POST import-csv happy path imports a CSV row", imported.status === 200
    && obj(imported.body).imported === 1 && Array.isArray(obj(imported.body).leads), `status=${imported.status} body=${imported.text.slice(0, 120)}`);
  const empty = await call("POST", base("/import-csv"), "  ", undefined, true);
  check("POST import-csv empty body -> 400", empty.status === 400, `status=${empty.status}`);
}

// ------------------------------------------------------- discover source parameter
{
  const places = await call("POST", base("/discover"), { category: "cafe", source: "google-places", limit: 1 });
  check("discover accepts source google-places -> 202", places.status === 202 && typeof obj(places.body).jobId === "string", `status=${places.status}`);
  const csv = await call("POST", base("/discover"), { category: "cafe", source: "csv", limit: 1 });
  check("discover accepts source csv -> 202", csv.status === 202, `status=${csv.status}`);
  const dflt = await call("POST", base("/discover"), { category: "cafe", limit: 1 });
  check("discover defaults source osm -> 202", dflt.status === 202, `status=${dflt.status}`);
  const bad = await call("POST", base("/discover"), { category: "cafe", source: "bing" });
  check("discover unknown source -> 400", bad.status === 400, `status=${bad.status}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

// ------------------------------------------------------- static pages
{
  const settings = await fetch(`http://127.0.0.1:${PORT}/settings.html`);
  const settingsText = await settings.text();
  check("GET /settings.html served as a static file", settings.status === 200 && /<html/i.test(settingsText), `status=${settings.status}`);
  const dossier = await fetch(`http://127.0.0.1:${PORT}/dossier.html`);
  const dossierText = await dossier.text();
  check("GET /dossier.html served as a static file", dossier.status === 200 && /<html/i.test(dossierText), `status=${dossier.status}`);
}

// Route table for the two cross-cutting loops below. Every new route is covered.
type RouteSpec = { name: string; method: string; path: string; body?: unknown; raw?: boolean };
const newRoutes: RouteSpec[] = [
  { name: "POST outreach", method: "POST", path: `/leads/${lead.id}/outreach`, body: { channel: "email" } },
  { name: "POST outreach/send", method: "POST", path: `/leads/${lead.id}/outreach/send`, body: {} },
  { name: "GET pricebook", method: "GET", path: "/pricebook" },
  { name: "PUT pricebook", method: "PUT", path: "/pricebook", body: { items: [] } },
  { name: "GET usage", method: "GET", path: "/usage" },
  { name: "GET invoices", method: "GET", path: "/invoices" },
  { name: "POST invoices", method: "POST", path: "/invoices", body: {} },
  { name: "GET invoice .html", method: "GET", path: "/invoices/fake-l27-invoice.html" },
  { name: "POST invoice pay-link", method: "POST", path: "/invoices/fake-l27-invoice/pay-link", body: { provider: "razorpay" } },
  { name: "POST import-csv", method: "POST", path: "/import-csv", body: "name\nFake L27 Import\n", raw: true },
  { name: "POST discover", method: "POST", path: "/discover", body: { category: "cafe", limit: 1 } },
];

// ------------------------------------------------------- unknown workspace 404, every route
for (const r of newRoutes) {
  const res = await call(r.method, `/api/workspaces/no-such-workspace${r.path}`, r.body, undefined, r.raw === true);
  check(`unknown workspace -> 404 (${r.name})`, res.status === 404, `status=${res.status} body=${res.text.slice(0, 120)}`);
}

// ------------------------------------------------------- missing key refused, every route
{
  process.env.LEADSCOUT_REQUIRE_KEYS = "1";
  for (const r of newRoutes) {
    const res = await call(r.method, base(r.path), r.body, undefined, r.raw === true);
    check(`missing key refused -> 401/403 (${r.name})`, res.status === 401 || res.status === 403,
      `status=${res.status} body=${res.text.slice(0, 120)}`);
  }
  const key = access.createApiKey(ws.id, ["read"]);
  const withKey = await call("GET", base("/usage"), undefined, key.key);
  check("valid workspace key accepted -> 200", withKey.status === 200, `status=${withKey.status}`);
  delete process.env.LEADSCOUT_REQUIRE_KEYS;
}

// ------------------------------------------------------- absent modules are 501, not a crash
{
  serverMod.setTestHooks({ moduleOverrides: { "./outreach.js": "./missing-module-for-l27-check.js" } });
  const missingOutreach = await call("POST", base(`/leads/${lead.id}/outreach`), { channel: "email" });
  check("absent outreach module -> 501 naming the module", missingOutreach.status === 501
    && /outreach/i.test(String(obj(missingOutreach.body).error)), `status=${missingOutreach.status} body=${missingOutreach.text.slice(0, 160)}`);

  serverMod.setTestHooks({ moduleOverrides: { "./billing.js": "./missing-module-for-l27-check.js" } });
  const missingBilling = await call("GET", base("/invoices"));
  check("absent billing module -> 501 naming the module", missingBilling.status === 501
    && /billing/i.test(String(obj(missingBilling.body).error)), `status=${missingBilling.status} body=${missingBilling.text.slice(0, 160)}`);

  serverMod.setTestHooks({ moduleOverrides: { "./sources-extra.js": "./missing-module-for-l27-check.js" } });
  const missingSources = await call("POST", base("/import-csv"), "name\nFake L27 Import\n", undefined, true);
  check("absent sources-extra module -> 501 naming the module", missingSources.status === 501
    && /sources-extra/i.test(String(obj(missingSources.body).error)), `status=${missingSources.status} body=${missingSources.text.slice(0, 160)}`);

  serverMod.setTestHooks({ moduleOverrides: {} });
  const healthAfter = await call("GET", "/api/health");
  check("server still answers after the 501s (no crash)", healthAfter.status === 200 && obj(healthAfter.body).ok === true, `status=${healthAfter.status}`);
}

// ------------------------------------------------------- health integrations (names, never values)
{
  const health = await call("GET", "/api/health");
  check("health lists integrations as an array of names", health.status === 200
    && Array.isArray(obj(health.body).integrations), `status=${health.status} body=${health.text.slice(0, 120)}`);

  const secret = "fake-places-integration-value";
  process.env.GOOGLE_PLACES_API_KEY = secret;
  const on = await call("GET", "/api/health");
  const names = obj(on.body).integrations as unknown[];
  check("health lists an enabled integration by name", names.includes("google-places"), `body=${on.text.slice(0, 160)}`);
  check("health never leaks integration values", !on.text.includes(secret), `body=${on.text.slice(0, 160)}`);
  delete process.env.GOOGLE_PLACES_API_KEY;
}

// ------------------------------------------------------- sending switch gates the injected transport
{
  serverMod.setTestHooks({ transport: fakeTransport });
  // Switch OFF: dry run stays on even with a transport injected (a real send needs the env switch).
  const dry = await call("POST", base(`/leads/${lead.id}/outreach/send`), {});
  check("dry-run stays on with a transport injected but sending disabled", dry.status === 200
    && obj(dry.body).dryRun === true && obj(dry.body).sent === false && transported === 0,
    `status=${dry.status} body=${dry.text.slice(0, 140)}`);

  // Switch ON: the injected transport is now used (still no real network).
  process.env.LEADSCOUT_SEND_ENABLED = "1";
  const sent = await call("POST", base(`/leads/${lead.id}/outreach/send`), {});
  check("injected transport used only when the env switch is on", sent.status === 200
    && obj(sent.body).sent === true && transported === 1, `status=${sent.status} body=${sent.text.slice(0, 140)}`);
  delete process.env.LEADSCOUT_SEND_ENABLED;
  serverMod.setTestHooks();
}

await new Promise<void>((resolve) => server.close(() => resolve()));
check("server stopped", true);

store.closeDb();
rmSync(ROOT, { recursive: true, force: true });
if (failed) {
  console.log("server-check FAILED");
  process.exit(1);
} else {
  console.log("server-check PASSED");
}
