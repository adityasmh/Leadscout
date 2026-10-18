// src/verify.ts
// L10-verify-score: contact verification before a lead is shown.
//
// Rules from docs/leadgen/PLAN_V2.md sections 2.1 and 3.2.
// No model calls. Network access only through injected deps.

import { resolveMx as dnsResolveMx } from "node:dns/promises";
// @ts-ignore node:sqlite is a Node 24 built-in; ambient types may be absent.
import { DatabaseSync } from "node:sqlite";
import { getDb } from "./store.js";
import type { RawLead, Enrichment } from "./types.js";
import type { Verification } from "./types-v2.js";

export type VerifyDeps = {
  fetchFn?: typeof fetch;
  resolveMx?: (domain: string) => Promise<{ exchange: string }[]>;
  now?: () => Date;
};

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "tempmail.com",
  "10minutemail.com",
  "guerrillamail.com",
  "throwaway.com",
  "yopmail.com",
  "getairmail.com",
  "fakeinbox.com",
  "sharklasers.com",
  "getnada.com",
]);

const DUMMY_LOCAL_PARTS = new Set(["test", "noreply", "no-reply", "admin", "info", "postmaster", "hostmaster", "abuse", "webmaster"]);
const DUMMY_DOMAINS = new Set(["example.com", "example.org", "example.net", "test.com", "test.org", "test.net", "localhost"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico"]);

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}

export function isDummyEmail(email: string): { dummy: boolean; reason?: string } {
  const lower = email.toLowerCase().trim();
  const at = lower.lastIndexOf("@");
  if (at <= 0) return { dummy: false };
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);

  if (DUMMY_DOMAINS.has(domain)) {
    return { dummy: true, reason: `domain ${domain} is an example/test domain` };
  }
  if (DUMMY_LOCAL_PARTS.has(local)) {
    return { dummy: true, reason: `local part ${local} is a role/test address` };
  }
  if (local.startsWith("test") || local.includes("+test")) {
    return { dummy: true, reason: `local part ${local} looks like a test address` };
  }
  for (const ext of IMAGE_EXTENSIONS) {
    if (domain.endsWith(ext) || local.endsWith(ext)) {
      return { dummy: true, reason: `email contains image file extension ${ext}` };
    }
  }
  return { dummy: false };
}

export function isValidEmailSyntax(email: string): boolean {
  // Minimal practical check: one @, no whitespace, domain has a dot, local part not empty.
  const trimmed = email.trim();
  if (!trimmed) return false;
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return false;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!local || !domain) return false;
  if (/\s/.test(trimmed)) return false;
  if (!domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  return true;
}

async function checkEmail(
  email: string,
  resolveMx: (domain: string) => Promise<{ exchange: string }[]>
): Promise<Verification["emails"][number]> {
  if (!isValidEmailSyntax(email)) {
    return { value: email, result: "bad-syntax" };
  }
  const dummy = isDummyEmail(email);
  if (dummy.dummy) {
    return { value: email, result: "dummy" };
  }
  const domain = email.toLowerCase().trim().slice(email.lastIndexOf("@") + 1);
  if (isDisposableDomain(domain)) {
    return { value: email, result: "disposable" };
  }
  try {
    const records = await resolveMx(domain);
    if (!records || records.length === 0) {
      return { value: email, result: "no-mx" };
    }
  } catch {
    return { value: email, result: "no-mx" };
  }
  return { value: email, result: "ok" };
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function hasLeadingPlus(value: string): boolean {
  return value.trim().startsWith("+");
}

function isTollFreeNational(national: string): boolean {
  return national.startsWith("1800") || national.startsWith("1860") || national.startsWith("1900");
}

function stripIndianTrunk(digits: string): string {
  if (digits.startsWith("91") && digits.length > 10) return digits.slice(2);
  if (digits.startsWith("0") && digits.length > 10) return digits.slice(1);
  return digits;
}

export function classifyPhone(value: string): { e164?: string; result: "mobile" | "landline" | "invalid"; reason?: string } {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return { result: "invalid", reason: "empty phone" };
  const digits = digitsOnly(trimmed);
  if (!digits) return { result: "invalid", reason: `unrecognised phone format ${value}` };
  const leadingPlus = hasLeadingPlus(trimmed);
  const indiaPlus = leadingPlus && trimmed.startsWith("+91");
  const indianContext = indiaPlus || !leadingPlus;

  // Toll-free and service numbers are not useful for a sales call.
  if (indianContext && isTollFreeNational(stripIndianTrunk(digits))) {
    return { result: "invalid", reason: "toll-free or service number" };
  }

  // Build the 10-digit Indian national number when the input carries an
  // Indian trunk (+91, 91, a single leading 0) or is a bare 10-digit string.
  let national: string | undefined;
  let hasIndianTrunk = false;
  if (indiaPlus) {
    national = digits.slice(2);
    hasIndianTrunk = true;
  } else if (!leadingPlus && digits.startsWith("91") && digits.length === 12) {
    national = digits.slice(2);
    hasIndianTrunk = true;
  } else if (!leadingPlus && digits.startsWith("0") && digits.length === 11) {
    national = digits.slice(1);
    hasIndianTrunk = true;
  } else if (digits.length === 10 && !leadingPlus) {
    national = digits;
    hasIndianTrunk = false;
  }

  if (national !== undefined) {
    if (national.length === 10 && /^[6-9]\d{9}$/.test(national)) {
      return { e164: `+91${national}`, result: "mobile", reason: `Indian mobile ${value}` };
    }
    if (hasIndianTrunk && national.length >= 8 && national.length <= 11) {
      // A 10-digit non-mobile after an Indian trunk is an STD landline;
      // other 8-11 digit +91 forms stay landline as before.
      return { e164: `+91${national}`, result: "landline", reason: `Indian landline ${value}` };
    }
  }

  // Generic E.164: leading + and 7-15 digits.
  if (leadingPlus && digits.length >= 7 && digits.length <= 15) {
    return { e164: `+${digits}`, result: "landline", reason: `E.164 valid ${value}` };
  }

  return { result: "invalid", reason: `unrecognised phone format ${value}` };
}

function allEmails(raw: RawLead, e: Enrichment): string[] {
  const list: string[] = [];
  if (raw.email) list.push(raw.email);
  for (const email of e.emails ?? []) {
    if (email) list.push(email);
  }
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

function allPhones(raw: RawLead, e: Enrichment): string[] {
  const list: string[] = [];
  if (raw.phone) list.push(raw.phone);
  for (const phone of e.phones ?? []) {
    if (phone) list.push(phone);
  }
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

function websiteUrl(raw: RawLead, e: Enrichment): string | undefined {
  return raw.website?.trim() || e.fetchedUrl?.trim() || undefined;
}

async function fetchAlive(
  url: string,
  fetchFn: typeof fetch,
  now: () => Date
): Promise<{ status: "alive" | "dead"; finalUrl?: string; httpStatus?: number; error?: string }> {
  let current = url;
  let redirects = 0;
  const maxRedirects = 3;
  const timeoutMs = 8000;

  while (redirects <= maxRedirects) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(current, {
        method: "GET",
        signal: controller.signal,
        redirect: "manual",
      });
      clearTimeout(timer);
      if (res.status < 400) {
        return { status: "alive", finalUrl: current, httpStatus: res.status };
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) {
          return { status: "dead", finalUrl: current, httpStatus: res.status, error: `redirect without Location` };
        }
        redirects++;
        if (redirects > maxRedirects) {
          return { status: "dead", finalUrl: current, httpStatus: res.status, error: `too many redirects` };
        }
        current = new URL(loc, current).href;
        continue;
      }
      return { status: "dead", finalUrl: current, httpStatus: res.status, error: `HTTP ${res.status}` };
    } catch (err) {
      clearTimeout(timer);
      return { status: "dead", finalUrl: current, error: (err as Error).message };
    }
  }
  return { status: "dead", finalUrl: current, error: `redirect limit exceeded` };
}

/**
 * Verify the contact routes for a lead.
 * `bizKey` is passed in as a parameter; this module does not compute it.
 */
export async function verify(raw: RawLead, e: Enrichment, deps: VerifyDeps = {}): Promise<Verification> {
  const fetchFn = deps.fetchFn ?? fetch;
  const resolveMx = deps.resolveMx ?? dnsResolveMx;
  const nowFn = deps.now ?? (() => new Date());
  const checkedAt = nowFn().toISOString();

  const reasons: string[] = [];
  const signals = new Set((e.signals ?? []).filter((s): s is string => typeof s === "string"));

  // Website
  let website: Verification["website"] = "not-checked";
  let finalUrl: string | undefined;
  let httpStatus: number | undefined;
  const url = websiteUrl(raw, e);
  if (signals.has("site-unreachable")) {
    website = "dead";
    reasons.push("website: site-unreachable signal present");
  } else if (!url) {
    website = "none";
    reasons.push("website: no website listed");
  } else {
    const result = await fetchAlive(url, fetchFn, nowFn);
    website = result.status;
    finalUrl = result.finalUrl;
    httpStatus = result.httpStatus;
    reasons.push(`website: ${result.status}${result.httpStatus ? ` HTTP ${result.httpStatus}` : ""} for ${url}`);
  }

  // Emails
  const emailValues = allEmails(raw, e);
  const emails: Verification["emails"] = [];
  for (const email of emailValues) {
    const checked = await checkEmail(email, resolveMx);
    emails.push(checked);
    reasons.push(`email ${email}: ${checked.result}`);
  }

  // Phones
  const phoneValues = allPhones(raw, e);
  const phones: Verification["phones"] = [];
  for (const phone of phoneValues) {
    const classified = classifyPhone(phone);
    phones.push({ value: phone, e164: classified.e164, result: classified.result });
    reasons.push(`phone ${phone}: ${classified.result}${classified.e164 ? ` -> ${classified.e164}` : ""}`);
  }

  // WhatsApp
  const whatsapp = Boolean(e.socials?.whatsapp);
  reasons.push(`whatsapp: ${whatsapp}`);

  // Contactable: at least one valid route: ok email, valid phone, or WhatsApp link.
  const hasOkEmail = emails.some((x) => x.result === "ok");
  const hasValidPhone = phones.some((x) => x.result === "mobile" || x.result === "landline");
  const contactable = hasOkEmail || hasValidPhone || whatsapp;
  reasons.push(`contactable: ${contactable}`);

  const v: Verification = {
    bizKey: "", // filled by caller / persistence
    checkedAt,
    website,
    finalUrl,
    httpStatus,
    emails,
    phones,
    whatsapp,
    contactable,
    reasons,
  };
  return v;
}

// ------------------------------------------------------------------ persistence

function ensureVerificationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verifications (
      bizKey TEXT PRIMARY KEY,
      checkedAt TEXT NOT NULL,
      website TEXT NOT NULL,
      finalUrl TEXT,
      httpStatus INTEGER,
      emails TEXT NOT NULL DEFAULT '[]',
      phones TEXT NOT NULL DEFAULT '[]',
      whatsapp INTEGER NOT NULL DEFAULT 0,
      contactable INTEGER NOT NULL DEFAULT 0,
      reasons TEXT NOT NULL DEFAULT '[]'
    );
  `);
}

export function saveVerification(bizKey: string, v: Verification): Verification {
  const db = getDb();
  ensureVerificationTable(db);
  db.prepare(
    `INSERT OR REPLACE INTO verifications
      (bizKey, checkedAt, website, finalUrl, httpStatus, emails, phones, whatsapp, contactable, reasons)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    bizKey,
    v.checkedAt,
    v.website,
    v.finalUrl ?? null,
    v.httpStatus ?? null,
    JSON.stringify(v.emails),
    JSON.stringify(v.phones),
    v.whatsapp ? 1 : 0,
    v.contactable ? 1 : 0,
    JSON.stringify(v.reasons)
  );
  return { ...v, bizKey };
}

export function loadVerification(bizKey: string): Verification | undefined {
  const db = getDb();
  ensureVerificationTable(db);
  const row = db.prepare("SELECT * FROM verifications WHERE bizKey = ?").get(bizKey) as any;
  if (!row) return undefined;
  return {
    bizKey: row.bizKey,
    checkedAt: row.checkedAt,
    website: row.website,
    finalUrl: row.finalUrl ?? undefined,
    httpStatus: row.httpStatus ?? undefined,
    emails: JSON.parse(row.emails ?? "[]"),
    phones: JSON.parse(row.phones ?? "[]"),
    whatsapp: Boolean(row.whatsapp),
    contactable: Boolean(row.contactable),
    reasons: JSON.parse(row.reasons ?? "[]"),
  };
}
