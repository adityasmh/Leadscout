// Order WE5-ch-venues proof: offline check for the wedding venue & banquet
// marketplace channel adapter. All fixtures are clearly fake (fixture-*.example
// domains and fake phone numbers); every transport (search, page read) is
// injected, so nothing dials out. The page shapes mirror the real public listing
// structure confirmed on 2026-10-12 by reading the live pages through the search
// proxy: venuelook.com renders "Venue Name | Capacity | Starting Price" table rows
// such as "Ballroom of ... | 50 - 200 Guests | Rs. 1500 per plate"; bookeventz.com
// renders "## <Name>" cards with "<min>-<max> pax", "₹ <price> / Person",
// "<label> <N> reviews", a standalone rating and "<Area>, <City>".
// Does not import src/company/, so the sandbox-company-root preamble is not needed.
// Run (from the repo root): npx tsx src/channels/ch-venues-check.ts
import assert from "node:assert/strict";
import type { ChannelDeps } from "../../src/channels/types.js";
import { venues, parseProfilePage, venuesSignals } from "./ch-venues.js";
import { channelAdapters } from "../../src/channels/registry.js";
import type { RawLead } from "../../src/types.js";
import type { ReachResult } from "../../src/reach.js";

// --- fixtures (clearly fake; real marketplace structure) ---------------------

const VL_LISTING_1 = `
# Best Banquet Halls in Delhi NCR
Best 1766 Out of 3475 Banquet Halls & Party Places in Delhi
## Banquet Halls in Delhi NCR Venues With Starting Price
| Venue Name | Capacity | Starting Price |
| --- | --- | --- |
| [Ballroom of Fixture Gola Sizzlers](https://www.venuelook.com/delhi/banquet-halls/fixture-ballroom-gola) | 50 - 200 Guests | Rs. 1500 per plate |
| [Grand Hall of Fixture Orion](https://www.venuelook.com/delhi/banquet-halls/fixture-grand-orion) | 15 - 400 Guests | Rs. 1250 per plate |
`;

const VL_LISTING_2 = `
# Best Banquet Halls in Delhi NCR
## Banquet Halls in Delhi NCR Venues With Starting Price
| Venue Name | Capacity | Starting Price |
| [Lawn of Fixture Ocean Pearl](https://www.venuelook.com/delhi/banquet-halls/fixture-ocean-pearl) | 200 - 550 Guests | Rs. 1800 per plate |
| [Rooftop of Fixture Jageer Palace](https://www.venuelook.com/delhi/banquet-halls/fixture-jageer-palace) | 10 - 150 Guests | Rs. 1250 per plate |
`;

const BE_LISTING_1 = `
# Best BookEventz Venues In Mumbai, with Price, Photos & Reviews
## Top Bookeventz Venues In Mumbai
## [Tunga International](https://www.bookeventz.com/venues/tunga-international)
50-250 pax
₹ 1300 / Person
Excellent 5 reviews
4.6
Andheri, Mumbai
## [The Goldfinch Hotel](https://www.bookeventz.com/venues/the-goldfinch-hotel)
₹ 1800 / Person
Exceptional 38 reviews
4.2
Andheri, Mumbai
`;

const CHANGED_PAGE = `Home page only. No vendor cards here.`;

const PROFILE_RICH = `
# Fixture Grand Orion Banquets
###### 4.7 ###### 312 reviews
###### Andheri, Mumbai(View on Map)
###### Contact
Phone: +91 98765 43210
24 Photos
Videos (2)
# Starting Price
₹ 1500 per plate
# Capacity
50 - 200 Guests
Services:
* Venue only
* In-house catering
* In-house decor

In business since 2014
Website https://fixture-venue-vendor.example/
Follow us on: https://www.instagram.com/fixturevenue https://www.facebook.com/fixturevenue
`;

// --- fakes -------------------------------------------------------------------

function reachOk(text: string): Promise<ReachResult> {
  return Promise.resolve({ ok: true, channel: "fixture", text, untrusted: true, trace: [] });
}
function reachBlockedFake(): Promise<ReachResult> {
  return Promise.resolve({ ok: false, channel: "fixture", text: "HTTP 403 blocked", untrusted: true, trace: [], error: "HTTP 403" });
}

function listingDispatcher(): (url: string) => Promise<ReachResult> {
  return (url: string) => {
    const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? "1");
    if (url.includes("venuelook.com")) {
      if (page === 1) return reachOk(VL_LISTING_1);
      if (page === 2) return reachOk(VL_LISTING_2);
      return reachOk(CHANGED_PAGE);
    }
    if (url.includes("bookeventz.com")) {
      if (page === 1) return reachOk(BE_LISTING_1);
      return reachOk(CHANGED_PAGE);
    }
    return reachBlockedFake();
  };
}

function depsWith(overrides: Partial<ChannelDeps> = {}): ChannelDeps {
  return {
    search: () => reachBlockedFake(),
    readPage: () => reachOk(PROFILE_RICH),
    limiter: {},
    now: () => Date.parse("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

const lead = (name: string): RawLead => ({
  name,
  category: "banquet-hall",
  city: "Delhi NCR",
  source: "ch-venues",
  sourceUrl: "https://www.venuelook.com/delhi/banquet-halls/fixture-grand-orion",
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
  const prev = process.env.CHANNEL_CH_VENUES;
  delete process.env.CHANNEL_CH_VENUES;

  try {
    // 1. registered; status off by default and on with CHANNEL_CH_VENUES
    try {
      assert.ok(channelAdapters().includes(venues), "adapter self-registered via import");
      assert.equal(venues.id, "ch-venues");
      assert.equal(venues.tier, "B");
      const off = venues.status();
      assert.equal(off.enabled, false, "off by default");
      assert.match(off.why ?? "", /CHANNEL_CH_VENUES/, `why names the env: ${off.why}`);
      process.env.CHANNEL_CH_VENUES = "1";
      assert.equal(venues.status().enabled, true, "on with CHANNEL_CH_VENUES=1");
      process.env.CHANNEL_CH_VENUES = "0";
      assert.equal(venues.status().enabled, false, "0 means off");
      delete process.env.CHANNEL_CH_VENUES;
      pass(1, "status is off by default and on only with CHANNEL_CH_VENUES=1");
    } catch (err) {
      fail(1, "status is off by default and on only with CHANNEL_CH_VENUES=1", err);
    }

    // 2. discovery returns the expected leads with source URLs
    try {
      const leads = await venues.discover(
        { category: "banquet-hall", city: "Delhi NCR", limit: 10 },
        depsWith({ readPage: listingDispatcher() }),
      );
      assert.equal(leads.length, 6, `six venues across both marketplaces, got ${leads.length}`);
      assert.deepEqual(
        leads.map((l) => l.name),
        ["Ballroom of Fixture Gola Sizzlers", "Grand Hall of Fixture Orion", "Lawn of Fixture Ocean Pearl", "Rooftop of Fixture Jageer Palace", "Tunga International", "The Goldfinch Hotel"],
        "names copied from the card links in site/page order",
      );
      for (const l of leads) {
        assert.match(l.sourceUrl, /^https:\/\/www\.(venuelook|bookeventz)\.com\//, `sourceUrl is a profile URL: ${l.sourceUrl}`);
        assert.equal(l.source, "ch-venues");
        assert.equal(l.category, "banquet-hall");
      }
      assert.ok(leads.some((l) => /venuelook\.com/.test(l.sourceUrl)), "venuelook leads present");
      assert.ok(leads.some((l) => /bookeventz\.com/.test(l.sourceUrl)), "bookeventz leads present (per-site table)");
      assert.equal(leads[0].city, "Delhi NCR", `city from the query when the card shows none: ${leads[0].city}`);
      assert.equal(leads[4].address, "Andheri", `area copied from the bookeventz card: ${leads[4].address}`);
      assert.equal(leads[4].city, "Mumbai", `city copied from the bookeventz card: ${leads[4].city}`);
      pass(2, "discover returns the expected leads with source URLs");
    } catch (err) {
      fail(2, "discover returns the expected leads with source URLs", err);
    }

    // 3. pagination is polite and stops at the limit
    try {
      const calls: string[] = [];
      const tracked = (url: string) => { calls.push(url); return listingDispatcher()(url); };
      const sleeps: number[] = [];
      const deps = depsWith({ readPage: tracked, limiter: { sleep: async (ms: number) => { sleeps.push(ms); } } });

      const three = await venues.discover({ category: "banquet-hall", city: "Delhi NCR", limit: 3 }, deps);
      assert.equal(three.length, 3, "limit 3 respected");
      assert.deepEqual(calls.map((u) => u.match(/page=(\d+)/)?.[1]), ["1", "2"], "stops after page 2 for limit 3");
      assert.ok(calls.every((u) => /venuelook\.com/.test(u)), "limit 3 is met on the first site (no second-site read needed)");
      assert.equal(sleeps.length, 1, "one polite pause between the two pages");

      calls.length = 0;
      sleeps.length = 0;
      const six = await venues.discover({ category: "banquet-hall", city: "Delhi NCR", limit: 6 }, deps);
      assert.equal(six.length, 6, "limit 6 respected");
      assert.ok(calls.some((u) => /venuelook\.com/.test(u)), "venuelook pages were read");
      assert.ok(calls.some((u) => /bookeventz\.com/.test(u)), "paging continues into the next marketplace");
      assert.equal(sleeps.length, 2, "a pause before each further page that is read (vl p2, vl p3)");
      pass(3, "pagination respects the limiter and stops at the limit");
    } catch (err) {
      fail(3, "pagination respects the limiter and stops at the limit", err);
    }

    // 4. blocked or changed page returns [] with no throw
    try {
      const blocked = await venues.discover(
        { category: "banquet-hall", city: "Delhi NCR", limit: 10 },
        depsWith({ readPage: () => reachBlockedFake() }),
      );
      assert.deepEqual(blocked, [], "blocked page -> []");
      const changed = await venues.discover(
        { category: "banquet-hall", city: "Delhi NCR", limit: 10 },
        depsWith({ readPage: () => reachOk(CHANGED_PAGE) }),
      );
      assert.deepEqual(changed, [], "changed page with no cards -> []");
      pass(4, "a blocked or changed page returns [] without a throw");
    } catch (err) {
      fail(4, "a blocked or changed page returns [] without a throw", err);
    }

    // 5. enrich extracts each listed field from a profile fixture
    try {
      const ev = await venues.enrich(lead("Fixture Grand Orion Banquets"), depsWith());
      assert.equal(ev.via, "page", "search is blocked so the page read wins the chain");
      assert.equal(ev.channel, "ch-venues");
      assert.equal(ev.untrusted, true, "evidence marked untrusted");
      const want: Record<string, string | number> = {
        name: "Fixture Grand Orion Banquets",
        area: "Andheri",
        city: "Mumbai",
        capacity: "50 - 200 Guests",
        capacityMin: 50,
        capacityMax: 200,
        rating: 4.7,
        reviewCount: 312,
        startingPrice: 1500,
        priceUnit: "per plate",
        photoCount: 24,
        videoCount: 2,
        videoPresent: "yes",
        services: "Venue only, In-house catering, In-house decor",
        yearsInBusiness: 12,
        phone: "+91 98765 43210",
        website: "https://fixture-venue-vendor.example/",
        instagram: "https://www.instagram.com/fixturevenue",
        facebook: "https://www.facebook.com/fixturevenue",
      };
      for (const [k, v] of Object.entries(want)) {
        assert.deepEqual(ev.fields[k], v, `field ${k} extracted verbatim (got ${JSON.stringify(ev.fields[k])})`);
      }
      // a blocked profile with no browser fallback must not throw
      const blockedEv = await venues.enrich(lead("Fixture Blocked"), depsWith({ readPage: () => reachBlockedFake() }));
      assert.deepEqual(blockedEv.fields, {}, "blocked profile -> empty fields");
      assert.equal(blockedEv.untrusted, true, "blocked profile evidence still untrusted");
      assert.equal(blockedEv.text, "", "blocked profile -> no quoted text");
      pass(5, "enrich extracts each listed field and survives a blocked profile");
    } catch (err) {
      fail(5, "enrich extracts each listed field and survives a blocked profile", err);
    }

    // 6. every signal fires on matching text and not otherwise
    try {
      const pairs: [string, string, string][] = [
        ["Portfolio of 12 photos of the banquet lawn", "Watch our wedding film on youtube.com/xyz", "portfolio-no-video"],
        ["Watch our wedding film on youtube.com/xyz", "Portfolio of 12 photos of the banquet lawn", "has-video-portfolio"],
        ["New reel posted 5 days ago", "Last reel posted 200 days ago", "social-video-active"],
        ["Last post 120 days ago", "New post 3 days ago", "social-inactive"],
        ["4.7 (312 reviews)", "4.7 (20 reviews)", "high-review-count"],
        ["Featured Tag", "Banquet Halls in Delhi NCR", "premium-listing"],
        ["Available in 4 Cities", "Available in 1 City", "multi-city"],
        ["Rs. 1500 per plate", "Price on request", "price-band-known"],
      ];
      for (const [pos, neg, mustFire] of pairs) {
        const sPos = venuesSignals(pos);
        const sNeg = venuesSignals(neg);
        assert.ok(sPos.includes(mustFire), `${mustFire} fires on the positive fixture - got [${sPos.join(", ")}]`);
        assert.ok(!sNeg.includes(mustFire), `${mustFire} must NOT fire on the negative fixture - got [${sNeg.join(", ")}]`);
        assert.equal(sPos.filter((s) => s === mustFire).length, 1, "no duplicate signal ids");
      }
      const every = new Set(venuesSignals(PROFILE_RICH));
      for (const id of ["has-video-portfolio", "high-review-count", "price-band-known"]) {
        assert.ok(every.has(id), `profile fixture yields ${id}`);
      }
      assert.ok(!every.has("portfolio-no-video"), "profile with a video does not yield portfolio-no-video");
      pass(6, "each signal fires on a fixture that has it and not on one that does not");
    } catch (err) {
      fail(6, "each signal fires on a fixture that has it and not on one that does not", err);
    }

    // 7. every fetched text is untrusted
    try {
      const fetched = await reachOk(PROFILE_RICH);
      assert.equal(fetched.untrusted, true, "injected reach result is untrusted");
      const ev = await venues.enrich(lead("Fixture Grand Orion Banquets"), depsWith());
      assert.equal(ev.untrusted, true, "evidence untrusted is the literal true");
      assert.equal(typeof ev.text, "string", "evidence keeps the quoted text");
      assert.equal(parseProfilePage(PROFILE_RICH).videoCount, 2, "profile parsed");
      pass(7, "every fetched text is marked untrusted: true");
    } catch (err) {
      fail(7, "every fetched text is marked untrusted: true", err);
    }
  } finally {
    if (prev === undefined) delete process.env.CHANNEL_CH_VENUES; else process.env.CHANNEL_CH_VENUES = prev;
  }

  console.log(`PASS ${results.filter((r) => r.startsWith("PASS")).length}/7 ch-venues-check (Order WE5-ch-venues)`);
  process.exit(0);
}

main().catch(() => {
  process.exitCode = 1;
});
