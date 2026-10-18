// src/reach-dossier-check.ts
// ORDER RS2-reach-in-dossier: the dossier breakdown must ignore emails whose
// domain cannot receive mail (all verification emails no-mx/invalid).
//
// Offline, temp database via env LEADSCOUT_DB, no network, no live database.
// Every business, email and number below is clearly fake (.example domains).
//
// Run: npx tsx src/reach-dossier-check.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lead } from "./types.js";
import type { LeadScore, Verification } from "./types-v2.js";

const ROOT = mkdtempSync(join(tmpdir(), "leadscout-reach-dossier-"));
process.env.LEADSCOUT_DB = join(ROOT, "reach-dossier.db");
process.env.COMPANY_ROOT = join(ROOT, "company");

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  :: ${detail}` : ""}`);
  }
}

function hasReason(reasons: string[], text: string): boolean {
  return reasons.some((r) => r.includes(text));
}

const OLD_EMAIL_REASON = "has an email address";
const NEW_EMAIL_REASON = "email domain cannot receive mail [email]";

function makeLead(over: Partial<Lead> = {}): Lead {
  return {
    workspaceId: "ws-reach-dossier",
    id: "lead-reach-dossier-1",
    name: "Fake Reach Dossier Co",
    category: "dentist",
    city: "Fake City",
    country: "IN",
    phone: "+919000000021",
    email: "hello@no-mx-fixture.example",
    website: "https://reachable-fixture.example",
    source: "osm",
    sourceUrl: "https://osm.example.invalid/reach-dossier-1",
    summary: "Fake dental clinic in Fake City used only for the reach dossier check.",
    emails: ["hello@no-mx-fixture.example"],
    phones: ["+919000000021"],
    socials: {},
    signals: ["has-email", "has-phone"],
    score: 0,
    fit: [{ service: "website", score: 80, reason: "Fake fixture fit." }],
    angle: "Fake outreach angle.",
    status: "new",
    notes: "",
    createdAt: "2026-02-01T00:00:00.000Z",
    ...over,
  };
}

function makeVerification(emails: Verification["emails"]): Verification {
  return {
    bizKey: "reachable-fixture.example",
    checkedAt: "2026-02-01T00:00:00.000Z",
    website: "alive",
    emails,
    phones: [{ value: "+919000000021", e164: "+919000000021", result: "mobile" }],
    whatsapp: false,
    contactable: true,
    reasons: [],
  };
}

function weightedTotal(fit: number, reach: number, timing: number): number {
  return Math.max(0, Math.min(100, Math.round(0.5 * fit + 0.3 * reach + 0.2 * timing)));
}

const { breakdownFromLead, resolveScore } = await import("./score.js");
const { bizKey } = await import("./evidence.js");
const { saveVerification } = await import("./verify.js");
const { closeDb } = await import("./store.js");

const lead = makeLead();

// ------------------------------------------------------------------ (a) all no-mx
const plain = breakdownFromLead(lead);
console.log(`INFO  plain breakdown: reach=${plain.reach} fit=${plain.fit} timing=${plain.timing} reasons=${JSON.stringify(plain.reasons)}`);
const allNoMx = breakdownFromLead(
  lead,
  makeVerification([{ value: "hello@no-mx-fixture.example", result: "no-mx" }]),
);
console.log(`INFO  all-no-mx breakdown: reach=${allNoMx.reach} reasons=${JSON.stringify(allNoMx.reasons)}`);
check(
  "a: all no-mx verification gives lower reach than without verification",
  allNoMx.reach < plain.reach,
  `no-mx reach=${allNoMx.reach} plain reach=${plain.reach}`,
);
check(
  "a: reason says the email domain cannot receive mail",
  hasReason(allNoMx.reasons, NEW_EMAIL_REASON),
  JSON.stringify(allNoMx.reasons),
);
check(
  "a: reason does not claim the lead has an email address",
  !hasReason(allNoMx.reasons, OLD_EMAIL_REASON),
  JSON.stringify(allNoMx.reasons),
);

// ------------------------------------------------------------------ (b) one ok keeps points
const oneOk = breakdownFromLead(
  lead,
  makeVerification([
    { value: "hello@no-mx-fixture.example", result: "no-mx" },
    { value: "sales@verified-fixture.example", result: "ok" },
  ]),
);
check(
  "b: one ok email keeps the email points",
  oneOk.reach === plain.reach,
  `one-ok reach=${oneOk.reach} plain reach=${plain.reach}`,
);

// ------------------------------------------------------------------ (c) empty / undefined unchanged
const emptyVer = breakdownFromLead(lead, makeVerification([]));
const undefVer = breakdownFromLead(lead, undefined);
console.log(`INFO  empty-verification breakdown: reach=${emptyVer.reach} undef-verification reach=${undefVer.reach}`);
check(
  "c: empty verification is unchanged from today",
  emptyVer.reach === plain.reach,
  `empty reach=${emptyVer.reach} plain reach=${plain.reach}`,
);
check(
  "c: undefined verification is unchanged from today",
  undefVer.reach === plain.reach,
  `undef reach=${undefVer.reach} plain reach=${plain.reach}`,
);

// ------------------------------------------------------------------ (d) resolveScore with stored all-no-mx
const key = bizKey(lead);
saveVerification(
  key,
  makeVerification([{ value: "hello@no-mx-fixture.example", result: "no-mx" }]),
);
const storedTotal = weightedTotal(allNoMx.fit, allNoMx.reach, allNoMx.timing);
const stored: LeadScore = {
  total: storedTotal,
  fit: 0,
  reach: 0,
  timing: 0,
  gate: "template",
  reasons: [],
};
const resolved = resolveScore(lead, stored);
console.log(`INFO  resolveScore stored-total=${storedTotal} resolved=${JSON.stringify(resolved)}`);
check(
  "d: resolveScore with stored all-no-mx verification returns the reduced reach",
  resolved.reach === allNoMx.reach && resolved.reach < plain.reach,
  `resolved reach=${resolved.reach} reduced reach=${allNoMx.reach} plain reach=${plain.reach}`,
);
check(
  "d: resolveScore keeps the same stored total",
  resolved.total === storedTotal,
  `resolved total=${resolved.total} stored total=${storedTotal}`,
);
check(
  "d: resolveScore reasons carry the new email reason",
  hasReason(resolved.reasons, NEW_EMAIL_REASON) && !hasReason(resolved.reasons, OLD_EMAIL_REASON),
  JSON.stringify(resolved.reasons),
);

// ------------------------------------------------------------------ (e) no stored verification does not throw
const lead2 = makeLead({
  id: "lead-reach-dossier-2",
  name: "Fake Reach Dossier Co Two",
  website: "https://other-fixture.example",
  sourceUrl: "https://osm.example.invalid/reach-dossier-2",
});
let threw = "";
try {
  const r = resolveScore(lead2);
  console.log(`INFO  resolveScore without stored verification: total=${r.total} reach=${r.reach}`);
} catch (err) {
  threw = (err as Error).message;
}
check("e: resolveScore with no stored verification does not throw", threw === "", threw);

// ------------------------------------------------------------------ done
closeDb();
rmSync(ROOT, { recursive: true, force: true });
if (failed > 0) {
  console.log(`reach-dossier-check FAILED (${failed} failing, ${passed} passing)`);
  process.exit(1);
} else {
  console.log(`reach-dossier-check PASSED (${passed} passing)`);
}
