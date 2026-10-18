// src/lookalike-check.ts
// Offline proof for L31-lookalike. Fixtures only, no real network: every fetch goes through an
// injected fetchFn, and the only source of fetch results is fixtures-v2/lookalike/*.html.
//
// Run: npx tsx src/lookalike-check.ts
//
// Covers, per the order: the profile's hand-computed frequencies (categories, signals, keywords,
// tech, language, contact routes, size hints); a twinned lead scores high and a distinct lead low;
// every score reason cites a real profile value; a failed example fetch is skipped and reported;
// fewer than 2 usable examples throws a clear error; the explanation uses no word that is not in
// the example data or the exported connective list.

import { readFileSync } from "node:fs";
import { enrich } from "./enrich.js";
import { buildProfile, explainProfile, scoreLookalike, EXPLAIN_CONNECTIVES, WEIGHTS } from "./lookalike.js";
import type { LookalikeExample, LookalikeProfile } from "./lookalike.js";
import type { Enrichment, RawLead } from "./types.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `  :: ${detail}` : ""}`);
  }
}

function checkEq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- fixtures

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures-v2/lookalike/${name}`, import.meta.url), "utf8");
}

const HTML_A = fixture("example-a.html");
const HTML_B = fixture("example-b.html");
const HTML_C = fixture("example-c.html");
const HTML_DISTINCT = fixture("example-distinct.html");

const HOST_HTML: Record<string, string> = {
  "fixture-a.example": HTML_A,
  "fixture-b.example": HTML_B,
  "fixture-c.example": HTML_C,
  "fixture-distinct.example": HTML_DISTINCT,
};

// ---------------------------------------------------------------- fake fetch

type Call = { url: string; init?: RequestInit };

function makeFetch(): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("fixture-dead")) throw new Error("simulated network failure: dead fixture host");
    if (url.endsWith("/robots.txt")) {
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      host = "";
    }
    const html = HOST_HTML[host];
    if (!html) throw new Error(`fake fetch: no route for ${url}`);
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }) as typeof fetch;
  return { fn, calls };
}

function leadFor(name: string, website: string, category: string): RawLead {
  return { name, category, website, source: "lookalike-example", sourceUrl: website };
}

const EXAMPLES: LookalikeExample[] = [
  { name: "Fake Dental A", website: "https://fixture-a.example", category: "dental-clinic" },
  { name: "Fake Dental B", website: "https://fixture-b.example", category: "dental-clinic" },
  { name: "Fake Dental C", website: "https://fixture-c.example", category: "dental-clinic" },
  { name: "Fake Dental Dead", website: "https://fixture-dead.example", category: "dental-clinic" },
];

// ---------------------------------------------------------------- build the profile once

const builder = makeFetch();
const profile: LookalikeProfile = await buildProfile(EXAMPLES, { fetchFn: builder.fn });

// ---------------------------------------------------------------- 1. hand-computed profile

checkEq("profile: usedCount is 3 usable examples", profile.usedCount, 3);

checkEq("profile: categories are dental clinic x3", profile.categories, [{ value: "dental clinic", count: 3 }]);

checkEq("profile: language is en-in x3", profile.languages, [{ value: "en-in", count: 3 }]);

checkEq(
  "profile: tech stack is wordpress x2 then wix x1",
  profile.techStack,
  [{ id: "wordpress", count: 2 }, { id: "wix", count: 1 }],
);

checkEq(
  "profile: contact routes contact-form / email / phone each x3",
  profile.contactRoutes,
  [{ route: "contact-form", count: 3 }, { route: "email", count: 3 }, { route: "phone", count: 3 }],
);

const expectedSignals = [
  { id: "has-email", count: 3, frequency: 3 / 3 },
  { id: "has-phone", count: 3, frequency: 3 / 3 },
  { id: "high-volume-enquiry-type", count: 3, frequency: 3 / 3 },
  { id: "no-chat-widget", count: 3, frequency: 3 / 3 },
  { id: "no-online-booking", count: 3, frequency: 3 / 3 },
  { id: "no-video-on-site", count: 3, frequency: 3 / 3 },
  { id: "outdated-copyright", count: 3, frequency: 3 / 3 },
  { id: "wordpress", count: 2, frequency: 2 / 3 },
  { id: "wix", count: 1, frequency: 1 / 3 },
];
checkEq("profile: signal frequencies match hand computation", profile.signals, expectedSignals);

const expectedKeywords = ["braces", "checkups", "clinic", "dental", "fake", "family", "offering", "pune", "staff", "team"];
checkEq(
  "profile: keywords are the 10 shared example words, each in all 3",
  profile.keywords,
  expectedKeywords.map((value) => ({ value, count: 3 })),
);

checkEq(
  "profile: absent signals are the universe minus the seen ones",
  profile.absentSignals,
  [
    "no-https", "not-mobile-friendly", "no-contact-form", "no-analytics", "shopify", "custom-cms",
    "has-whatsapp", "social-active-links", "slow-response", "ecommerce", "appointment-based",
  ],
);

checkEq("profile: size hint read from example text only", profile.sizeHints, ["staff 8"]);

checkEq(
  "profile: the failed example is skipped with a reason",
  profile.skipped,
  [{ example: "Fake Dental Dead", reason: "site-unreachable" }],
);

checkEq("profile: weights are exported and sum to 100", WEIGHTS.category + WEIGHTS.signal + WEIGHTS.keyword + WEIGHTS.language + WEIGHTS.tech + WEIGHTS.contact, 100);

// ---------------------------------------------------------------- 2. twinned vs distinct score

const twinFetch = makeFetch();
const twinLead = leadFor("Fake Dental A", "https://fixture-a.example", "dental-clinic");
const twinEnrichment = await enrich(twinLead, { fetchFn: twinFetch.fn });
check(
  "twin: enrich produced the expected wordpress/has-email/has-phone signals",
  ["wordpress", "has-email", "has-phone"].every((s) => twinEnrichment.signals.includes(s)),
  JSON.stringify(twinEnrichment.signals),
);

const twin = scoreLookalike(profile, twinLead, twinEnrichment);
check("twin: lead built like the examples scores high (>= 80)", twin.score >= 80, JSON.stringify(twin));
check("twin: reasons are 1 to 3", twin.reasons.length >= 1 && twin.reasons.length <= 3, JSON.stringify(twin.reasons));
check("twin: score is a whole number in 0..100", Number.isInteger(twin.score) && twin.score >= 0 && twin.score <= 100, String(twin.score));

const distinctFetch = makeFetch();
const distinctLead = leadFor("Fixture Widgetco Works", "https://fixture-distinct.example", "factory");
const distinctEnrichment = await enrich(distinctLead, { fetchFn: distinctFetch.fn });
const distinct = scoreLookalike(profile, distinctLead, distinctEnrichment);
check("distinct: a different lead scores low (<= 20)", distinct.score <= 20, JSON.stringify(distinct));

// ---------------------------------------------------------------- 3. reasons cite real profile values

function allowedCitations(p: LookalikeProfile): Map<string, Set<string>> {
  return new Map<string, Set<string>>([
    ["signal", new Set(p.signals.map((s) => s.id))],
    ["keyword", new Set(p.keywords.map((k) => k.value))],
    ["category", new Set(p.categories.map((c) => c.value))],
    ["language", new Set(p.languages.map((l) => l.value))],
    ["tech", new Set(p.techStack.map((t) => t.id))],
    ["contact route", new Set(p.contactRoutes.map((r) => r.route))],
  ]);
}

{
  const allowed = allowedCitations(profile);
  const kinds = "(signal|keyword|category|language|tech|contact route)";
  for (const reason of twin.reasons) {
    const match = reason.match(new RegExp(`^${kinds} (.+?) \\(`));
    const kind = match?.[1] ?? "";
    const value = match?.[2] ?? "";
    check(`reason cites a real ${kind || "value"}: ${reason}`, !!match && !!allowed.get(kind)?.has(value), reason);
  }
  check("distinct: no reasons when nothing matched", distinct.reasons.length === 0, JSON.stringify(distinct.reasons));
}

// ---------------------------------------------------------------- 4. fewer than 2 usable -> clear error

{
  const fewFetch = makeFetch();
  const examples: LookalikeExample[] = [
    { name: "Fake Dental A", website: "https://fixture-a.example", category: "dental-clinic" },
    { name: "Fake Dead One", website: "https://fixture-dead-one.example", category: "dental-clinic" },
    { name: "Fake Dead Two", website: "https://fixture-dead-two.example", category: "dental-clinic" },
  ];
  let error: unknown = null;
  try {
    await buildProfile(examples, { fetchFn: fewFetch.fn });
  } catch (caught) {
    error = caught;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  check("fewer than 2 usable: buildProfile throws", error instanceof Error, message);
  check("fewer than 2 usable: error names the 2-example minimum", /at least 2 usable examples/i.test(message), message);
  check("fewer than 2 usable: error counts usable vs required", /1 of 3/.test(message), message);
}

// ---------------------------------------------------------------- 5. explanation is grounded in example data

{
  const explanation = explainProfile(profile);
  const allowedWords = new Set<string>();
  const addTokens = (value: string): void => {
    for (const token of String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []) allowedWords.add(token);
  };
  EXPLAIN_CONNECTIVES.forEach(addTokens);
  profile.categories.forEach((c) => addTokens(c.value));
  profile.keywords.forEach((k) => addTokens(k.value));
  profile.signals.forEach((s) => addTokens(s.id));
  profile.absentSignals.forEach(addTokens);
  profile.languages.forEach((l) => addTokens(l.value));
  profile.techStack.forEach((t) => addTokens(t.id));
  profile.contactRoutes.forEach((r) => addTokens(r.route));
  profile.sizeHints.forEach(addTokens);
  profile.skipped.forEach((s) => { addTokens(s.example); addTokens(s.reason); });

  const words = [...new Set(explanation.toLowerCase().match(/[a-z]+/g) ?? [])].filter((word) => word.length > 1);
  const ungrounded = words.filter((word) => !allowedWords.has(word));
  check("explanation: every word comes from example data or connectives", ungrounded.length === 0, ungrounded.join(", "));
  check("explanation: mentions the usable example count", explanation.includes("3 usable examples"), explanation);
  check("explanation: reports the skipped example", /Fake Dental Dead/.test(explanation) && /site-unreachable/.test(explanation), explanation);
}

// ---------------------------------------------------------------- summary

console.log("");
console.log(`L31-lookalike: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed checks: ${failures.join("; ")}`);
  process.exitCode = 1;
}
