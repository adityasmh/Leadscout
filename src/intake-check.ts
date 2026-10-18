// Proof harness for intake.ts: adaptive intake -> Target Brief -> discovery queries.
// Offline only: no network, no real model, clearly fake fixtures.
// Sets a temp database via LEADSCOUT_DB before importing any module that opens the DB.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "leadscout-intake-check-"));
const dbPath = join(tmpDir, "test.db");
process.env.LEADSCOUT_DB = dbPath;

const {
  nextQuestions,
  refineWithModel,
  compileBrief,
  briefToQueries,
  saveBrief,
  loadBrief,
  SECTION_IDS,
  PACK_KEYS,
} = await import("./intake.js");
const { createWorkspace, closeDb } = await import("./store.js");

const checks: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
  checks.push({ name, ok: condition, detail });
  const status = condition ? "PASS" : "FAIL";
  console.log(`${status}: ${name}${detail ? ` (${detail})` : ""}`);
  return condition;
}

// CONTRACT SIGNALS ids (docs/leadgen/CONTRACT.md), used to verify priorities stay in-contract.
const CONTRACT_SIGNALS = [
  "no-website", "no-https", "not-mobile-friendly", "no-contact-form", "no-chat-widget",
  "no-online-booking", "no-analytics", "outdated-copyright", "wordpress", "wix", "shopify",
  "custom-cms", "has-whatsapp", "has-email", "has-phone", "social-active-links", "slow-response",
  "site-unreachable", "ecommerce", "appointment-based", "high-volume-enquiry-type",
];

// Fake industry phrase per pack key; each matches only its own pack's keywords.
const INDUSTRY_PHRASES: Record<string, string> = {
  clinic: "multi-speciality hospital",
  dental: "dental implants practice",
  salon: "beauty salon and spa",
  gym: "gym and fitness studio",
  "school-coaching": "coaching academy for class 10",
  "restaurant-cafe": "cloud kitchen restaurant",
  "real-estate": "real estate broker office",
  travel: "travel tour operator",
  "repair-services": "appliance repair plumber",
  retail: "retail supermarket",
  manufacturing: "manufacturing factory",
  "legal-accounting": "chartered accountant audit firm",
};

// ------------------------------------------------------- 0. question tree shape

{
  const expected = ["seller", "offer", "niche", "size", "geo", "signals", "buyer", "exclusions", "volume", "outreach", "examples"];
  check("tree-11-sections", SECTION_IDS.length === 11, `got=${SECTION_IDS.length}`);
  check("tree-section-order", JSON.stringify(SECTION_IDS) === JSON.stringify(expected));
  const expectedPacks = [
    "clinic", "dental", "salon", "gym", "school-coaching", "restaurant-cafe",
    "real-estate", "travel", "repair-services", "retail", "manufacturing", "legal-accounting",
  ];
  check("tree-12-pack-keys", JSON.stringify(PACK_KEYS) === JSON.stringify(expectedPacks), `got=${PACK_KEYS.join(",")}`);
}

// ------------------------------------------------------- 1. adaptive flow

{
  const empty = nextQuestions({ answers: {} });
  check("flow-empty-asks-first-question", empty.some((q) => q.id === "seller.sellToWhom"));
  check("flow-empty-no-pack", !empty.some((q) => q.id.startsWith("pack.")), `pack questions=${empty.filter((q) => q.id.startsWith("pack.")).length}`);
  check("flow-empty-hides-conditional", !empty.some((q) => q.id === "buyer.decisionOther"));

  const withIndustry = nextQuestions({ answers: {}, industry: "dental implants" });
  check("flow-industry-adds-pack", withIndustry.some((q) => q.id.startsWith("pack.dental.")));

  const withChoice = nextQuestions({ answers: { "buyer.whoDecides": "other (describe below)" } });
  check("flow-showif-appears-when-triggered", withChoice.some((q) => q.id === "buyer.decisionOther"));

  const answered = nextQuestions({
    answers: {
      "seller.sellToWhom": "We build WhatsApp booking bots for clinic owners in Pune.",
      "niche.industry": "dental implants",
    },
  });
  check("flow-answered-question-disappears", !answered.some((q) => q.id === "seller.sellToWhom"));
  check("flow-pack-present-after-answer", answered.some((q) => q.id.startsWith("pack.dental.")));
}

// ------------------------------------------------------- 2. all 12 packs appear

for (const key of PACK_KEYS) {
  const phrase = INDUSTRY_PHRASES[key] ?? key;
  const qs = nextQuestions({ answers: {}, industry: phrase });
  const packQs = qs.filter((q) => q.id.startsWith(`pack.${key}.`));
  check(`pack-${key}-appears`, packQs.length > 0, `industry="${phrase}" packQuestions=${packQs.length}`);
}

// ------------------------------------------------------- 3. vague answers trigger one follow-up

{
  const qs = nextQuestions({ answers: { "seller.sellToWhom": "clients" } });
  const fu = qs.find((q) => q.id === "seller.sellToWhom.followup");
  check("vague-text-triggers-followup", !!fu, fu ? "found" : "missing followup");
  check("vague-followup-has-parentid", !!fu && fu.parentId === "seller.sellToWhom");

  const perParent = new Map<string, number>();
  for (const q of qs) {
    if (q.parentId) perParent.set(q.parentId, (perParent.get(q.parentId) ?? 0) + 1);
  }
  check("vague-at-most-one-per-question", [...perParent.values()].every((n) => n === 1), `parents=${perParent.size}`);

  const afterFu = nextQuestions({
    answers: {
      "seller.sellToWhom": "clients",
      "seller.sellToWhom.followup": "We build WhatsApp booking bots for dental clinic owners in Pune.",
    },
  });
  check("vague-followup-never-repeated", !afterFu.some((q) => q.id === "seller.sellToWhom.followup"));

  const vagueNum = nextQuestions({ answers: { "offer.priceRange": "affordable" } });
  check("vague-number-triggers-followup", vagueNum.some((q) => q.id === "offer.priceRange.followup"));
  const okNum = nextQuestions({ answers: { "offer.priceRange": "20,000 to 60,000 INR per project" } });
  check("number-with-digit-not-vague", !okNum.some((q) => q.id === "offer.priceRange.followup"));
  const okNumValue = nextQuestions({ answers: { "volume.callsPerWeek": 25 } });
  check("number-value-not-vague", !okNumValue.some((q) => q.id === "volume.callsPerWeek.followup"));

  const vaguePlace = nextQuestions({ answers: { "geo.country": "anywhere really" } });
  check("vague-place-triggers-followup", vaguePlace.some((q) => q.id === "geo.country.followup"));
  const okPlace = nextQuestions({ answers: { "geo.country": "India" } });
  check("place-with-name-not-vague", !okPlace.some((q) => q.id === "geo.country.followup"));
}

// ------------------------------------------------------- 4. refineWithModel

{
  const state = {
    answers: {
      "seller.sellToWhom": "We build websites for local businesses.",
      "niche.industry": "dental implants",
    },
  };

  let calls = 0;
  const countingFn = async () => {
    calls++;
    return { text: JSON.stringify(["Q one?", "Q two?", "Q three?", "Q four?", "Q five?"]) };
  };

  const none = await refineWithModel(state);
  check("refine-no-fn-returns-empty", Array.isArray(none) && none.length === 0, `len=${none.length}`);

  const refined = await refineWithModel(state, countingFn);
  check("refine-capped-at-3", refined.length === 3, `got=${refined.length}`);
  check("refine-called-once-with-fn", calls === 1, `calls=${calls}`);

  const thrower = async (): Promise<{ text: string }> => {
    throw new Error("fake model failure");
  };
  const threw = await refineWithModel(state, thrower);
  check("refine-throw-returns-empty", Array.isArray(threw) && threw.length === 0);

  const junker = async () => ({ text: "ha ha no questions here" });
  const junk = await refineWithModel(state, junker);
  check("refine-junk-returns-empty", Array.isArray(junk) && junk.length === 0);
}

// ------------------------------------------------------- 5. compiled brief covers answered sections

const fullState = {
  workspaceId: "ws-full",
  industry: "dental implants",
  answers: {
    "seller.sellToWhom": "We build WhatsApp booking bots for clinic owners in Pune.",
    "seller.sellToWhom.followup": "Mainly single-location dental clinics.",
    "offer.services": ["website", "automation", "seo"],
    "offer.priceRange": "20,000 to 60,000 INR per project",
    "niche.industry": "dental implants",
    "niche.subNiche": "dental clinics that do implants",
    "geo.country": "India",
    "geo.cities": ["Pune", "Mumbai"],
    "signals.triggers": ["no-online-booking", "no-website", "slow-response"],
    "buyer.whoDecides": "owner",
    "exclusions.list": ["chains", "businesses we already serve"],
    "volume.callsPerWeek": 30,
    "outreach.tone": "plain and direct",
    "pack.dental.chairs": 4,
    "examples.sites": ["https://dental-a.example", "https://dental-b.example", "https://dental-c.example"],
  },
} as const;

{
  const brief = compileBrief(fullState);
  const sectionIds = brief.sections.map((s) => s.sectionId);
  const expected = ["seller", "offer", "niche", "geo", "signals", "buyer", "exclusions", "volume", "outreach", "examples", "dental"];
  const missing = expected.filter((id) => !sectionIds.includes(id));
  check("brief-has-every-answered-section", missing.length === 0, `missing=${missing.join(",")}`);
  check("brief-unanswered-section-absent", !sectionIds.includes("size"));
  check("brief-meta", brief.meta.packKey === "dental" && brief.meta.industry === "dental implants" && typeof brief.meta.createdAt === "string");
  const seller = brief.sections.find((s) => s.sectionId === "seller");
  const fuEntry = seller?.answers.find((a) => a.id === "seller.sellToWhom.followup");
  check("brief-keeps-followup-answer", !!fuEntry, fuEntry ? "found" : "missing");
}

// ------------------------------------------------------- 6. query shape matches discover input

{
  const brief = compileBrief(fullState);
  const compiled = briefToQueries(brief);
  const shapeOk = compiled.queries.length > 0 && compiled.queries.every((q) =>
    typeof q.category === "string" && q.category.trim() !== "" &&
    typeof q.city === "string" &&
    typeof q.country === "string" && q.country.trim() !== "" &&
    typeof q.limit === "number" && Number.isFinite(q.limit)
  );
  check("queries-discover-shape", shapeOk, `n=${compiled.queries.length}`);
  check("queries-one-per-city", compiled.queries.length === 2, `cities=${compiled.queries.map((q) => q.city).join("|")}`);
  check("queries-limit-from-volume", compiled.queries.every((q) => q.limit === 30), `limit=${compiled.queries[0]?.limit}`);
  check("queries-limit-bounded", compiled.queries.every((q) => q.limit >= 1 && q.limit <= 200));
  check("queries-category-from-niche", compiled.queries[0]?.category === "dental clinics that do implants", `cat=${compiled.queries[0]?.category}`);
  check("queries-country-from-geo", compiled.queries.every((q) => q.country === "India"));

  const emptyBrief = compileBrief({ answers: {} });
  const emptyCompiled = briefToQueries(emptyBrief);
  check("queries-empty-brief-defaults", emptyCompiled.queries.length === 1 && emptyCompiled.queries[0].limit === 20);
}

// ------------------------------------------------------- 7. exclusions and weights

{
  const brief = compileBrief(fullState);
  const compiled = briefToQueries(brief);
  check("exclusions-terms-present", compiled.exclusions.terms.includes("chains") && compiled.exclusions.terms.includes("businesses we already serve"), `terms=${compiled.exclusions.terms.join(",")}`);
  check("exclusions-rules-present", compiled.exclusions.rules.length > 0);
  check("weights-service-ids-present", ["website", "automation", "seo"].every((s) => typeof compiled.scoringWeights[s] === "number"), `keys=${Object.keys(compiled.scoringWeights).join(",")}`);
  check("weights-signal-ids-present", compiled.signalPriorities.length > 0 && compiled.signalPriorities.every((id) => typeof compiled.scoringWeights[id] === "number"));
  check("signal-priorities-contract-only", compiled.signalPriorities.every((id) => CONTRACT_SIGNALS.includes(id)), `prio=${compiled.signalPriorities.join(",")}`);
  check("dossier-tone-present", typeof compiled.dossierTone === "string" && compiled.dossierTone.trim() !== "", `tone=${compiled.dossierTone}`);
}

// ------------------------------------------------------- 8. save/load round trip

const ws1 = createWorkspace({
  name: "Intake Check One",
  offer: { services: ["website"], description: "fake offer one" },
  icp: { categories: ["dental"], cities: ["Pune"], countries: ["IN"] },
});

{
  const briefA = compileBrief({ ...fullState, workspaceId: ws1.id });
  saveBrief(ws1.id, briefA);
  const loaded = loadBrief(ws1.id);
  check("save-load-round-trip", !!loaded && JSON.stringify(loaded) === JSON.stringify(briefA));
  check("load-missing-workspace-undefined", loadBrief("no-such-workspace") === undefined);
}

// ------------------------------------------------------- 9. two workspaces never share a brief

{
  const ws2 = createWorkspace({
    name: "Intake Check Two",
    offer: { services: ["seo"], description: "fake offer two" },
    icp: { categories: ["gym"], cities: ["Delhi"], countries: ["IN"] },
  });
  const briefB = compileBrief({
    workspaceId: ws2.id,
    industry: "gyms",
    answers: { "seller.sellToWhom": "We do SEO for gyms in Delhi." },
  });
  saveBrief(ws2.id, briefB);

  const loadedA = loadBrief(ws1.id);
  const loadedB = loadBrief(ws2.id);
  check("isolation-briefs-differ", JSON.stringify(loadedA) !== JSON.stringify(loadedB));
  check("isolation-a-intact", loadedA?.meta.workspaceId === ws1.id, `a=${loadedA?.meta.workspaceId}`);
  check("isolation-b-intact", loadedB?.meta.workspaceId === ws2.id && loadedB?.meta.packKey === "gym", `b=${loadedB?.meta.workspaceId}`);
}

// ------------------------------------------------------------------ summary

closeDb();
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup failures */ }

const failures = checks.filter((c) => !c.ok);
const overall = failures.length === 0 ? "PASS" : "FAIL";
console.log(`\n${overall}: ${checks.length - failures.length}/${checks.length} checks passed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail ?? ""}`);
  process.exit(1);
}
