// Offline proof harness for billing.ts.
// Sets LEADSCOUT_DB to a temp file BEFORE importing any module that opens the DB.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "leadscout-billing-check-"));
const dbPath = join(tmpDir, "test.db");
process.env.LEADSCOUT_DB = dbPath;

const {
  buildInvoice,
  usageForPeriod,
  renderInvoiceHtml,
  createPaymentLink,
  enforceLimits,
  recordUsage,
  setWorkspacePlan,
  BillingError,
} = await import("./billing.js");
const { createWorkspace, upsertLead, getDb, closeDb } = await import("./store.js");

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

async function assertThrows(name: string, fn: () => void | Promise<void>, expectCode: string) {
  try {
    await fn();
    return check(name, false, `expected BillingError ${expectCode} but none thrown`);
  } catch (err) {
    const code = err instanceof BillingError ? err.code : "?";
    const msg = err instanceof Error ? err.message : String(err);
    return check(name, code === expectCode, `code=${code} msg=${msg}`);
  }
}

function currentMonthPeriod() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

function makeWs(name: string) {
  return createWorkspace({
    name,
    offer: { services: ["website"], description: "fake offer" },
    icp: { categories: ["dental"], cities: ["Mumbai"], countries: ["IN"] },
  });
}

function createLeads(workspaceId: string, count: number) {
  for (let i = 1; i <= count; i++) {
    upsertLead({
      workspaceId,
      name: `Lead ${workspaceId.slice(0, 4)} ${i}`,
      category: "dental",
      source: "test",
      sourceUrl: `https://example.com/lead/${i}`,
    });
  }
}

// --------------------------------------------------------------------------- env helpers

const FAKE_RAZORPAY_KEY_ID = "rzp_test_FAKE123";
const FAKE_RAZORPAY_KEY_SECRET = "fake_secret_abc";
const FAKE_STRIPE_SECRET_KEY = "sk_test_fakestripekey";

function saveEnv(): Record<string, string | undefined> {
  return {
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  };
}

function restoreEnv(prev: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearPaymentEnv() {
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  delete process.env.STRIPE_SECRET_KEY;
}

// --------------------------------------------------------------------------- A1 arithmetic

{
  const ws = makeWs("A1 Arithmetic");
  setWorkspacePlan(ws.id, "starter");

  // starter: monthlyPrice 499900, includedLeads 100, overagePerLead 3333,
  // includedDossiers 10, overagePerDossier 16667, GST default 18%
  createLeads(ws.id, 102); // 2 lead overage
  recordUsage(ws.id, "dossier", 11); // 1 dossier overage

  const invoice = buildInvoice(ws.id, currentMonthPeriod());
  const fee = invoice.lines.find((l) => l.label === "Plan fee")?.amount;
  const leadOver = invoice.lines.find((l) => l.label === "Lead overage")?.amount;
  const dossierOver = invoice.lines.find((l) => l.label === "Dossier overage")?.amount;

  // 2 * 3333 = 6666; 1 * 16667 = 16667; subtotal = 499900 + 6666 + 16667 = 523233
  // GST = round(523233 * 0.18) = round(94181.94) = 94182; total = 617415
  check("A1-plan-fee", fee === 499900, `fee=${fee}`);
  check("A1-lead-overage", leadOver === 6666, `leadOver=${leadOver}`);
  check("A1-dossier-overage", dossierOver === 16667, `dossierOver=${dossierOver}`);
  check("A1-subtotal", invoice.subtotal === 523233, `subtotal=${invoice.subtotal}`);
  check("A1-gst", invoice.gstAmount === 94182, `gst=${invoice.gstAmount}`);
  check("A1-total", invoice.total === 617415, `total=${invoice.total}`);
}

// --------------------------------------------------------------------------- A2 invoice numbering

{
  const wsA = makeWs("A2 Workspace A");
  const wsB = makeWs("A2 Workspace B");
  setWorkspacePlan(wsA.id, "starter");
  setWorkspacePlan(wsB.id, "starter");

  const invA1 = buildInvoice(wsA.id, currentMonthPeriod());
  const invA2 = buildInvoice(wsA.id, currentMonthPeriod());
  const invB1 = buildInvoice(wsB.id, currentMonthPeriod());

  const a1Seq = Number(invA1.invoiceNumber.split("-").pop());
  const a2Seq = Number(invA2.invoiceNumber.split("-").pop());
  const b1Seq = Number(invB1.invoiceNumber.split("-").pop());

  check("A2-format-a1", /^[a-f0-9-]+-\d{6}-\d{4}$/i.test(invA1.invoiceNumber), invA1.invoiceNumber);
  check("A2-sequence-increments", a2Seq === a1Seq + 1, `a1=${a1Seq} a2=${a2Seq}`);
  check("A2-independent-workspaces", b1Seq === 1, `b1=${b1Seq}`);
  check("A2-distinct", invA1.invoiceNumber !== invB1.invoiceNumber);
}

// --------------------------------------------------------------------------- A3 HTML has no external URLs

{
  const ws = makeWs("A3 HTML");
  setWorkspacePlan(ws.id, "starter");
  const invoice = buildInvoice(ws.id, currentMonthPeriod());
  const html = renderInvoiceHtml(invoice);
  const hasHttp = /https?:\/\//i.test(html);
  const hasProtocolRelative = /(?<!:)\/\//.test(html);
  const hasImg = /<img\b/i.test(html);
  check("A3-no-http-urls", !hasHttp);
  check("A3-no-protocol-relative", !hasProtocolRelative);
  check("A3-no-img", !hasImg);
}

// --------------------------------------------------------------------------- A4 limits

{
  const ws = makeWs("A4 Limits");
  setWorkspacePlan(ws.id, "starter");

  // leads: included 100
  createLeads(ws.id, 99);
  let status = enforceLimits(ws.id);
  check("A4-lead-allow-below", status.allowed.lead && !status.blocked.includes("lead"), `used=${status.allowed.lead}`);

  // Add one more uniquely-named lead so it is not deduped by upsertLead.
  upsertLead({
    workspaceId: ws.id,
    name: "Lead A4 100",
    category: "dental",
    source: "test",
    sourceUrl: "https://example.com/lead/a4-100",
  });
  status = enforceLimits(ws.id);
  check("A4-lead-block-at-limit", !status.allowed.lead && status.blocked.includes("lead"), `used=${status.blocked.join(",")}`);

  // dossiers: included 10
  recordUsage(ws.id, "dossier", 9);
  status = enforceLimits(ws.id);
  check("A4-dossier-allow-below", status.allowed.dossier && !status.blocked.includes("dossier"));

  recordUsage(ws.id, "dossier", 1);
  status = enforceLimits(ws.id);
  check("A4-dossier-block-at-limit", !status.allowed.dossier && status.blocked.includes("dossier"));

  // apiCalls: included 50
  recordUsage(ws.id, "apiCall", 49);
  status = enforceLimits(ws.id);
  check("A4-apiCall-allow-below", status.allowed.apiCall && !status.blocked.includes("apiCall"));

  recordUsage(ws.id, "apiCall", 1);
  status = enforceLimits(ws.id);
  check("A4-apiCall-block-at-limit", !status.allowed.apiCall && status.blocked.includes("apiCall"));
}

// --------------------------------------------------------------------------- A5 adapters

{
  const ws = makeWs("A5 Adapters");
  setWorkspacePlan(ws.id, "starter");
  const invoice = buildInvoice(ws.id, currentMonthPeriod());

  const prev = saveEnv();
  process.env.RAZORPAY_KEY_ID = FAKE_RAZORPAY_KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = FAKE_RAZORPAY_KEY_SECRET;
  process.env.STRIPE_SECRET_KEY = FAKE_STRIPE_SECRET_KEY;

  // Razorpay
  let captured: { url?: string; init?: RequestInit } = {};
  const razorpayFetch = async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response(JSON.stringify({ id: "plink_fake", short_url: "https://rzp.io/fake" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const rzpResult = await createPaymentLink(invoice, "razorpay", { fetchFn: razorpayFetch as any });
  const rzpAuth = (captured.init?.headers as Record<string, string>)?.Authorization ?? "";
  const rzpDecoded = Buffer.from(rzpAuth.replace(/^Basic\s+/i, ""), "base64").toString();
  const rzpBody = JSON.parse((captured.init?.body as string) ?? "{}");
  check("A5-razorpay-url", captured.url === "https://api.razorpay.com/v1/payment_links", captured.url);
  check("A5-razorpay-method", captured.init?.method === "POST", String(captured.init?.method));
  check("A5-razorpay-auth-basic", rzpAuth.startsWith("Basic "));
  check("A5-razorpay-auth-credentials", rzpDecoded === `${FAKE_RAZORPAY_KEY_ID}:${FAKE_RAZORPAY_KEY_SECRET}`);
  check("A5-razorpay-body-amount", rzpBody.amount === invoice.total, `amount=${rzpBody.amount}`);
  check("A5-razorpay-result", (rzpResult as any).enabled === true && (rzpResult as any).url === "https://rzp.io/fake");

  // Stripe
  captured = {};
  const stripeFetch = async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response(JSON.stringify({ id: "cs_fake", url: "https://checkout.stripe.com/fake" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const stripeResult = await createPaymentLink(invoice, "stripe", { fetchFn: stripeFetch as any });
  const stripeAuth = (captured.init?.headers as Record<string, string>)?.Authorization ?? "";
  const stripeBody = new URLSearchParams((captured.init?.body as string) ?? "");
  check("A5-stripe-url", captured.url === "https://api.stripe.com/v1/checkout/sessions", captured.url);
  check("A5-stripe-method", captured.init?.method === "POST", String(captured.init?.method));
  check("A5-stripe-auth-bearer", stripeAuth === `Bearer ${FAKE_STRIPE_SECRET_KEY}`);
  check("A5-stripe-unit-amount", stripeBody.get("line_items[0][price_data][unit_amount]") === String(invoice.total));
  check("A5-stripe-result", (stripeResult as any).enabled === true && (stripeResult as any).url === "https://checkout.stripe.com/fake");

  restoreEnv(prev);
}

// --------------------------------------------------------------------------- A6 enabled:false without keys

{
  const ws = makeWs("A6 Disabled");
  setWorkspacePlan(ws.id, "starter");
  const invoice = buildInvoice(ws.id, currentMonthPeriod());
  const noopFetch = async () => new Response("{}");

  const prev = saveEnv();
  clearPaymentEnv();
  const noKeysRzp = await createPaymentLink(invoice, "razorpay", { fetchFn: noopFetch as any });
  const noKeysStripe = await createPaymentLink(invoice, "stripe", { fetchFn: noopFetch as any });
  check("A6-razorpay-no-keys", (noKeysRzp as any).enabled === false);
  check("A6-stripe-no-keys", (noKeysStripe as any).enabled === false);

  process.env.RAZORPAY_KEY_ID = FAKE_RAZORPAY_KEY_ID;
  const onlyIdRzp = await createPaymentLink(invoice, "razorpay", { fetchFn: noopFetch as any });
  check("A6-razorpay-only-id", (onlyIdRzp as any).enabled === false);

  restoreEnv(prev);
}

// --------------------------------------------------------------------------- A7 keys never echoed

{
  const ws = makeWs("A7 Key Sanitisation");
  setWorkspacePlan(ws.id, "starter");
  const invoice = buildInvoice(ws.id, currentMonthPeriod());

  const prev = saveEnv();
  process.env.RAZORPAY_KEY_ID = FAKE_RAZORPAY_KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = FAKE_RAZORPAY_KEY_SECRET;
  process.env.STRIPE_SECRET_KEY = FAKE_STRIPE_SECRET_KEY;

  const errorFetch = async () =>
    new Response(JSON.stringify({ error: "server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  const rejectFetch = async () => {
    throw new Error("network failure");
  };

  const rzpError = await createPaymentLink(invoice, "razorpay", { fetchFn: errorFetch as any });
  const rzpReject = await createPaymentLink(invoice, "razorpay", { fetchFn: rejectFetch as any });
  const stripeError = await createPaymentLink(invoice, "stripe", { fetchFn: errorFetch as any });

  const messages = [
    (rzpError as any).error?.message ?? "",
    (rzpReject as any).error?.message ?? "",
    (stripeError as any).error?.message ?? "",
  ].join(" ");

  check(
    "A7-no-key-id-in-error",
    !messages.includes(FAKE_RAZORPAY_KEY_ID),
    messages
  );
  check(
    "A7-no-key-secret-in-error",
    !messages.includes(FAKE_RAZORPAY_KEY_SECRET),
    messages
  );
  check(
    "A7-no-stripe-key-in-error",
    !messages.includes(FAKE_STRIPE_SECRET_KEY),
    messages
  );

  restoreEnv(prev);
}

// --------------------------------------------------------------------------- edge cases

{
  // Zero usage still shows plan fee
  const ws = makeWs("Edge Zero Usage");
  setWorkspacePlan(ws.id, "starter");
  const invoice = buildInvoice(ws.id, currentMonthPeriod());
  const hasFee = invoice.lines.some((l) => l.label === "Plan fee" && l.amount === 499900);
  const total = 499900 + Math.floor(499900 * 0.18 + 0.5); // 589882
  check("edge-zero-usage-shows-fee", hasFee);
  check("edge-zero-usage-total", invoice.total === total, `total=${invoice.total}`);
}

{
  // Unknown workspace on buildInvoice
  await assertThrows("edge-unknown-workspace", () => buildInvoice("no-such-workspace", currentMonthPeriod()), "unknown-workspace");
}

{
  // Unknown provider throws before fetch
  const ws = makeWs("Edge Unknown Provider");
  setWorkspacePlan(ws.id, "starter");
  const invoice = buildInvoice(ws.id, currentMonthPeriod());
  await assertThrows("edge-unknown-provider", () => createPaymentLink(invoice, "paypal", { fetchFn: async () => new Response("{}") as any }), "unknown-provider");
}

{
  // Fetch reject and non-2xx return structured error
  const ws = makeWs("Edge Fetch Errors");
  setWorkspacePlan(ws.id, "starter");
  const invoice = buildInvoice(ws.id, currentMonthPeriod());

  const prev = saveEnv();
  process.env.RAZORPAY_KEY_ID = FAKE_RAZORPAY_KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = FAKE_RAZORPAY_KEY_SECRET;

  const rejectResult = await createPaymentLink(invoice, "razorpay", {
    fetchFn: async () => {
      throw new Error("connection refused");
    },
  });
  check("edge-fetch-reject", (rejectResult as any).enabled === true && (rejectResult as any).error?.message?.includes("request failed"));

  const non2xxResult = await createPaymentLink(invoice, "razorpay", {
    fetchFn: async () => new Response("bad", { status: 503 }),
  });
  check("edge-fetch-non2xx", (non2xxResult as any).enabled === true && (non2xxResult as any).error?.status === 503);

  restoreEnv(prev);
}

{
  // Two-dimension overage present in one invoice
  const ws = makeWs("Edge Two Dimension Overage");
  setWorkspacePlan(ws.id, "starter");
  createLeads(ws.id, 105); // 5 lead overage
  recordUsage(ws.id, "dossier", 15); // 5 dossier overage
  const invoice = buildInvoice(ws.id, currentMonthPeriod());
  const leadLine = invoice.lines.find((l) => l.label === "Lead overage");
  const dossierLine = invoice.lines.find((l) => l.label === "Dossier overage");
  check("edge-two-dimension-lead", leadLine !== undefined && leadLine.quantity === 5);
  check("edge-two-dimension-dossier", dossierLine !== undefined && dossierLine.quantity === 5);
}

{
  // Malformed branding falls back to text
  const ws = makeWs("Edge Malformed Branding");
  setWorkspacePlan(ws.id, "starter");
  getDb()
    .prepare("INSERT OR REPLACE INTO branding (workspaceId, json, updatedAt) VALUES (?, ?, ?)")
    .run(ws.id, "not valid json", new Date().toISOString());
  const invoice = buildInvoice(ws.id, currentMonthPeriod());
  let html = "";
  let threw = false;
  try {
    html = renderInvoiceHtml(invoice);
  } catch {
    threw = true;
  }
  check("edge-malformed-branding-no-throw", !threw);
  check("edge-malformed-branding-fallback", html.includes("Leadscout invoice"));
}

// --------------------------------------------------------------------------- summary

closeDb();
try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // ignore cleanup failures
}

const failures = checks.filter((c) => !c.ok);
const overall = failures.length === 0 ? "PASS" : "FAIL";
console.log(`\n${overall}: ${checks.length - failures.length}/${checks.length} checks passed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail ?? ""}`);
  process.exit(1);
}
