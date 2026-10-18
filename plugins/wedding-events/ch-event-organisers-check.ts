// Order WE7 proof: offline check for the ch-event-organisers channel adapter.
// Every fixture is clearly fake (fixture-*.example content on platform-shaped
// URLs) and every transport (search, page read, robots fetch, browser) is
// injected, so nothing dials out. Does not import src/company/, so the
// sandbox-company-root preamble is not needed.
// Run (from the repo root):
//   npx tsx src/channels/ch-event-organisers-check.ts
import assert from "node:assert/strict";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { BrowserReaderLike, ChannelDeps } from "../../src/channels/types.js";
import {
  eventOrganisers, parseListingPage, parseEventProfile, eventOrganisersSignals,
  EVENT_ORGANISERS_CHANNEL_ID,
} from "./ch-event-organisers.js";
import { channelAdapters } from "../../src/channels/registry.js";
import type { RawLead } from "../../src/types.js";
import type { ReachResult } from "../../src/reach.js";

// --- fixture URLs (platform-shaped; content is fake) ------------------------
const U1 = "https://allevents.in/chennai/fixture-events-co";
const U2 = "https://insider.in/chennai/fixture-live-productions";
const U3 = "https://www.eventbrite.in/o/fixture-wedding-studio-000000";
const BLOCKED_URL = "https://insider.in/chennai/fixture-locked-page";
const PRIVATE_URL = "https://allevents.in/private/fixture-secret";
const PROFILE_OK_URL = "https://allevents.in/organiser/fixture-events-co";

// --- listing-page fixtures (3), normalised label structure the parser copies -
const LIST1 = `
Organiser: Fixture Events Co
City: Chennai
Area: Adyar
Phone: +91 90000 00001
Website: https://fixture-events.example/
Events: 42
Event types: weddings, concerts, corporate

Organiser: Fixture Celebrations
Category: photographer
City: Chennai
Area: T. Nagar
Events: 8
Event types: weddings, engagements
`;

const LIST2 = `
Name: Fixture Live Productions
City: Chennai
Area: Nungambakkam
Events: 120
Website: https://fixture-live.example/
Event types: music, comedy, festivals
`;

const LIST3 = `
Name: Fixture Wedding Studio
City: Chennai
Events: 5
Event types: weddings, exhibitions
`;

const PAGES: Record<string, string> = {
  [U1]: LIST1,
  [U2]: LIST2,
  [U3]: LIST3,
  [PROFILE_OK_URL]: "", // overwritten below once PROFILE fixtures are declared
};

// --- profile fixtures (2), one rich and one behind a blocked page -----------
const PROFILE_OK = `
Name: Fixture Events Co
Category: event-company
City: Chennai
Portfolio photos: 24
Starting price: INR 1,50,000
Services: event planning, decor, catering
12 Years in Business
Sales 4.6/5
Based on 128 Reviews
Website: https://fixture-events.example/
Instagram: https://instagram.com/fixtureevents
Facebook: https://facebook.com/fixtureevents
`;

const PROFILE_BLOCKED = `
Name: Fixture Blocked Organisers
City: Chennai
Portfolio photos: 3
Services: weddings
`;
PAGES[PROFILE_OK_URL] = PROFILE_OK;

// --- fakes -------------------------------------------------------------------
function reachOk(text: string): Promise<ReachResult> {
  return Promise.resolve({ ok: true, channel: "fixture", text, untrusted: true, trace: [] });
}
function reachBlockedFake(): Promise<ReachResult> {
  return Promise.resolve({ ok: false, channel: "fixture", text: "HTTP 403 blocked", untrusted: true, trace: [], error: "HTTP 403" });
}

const SEARCH_TEXT = ["Results:", U1, U2, U3, BLOCKED_URL].join("\n");
const ROBOTS_ALLOW = "User-agent: *\nAllow: /\n";
const ROBOTS_DENY = "User-agent: *\nDisallow: /private/\n";

type Counters = { reads: number; sleeps: number; searches: number; robots: number };

function makeDeps(over: Partial<ChannelDeps> = {}, robots = ROBOTS_ALLOW): { deps: ChannelDeps; c: Counters } {
  const c: Counters = { reads: 0, sleeps: 0, searches: 0, robots: 0 };
  const deps: ChannelDeps = {
    search: () => { c.searches += 1; return reachBlockedFake(); },
    readPage: (url: string) => {
      c.reads += 1;
      if (url === BLOCKED_URL) return reachBlockedFake();
      const body = PAGES[url];
      if (body === undefined || body === "") return reachBlockedFake();
      return reachOk(body);
    },
    fetchFn: (async (url: string) => {
      c.robots += 1;
      return { ok: true, text: async () => (String(url).endsWith("/robots.txt") ? robots : "") };
    }) as unknown as typeof fetch,
    limiter: { sleep: async () => { c.sleeps += 1; } },
    now: () => 0,
    ...over,
  };
  return { deps, c };
}

// Discover tests need search to return the fixture listing URLs.
function listingDeps(robots = ROBOTS_ALLOW): { deps: ChannelDeps; c: Counters } {
  return makeDeps({ search: () => reachOk(SEARCH_TEXT) }, robots);
}

function fakeBrowser(text: string): BrowserReaderLike {
  return {
    read: async (url: string) => ({ text, url }),
    search: async (site: string, query: string) => ({ text, url: `https://www.${site}/search?q=${query}` }),
    status: () => ({ enabled: true, killSwitch: false, backends: { opencli: { ok: true }, cdp: { ok: false, url: "http://127.0.0.1:9222" } } }),
  } as unknown as BrowserReaderLike;
}

const lead = (name: string): RawLead => ({
  name,
  category: "wedding-planner",
  city: "Chennai",
  source: EVENT_ORGANISERS_CHANNEL_ID,
  sourceUrl: PROFILE_OK_URL,
});

const results: string[] = [];
function pass(n: number, name: string): void {
  const line = `PASS ${n} ${name}`;
  results.push(line);
  console.log(line);
}
function fail(n: number, name: string, err: unknown): never {
  const msg = `FAIL ${n} ${name}: ${(err as Error).message}`;
  results.push(msg);
  console.log(msg);
  throw err;
}

// ============================================================================

async function main(): Promise<void> {
  const prev = process.env.CHANNEL_CH_EVENT_ORGANISERS;
  delete process.env.CHANNEL_CH_EVENT_ORGANISERS;

  try {
    // 1. registered; status off by default, on only with the env var
    try {
      assert.ok(channelAdapters().includes(eventOrganisers), "adapter self-registered via import");
      const off = eventOrganisers.status();
      assert.equal(off.enabled, false, "off by default");
      assert.match(off.why ?? "", /CHANNEL_CH_EVENT_ORGANISERS/, `why names the env var: ${off.why}`);
      assert.equal(eventOrganisers.tier, "B", "tier B");
      process.env.CHANNEL_CH_EVENT_ORGANISERS = "0";
      assert.equal(eventOrganisers.status().enabled, false, "=0 stays off");
      process.env.CHANNEL_CH_EVENT_ORGANISERS = "1";
      assert.equal(eventOrganisers.status().enabled, true, "=1 turns it on");
      pass(1, "status off by default, on only with CHANNEL_CH_EVENT_ORGANISERS=1");
    } catch (err) {
      fail(1, "status off by default, on only with CHANNEL_CH_EVENT_ORGANISERS=1", err);
    } finally {
      delete process.env.CHANNEL_CH_EVENT_ORGANISERS;
    }

    // 2. discovery: fixture search -> RawLead with source URL, category, eventCount
    try {
      const { deps } = listingDeps();
      const leads = await eventOrganisers.discover({ category: "wedding-planner", city: "Chennai", limit: 10 }, deps);
      assert.equal(leads.length, 4, `4 leads from the 3 listing pages, got ${leads.length}`);
      const urls = new Set([U1, U2, U3]);
      for (const l of leads) {
        assert.ok(urls.has(l.sourceUrl), `sourceUrl is a listing URL: ${l.sourceUrl}`);
        assert.equal(l.source, EVENT_ORGANISERS_CHANNEL_ID, "source id");
        assert.ok(l.category, "source category present");
      }
      assert.equal(leads[0].name, "Fixture Events Co", `first name: ${leads[0].name}`);
      assert.equal(leads[0].eventCount, 42, `eventCount copied: ${leads[0].eventCount}`);
      assert.equal(leads[0].address, "Adyar", "area -> address");
      assert.equal(leads[0].phone, "+91 90000 00001", "phone copied");
      assert.equal(leads[0].website, "https://fixture-events.example/", "website copied");
      assert.equal(leads[1].category, "photographer", "explicit canonical Category label kept");
      pass(2, "discover turns fixture listings into RawLead with source URLs, category and eventCount");
    } catch (err) {
      fail(2, "discover turns fixture listings into RawLead with source URLs, category and eventCount", err);
    }

    // 3. pagination across pages and the limit are respected
    try {
      const a = listingDeps();
      const all = await eventOrganisers.discover({ category: "wedding-planner", city: "Chennai", limit: 10 }, a.deps);
      assert.equal(all.length, 4, "all three listing pages were paged");
      assert.equal(a.c.reads, 4, `read attempt for each non-robots page (3 listings + 1 blocked), got ${a.c.reads}`);
      assert.equal(a.c.sleeps, a.c.reads - 1, `polite pause between pages (${a.c.sleeps} of ${a.c.reads - 1})`);

      const b = listingDeps();
      const one = await eventOrganisers.discover({ category: "wedding-planner", city: "Chennai", limit: 1 }, b.deps);
      assert.equal(one.length, 1, "limit 1 yields exactly one lead");
      const two = await eventOrganisers.discover({ category: "wedding-planner", city: "Chennai", limit: 2 }, listingDeps().deps);
      assert.equal(two.length, 2, "limit 2 yields exactly two leads");
      pass(3, "pagination pages through listings and never exceeds the limit");
    } catch (err) {
      fail(3, "pagination pages through listings and never exceeds the limit", err);
    }

    // 4. a blocked / changed page returns [] with no throw; robots.txt is honoured
    try {
      const blockedOnly = makeDeps({
        search: () => reachOk(`Results:\n${BLOCKED_URL}`),
      });
      const none = await eventOrganisers.discover({ category: "wedding-planner", city: "Chennai", limit: 10 }, blockedOnly.deps);
      assert.deepEqual(none, [], "a blocked listing page yields [] and does not throw");

      const robotsDenied = makeDeps({ search: () => reachOk(`Results:\n${PRIVATE_URL}`) }, ROBOTS_DENY);
      const skipped = await eventOrganisers.discover({ category: "wedding-planner", city: "Chennai", limit: 10 }, robotsDenied.deps);
      assert.deepEqual(skipped, [], "a robots.txt-disallowed listing is skipped");
      assert.ok(robotsDenied.c.robots >= 1, "robots.txt was actually fetched through the injected fetchFn");
      pass(4, "blocked page returns [] (no throw) and robots.txt is honoured");
    } catch (err) {
      fail(4, "blocked page returns [] (no throw) and robots.txt is honoured", err);
    }

    // 5. enrich extracts each listed field from a profile page
    try {
      const { deps } = makeDeps();
      const ev = await eventOrganisers.enrich(lead("Fixture Events Co"), deps);
      assert.equal(ev.via, "page", "readPage wins the chain when search is blocked");
      assert.equal(ev.untrusted, true, "evidence marked untrusted");
      assert.equal(ev.channel, EVENT_ORGANISERS_CHANNEL_ID);
      const want: Record<string, string | number> = {
        name: "Fixture Events Co",
        category: "event-company",
        portfolioPhotoCount: 24,
        reviewCount: 128,
        rating: 4.6,
        priceBand: "INR 1,50,000",
        services: "event planning, decor, catering",
        yearsInBusiness: 12,
        website: "https://fixture-events.example/",
        instagram: "https://instagram.com/fixtureevents",
        facebook: "https://facebook.com/fixtureevents",
      };
      for (const [k, v] of Object.entries(want)) {
        assert.deepEqual(ev.fields[k], v, `field ${k} extracted verbatim (got ${JSON.stringify(ev.fields[k])})`);
      }
      assert.ok(ev.signals.includes("portfolio-no-video"), `no video on the rich profile: [${ev.signals.join(", ")}]`);
      pass(5, "enrich extracts photo count, reviews, rating, price, socials, services, years");
    } catch (err) {
      fail(5, "enrich extracts photo count, reviews, rating, price, socials, services, years", err);
    }

    // 6. the blocked profile: search + page blocked -> browser fallback, still untrusted
    try {
      const { deps } = makeDeps({ search: () => reachBlockedFake(), readPage: () => reachBlockedFake(), browser: fakeBrowser(PROFILE_BLOCKED) });
      const ev = await eventOrganisers.enrich(lead("Fixture Blocked Organisers"), deps);
      assert.equal(ev.via, "browser", "blocked search+page -> browser fallback");
      assert.equal(ev.untrusted, true, "browser evidence is untrusted");
      assert.equal(ev.fields.name, "Fixture Blocked Organisers", "browser text parsed like any other");

      const wall = await eventOrganisers.enrich(lead("Fixture Blocked Organisers"), makeDeps({
        search: () => reachBlockedFake(), readPage: () => reachBlockedFake(),
        browser: { ...(fakeBrowser("") as BrowserReaderLike), read: async () => { throw new BrowserBlockedError("sign in to continue (fixture login wall)", EVENT_ORGANISERS_CHANNEL_ID, false); } },
      }).deps);
      assert.equal(wall.signals.includes("needs-human"), true, "login wall -> needs-human");
      assert.equal(wall.untrusted, true, "needs-human evidence is untrusted");
      pass(6, "blocked profile falls back to the browser and a login wall gives needs-human");
    } catch (err) {
      fail(6, "blocked profile falls back to the browser and a login wall gives needs-human", err);
    }

    // 7. each signal fires on matching text and not on text that lacks it
    try {
      const pairs: [string, string, string][] = [
        ["Portfolio photos: 20, see our gallery.", "Call us to discuss your event.", "portfolio-no-video"],
        ["Watch our film: https://youtube.com/watch?v=fixture", "Photos and a gallery of our work.", "has-video-portfolio"],
        ["New reel posted 5 days ago.", "New reel posted 120 days ago.", "social-video-active"],
        ["Last post was 120 days ago.", "New post 3 days ago.", "social-inactive"],
        ["Based on 128 Reviews.", "Based on 12 Reviews.", "high-review-count"],
        ["Featured organiser on the platform.", "A local organiser.", "premium-listing"],
        ["A multi-city organiser.", "A single-city organiser.", "multi-city"],
        ["Starting price: INR 50,000", "Contact us for a quote.", "price-band-known"],
      ];
      for (const [pos, neg, mustFire] of pairs) {
        const sPos = eventOrganisersSignals(pos);
        const sNeg = eventOrganisersSignals(neg);
        assert.ok(sPos.includes(mustFire), `${mustFire} fires on the positive text — got [${sPos.join(", ")}]`);
        assert.ok(!sNeg.includes(mustFire), `${mustFire} must NOT fire on the negative text — got [${sNeg.join(", ")}]`);
        assert.equal(sPos.filter((s) => s === mustFire).length, 1, "no duplicate signal ids");
      }
      pass(7, "each signal fires only on matching text (positive and negative)");
    } catch (err) {
      fail(7, "each signal fires only on matching text (positive and negative)", err);
    }

    // 8. every fetched text is untrusted: true
    try {
      const { deps } = makeDeps();
      const ev = await eventOrganisers.enrich(lead("Fixture Events Co"), deps);
      assert.equal(ev.untrusted, true, "evidence.untrusted is literal true");
      const ok = await reachOk("x");
      const blocked = await reachBlockedFake();
      assert.equal(ok.untrusted, true, "ok reach result is untrusted");
      assert.equal(blocked.untrusted, true, "blocked reach result is untrusted");
      pass(8, "every fetched text (and every evidence) is untrusted: true");
    } catch (err) {
      fail(8, "every fetched text (and every evidence) is untrusted: true", err);
    }
  } finally {
    if (prev === undefined) delete process.env.CHANNEL_CH_EVENT_ORGANISERS; else process.env.CHANNEL_CH_EVENT_ORGANISERS = prev;
  }

  console.log(`PASS ${results.filter((r) => r.startsWith("PASS")).length}/8 ch-event-organisers-check (Order WE7-ch-event-organisers)`);
  process.exit(0);
}

main().catch(() => {
  process.exitCode = 1;
});
