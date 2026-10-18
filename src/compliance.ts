// Leadscout compliance layer: opt-out list, suppression checks and outreach checklists.
// Uses the DB from ./store.js so temp-database checks can set LEADSCOUT_DB before import.

// @ts-ignore node:sqlite is a Node 24 built-in; ambient types are not available in this environment.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { getDb } from "./store.js";
import type { OptOut } from "./types-v2.js";

export type ComplianceOptOut = OptOut & { note?: string };

const OPT_OUT_SCHEMA = `
CREATE TABLE IF NOT EXISTS opt_outs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  createdAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_opt_outs_unique ON opt_outs(kind, value, scope);
`;

// Initialise tables on first use of this module. In tests, LEADSCOUT_DB must be set before import.
getDb().exec(OPT_OUT_SCHEMA);

// ---------------------------------------------------------------- normalisers

export function normaliseDomain(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  let host: string;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    host = url.hostname;
  } catch {
    host = raw;
  }
  return host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

export function normaliseEmail(input: string): string {
  return String(input ?? "").trim().toLowerCase();
}

export function normalisePhone(input: string): string {
  let digits = String(input ?? "").replace(/[^0-9]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^[6-9]\d{9}$/.test(digits)) digits = `91${digits}`;
  return digits;
}

export function normaliseBizKey(input: string): string {
  return String(input ?? "").trim();
}

// ---------------------------------------------------------------- helpers

function normaliseForKind(kind: string, value: string): string {
  switch (kind) {
    case "domain":
      return normaliseDomain(value);
    case "email":
      return normaliseEmail(value);
    case "phone":
      return normalisePhone(value);
    case "bizKey":
      return normaliseBizKey(value);
    default:
      return value.trim();
  }
}

function detectKind(value: string): "domain" | "email" | "phone" {
  const v = value.trim();
  if (v.includes("@")) return "email";
  const digits = v.replace(/[^0-9]/g, "").length;
  const letters = v.replace(/[^a-zA-Z]/g, "").length;
  if (letters === 0 || (v.length > 0 && digits / v.length >= 0.7)) return "phone";
  return "domain";
}

function rowToOptOut(row: any): ComplianceOptOut {
  return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    scope: row.scope,
    source: row.source,
    note: row.note ?? undefined,
    createdAt: row.createdAt,
  };
}

function extractEmailDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1) : undefined;
}

// ---------------------------------------------------------------- public API

export function addOptOut(input: {
  kind?: "domain" | "email" | "phone" | "bizKey";
  value: string;
  scope: string;
  source: string;
  note?: string;
}): ComplianceOptOut {
  const rawValue = String(input.value ?? "").trim();
  if (!rawValue) throw new Error("opt-out value is required");

  const kind = input.kind ? input.kind : detectKind(rawValue);
  const normValue = normaliseForKind(kind, rawValue);
  const scope = String(input.scope ?? "").trim();
  const source = String(input.source ?? "").trim();
  const note = input.note === undefined ? undefined : String(input.note).trim();

  if (!scope) throw new Error("opt-out scope is required");
  if (!source) throw new Error("opt-out source is required");

  const database = getDb();
  const existing = database
    .prepare("SELECT * FROM opt_outs WHERE kind = ? AND value = ? AND scope = ?")
    .get(kind, normValue, scope) as any;
  if (existing) return rowToOptOut(existing);

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  database
    .prepare(
      "INSERT INTO opt_outs (id, kind, value, scope, source, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(id, kind, normValue, scope, source, note ?? null, createdAt);

  return { id, kind, value: normValue, scope, source, note, createdAt };
}

export function removeOptOut(id: string): boolean {
  const res = getDb().prepare("DELETE FROM opt_outs WHERE id = ?").run(id);
  return (res.changes ?? 0) > 0;
}

export function listOptOuts(scope?: string): ComplianceOptOut[] {
  const database = getDb();
  if (scope === undefined) {
    const rows = database
      .prepare("SELECT * FROM opt_outs ORDER BY createdAt ASC, rowid ASC")
      .all() as any[];
    return rows.map(rowToOptOut);
  }
  const rows = database
    .prepare("SELECT * FROM opt_outs WHERE scope = ? ORDER BY createdAt ASC, rowid ASC")
    .all(scope) as any[];
  return rows.map(rowToOptOut);
}

export function isSuppressed(
  lead: {
    website?: string;
    emails?: string[];
    phones?: string[];
    email?: string;
    phone?: string;
  },
  ws: string,
  bizKey?: string
): { suppressed: boolean; reason?: string } {
  const database = getDb();

  const checks: { kind: string; values: string[] }[] = [];

  const host = normaliseDomain(lead.website ?? "");
  if (host) checks.push({ kind: "domain", values: [host] });

  const directEmails: string[] = [];
  if (lead.email) directEmails.push(normaliseEmail(lead.email));
  if (lead.emails) {
    for (const e of lead.emails) directEmails.push(normaliseEmail(e));
  }
  const uniqueEmails = [...new Set(directEmails.filter(Boolean))];
  if (uniqueEmails.length) checks.push({ kind: "email", values: uniqueEmails });

  const emailDomains = [
    ...new Set(uniqueEmails.map(extractEmailDomain).filter((d): d is string => Boolean(d))),
  ];
  if (emailDomains.length) checks.push({ kind: "domain", values: emailDomains });

  const directPhones: string[] = [];
  if (lead.phone) directPhones.push(normalisePhone(lead.phone));
  if (lead.phones) {
    for (const p of lead.phones) directPhones.push(normalisePhone(p));
  }
  const uniquePhones = [...new Set(directPhones.filter(Boolean))];
  if (uniquePhones.length) checks.push({ kind: "phone", values: uniquePhones });

  const normBiz = bizKey ? normaliseBizKey(bizKey) : "";
  if (normBiz) checks.push({ kind: "bizKey", values: [normBiz] });

  const stmt = database.prepare(
    "SELECT 1 FROM opt_outs WHERE kind = ? AND value = ? AND scope = ? LIMIT 1"
  );
  const scopes = ["global", ws];

  for (const { kind, values } of checks) {
    for (const scope of scopes) {
      for (const value of values) {
        if (stmt.get(kind, value, scope)) {
          return { suppressed: true, reason: `${kind} (${scope})` };
        }
      }
    }
  }

  return { suppressed: false };
}

// ---------------------------------------------------------------- outreach checklists

const EU_CODES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

const COLLECTION_CHECKLIST = [
  "Public business information only. No login-walled pages, no paid directories, no Google Maps, JustDial or IndiaMART scraping.",
  "robots.txt honoured for every site; descriptive User-Agent Leadscout/0.1 with a contact URL; per-host spacing; Nominatim at most 1 request per second and cached; Overpass used sparingly.",
  'OpenStreetMap data is under the ODbL: show "(c) OpenStreetMap contributors" on pages and in exports. Selling OSM-derived lists may count as a derivative database with share-alike duties: legal review before resale.',
  "Every lead stores its source URL; every claim cites evidence.",
  "Opt-out page and API; a global suppression list applies to every workspace; suppressed businesses are never shown, exported or sent to the model; erasure request removes stored personal fields.",
  "Retention: purge leads never verified or never shortlisted after 12 months.",
];

const RESALE_LINE =
  "Resale: customer terms say the customer is responsible for its own outreach compliance; provide a data processing addendum; per-country checklist shown in the workspace.";

const COUNTRY_CHECKLISTS: Record<string, string[]> = {
  IN: [
    "DPDP Act 2023: an owner's name or personal mobile is personal data. Rely on publicly-available exclusion only where the business itself published it, keep the evidence, collect the minimum, honour erasure, publish a grievance contact, and track DPDP Rules phase-in dates.",
    "Calls and SMS: TRAI's commercial communication rules (TCCCPR 2018) restrict promotional calls and SMS to numbers on the DND registry and penalise unregistered telemarketing; scrub against DND before any bulk calling or SMS; one-to-one B2B calls carry lower but non-zero risk.",
    "WhatsApp: business-initiated messages need the person's opt-in under WhatsApp Business policy; never bulk-message discovered numbers. The pushback line asks permission ('may I send ...?') for this reason.",
    "Email: no dedicated Indian anti-spam statute, but identify the sender, give a working opt-out, and honour it quickly.",
  ],
  US: [
    "US: CAN-SPAM for email (true headers, honest subject, postal address, opt-out honoured within 10 business days); TCPA and state rules for calls and texts to mobiles.",
  ],
  GB: [
    "UK: PECR (B2B email to corporate subscribers allowed with identity and opt-out; sole traders and partnerships need consent) plus UK GDPR legitimate interests assessment and an Article 14 notice.",
  ],
  EU: [
    "EU: GDPR plus national ePrivacy rules, which vary (some countries require consent even for B2B email).",
  ],
  CA: [
    'Canada: CASL (consent; implied consent only for conspicuously published addresses relevant to the role, with no "no unsolicited messages" statement); identification and unsubscribe in every message.',
  ],
  AU: [
    "Australia: Spam Act 2003 (inferred consent for conspicuously published role addresses; identify and unsubscribe); Do Not Call Register for calls.",
  ],
};

export function outreachChecklist(country: string): string[] {
  const code = String(country ?? "").trim().toUpperCase();
  const specific = COUNTRY_CHECKLISTS[code] ?? (EU_CODES.has(code) ? COUNTRY_CHECKLISTS.EU : []);
  return [
    "Not legal advice. Check with counsel before outreach.",
    ...COLLECTION_CHECKLIST,
    ...specific,
    RESALE_LINE,
  ];
}

// ---------------------------------------------------------------- input validation

const MARKUP_RE = /[<>&"'`]/;
const ALLOWED_KINDS = new Set(["email", "phone", "domain", "bizKey"]);

export function validateOptOutInput(
  body: unknown
): { ok: true; value: string; kind?: string; note?: string } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!body || typeof body !== "object") {
    return { ok: false, errors: ["body must be an object"] };
  }
  const b = body as Record<string, unknown>;

  const rawValue = typeof b.value === "string" ? b.value : "";
  const value = rawValue.trim();
  if (!value) {
    errors.push("value is required");
  } else {
    if (value.length < 3) errors.push("value must be at least 3 characters");
    if (value.length > 200) errors.push("value must be at most 200 characters");
    if (MARKUP_RE.test(value)) errors.push("value contains markup characters");
  }

  let kind: string | undefined;
  if (b.kind !== undefined) {
    if (typeof b.kind !== "string" || !ALLOWED_KINDS.has(b.kind)) {
      errors.push("kind must be email, phone, domain or bizKey");
    } else {
      kind = b.kind;
    }
  }

  let note: string | undefined;
  if (b.note !== undefined) {
    if (typeof b.note !== "string") {
      errors.push("note must be a string");
    } else {
      const n = b.note.trim();
      if (n.length > 300) errors.push("note must be at most 300 characters");
      if (MARKUP_RE.test(n)) errors.push("note contains markup characters");
      if (n) note = n;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const sanitisedValue = kind ? normaliseForKind(kind, value) : value;
  return { ok: true, value: sanitisedValue, kind, note };
}
