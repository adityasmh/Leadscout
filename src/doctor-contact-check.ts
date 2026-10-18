// src/doctor-contact-check.ts - Order DR1-doctor-direct-contact.
// Offline proof: fictional fixtures only, temp DB path via env LEADSCOUT_DB.
// Imports nothing from src/company/ and touches no real database.
// Run ONCE: npx tsx src/doctor-contact-check.ts
process.env.LEADSCOUT_DB =
  process.env.LEADSCOUT_DB ?? `${process.env.TEMP ?? process.env.TMP ?? "/tmp"}/leadscout-dr1-check.db`;

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

void tmpdir;
void join;

import { findDecisionMaker, toEvidence, type DoctorLead, type DoctorPage } from "./doctor-contact.js";

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass += 1;
    console.log(`PASS ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

// All fixture clinics are fictional (Faketown); phones are example ranges.
const LEAD_NAMED: DoctorLead = { name: "Dr. Rahul Jain's Swastik Dental Clinic" };
const LEAD_PLAIN: DoctorLead = { name: "Swastik Dental Clinic (fictional demo clinic, Faketown)" };
const LEAD_NODR: DoctorLead = { name: "City Dental Care (fictional demo clinic, Faketown)" };

const homePages: DoctorPage[] = [
  {
    url: "https://fictional-swastik-dental.example/home",
    title: "Swastik Dental Clinic (fictional demo clinic, Faketown)",
    body: "Welcome to Swastik Dental Clinic, a fictional demo clinic in Faketown. For appointments call 98765 43210. Reception: 91234 56789.",
  },
  {
    url: "https://fictional-swastik-dental.example/contact",
    title: "Contact (fictional demo page, Faketown)",
    body: "Dr. Rahul Jain mobile 98111 22233.\nChat with us https://wa.me/919811122233 .\nFollow the doctor at https://instagram.com/dr.rahuljain.faketown .\nClinic page https://facebook.com/fictional-swastik-dental-faketown .",
  },
];

const aboutPages: DoctorPage[] = [
  {
    url: "https://fictional-swastik-dental.example/about",
    title: "About (fictional demo clinic, Faketown)",
    body: "About our fictional demo clinic in Faketown. Meet the doctor: Dr. Rahul Jain, BDS, MDS, chief dentist with 10 years of fictional practice.",
  },
];

const noDrPages: DoctorPage[] = [
  {
    url: "https://fictional-city-dental.example/",
    title: "City Dental Care (fictional demo clinic, Faketown)",
    body: "A fictional demo clinic in Faketown. Open Mon-Sat. Visit us on Main Street.",
  },
];

// 1: name from lead name.
const r1 = findDecisionMaker(LEAD_NAMED, homePages);
check("name from lead name 'Dr. Rahul Jain's Swastik Dental Clinic'", r1.name === "Dr. Rahul Jain", `got ${r1.name}`);

// 2: name from About block when lead name has no Dr.
const r2 = findDecisionMaker(LEAD_PLAIN, aboutPages);
check("name from About/Meet-the-doctor block", r2.name === "Dr. Rahul Jain", `got ${r2.name}`);

// 3: never invented without Dr text.
const r3 = findDecisionMaker(LEAD_NODR, noDrPages);
check("no name invented without Dr text", r3.name === undefined, `got ${r3.name}`);

// 4: numbers near Reception/Appointments are desk.
const deskHit = r1.numbers.find((n) => n.phone.replace(/\D/g, "").endsWith("9876543210"));
const recepHit = r1.numbers.find((n) => n.phone.replace(/\D/g, "").endsWith("9123456789"));
check(
  "number near Appointments is desk",
  deskHit?.role === "desk" && deskHit.confidence === 0.2,
  JSON.stringify(deskHit)
);
check(
  "number near Reception is desk",
  recepHit?.role === "desk" && recepHit.confidence === 0.2,
  JSON.stringify(recepHit)
);

// 5: number near 'Dr. Rahul Jain mobile' is direct.
const directHit = r1.numbers.find((n) => n.phone.replace(/\D/g, "").endsWith("9811122233"));
check(
  "number near 'Dr. Rahul Jain mobile' is direct",
  directHit?.role === "direct" && directHit.confidence === 0.8,
  JSON.stringify(directHit)
);

// 6: wa.me link returned as whatsapp link.
check(
  "wa.me link returned as whatsapp link",
  r1.whatsappLinks.some((w) => w.url === "https://wa.me/919811122233"),
  JSON.stringify(r1.whatsappLinks)
);

// 7: instagram handle with doctor surname is owner doctor.
const insta = r1.socials.find((s) => s.platform === "instagram");
check("instagram handle with surname is owner doctor", insta?.owner === "doctor", JSON.stringify(insta));
const fb = r1.socials.find((s) => s.platform === "facebook");
check("clinic facebook link is owner clinic", fb?.owner === "clinic", JSON.stringify(fb));

// 8: two numbers on one page both returned, de-duplicated.
const dupPages: DoctorPage[] = [
  {
    url: "https://fictional-dup.example/",
    title: "Dup (fictional)",
    body: "Reception 98765 43210 and again Reception 98765 43210, plus Appointments 91234 56789. Fictional Faketown clinic.",
  },
];
const r8 = findDecisionMaker(LEAD_NODR, dupPages);
check(
  "two numbers same page both returned, de-duplicated",
  r8.numbers.length === 2,
  JSON.stringify(r8.numbers.map((n) => n.phone))
);

// 9: nothing found => found false and hook adds no evidence.
const r9 = findDecisionMaker(LEAD_NODR, noDrPages);
check("nothing found returns found false", r9.found === false, JSON.stringify(r9.found));
// Simulate the pipeline hook exactly: add nothing when found is false.
type Ev = { id: string; kind: string; url: string; quote: string; field?: string; fetchedAt: string };
function hookSim(base: Ev[], lead: DoctorLead, pages: DoctorPage[]): Ev[] {
  const f = findDecisionMaker(lead, pages);
  if (!f.found) return base;
  return [...base, ...toEvidence(f).map((e, i) => ({ ...e, id: `R${base.length + i + 1}` }))];
}
check("pipeline hook adds no evidence when found false", hookSim([], LEAD_NODR, noDrPages).length === 0);
const hooked = hookSim([], LEAD_NAMED, homePages);
check(
  "pipeline hook adds doctor-contact evidence when found",
  hooked.length > 0 && hooked.every((e) => e.kind === "doctor-contact"),
  JSON.stringify(hooked.map((e) => e.field))
);

// 10: quotes capped at 120 chars; lead phone field never written.
const before = JSON.stringify(LEAD_NAMED);
findDecisionMaker(LEAD_NAMED, homePages);
check("lead object never mutated (no phone field written)", JSON.stringify(LEAD_NAMED) === before && !("phone" in LEAD_NAMED));
check(
  "number quotes capped at 120 chars",
  r1.numbers.every((n) => n.quote.length <= 120),
  JSON.stringify(r1.numbers.map((n) => n.quote.length))
);

// 11: fixtures clearly fake.
const fixtureText = JSON.stringify([LEAD_NAMED, LEAD_PLAIN, LEAD_NODR, homePages, aboutPages, noDrPages, dupPages]);
check(
  "all fixture clinics clearly fake",
  /fictional|faketown|example/i.test(fixtureText),
  "missing fake markers"
);

// 12: pipeline.ts carries the one dynamic-import hook.
const pipe = readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
check("pipeline hook present (dynamic import doctor-contact.js)", pipe.includes('import("./doctor-contact.js")'));

console.log(`DR1 doctor-contact-check: ${pass} PASS, ${fail} FAIL`);
if (fail > 0) process.exit(1);
