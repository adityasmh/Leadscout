// src/enrich-check.ts
// Proof for L4-enrich. Fixtures only, no real network calls: every fetch goes through an injected
// fetchFn. Run: npx tsx src/enrich-check.ts
//
// Covers, per the order: Indian phone formats; obfuscated email; image-name false positives dropped;
// each signal detected on a fixture that has it and absent on one that does not; summary uses only
// fixture text; robots disallow respected; timeout and unreachable site produce site-unreachable
// instead of throwing; no website path; body size cap.

import { readFileSync } from "node:fs";
import {
  MAX_BYTES,
  PAGE_TIMEOUT_MS,
  USER_AGENT,
  detectSignals,
  enrich,
  extractContacts,
  extractSocials,
  parseRobots,
  robotsAllows,
  summarize,
} from "./enrich.js";
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
  return readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url), "utf8");
}

const RICH_HTML = fixture("dental-rich.html");
const BARE_HTML = fixture("dental-bare.html");
const WIX_HTML = fixture("wix-site.html");
const SHOP_HTML = fixture("shopify-shop.html");
const CONTACT_HTML = fixture("contact.html");
const ABOUT_HTML = fixture("about.html");
const OBFUSCATED_HTML = fixture("obfuscated.html");

const SITE = "https://fakedental.example";
const SITE_URL = SITE + "/";
const BARE_URL = "https://fakebare.example/";
const CURRENT_YEAR = new Date().getFullYear();

// ---------------------------------------------------------------- fake fetch

const encoder = new TextEncoder();

function htmlRes(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

type Route = { match: (url: string) => boolean; respond: (url: string) => Response };
type Call = { url: string; init?: RequestInit };

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key === name);
    return found?.[1];
  }
  return (headers as Record<string, string>)[name];
}

function fakeFetch(routes: Route[]): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn: typeof fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find((item) => item.match(url));
    if (!route) throw new Error(`fake fetch: no route for ${url}`);
    return route.respond(url);
  };
  return { fn, calls };
}

function siteRoutes(overrides: { robots?: Response; home?: Response; contact?: Response; about?: Response } = {}): Route[] {
  return [
    { match: (url) => url.endsWith("/robots.txt"), respond: () => overrides.robots ?? htmlRes("User-agent: *\nDisallow:\n", 200, { "content-type": "text/plain" }) },
    { match: (url) => url === SITE_URL, respond: () => overrides.home ?? htmlRes(RICH_HTML) },
    { match: (url) => url.includes("/contact.html"), respond: () => overrides.contact ?? htmlRes(CONTACT_HTML) },
    { match: (url) => url.includes("/about.html"), respond: () => overrides.about ?? htmlRes(ABOUT_HTML) },
  ];
}

const LEAD: RawLead = {
  name: "Fake Dental Care",
  category: "dental-clinic",
  city: "Pune",
  country: "India",
  source: "osm",
  sourceUrl: "https://www.openstreetmap.org/node/1",
  website: "fakedental.example",
  phone: "+91 90000 00001",
  email: "hello@fakedental.example",
};

// ---------------------------------------------------------------- 1. phones

{
  const contacts = extractContacts(RICH_HTML);
  check("phone: +91 mobile with spaces -> +919000000001", contacts.phones.includes("+919000000001"), JSON.stringify(contacts.phones));
  check("phone: 0xx-xxxxxxx landline -> 02040000002", contacts.phones.includes("02040000002"), JSON.stringify(contacts.phones));
  check("phone: bare 10 digit mobile starting 9 -> 9000000003", contacts.phones.includes("9000000003"), JSON.stringify(contacts.phones));
  check("phone: international E.164 -> +442079460003", contacts.phones.includes("+442079460003"), JSON.stringify(contacts.phones));
  check("phone: wa.me number is also listed as a phone", contacts.phones.includes("+919000000004"), JSON.stringify(contacts.phones));
  checkEq("phone: exactly the five real numbers", contacts.phones.length, 5);
  check(
    "phone: every value is a valid Indian or E.164 shape",
    contacts.phones.every((phone) => /^(?:\+\d{8,15}|0\d{9,11}|\d{10})$/.test(phone)),
    JSON.stringify(contacts.phones),
  );
  check(
    "phone: 10 digits not starting 6-9 are rejected",
    extractContacts("<p>Order number: 5345678901</p>").phones.length === 0,
    JSON.stringify(extractContacts("<p>Order number: 5345678901</p>").phones),
  );
  check(
    "phone: too-short and year-like runs are rejected",
    extractContacts("<p>Pin 411001 and year 2019</p>").phones.length === 0,
    JSON.stringify(extractContacts("<p>Pin 411001 and year 2019</p>").phones),
  );
  check("phone: tel: links are used", RICH_HTML.includes("tel:+919000000001") && contacts.phones.includes("+919000000001"));
}

// ---------------------------------------------------------------- 2. emails

{
  const contacts = extractContacts(OBFUSCATED_HTML);
  check("email: plain mailto kept", contacts.emails.includes("info@fakedental.example"), JSON.stringify(contacts.emails));
  check("email: 'name [at] domain [dot] com' decoded", contacts.emails.includes("reception@fakedental.example"), JSON.stringify(contacts.emails));
  check("email: 'name(at)domain(dot)com' decoded", contacts.emails.includes("bookings@fakedental.example"), JSON.stringify(contacts.emails));
  checkEq("email: exactly the three real addresses", contacts.emails.length, 3);
  check(
    "email: no image file names survive (logo@2x.png, hero@3x.jpg, sprite@1x.gif)",
    !contacts.emails.some((email) => /\.(png|jpg|jpeg|gif|svg|webp|ico|css|js)$/i.test(email) || /^(logo|hero|sprite)/i.test(email)),
    JSON.stringify(contacts.emails),
  );
  for (const bad of ["logo@2x.png", "hero@3x.jpg", "sprite@1x.gif"]) {
    check(`email: image name '${bad}' dropped`, !contacts.emails.includes(bad), JSON.stringify(contacts.emails));
  }
  for (const bad of ["your@email.com", "name@domain.com", "someone@example.com", "sales@yourdomain.com"]) {
    check(`email: template field '${bad}' dropped`, !contacts.emails.includes(bad), JSON.stringify(contacts.emails));
  }
  check(
    "email: broken mailto is ignored",
    !contacts.emails.some((email) => email.includes("%20") || email.length < 6),
  );
  checkEq("whatsapp: wa.me and api.whatsapp.com canonicalised", contacts.whatsapp, ["https://wa.me/919000000004", "https://wa.me/919000000005"]);
}

// ---------------------------------------------------------------- 3. socials

{
  const socials = extractSocials(RICH_HTML);
  checkEq("socials: facebook profile wins over the sharer link", socials.facebook, "https://facebook.com/fakedentalcare");
  checkEq("socials: instagram profile", socials.instagram, "https://instagram.com/fakedentalcare");
  checkEq("socials: whatsapp link", socials.whatsapp, "https://wa.me/919000000004");
  checkEq("socials: bare fixture has none", JSON.stringify(extractSocials(BARE_HTML)), "{}");
}

// ---------------------------------------------------------------- 4. signals

const CONTRACT_SIGNALS = new Set([
  "no-website", "no-https", "not-mobile-friendly", "no-contact-form", "no-chat-widget", "no-online-booking",
  "no-analytics", "outdated-copyright", "wordpress", "wix", "shopify", "custom-cms", "has-whatsapp",
  "has-email", "has-phone", "social-active-links", "slow-response", "site-unreachable", "ecommerce",
  "appointment-based", "high-volume-enquiry-type",
]);

{
  const freshCopyright = `<html lang="en"><head><title>Fresh Fake Co</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Fresh Fake Co</h1><footer>(c) ${CURRENT_YEAR} Fresh Fake Co</footer></body></html>`;
  const cases: Array<{ signal: string; present: string; presentUrl: string; absent: string; absentUrl: string }> = [
    { signal: "no-https", present: RICH_HTML, presentUrl: "http://fakedental.example/", absent: RICH_HTML, absentUrl: SITE_URL },
    { signal: "not-mobile-friendly", present: BARE_HTML, presentUrl: BARE_URL, absent: RICH_HTML, absentUrl: SITE_URL },
    { signal: "no-contact-form", present: BARE_HTML, presentUrl: BARE_URL, absent: RICH_HTML, absentUrl: SITE_URL },
    { signal: "no-chat-widget", present: BARE_HTML, presentUrl: BARE_URL, absent: RICH_HTML, absentUrl: SITE_URL },
    { signal: "no-online-booking", present: BARE_HTML, presentUrl: BARE_URL, absent: RICH_HTML, absentUrl: SITE_URL },
    { signal: "no-analytics", present: BARE_HTML, presentUrl: BARE_URL, absent: RICH_HTML, absentUrl: SITE_URL },
    { signal: "outdated-copyright", present: BARE_HTML, presentUrl: BARE_URL, absent: freshCopyright, absentUrl: SITE_URL },
    { signal: "wordpress", present: RICH_HTML, presentUrl: SITE_URL, absent: BARE_HTML, absentUrl: BARE_URL },
    { signal: "wix", present: WIX_HTML, presentUrl: "https://fakewix.example/", absent: RICH_HTML, absentUrl: SITE_URL },
    { signal: "shopify", present: SHOP_HTML, presentUrl: "https://fakeshop.example/", absent: RICH_HTML, absentUrl: SITE_URL },
    { signal: "custom-cms", present: BARE_HTML, presentUrl: BARE_URL, absent: RICH_HTML, absentUrl: SITE_URL },
    { signal: "ecommerce", present: SHOP_HTML, presentUrl: "https://fakeshop.example/", absent: RICH_HTML, absentUrl: SITE_URL },
    { signal: "has-email", present: RICH_HTML, presentUrl: SITE_URL, absent: BARE_HTML, absentUrl: BARE_URL },
    { signal: "has-phone", present: RICH_HTML, presentUrl: SITE_URL, absent: BARE_HTML, absentUrl: BARE_URL },
    { signal: "has-whatsapp", present: RICH_HTML, presentUrl: SITE_URL, absent: BARE_HTML, absentUrl: BARE_URL },
    { signal: "social-active-links", present: RICH_HTML, presentUrl: SITE_URL, absent: BARE_HTML, absentUrl: BARE_URL },
    { signal: "appointment-based", present: RICH_HTML, presentUrl: SITE_URL, absent: BARE_HTML, absentUrl: BARE_URL },
  ];
  for (const item of cases) {
    const present = detectSignals(item.present, {}, item.presentUrl);
    const absent = detectSignals(item.absent, {}, item.absentUrl);
    check(`signal ${item.signal}: detected on a fixture that has it`, present.includes(item.signal), JSON.stringify(present));
    check(`signal ${item.signal}: absent on a fixture that does not`, !absent.includes(item.signal), JSON.stringify(absent));
  }

  const seen = new Set<string>();
  for (const html of [RICH_HTML, BARE_HTML, WIX_HTML, SHOP_HTML, OBFUSCATED_HTML]) {
    for (const signal of detectSignals(html, {}, SITE_URL)) seen.add(signal);
  }
  const unknown = [...seen].filter((signal) => !CONTRACT_SIGNALS.has(signal));
  check("signals: every detected id is in the CONTRACT list", unknown.length === 0, unknown.join(", "));
  check(
    "signals: rich fixture has analytics (so no no-analytics signal)",
    !detectSignals(RICH_HTML, {}, SITE_URL).includes("no-analytics"),
    JSON.stringify(detectSignals(RICH_HTML, {}, SITE_URL)),
  );
  check(
    "signals: x-powered-by header yields custom-cms",
    detectSignals("<html><body>hi</body></html>", { "x-powered-by": "Drupal" }, SITE_URL).includes("custom-cms"),
  );
}

// ---------------------------------------------------------------- 5. summary

{
  const summary = summarize(RICH_HTML);
  check("summary: uses the fixture meta description", summary.includes("family dentistry"), summary);
  check(
    "summary: 1 to 2 sentences",
    summary.split(/(?<=[.!?])\s+/).filter(Boolean).length <= 2,
    summary,
  );
  const words = summary.toLowerCase().match(/[a-z]{5,}/g) ?? [];
  const invented = words.filter((word) => !RICH_HTML.toLowerCase().includes(word));
  check("summary: every word appears in the fixture (no imagination)", invented.length === 0, invented.join(", "));
  check(
    "summary: thin fixture says so instead of guessing",
    /not enough public text/i.test(summarize(BARE_HTML)),
    summarize(BARE_HTML),
  );
  check(
    "summary: thin fixture keeps the real page title",
    summarize(BARE_HTML).includes("Fake Dental"),
    summarize(BARE_HTML),
  );
  check(
    "summary: heading-only page is described from the heading",
    summarize("<html><body><h1>Fake Yoga Studio in Pune</h1></body></html>").includes("Fake Yoga Studio in Pune"),
    summarize("<html><body><h1>Fake Yoga Studio in Pune</h1></body></html>"),
  );
}

// ---------------------------------------------------------------- 6. robots.txt parsing

{
  check(
    "robots: a Leadscout group wins over the * group",
    !robotsAllows("/nope", parseRobots("User-agent: *\nDisallow: /private\nUser-agent: Leadscout\nDisallow: /nope\n")) &&
      robotsAllows("/private", parseRobots("User-agent: *\nDisallow: /private\nUser-agent: Leadscout\nDisallow: /nope\n")),
  );
  check(
    "robots: disallow prefix blocks and root stays allowed",
    !robotsAllows("/admin/x", parseRobots("User-agent: *\nDisallow: /admin\n")) && robotsAllows("/", parseRobots("User-agent: *\nDisallow: /admin\n")),
  );
  check("robots: empty Disallow allows everything", robotsAllows("/anything", parseRobots("User-agent: *\nDisallow:\n")));
  check(
    "robots: longest matching rule wins",
    robotsAllows("/private/public/x", parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/public\n")),
  );
}

// ---------------------------------------------------------------- 7. enrich end to end (fixtures)

{
  const { fn, calls } = fakeFetch(siteRoutes());
  const enrichment = await enrich(LEAD, { fetchFn: fn });
  checkEq(
    "enrich: robots.txt, homepage, one contact page and one about page, in that order",
    calls.map((call) => call.url),
    [`${SITE}/robots.txt`, SITE_URL, `${SITE}/contact.html`, `${SITE}/about.html`],
  );
  checkEq("enrich: fetchedUrl is the homepage", enrichment.fetchedUrl, SITE_URL);
  checkEq("enrich: title from the homepage", enrichment.title, "Fake Dental Care | Dentist in Fake Nagar, Pune (fixture)");
  check("enrich: description from the homepage", String(enrichment.description).includes("family dentistry"), String(enrichment.description));
  checkEq("enrich: language from the lang attribute", enrichment.language, "en-in");
  check("enrich: summary from the homepage text", enrichment.summary.includes("family dentistry"), enrichment.summary);
  check(
    "enrich: emails merged from homepage and contact page",
    enrichment.emails.includes("hello@fakedental.example") && enrichment.emails.includes("appointments@fakedental.example"),
    JSON.stringify(enrichment.emails),
  );
  checkEq("enrich: lead email is deduped, not duplicated", enrichment.emails.length, 2);
  check(
    "enrich: phones merged, lead phone deduped",
    enrichment.phones.length === 5 && enrichment.phones.includes("9000000003") && enrichment.phones.includes("+442079460003"),
    JSON.stringify(enrichment.phones),
  );
  checkEq("enrich: socials facebook", enrichment.socials.facebook, "https://facebook.com/fakedentalcare");
  checkEq("enrich: socials instagram", enrichment.socials.instagram, "https://instagram.com/fakedentalcare");
  checkEq("enrich: socials whatsapp", enrichment.socials.whatsapp, "https://wa.me/919000000004");
  checkEq("enrich: no invented social keys", Object.keys(enrichment.socials).sort().join(","), "facebook,instagram,whatsapp");
  for (const signal of ["wordpress", "has-email", "has-phone", "has-whatsapp", "social-active-links", "appointment-based", "high-volume-enquiry-type"]) {
    check(`enrich: signal ${signal} present`, enrichment.signals.includes(signal), JSON.stringify(enrichment.signals));
  }
  for (const signal of ["site-unreachable", "no-website", "no-contact-form", "no-chat-widget", "no-online-booking", "no-analytics", "outdated-copyright", "ecommerce"]) {
    check(`enrich: signal ${signal} absent`, !enrichment.signals.includes(signal), JSON.stringify(enrichment.signals));
  }
  const homeCall = calls.find((call) => call.url === SITE_URL);
  checkEq("enrich: polite User-Agent on page requests", String(headerValue(homeCall?.init, "User-Agent")), USER_AGENT);
  check("enrich: every page request carries an abort signal", !!homeCall?.init?.signal, "no signal");
  checkEq("enrich: page timeout is 8 seconds", PAGE_TIMEOUT_MS, 8000);
}

// ---------------------------------------------------------------- 8. robots disallow respected

{
  const { fn, calls } = fakeFetch(siteRoutes({ robots: htmlRes("User-agent: *\nDisallow: /contact\n", 200, { "content-type": "text/plain" }) }));
  const enrichment = await enrich(LEAD, { fetchFn: fn });
  const urls = calls.map((call) => call.url);
  check("robots: disallowed contact page was never fetched", !urls.includes(`${SITE}/contact.html`), JSON.stringify(urls));
  check("robots: allowed about page was fetched", urls.includes(`${SITE}/about.html`), JSON.stringify(urls));
  checkEq("robots: only robots.txt, homepage and about page were requested", urls, [`${SITE}/robots.txt`, SITE_URL, `${SITE}/about.html`]);
  check("robots: contact page email is therefore absent", !enrichment.emails.includes("appointments@fakedental.example"), JSON.stringify(enrichment.emails));
  check("robots: homepage email still present", enrichment.emails.includes("hello@fakedental.example"), JSON.stringify(enrichment.emails));
}

// ---------------------------------------------------------------- 9. timeout and unreachable

{
  const timeout = fakeFetch([
    { match: (url) => url.endsWith("/robots.txt"), respond: () => htmlRes("not found", 404, { "content-type": "text/plain" }) },
    {
      match: () => true,
      respond: () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      },
    },
  ]);
  let threw = false;
  let enrichment: Enrichment | null = null;
  try {
    enrichment = await enrich(LEAD, { fetchFn: timeout.fn });
  } catch {
    threw = true;
  }
  check("timeout: enrich does not throw", !threw);
  check("timeout: site-unreachable signal", !!enrichment && enrichment.signals.includes("site-unreachable"), JSON.stringify(enrichment?.signals));
  check("timeout: high-volume-enquiry-type signal for dental-clinic", !!enrichment && enrichment.signals.includes("high-volume-enquiry-type"), JSON.stringify(enrichment?.signals));
  check("timeout: summary explains the timeout", !!enrichment && /could not be read/i.test(enrichment.summary) && /timed out/i.test(enrichment.summary), enrichment?.summary ?? "");

  const fiveHundred = fakeFetch([
    { match: (url) => url.endsWith("/robots.txt"), respond: () => htmlRes("not found", 404, { "content-type": "text/plain" }) },
    { match: () => true, respond: () => htmlRes("<html><body>server error</body></html>", 500) },
  ]);
  let threw500 = false;
  let enrichment500: Enrichment | null = null;
  try {
    enrichment500 = await enrich(LEAD, { fetchFn: fiveHundred.fn });
  } catch {
    threw500 = true;
  }
  check("unreachable: enrich does not throw on HTTP 500", !threw500);
  check("unreachable: site-unreachable signal", !!enrichment500 && enrichment500.signals.includes("site-unreachable"), JSON.stringify(enrichment500?.signals));
  check("unreachable: high-volume-enquiry-type signal for dental-clinic", !!enrichment500 && enrichment500.signals.includes("high-volume-enquiry-type"), JSON.stringify(enrichment500?.signals));
  check("unreachable: summary mentions HTTP 500", !!enrichment500 && /HTTP 500/.test(enrichment500.summary), enrichment500?.summary ?? "");
  checkEq("unreachable: only robots.txt and the homepage were tried", fiveHundred.calls.length, 2);
}

// ---------------------------------------------------------------- 10. no website

{
  const never = fakeFetch([
    {
      match: () => true,
      respond: () => {
        throw new Error("fetch must not be called when there is no website");
      },
    },
  ]);
  const noWebsiteLead: RawLead = { ...LEAD, website: undefined };
  const enrichment = await enrich(noWebsiteLead, { fetchFn: never.fn });
  checkEq("no-website: signal includes ['no-website', 'high-volume-enquiry-type']", enrichment.signals, ["no-website", "high-volume-enquiry-type"]);
  const factoryLead: RawLead = { ...LEAD, website: undefined, category: "factory" };
  const factoryEnrichment = await enrich(factoryLead, { fetchFn: never.fn });
  checkEq("no-website: non-high-volume category has only ['no-website']", factoryEnrichment.signals, ["no-website"]);
  check(
    "no-website: summary states only the category and place",
    enrichment.summary.includes("dental-clinic") && enrichment.summary.includes("Pune, India") && /no website is on record/i.test(enrichment.summary),
    enrichment.summary,
  );
  checkEq("no-website: no fetch at all", never.calls.length, 0);
  checkEq("no-website: lead email kept", enrichment.emails, ["hello@fakedental.example"]);
  checkEq("no-website: lead phone kept", enrichment.phones, ["+919000000001"]);
  checkEq("no-website: summary never mentions the business name", enrichment.summary.includes("Fake Dental Care"), false);
}

// ---------------------------------------------------------------- 11. body size cap

{
  const filler = "x".repeat(MAX_BYTES + 4096);
  const bigHtml =
    `<html><head><title>Big Fake Co</title>` +
    `<meta name="description" content="Big Fake Co sells fake widgets and fake gadgets from a fake factory in Pune, India.">` +
    `</head><body><!--${filler}--><h1>CANARY_BEYOND_CAP</h1></body></html>`;
  const capFetch = fakeFetch([
    { match: (url) => url.endsWith("/robots.txt"), respond: () => htmlRes("not found", 404, { "content-type": "text/plain" }) },
    { match: () => true, respond: () => htmlRes(bigHtml) },
  ]);
  const enrichment = await enrich({ ...LEAD, website: "bigfake.example" }, { fetchFn: capFetch.fn });
  checkEq("body cap: MAX_BYTES is 1.5 MB", MAX_BYTES, 1_572_864);
  checkEq("body cap: title read from before the cut", enrichment.title, "Big Fake Co");
  check("body cap: summary read from before the cut", enrichment.summary.includes("fake widgets"), enrichment.summary);
  check("body cap: high-volume-enquiry-type signal for dental-clinic", enrichment.signals.includes("high-volume-enquiry-type"), JSON.stringify(enrichment.signals));
  check(
    "body cap: content after 1.5 MB was dropped",
    !JSON.stringify(enrichment).includes("CANARY_BEYOND_CAP"),
    JSON.stringify(enrichment).slice(0, 200),
  );
  checkEq("body cap: only robots.txt and the homepage were requested", capFetch.calls.length, 2);
}

// ---------------------------------------------------------------- summary

console.log("");
console.log(`Fixtures: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed checks: ${failures.join("; ")}`);
  process.exitCode = 1;
}
