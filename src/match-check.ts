// src/match-check.ts
// Proof for L5-match. Pure fixtures, no network calls (match never touches the network).
// Run: npx tsx src/match-check.ts
//
// Every business, address, email and number below is clearly fake.

import {
  effectiveSignals,
  firstSentence,
  loadRules,
  match,
  normaliseCategory,
  type ServiceRules,
} from "./match.js";
import type { Enrichment, Offer, RawLead } from "./types.js";

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

const rules: ServiceRules = loadRules();

// ---------------------------------------------------------------- fixtures

const FAKE_SOURCE_URL = "https://www.openstreetmap.org/node/999001";

// A: a dental clinic with no site at all, but an email and a phone.
const NO_SITE_LEAD: RawLead = {
  name: "Fake Dental Care",
  category: "dental-clinic",
  city: "Pune",
  country: "India",
  email: "hello@fakedental.example",
  phone: "+91 00000 00001",
  source: "osm",
  sourceUrl: FAKE_SOURCE_URL,
};
const NO_SITE_ENRICH: Enrichment = {
  summary: "Fake Dental Care is a dental clinic in Pune.",
  emails: ["hello@fakedental.example"],
  phones: ["+91 00000 00001"],
  socials: {},
  signals: ["no-website"],
};

// B: a clinic with a working site and a contact form, but no chat widget.
const CHAT_LEAD: RawLead = {
  name: "Fake Smile Clinic",
  category: "clinic",
  city: "Pune",
  country: "India",
  website: "https://fakesmile.example",
  email: "hello@fakesmile.example",
  source: "osm",
  sourceUrl: FAKE_SOURCE_URL,
};
const CHAT_ENRICH: Enrichment = {
  fetchedUrl: "https://fakesmile.example",
  summary: "Fake Smile Clinic is a clinic in Pune.",
  emails: ["hello@fakesmile.example"],
  phones: ["+91 00000 00002"],
  socials: {},
  signals: ["no-chat-widget"],
};

// C: a clinic with a site, used to show two offers rank the same lead differently.
const RANK_LEAD: RawLead = {
  name: "Fake Family Clinic",
  category: "clinic",
  city: "Pune",
  country: "India",
  website: "https://fakefamilyclinic.example",
  email: "hello@fakefamilyclinic.example",
  phone: "+91 00000 00003",
  source: "osm",
  sourceUrl: FAKE_SOURCE_URL,
};
const RANK_ENRICH: Enrichment = {
  fetchedUrl: "https://fakefamilyclinic.example",
  summary: "Fake Family Clinic is a clinic in Pune.",
  emails: ["hello@fakefamilyclinic.example"],
  phones: ["+91 00000 00003"],
  socials: {},
  signals: ["no-online-booking", "no-analytics"],
};

// D: no way to contact at all.
const UNREACHABLE_LEAD: RawLead = {
  name: "Fake Unreachable Clinic",
  category: "clinic",
  city: "Pune",
  country: "India",
  source: "osm",
  sourceUrl: FAKE_SOURCE_URL,
};
const UNREACHABLE_ENRICH: Enrichment = {
  summary: "Fake Unreachable Clinic is a clinic in Pune.",
  emails: [],
  phones: [],
  socials: {},
  signals: ["no-website", "no-online-booking"],
};

// E: a reachable lead whose listed site is dead.
const DEAD_LEAD: RawLead = {
  name: "Fake Lapsed Clinic",
  category: "clinic",
  city: "Pune",
  country: "India",
  website: "https://fakelapsed.example",
  email: "hello@fakelapsed.example",
  source: "osm",
  sourceUrl: FAKE_SOURCE_URL,
};
const DEAD_ENRICH: Enrichment = {
  fetchedUrl: "https://fakelapsed.example",
  summary: "Fake Lapsed Clinic is a clinic in Pune.",
  emails: ["hello@fakelapsed.example"],
  phones: [],
  socials: {},
  signals: ["no-online-booking", "site-unreachable"],
};
const DEAD_ENRICH_NO_SIGNAL: Enrichment = { ...DEAD_ENRICH, signals: ["no-online-booking"] };

const ALL_FIXTURES: Array<{ name: string; lead: RawLead; enrich: Enrichment; offer: Offer }> = [
  { name: "no-site clinic", lead: NO_SITE_LEAD, enrich: NO_SITE_ENRICH, offer: { services: ["website"], description: "we build websites" } },
  { name: "no-chat-widget clinic", lead: CHAT_LEAD, enrich: CHAT_ENRICH, offer: { services: ["ai-chatbot"], description: "we build chatbots" } },
  { name: "ranked clinic", lead: RANK_LEAD, enrich: RANK_ENRICH, offer: { services: ["website", "seo", "booking-system", "crm-setup"], description: "we do websites and automation" } },
  { name: "unreachable clinic", lead: UNREACHABLE_LEAD, enrich: UNREACHABLE_ENRICH, offer: { services: ["booking-system", "whatsapp-automation"], description: "we do booking and WhatsApp" } },
  { name: "dead-site clinic", lead: DEAD_LEAD, enrich: DEAD_ENRICH, offer: { services: ["booking-system"], description: "we do booking" } },
];

// ---------------------------------------------------------------- 1. rules

check("service-rules.json loads and validates", rules.services.length >= 11, `services=${rules.services.length}`);
check(
  "all 11 contract services have rules",
  ["website", "website-redesign", "automation", "ai-chatbot", "whatsapp-automation", "seo", "crm-setup", "booking-system", "ecommerce", "ai-voice-agent", "lead-gen"].every(
    (id) => rules.services.some((s) => s.id === id),
  ),
);
check("every rule signals map to a known signal id with a phrase", rules.services.every((s) => Object.keys(s.signals).every((sig) => !!rules.signals[sig]?.phrase)));
check("no model calls or network in match.ts", !/fetch\(|https?\.request|https?\.get/.test(String(match)) && rules.version === 1);
check("normaliseCategory: 'Dental Clinic' -> 'dental-clinic'", normaliseCategory("Dental Clinic") === "dental-clinic", normaliseCategory("Dental Clinic"));

// ---------------------------------------------------------------- 2. required proof items

// (a) website seller scores a no-website lead high
{
  const result = match(NO_SITE_LEAD, NO_SITE_ENRICH, { services: ["website"], description: "we build websites" });
  const top = result.fit[0];
  check(
    "website seller scores a no-website lead high (top service website, score >= 60, overall >= 50)",
    top?.service === "website" && top.score >= 60 && result.score >= 50,
    JSON.stringify(result),
  );
  check("no-website reason names the missing site", top.reason.includes("no website was found"), top.reason);
}

// (b) chatbot seller scores a lead with a contact form but no chat widget high
{
  const signals = effectiveSignals(CHAT_LEAD, CHAT_ENRICH);
  const result = match(CHAT_LEAD, CHAT_ENRICH, { services: ["ai-chatbot"], description: "we build chatbots" });
  const top = result.fit[0];
  check(
    "chatbot fixture really has no-chat-widget and no no-contact-form",
    signals.includes("no-chat-widget") && !signals.includes("no-contact-form"),
    JSON.stringify(signals),
  );
  check(
    "chatbot seller scores a contact-form/no-chat-widget lead high (top service ai-chatbot, score >= 55)",
    top?.service === "ai-chatbot" && top.score >= 55,
    JSON.stringify(result),
  );
  check("chatbot reason names the missing chat widget", top.reason.includes("no chat widget"), top.reason);
}

// (c) same lead, two offers, different ranking
{
  const offerA: Offer = { services: ["website", "seo"], description: "websites and search" };
  const offerB: Offer = { services: ["booking-system", "ai-chatbot"], description: "booking and chatbot" };
  const a = match(RANK_LEAD, RANK_ENRICH, offerA);
  const b = match(RANK_LEAD, RANK_ENRICH, offerB);
  const rankA = a.fit.map((f) => f.service).join(">");
  const rankB = b.fit.map((f) => f.service).join(">");
  check("same lead + two offers rank differently", rankA !== rankB, `A=${rankA}  B=${rankB}`);
  check("the two offers give different top services", a.fit[0].service !== b.fit[0].service, `${a.fit[0].service} vs ${b.fit[0].service}`);
  check("the two offers give different outreach angles", a.angle !== b.angle, `${a.angle}  |  ${b.angle}`);
  console.log(`      A ${rankA}: ${a.fit.map((f) => `${f.service}=${f.score}`).join(", ")}`);
  console.log(`      B ${rankB}: ${b.fit.map((f) => `${f.service}=${f.score}`).join(", ")}`);
}

// (d) unreachable lead capped at 30
{
  const result = match(UNREACHABLE_LEAD, UNREACHABLE_ENRICH, { services: ["booking-system"], description: "we do booking" });
  check("unreachable lead (no email, phone or WhatsApp) is capped at 30", result.score <= 30 && result.score === 30, JSON.stringify(result));
  const reachable = match(
    { ...UNREACHABLE_LEAD, email: "hello@fakeunreachable.example" },
    { ...UNREACHABLE_ENRICH, emails: ["hello@fakeunreachable.example"] },
    { services: ["booking-system"], description: "we do booking" },
  );
  check("the same lead with an email is above the cap", reachable.score > 30, JSON.stringify(reachable));
}

// (e) dead contact route costs points
{
  const dead = match(DEAD_LEAD, DEAD_ENRICH, { services: ["booking-system"], description: "we do booking" });
  const alive = match(DEAD_LEAD, DEAD_ENRICH_NO_SIGNAL, { services: ["booking-system"], description: "we do booking" });
  const penalty = rules.scoring.deadRoutePenalty;
  check(`site-unreachable removes the dead-route penalty (${penalty})`, alive.score - dead.score === penalty, `alive=${alive.score} dead=${dead.score}`);
  check("a dead site still leaves a reachable lead above the unreachable cap", dead.score > rules.scoring.unreachableCap, `dead=${dead.score}`);
}

// (f) reasons always reference a signal that is present in the input
{
  const phraseToSignals = new Map<string, string[]>();
  const addPhrase = (signal: string, text: string): void => {
    if (!text) return;
    const list = phraseToSignals.get(text) ?? [];
    list.push(signal);
    phraseToSignals.set(text, list);
  };
  for (const [id, info] of Object.entries(rules.signals)) addPhrase(id, info.phrase);
  for (const service of rules.services) for (const [signal, text] of Object.entries(service.reasons ?? {})) addPhrase(signal, text);

  const bad: string[] = [];
  for (const fixture of ALL_FIXTURES) {
    const present = new Set(effectiveSignals(fixture.lead, fixture.enrich));
    const result = match(fixture.lead, fixture.enrich, fixture.offer);
    for (const fit of result.fit) {
      const cited = [...phraseToSignals.entries()]
        .filter(([text]) => fit.reason.includes(text))
        .flatMap(([, signals]) => signals)
        .filter((signal) => present.has(signal));
      if (cited.length === 0) bad.push(`${fixture.name}/${fit.service}: "${fit.reason}" <- signals ${JSON.stringify([...present])}`);
    }
  }
  check("every reason cites a signal present in the input", bad.length === 0, bad.join(" | "));
}

// (g) services not in the offer never appear
{
  const offers: Offer[] = [
    { services: ["website"], description: "one service" },
    { services: ["seo", "crm-setup"], description: "two services" },
    { services: ["booking-system", "ai-chatbot", "ecommerce", "ai-voice-agent", "lead-gen"], description: "five services" },
  ];
  let ok = true;
  const detail: string[] = [];
  for (const offer of offers) {
    const result = match(RANK_LEAD, RANK_ENRICH, offer);
    const known = offer.services.filter((id) => rules.services.some((s) => s.id === id));
    if (result.fit.length !== known.length) ok = false;
    for (const fit of result.fit) if (!offer.services.includes(fit.service)) ok = false;
    detail.push(`${offer.services.join("+")} -> ${result.fit.map((f) => f.service).join(",")}`);
  }
  check("services not in the offer never appear (and every offered rule is scored)", ok, detail.join(" | "));
  const unknown = match(RANK_LEAD, RANK_ENRICH, { services: ["website", "invented-service"], description: "includes an unknown id" });
  check("unknown service ids are ignored, never invented", unknown.fit.length === 1 && unknown.fit[0].service === "website", JSON.stringify(unknown.fit));
}

// (h) angle contains no text absent from the inputs
{
  const bad: string[] = [];
  for (const fixture of ALL_FIXTURES) {
    const result = match(fixture.lead, fixture.enrich, fixture.offer);
    const angle = result.angle;
    const expected = `${firstSentence(fixture.enrich.summary).replace(/[.!?]+$/, "")} - ${result.fit[0].reason.replace(/[.!?]+$/, "")}.`;
    if (angle !== expected) bad.push(`${fixture.name}: angle "${angle}" !== expected "${expected}"`);
    if (!fixture.enrich.summary.includes(firstSentence(fixture.enrich.summary))) bad.push(`${fixture.name}: angle summary is not from the enrichment`);
    const terminators = (angle.match(/[.!?]/g) ?? []).length;
    if (terminators !== 1) bad.push(`${fixture.name}: angle is not one sentence (${terminators} terminators)`);
    if (/\d/.test(angle)) bad.push(`${fixture.name}: angle contains a number that is not in the inputs`);
    // token scan: every word in the angle must come from the summary, the reason, or the lead's own text
    const known = `${fixture.enrich.summary} ${result.fit[0].reason} ${fixture.lead.name} ${fixture.lead.city ?? ""} ${fixture.offer.description}`.toLowerCase();
    const tokens = angle.toLowerCase().match(/[a-z][a-z'-]+/g) ?? [];
    const stray = tokens.filter((t) => !known.includes(t));
    if (stray.length > 0) bad.push(`${fixture.name}: angle words not in inputs: ${JSON.stringify(stray)}`);
    // trap tokens an invented pitch would use
    const traps = ["award", "guaranteed", "100%", "trusted by", "leading"];
    for (const trap of traps) if (angle.toLowerCase().includes(trap)) bad.push(`${fixture.name}: angle uses the trap word "${trap}"`);
  }
  check("angle is one sentence built only from the summary, the top reason and the lead", bad.length === 0, bad.join(" | "));
}

// ---------------------------------------------------------------- 3. shape and edge rules

{
  const result = match(RANK_LEAD, RANK_ENRICH, { services: ["website", "seo", "booking-system", "crm-setup"], description: "mixed" });
  check("fit is sorted best first", result.fit.every((f, i) => i === 0 || result.fit[i - 1].score >= f.score), JSON.stringify(result.fit.map((f) => f.score)));
  check("all per-service scores are within 0..100", result.fit.every((f) => f.score >= 0 && f.score <= 100), JSON.stringify(result.fit.map((f) => f.score)));
  check("overall score is within 0..100", result.score >= 0 && result.score <= 100, String(result.score));
  check("fit entries carry service, score and reason", result.fit.every((f) => typeof f.service === "string" && typeof f.score === "number" && typeof f.reason === "string" && f.reason.length > 0));
  check("angle ends with a full stop", result.angle.endsWith("."), result.angle);
}

{
  const empty = match(RANK_LEAD, RANK_ENRICH, { services: [], description: "nothing offered" });
  check("empty offer -> empty fit, zero score, angle still a sentence", empty.fit.length === 0 && empty.score === 0 && empty.angle.endsWith("."), JSON.stringify(empty));
}

{
  const withBonus = match(RANK_LEAD, RANK_ENRICH, { services: ["booking-system"], description: "booking" });
  const otherCategory = match({ ...RANK_LEAD, category: "grocery" }, RANK_ENRICH, { services: ["booking-system"], description: "booking" });
  const noCategory = match({ ...RANK_LEAD, category: "unknown-kind" }, RANK_ENRICH, { services: ["booking-system"], description: "booking" });
  const bookingRule = rules.services.find((s) => s.id === "booking-system");
  const bonus = bookingRule?.categoryBonus ?? 0;
  check("a naturally high-need category adds its category bonus", withBonus.fit[0].score - noCategory.fit[0].score === bonus, `${withBonus.fit[0].score} vs ${noCategory.fit[0].score}, bonus=${bonus}`);
  check("a category outside the list gets no bonus", otherCategory.fit[0].score === noCategory.fit[0].score, `${otherCategory.fit[0].score} vs ${noCategory.fit[0].score}`);
}

{
  const bare: RawLead = { name: "Fake Bare Lead", category: "unknown-kind", source: "osm", sourceUrl: FAKE_SOURCE_URL };
  const bareEnrich: Enrichment = { summary: "", emails: [], phones: [], socials: {}, signals: [] };
  const signals = effectiveSignals(bare, bareEnrich);
  check("a lead with no site and no contacts still derives no-website", signals.includes("no-website"), JSON.stringify(signals));
  const result = match(bare, bareEnrich, { services: ["website"], description: "websites" });
  check("a bare lead still scores without crashing and is capped at 30", result.score <= 30 && result.fit.length === 1, JSON.stringify(result));
  check("a bare lead still gets a one-sentence angle", (result.angle.match(/[.!?]/g) ?? []).length === 1, result.angle);
}

{
  // every service in the table must score without throwing
  let ok = true;
  for (const service of rules.services) {
    const result = match(RANK_LEAD, RANK_ENRICH, { services: [service.id], description: "single" });
    if (result.fit.length !== 1 || result.fit[0].reason.length === 0) ok = false;
  }
  check("every service rule scores a lead and returns one reason", ok);
}

// ---------------------------------------------------------------- summary

console.log("");
console.log(`Fixtures: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed checks: ${failures.join("; ")}`);
  process.exitCode = 1;
}
