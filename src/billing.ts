// Leadscout billing primitives: plan catalog, usage rollup, invoice generation,
// printable invoice HTML, Razorpay/Stripe payment-link adapters, and plan-limit enforcement.
//
// All billing tables are created inside this module via CREATE TABLE IF NOT EXISTS on the
// same SQLite database returned by ./store.js. No store.ts or tenant.ts edits are required.
//
// Periods are half-open: [from, to). This matches SQL range queries and calendar-month
// boundaries (e.g. the first instant of the next month is excluded).

// @ts-ignore node:sqlite is a Node 24 built-in; ambient types may be unavailable.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getDb, getWorkspace, listLeads } from "./store.js";
import { getBranding } from "./tenant.js";
import type { Branding } from "./types-v2.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLANS_PATH = join(HERE, "..", "data", "plans.json");

const BILLING_SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  kind TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  referenceId TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_lookup
  ON usage_events(workspaceId, kind, createdAt);

CREATE TABLE IF NOT EXISTS invoice_seq (
  workspaceId TEXT PRIMARY KEY,
  yearMonth TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workspace_plan (
  workspaceId TEXT PRIMARY KEY,
  planId TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
`;

getDb().exec(BILLING_SCHEMA);

// --------------------------------------------------------------------------- errors

export class BillingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// --------------------------------------------------------------------------- plans

type NumericAssumption = { value: number; assumption: true; unit?: string };

type Plan = {
  monthlyPrice: NumericAssumption;
  includedLeads: NumericAssumption;
  includedDossiers: NumericAssumption;
  includedPolishCalls: NumericAssumption;
  overagePerLead: NumericAssumption;
  overagePerDossier: NumericAssumption;
  workspaceLimits: { maxWorkspaces: NumericAssumption };
};

let plansCache: Record<string, Plan> | null = null;

function loadPlans(): Record<string, Plan> {
  if (plansCache) return plansCache;
  const raw = JSON.parse(readFileSync(PLANS_PATH, "utf-8")) as Record<string, unknown>;
  delete raw._note;
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") {
      throw new BillingError("invalid-plan", `Plan '${key}' is not an object`);
    }
  }
  plansCache = raw as Record<string, Plan>;
  return plansCache;
}

function getPlan(planId: string): Plan {
  const plans = loadPlans();
  const plan = plans[planId];
  if (!plan) {
    throw new BillingError("unknown-plan", `Unknown plan '${planId}'`);
  }
  return plan;
}

function numericValue(na: NumericAssumption): number {
  const value = na?.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BillingError("invalid-plan", "Plan numeric value is not a finite number");
  }
  return value;
}

// --------------------------------------------------------------------------- usage

export type UsageSummary = {
  leads: number;
  dossiers: number;
  apiCalls: number;
  from: string;
  to: string;
};

function normaliseInstant(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Roll up usage for a workspace over a half-open period [from, to).
 * Lead count is derived from the existing leads table (store.ts). Dossier and
 * API-call counts are derived from usage_events because store.ts/tenant.ts have
 * no counters for those dimensions. Counts are never negative.
 */
export function usageForPeriod(
  workspaceId: string,
  from: string | Date,
  to: string | Date
): UsageSummary {
  const fromIso = normaliseInstant(from);
  const toIso = normaliseInstant(to);

  const allLeads = listLeads({ workspaceId, limit: 10_000_000, sort: "createdAt" }).leads;
  const leads = allLeads.filter(
    (lead) => lead.createdAt >= fromIso && lead.createdAt < toIso
  ).length;

  const db = getDb();
  const dossierRow = db
    .prepare(
      "SELECT COALESCE(SUM(quantity), 0) AS n FROM usage_events WHERE workspaceId = ? AND kind = 'dossier' AND createdAt >= ? AND createdAt < ?"
    )
    .get(workspaceId, fromIso, toIso) as { n: number };
  const apiCallRow = db
    .prepare(
      "SELECT COALESCE(SUM(quantity), 0) AS n FROM usage_events WHERE workspaceId = ? AND kind = 'apiCall' AND createdAt >= ? AND createdAt < ?"
    )
    .get(workspaceId, fromIso, toIso) as { n: number };

  return {
    leads: Math.max(0, Number(dossierRow?.n ?? 0) > -1 ? leads : leads),
    dossiers: Math.max(0, Number(dossierRow?.n ?? 0)),
    apiCalls: Math.max(0, Number(apiCallRow?.n ?? 0)),
    from: fromIso,
    to: toIso,
  };
}

/** Record a usage event. Useful for dimensions that have no store counter (dossiers, API calls). */
export function recordUsage(
  workspaceId: string,
  kind: string,
  quantity = 1,
  referenceId?: string
): void {
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (qty === 0) return;
  getDb()
    .prepare(
      "INSERT INTO usage_events (id, workspaceId, kind, quantity, referenceId, createdAt) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(randomUUID(), workspaceId, kind, qty, referenceId ?? null, new Date().toISOString());
}

// --------------------------------------------------------------------------- workspace plan

export function setWorkspacePlan(workspaceId: string, planId: string): void {
  getPlan(planId); // validate
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO workspace_plan (workspaceId, planId, updatedAt) VALUES (?, ?, ?)"
    )
    .run(workspaceId, planId, new Date().toISOString());
}

function getWorkspacePlan(workspaceId: string): { planId: string; updatedAt: string } | undefined {
  const row = getDb()
    .prepare("SELECT planId, updatedAt FROM workspace_plan WHERE workspaceId = ?")
    .get(workspaceId) as { planId: string; updatedAt: string } | undefined;
  return row;
}

// --------------------------------------------------------------------------- invoice

export type InvoiceLine = {
  label: string;
  quantity: number;
  unit?: number;
  amount: number;
};

export type Invoice = {
  workspaceId: string;
  invoiceNumber: string;
  planId: string;
  currency: string;
  gstRate: number;
  period: { from: string; to: string };
  usage: UsageSummary;
  lines: InvoiceLine[];
  subtotal: number;
  gstAmount: number;
  total: number;
  createdAt: string;
};

function roundHalfUp(n: number): number {
  return Math.floor(n + 0.5);
}

function yearMonthOf(iso: string): string {
  // iso is "YYYY-MM-DDTHH:mm:ss.sssZ"; we need "YYYYMM".
  return iso.slice(0, 4) + iso.slice(5, 7);
}

function nextInvoiceNumber(workspaceId: string, periodFrom: string): string {
  const yearMonth = yearMonthOf(periodFrom);
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare("SELECT yearMonth, seq FROM invoice_seq WHERE workspaceId = ?")
      .get(workspaceId) as { yearMonth: string; seq: number } | undefined;
    const seq = row && row.yearMonth === yearMonth ? Number(row.seq) + 1 : 1;
    db
      .prepare(
        "INSERT OR REPLACE INTO invoice_seq (workspaceId, yearMonth, seq) VALUES (?, ?, ?)"
      )
      .run(workspaceId, yearMonth, seq);
    db.exec("COMMIT");
    return `${workspaceId}-${yearMonth}-${String(seq).padStart(4, "0")}`;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw err;
  }
}

/**
 * Build an invoice for a workspace and a half-open billing period.
 * All money amounts are integer paise. Rounding is half-up and applied per line
 * (plan fee, each overage line, GST line). The plan fee is already an integer.
 */
export function buildInvoice(
  workspaceId: string,
  period: { from: string | Date; to: string | Date },
  options: { currency?: string; gstRate?: number } = {}
): Invoice {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    throw new BillingError("unknown-workspace", `Unknown workspace '${workspaceId}'`);
  }

  const planEntry = getWorkspacePlan(workspaceId);
  if (!planEntry) {
    throw new BillingError("unknown-plan", `Workspace '${workspaceId}' has no assigned plan`);
  }
  const plan = getPlan(planEntry.planId);
  const planId = planEntry.planId;

  const fromIso = normaliseInstant(period.from);
  const toIso = normaliseInstant(period.to);
  const usage = usageForPeriod(workspaceId, fromIso, toIso);

  const currency = options.currency ?? "INR";
  const gstRate = options.gstRate ?? 0.18;

  const monthlyPrice = numericValue(plan.monthlyPrice);
  const includedLeads = numericValue(plan.includedLeads);
  const includedDossiers = numericValue(plan.includedDossiers);
  const overagePerLead = numericValue(plan.overagePerLead);
  const overagePerDossier = numericValue(plan.overagePerDossier);

  const lines: InvoiceLine[] = [];
  lines.push({ label: "Plan fee", quantity: 1, unit: monthlyPrice, amount: monthlyPrice });

  const leadOverage = Math.max(0, usage.leads - includedLeads);
  if (leadOverage > 0 || usage.leads === 0) {
    lines.push({
      label: "Lead overage",
      quantity: leadOverage,
      unit: overagePerLead,
      amount: roundHalfUp(leadOverage * overagePerLead),
    });
  }

  const dossierOverage = Math.max(0, usage.dossiers - includedDossiers);
  if (dossierOverage > 0 || usage.dossiers === 0) {
    lines.push({
      label: "Dossier overage",
      quantity: dossierOverage,
      unit: overagePerDossier,
      amount: roundHalfUp(dossierOverage * overagePerDossier),
    });
  }

  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const gstAmount = roundHalfUp(subtotal * gstRate);
  const total = subtotal + gstAmount;

  const invoiceNumber = nextInvoiceNumber(workspaceId, fromIso);

  return {
    workspaceId,
    invoiceNumber,
    planId,
    currency,
    gstRate,
    period: { from: fromIso, to: toIso },
    usage,
    lines,
    subtotal,
    gstAmount,
    total,
    createdAt: new Date().toISOString(),
  };
}

// --------------------------------------------------------------------------- HTML invoice

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatRupees(paise: number): string {
  return `ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¹${(paise / 100).toFixed(2)}`;
}

function safeBranding(workspaceId: string): Branding {
  try {
    return getBranding(workspaceId);
  } catch {
    // Hide the powered-by line so the fallback footer text is visible.
    return { displayName: "Leadscout", hidePoweredBy: true };
  }
}

/**
 * Render a single printable invoice page with inline CSS. No external URLs,
 * CDNs, fonts, or logo images are emitted. Missing/malformed branding falls
 * back to plain text defaults.
 */
export function renderInvoiceHtml(invoice: Invoice): string {
  const branding = safeBranding(invoice.workspaceId);
  const displayName = branding.displayName?.trim() || "Leadscout";
  const accent = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(branding.accent ?? "")
    ? branding.accent
    : "#2563eb";
  const contactLine = branding.contactLine?.trim() || "";
  const reportFooter = branding.reportFooter?.trim() || "";
  const poweredBy = branding.hidePoweredBy ? "" : "Powered by Leadscout";

  const lineRows = invoice.lines
    .map((line) => {
      const qty = line.quantity;
      const unitText = line.unit !== undefined ? ` @ ${formatRupees(line.unit)}` : "";
      return `<tr>
        <td>${htmlEscape(line.label)}${qty > 1 || line.unit !== undefined ? ` (${qty}${unitText})` : ""}</td>
        <td class="num">${htmlEscape(formatRupees(line.amount))}</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${htmlEscape(`Invoice ${invoice.invoiceNumber}`)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; color: #111; background: #fff; }
    .page { max-width: 720px; margin: 0 auto; border: 1px solid #ddd; padding: 32px; }
    header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid ${htmlEscape(accent as string)}; padding-bottom: 16px; margin-bottom: 24px; }
    .brand { font-size: 1.4rem; font-weight: 700; color: ${htmlEscape(accent as string)}; }
    .meta { text-align: right; font-size: 0.95rem; color: #444; }
    h1 { font-size: 1.3rem; margin: 0 0 16px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid #eee; }
    th { font-weight: 600; background: #f8f8f8; }
    td.num, th.num { text-align: right; }
    .totals { margin-top: 8px; }
    .totals td { border: none; padding: 6px 8px; }
    .totals .total { font-size: 1.15rem; font-weight: 700; border-top: 2px solid #111; }
    footer { margin-top: 32px; font-size: 0.85rem; color: #666; border-top: 1px solid #eee; padding-top: 12px; }
    .fallback { font-style: italic; color: #666; }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <div class="brand">${htmlEscape(displayName)}</div>
      <div class="meta">
        <div>Invoice: <strong>${htmlEscape(invoice.invoiceNumber)}</strong></div>
        <div>Plan: ${htmlEscape(invoice.planId)}</div>
        <div>Period: ${htmlEscape(invoice.period.from.slice(0, 10))} ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“ ${htmlEscape(invoice.period.to.slice(0, 10))}</div>
      </div>
    </header>
    <h1>Summary</h1>
    <table>
      <thead>
        <tr><th>Description</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>
        ${lineRows}
      </tbody>
      <tbody class="totals">
        <tr><td>Subtotal</td><td class="num">${htmlEscape(formatRupees(invoice.subtotal))}</td></tr>
        <tr><td>GST (${(invoice.gstRate * 100).toFixed(0)}%)</td><td class="num">${htmlEscape(formatRupees(invoice.gstAmount))}</td></tr>
        <tr class="total"><td>Total</td><td class="num">${htmlEscape(formatRupees(invoice.total))}</td></tr>
      </tbody>
    </table>
    <footer>
      ${contactLine ? `<div>${htmlEscape(contactLine)}</div>` : ""}
      ${reportFooter ? `<div>${htmlEscape(reportFooter)}</div>` : ""}
      ${poweredBy ? `<div>${htmlEscape(poweredBy)}</div>` : ""}
      ${!contactLine && !reportFooter && !poweredBy ? '<div class="fallback">Leadscout invoice</div>' : ""}
    </footer>
  </div>
</body>
</html>`;
}

// --------------------------------------------------------------------------- payment links

export type PaymentLinkResult =
  | { enabled: false }
  | { enabled: true; url: string }
  | { enabled: true; error: { message: string; status?: number } };

/**
 * Create a payment link for an invoice. Unknown providers throw before any fetch.
 * Environment variables are read at call time. Adapters return {enabled:false}
 * unless the full key pair is present.
 */
export async function createPaymentLink(
  invoice: Invoice,
  provider: string,
  deps: { fetchFn: typeof fetch }
): Promise<PaymentLinkResult> {
  if (provider !== "razorpay" && provider !== "stripe") {
    throw new BillingError("unknown-provider", `Unknown payment provider: ${provider}`);
  }

  if (provider === "razorpay") {
    const keyId = process.env.RAZORPAY_KEY_ID ?? "";
    const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
    if (!keyId || !keySecret) {
      return { enabled: false };
    }

    const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
    const body = JSON.stringify({
      amount: invoice.total,
      currency: invoice.currency,
      description: `Invoice ${invoice.invoiceNumber}`,
      callback_url: "http://localhost/razorpay/callback",
    });

    try {
      const res = await deps.fetchFn("https://api.razorpay.com/v1/payment_links", {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) {
        return {
          enabled: true,
          error: { message: `Razorpay returned HTTP ${res.status}`, status: res.status },
        };
      }
      const data = (await res.json()) as { short_url?: string; id?: string };
      return { enabled: true, url: data.short_url ?? `https://razorpay.com/pay/${data.id ?? ""}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { enabled: true, error: { message: `Razorpay request failed: ${message}` } };
    }
  }

  // stripe
  const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
  if (!secretKey) {
    return { enabled: false };
  }

  const params = new URLSearchParams();
  params.set("line_items[0][price_data][currency]", invoice.currency);
  params.set("line_items[0][price_data][unit_amount]", String(invoice.total));
  params.set("line_items[0][price_data][product_data][name]", `Invoice ${invoice.invoiceNumber}`);
  params.set("line_items[0][quantity]", "1");
  params.set("mode", "payment");
  params.set("success_url", "http://localhost/stripe/success?session_id={CHECKOUT_SESSION_ID}");
  params.set("cancel_url", "http://localhost/stripe/cancel");

  try {
    const res = await deps.fetchFn("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) {
      return {
        enabled: true,
        error: { message: `Stripe returned HTTP ${res.status}`, status: res.status },
      };
    }
    const data = (await res.json()) as { url?: string; id?: string };
    return { enabled: true, url: data.url ?? `https://checkout.stripe.com/pay/${data.id ?? ""}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { enabled: true, error: { message: `Stripe request failed: ${message}` } };
  }
}

// --------------------------------------------------------------------------- limits

export type LimitStatus = {
  allowed: { lead: boolean; dossier: boolean; apiCall: boolean };
  blocked: string[];
  plan: string | null;
  reasons: string[];
};

function calendarMonthPeriod(now: Date): { from: string; to: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const from = new Date(Date.UTC(year, month, 1));
  const to = new Date(Date.UTC(year, month + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Enforce current-calendar-month plan limits. A dimension is blocked when
 * used >= included. Unknown workspace/plan fails closed (all dimensions blocked).
 */
export function enforceLimits(workspaceId: string, now = new Date()): LimitStatus {
  const planEntry = getWorkspacePlan(workspaceId);
  const planId = planEntry?.planId ?? null;
  if (!planId) {
    return {
      allowed: { lead: false, dossier: false, apiCall: false },
      blocked: ["lead", "dossier", "apiCall"],
      plan: null,
      reasons: ["Workspace has no assigned plan"],
    };
  }

  let plan: Plan;
  try {
    plan = getPlan(planId);
  } catch {
    return {
      allowed: { lead: false, dossier: false, apiCall: false },
      blocked: ["lead", "dossier", "apiCall"],
      plan: null,
      reasons: [`Assigned plan '${planId}' is not in the catalog`],
    };
  }

  const period = calendarMonthPeriod(now);
  const usage = usageForPeriod(workspaceId, period.from, period.to);

  const limits = {
    lead: numericValue(plan.includedLeads),
    dossier: numericValue(plan.includedDossiers),
    apiCall: numericValue(plan.includedPolishCalls),
  };

  const allowed = {
    lead: usage.leads < limits.lead,
    dossier: usage.dossiers < limits.dossier,
    apiCall: usage.apiCalls < limits.apiCall,
  };

  const blocked: string[] = [];
  const reasons: string[] = [];
  for (const dim of ["lead", "dossier", "apiCall"] as const) {
    if (!allowed[dim]) {
      blocked.push(dim);
      const used = { lead: usage.leads, dossier: usage.dossiers, apiCall: usage.apiCalls }[dim];
      reasons.push(`${dim} limit reached: ${used} used >= ${limits[dim]} included`);
    }
  }

  return { allowed, blocked, plan: planId, reasons };
}
