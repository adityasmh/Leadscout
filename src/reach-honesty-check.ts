// src/reach-honesty-check.ts
// ORDER RS1-reach-honesty: the reach score must not count an email whose domain
// cannot receive mail (verification result no-mx/invalid). An address with no
// verification entry still counts, as before.
//
// Offline: only pure scoreLead calls, temp database via env LEADSCOUT_DB (set
// before importing score.js, which transitively imports store.js). No network,
// no live database. Every business, address, email and number below is clearly
// fake (.example domains).
//
// Run: npx tsx src/reach-honesty-check.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "leadscout-reach-honesty-"));
process.env.LEADSCOUT_DB = join(ROOT, "reach-honesty.db");

import type { Lead } from "./types.js";
import type { Verification } from "./types-v2.js";

const { scoreLead } = await import("./score.js");

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

const WS = "ws-reach-honesty";

function baseLead(name: string, email: string | undefined, emails: string[]): Lead {
  return {
    workspaceId: WS,
    id: `lead-reach-honesty-${name}`,
    name: `Fake Reach Honesty ${name}`,
    category: "dentist",
    city: "Fake City",
    country: "IN",
    phone: "+919000000011",
    email,
    website: "https://reachable-fixture.example",
    source: "osm",
    sourceUrl: "https://osm.example.invalid/reach-honesty",
    summary: "Fake dental clinic in Fake City used only for the reach honesty check.",
    emails,
    phones: ["+919000000011"],
    socials: {},
    signals: [],
    score: 0,
    fit: [{ service: "website", score: 80, reason: "Fake fixture fit for the reach honesty check." }],
    angle: "Fake outreach angle for the reach honesty check.",
    status: "new",
    notes: "",
    createdAt: "2026-02-01T00:00:00.000Z",
  };
}

function baseVerification(emails: Verification["emails"]): Verification {
  return {
    bizKey: "reachable-fixture.example",
    checkedAt: "2026-02-01T00:00:00.000Z",
    website: "alive",
    emails,
    phones: [{ value: "+919000000011", e164: "+919000000011", result: "mobile" }],
    whatsapp: false,
    contactable: true,
    reasons: [],
  };
}

// ------------------------------------------------------------------ (a) no-mx-only email
const leadA = baseLead("a", "contact@no-mx-fixture.example", ["contact@no-mx-fixture.example"]);
const vNoMx = baseVerification([{ value: "contact@no-mx-fixture.example", result: "no-mx" }]);
const vOk = baseVerification([{ value: "contact@no-mx-fixture.example", result: "ok" }]);
const sNoMx = scoreLead(leadA, vNoMx);
const sOk = scoreLead(leadA, vOk);
check(
  "a: no-mx-only email gives lower reach than the same lead with a verified email",
  sNoMx.reach < sOk.reach,
  `no-mx reach=${sNoMx.reach} verified reach=${sOk.reach}`,
);
check(
  "a: reason says the email domain cannot receive mail",
  sNoMx.reasons.some((r) => r.includes("email domain cannot receive mail [email]")),
  JSON.stringify(sNoMx.reasons),
);
check(
  "a: reason does not claim the lead has an email address",
  !sNoMx.reasons.some((r) => r.includes("has an email address")),
  JSON.stringify(sNoMx.reasons),
);

// ------------------------------------------------- (b) one no-mx + one valid email
const leadB = baseLead("b", "sales@verified-fixture.example", [
  "contact@no-mx-fixture.example",
  "sales@verified-fixture.example",
]);
const vB = baseVerification([
  { value: "contact@no-mx-fixture.example", result: "no-mx" },
  { value: "sales@verified-fixture.example", result: "ok" },
]);
const vBOk = baseVerification([{ value: "sales@verified-fixture.example", result: "ok" }]);
const sB = scoreLead(leadB, vB);
const sBOk = scoreLead(leadB, vBOk);
check(
  "b: two emails with one no-mx and one valid keep the email points",
  sB.reach === sBOk.reach && sBOk.reach > sNoMx.reach,
  `mixed reach=${sB.reach} valid-only reach=${sBOk.reach} no-mx-only reach=${sNoMx.reach}`,
);

// ------------------------------------------------------- (c) invalid-only email
// The email result union in types-v2.ts has no "invalid" member (verify.ts only
// emits "invalid" for phones), but the scorer must still treat it as
// unreceivable. The entry below carries result "invalid" at runtime while its
// declared type stays within the union, so no cast is needed.
const invalidEntry: { value: string; result: "no-mx" } = {
  value: "contact@invalid-fixture.example",
  result: "no-mx",
};
const widenedInvalidEntry: { value: string; result: string } = invalidEntry;
widenedInvalidEntry.result = "invalid";
const leadC = baseLead("c", "contact@invalid-fixture.example", ["contact@invalid-fixture.example"]);
const vC = baseVerification([invalidEntry]);
const sC = scoreLead(leadC, vC);
check(
  "c: invalid-only email loses the email points",
  sC.reach === sNoMx.reach && sC.reach < sOk.reach,
  `invalid reach=${sC.reach} no-mx reach=${sNoMx.reach} verified reach=${sOk.reach}`,
);
check(
  "c: reason says the email domain cannot receive mail",
  sC.reasons.some((r) => r.includes("email domain cannot receive mail [email]")),
  JSON.stringify(sC.reasons),
);

// ----------------------------------------------------- (d) unverified email
const leadD = baseLead("d", "hello@unverified-fixture.example", ["hello@unverified-fixture.example"]);
const vD = baseVerification([]);
const sD = scoreLead(leadD, vD);
const vDOk = baseVerification([{ value: "hello@unverified-fixture.example", result: "ok" }]);
const sDOk = scoreLead(leadD, vDOk);
check(
  "d: unverified email keeps the email points",
  sD.reach === sDOk.reach,
  `unverified reach=${sD.reach} verified reach=${sDOk.reach}`,
);

// ------------------------------------------------------- (e) no emails at all
// EXPECTED_NO_EMAIL_TOTAL is the total printed by the INFO line on a run BEFORE
// score.ts was edited (see docs/leadgen/REPORT_RS1-reach-honesty.md).
const EXPECTED_NO_EMAIL_TOTAL = 71;
const leadE = baseLead("e", undefined, []);
const vE = baseVerification([]);
const sE = scoreLead(leadE, vE);
console.log(`INFO  no-email lead: total=${sE.total} reach=${sE.reach} timing=${sE.timing} fit=${sE.fit}`);
check(
  "e: lead with no emails keeps its pre-edit total",
  sE.total === EXPECTED_NO_EMAIL_TOTAL,
  `total=${sE.total} expected=${EXPECTED_NO_EMAIL_TOTAL}`,
);

// ------------------------------------------------------------------ done
const { closeDb } = await import("./store.js");
closeDb();
rmSync(ROOT, { recursive: true, force: true });
if (failed > 0) {
  console.log(`reach-honesty-check FAILED (${failed} failing, ${passed} passing)`);
  process.exit(1);
} else {
  console.log(`reach-honesty-check PASSED (${passed} passing)`);
}
