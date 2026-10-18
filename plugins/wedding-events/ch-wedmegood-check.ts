// Order WE2-ch-wedmegood proof: offline check for the WedMeGood channel adapter.
// All fixtures are clearly fake (fixture-*.example domains and fake phone numbers);
// every transport (search, page read) is injected, so nothing dials out. The page
// shapes mirror the real listing/profile structure confirmed on 2026-10-12 by
// reading the live public pages (cards "[ [Name](profile/"<Name>") 4.9(175 reviews)
// ... <Area>, <City> Planning Fee ₹2,50,000 Onwards ... Planned in 13 Cities]",
// pagination "?page=N", profile "Portfolio (3)Albums (1)Videos (1)", "Starting
// Price ₹ ...", "Planning since <YYYY>", "Services Offered by ...",
// "Planned in: <cities>").
// Does not import src/company/, so the sandbox-company-root preamble is not needed.
// Run (from the repo root): npx tsx src/channels/ch-wedmegood-check.ts
import assert from "node:assert/strict";
import type { ChannelDeps } from "../../src/channels/types.js";
import { wedmegood, parseListingPage, parseProfilePage, wedmegoodSignals, listingUrl } from "./ch-wedmegood.js";
import { channelAdapters } from "../../src/channels/registry.js";
import type { RawLead } from "../../src/types.js";
import type { ReachResult } from "../../src/reach.js";

// --- fixtures (clearly fake; real WedMeGood structure) -----------------------

const LISTING_PAGE_1 = `
# Wedding Planners in Delhi NCR
Showing 6 results as per your search criteria
List Grid
About vendor
[[Fixture Parbliss Events](https://www.wedmegood.com/profile/Fixture-Parbliss-Events-111 "Fixture Parbliss Events") 4.9(175 reviews) ![Image 23: Location](https://images.wedmegood.com/location.417064ed.svg) GTB Nagar, Delhi NCR Planning Fee ₹2,50,000 Onwards Inhouse & outside decorators Users' Choice Awards Winner +3 more * Planned in 13 Cities](https://www.wedmegood.com/profile/Fixture-Parbliss-Events-111)
About vendor
[[Fixture Knot Crafts](https://www.wedmegood.com/profile/Fixture-Knot-Crafts-222 "Fixture Knot Crafts") 4.9(20 reviews) ![Image 24: Location](https://images.wedmegood.com/location.417064ed.svg) Dwarka, Delhi NCR Planning Fee ₹2,50,000 Onwards Planned in 8 Cities](https://www.wedmegood.com/profile/Fixture-Knot-Crafts-222)
#### Latest Reviews
[Shiny Eventz](https://www.wedmegood.com/profile/Shiny-Eventz-1835502/reviews/716118)
`;

const LISTING_PAGE_2 = `
# Wedding Planners in Delhi NCR
Showing 6 results as per your search criteria
About vendor
[[Fixture MakeBestDay](https://www.wedmegood.com/profile/Fixture-MakeBestDay-333 "Fixture MakeBestDay") 4.9(99 reviews) ![Image 1: Location](https://images.wedmegood.com/location.417064ed.svg) Dwarka, Delhi NCR Price on Request Planned in 9 Cities](https://www.wedmegood.com/profile/Fixture-MakeBestDay-333)
[[Fixture Bells and Bows](https://www.wedmegood.com/profile/Fixture-Bells-and-Bows-444 "Fixture Bells and Bows") 5.0(44 reviews) ![Image 2: Location](https://images.wedmegood.com/location.417064ed.svg) South Delhi, Delhi NCR Planning Fee ₹4,00,000 Onwards Planned in 7 Cities](https://www.wedmegood.com/profile/Fixture-Bells-and-Bows-444)
`;

const LISTING_PAGE_3 = `
# Wedding Planners in Delhi NCR
About vendor
[[Fixture Octave Events](https://www.wedmegood.com/profile/Fixture-Octave-Events-555 "Fixture Octave Events") 5.0(1 review) ![Image 1: Location](https://images.wedmegood.com/location.417064ed.svg) Punjabi Bagh, Delhi NCR Planning Fee ₹4,00,000 Onwards Planned in 4 Cities](https://www.wedmegood.com/profile/Fixture-Octave-Events-555)
[[Fixture SVG Broad Media](https://www.wedmegood.com/profile/Fixture-SVG-Broad-Media-666 "Fixture SVG Broad Media") 5.0(1 review) ![Image 2: Location](https://images.wedmegood.com/location.417064ed.svg) Model Town, Delhi NCR Planning Fee ₹2,00,000 Onwards Planned in 3 Cities](https://www.wedmegood.com/profile/Fixture-SVG-Broad-Media-666)
`;

const CHANGED_PAGE = `Home page only. No vendor cards here.`;

const PROFILE_RICH = `
# Fixture Mega Weddings & Events
###### 5.0 ###### 12 reviews
###### South Delhi, Delhi NCR(View on Map)
###### Contact
3 Photos
Portfolio (3)Albums (1)Videos (1)
Vlog of Grand Indian Destination Wedding in Delhi NCR
###### Starting Price
₹
400,000
###### Price (Planning Fee)
Send Message
View Contact
Services Offered by Fixture Mega Weddings & Events
* Venue Consultancy
* Design & Decor
* Catering
* Hospitality

Been on  WedMeGood Since
4 years 7 months
Planned in: Delhi NCR. Jaipur, Udaipur, Goa, Mussoorie
Experience
Planning since 2014
Website https://fixture-wedmegood-vendor.example/
Follow us on: https://www.instagram.com/fixturevendor https://www.facebook.com/fixturevendor
`;

const PROFILE_VIDEO = `
# Fixture Video Studio
5.0 ###### 60 reviews
###### Bandra, Mumbai(View on Map)
8 Photos
Portfolio (8)Albums (2)Videos (4)
###### Starting Price
₹ 1,50,000
Services Offered by Fixture Video Studio
* Cinematography
* Photography
* Drone Shots

Experience
Planning since 2016
Planned in: Mumbai, Goa
Follow us on: https://www.youtube.com/@fixturestudio https://www.instagram.com/fixturestudio
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
    if (page === 1) return reachOk(LISTING_PAGE_1);
    if (page === 2) return reachOk(LISTING_PAGE_2);
    if (page === 3) return reachOk(LISTING_PAGE_3);
    return reachBlockedFake();
  };
}

// Default deps: search blocked so the read chain lands on the page fixture.
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
  category: "wedding-planner",
  city: "Delhi NCR",
  source: "ch-wedmegood",
  sourceUrl: "https://www.wedmegood.com/profile/Fixture-Mega-Weddings-and-Events-999",
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
  const prev = process.env.CHANNEL_CH_WEDMEGOOD;
  delete process.env.CHANNEL_CH_WEDMEGOOD;

  try {
    // 1. registered; status off by default and on with CHANNEL_CH_WEDMEGOOD
    try {
      assert.ok(channelAdapters().includes(wedmegood), "adapter self-registered via import");
      assert.equal(wedmegood.id, "ch-wedmegood");
      assert.equal(wedmegood.tier, "B");
      const off = wedmegood.status();
      assert.equal(off.enabled, false, "off by default");
      assert.match(off.why ?? "", /CHANNEL_CH_WEDMEGOOD/, `why names the env: ${off.why}`);
      process.env.CHANNEL_CH_WEDMEGOOD = "1";
      assert.equal(wedmegood.status().enabled, true, "on with CHANNEL_CH_WEDMEGOOD=1");
      process.env.CHANNEL_CH_WEDMEGOOD = "0";
      assert.equal(wedmegood.status().enabled, false, "0 means off");
      delete process.env.CHANNEL_CH_WEDMEGOOD;
      pass(1, "status is off by default and on only with CHANNEL_CH_WEDMEGOOD=1");
    } catch (err) {
      fail(1, "status is off by default and on only with CHANNEL_CH_WEDMEGOOD=1", err);
    }

    // 2. discovery returns the expected leads with source URLs
    try {
      const leads = await wedmegood.discover(
        { category: "wedding-planner", city: "Delhi NCR", limit: 10 },
        depsWith({ readPage: listingDispatcher() }),
      );
      assert.equal(leads.length, 6, `six vendors across three pages, got ${leads.length}`);
      assert.deepEqual(
        leads.map((l) => l.name),
        ["Fixture Parbliss Events", "Fixture Knot Crafts", "Fixture MakeBestDay", "Fixture Bells and Bows", "Fixture Octave Events", "Fixture SVG Broad Media"],
        "names copied from the card links in page order",
      );
      for (const l of leads) {
        assert.match(l.sourceUrl, /^https:\/\/www\.wedmegood\.com\/profile\//, `sourceUrl is a profile URL: ${l.sourceUrl}`);
        assert.equal(l.source, "ch-wedmegood");
        assert.equal(l.category, "wedding-planner");
        assert.equal(l.city, "Delhi NCR");
      }
      assert.equal(leads[0].address, "GTB Nagar, Delhi NCR", `area copied from the card: ${leads[0].address}`);
      assert.equal(leads[3].address, "South Delhi, Delhi NCR", `second page area: ${leads[3].address}`);
      // the "Latest Reviews" single-bracket link must never become a lead
      assert.ok(!leads.some((l) => /Shiny-Eventz/.test(l.sourceUrl)), "review links are not vendor leads");
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

      const three = await wedmegood.discover({ category: "wedding-planner", city: "Delhi NCR", limit: 3 }, deps);
      assert.equal(three.length, 3, "limit 3 respected");
      assert.deepEqual(calls.map((u) => u.match(/page=(\d+)/)?.[1]), ["1", "2"], "stops after page 2 for limit 3");
      assert.equal(sleeps.length, 1, "one polite pause between the two pages");

      calls.length = 0;
      const five = await wedmegood.discover({ category: "wedding-planner", city: "Delhi NCR", limit: 5 }, deps);
      assert.equal(five.length, 5, "limit 5 respected");
      assert.deepEqual(calls.map((u) => u.match(/page=(\d+)/)?.[1]), ["1", "2", "3"], "pages 1-3 for limit 5");
      pass(3, "pagination respects the limiter and stops at the limit");
    } catch (err) {
      fail(3, "pagination respects the limiter and stops at the limit", err);
    }

    // 4. blocked or changed page returns [] with no throw
    try {
      const blocked = await wedmegood.discover(
        { category: "wedding-planner", city: "Delhi NCR", limit: 10 },
        depsWith({ readPage: () => reachBlockedFake() }),
      );
      assert.deepEqual(blocked, [], "blocked page -> []");
      const changed = await wedmegood.discover(
        { category: "wedding-planner", city: "Delhi NCR", limit: 10 },
        depsWith({ readPage: () => reachOk(CHANGED_PAGE) }),
      );
      assert.deepEqual(changed, [], "changed page with no cards -> []");
      pass(4, "a blocked or changed page returns [] without a throw");
    } catch (err) {
      fail(4, "a blocked or changed page returns [] without a throw", err);
    }

    // 5. enrich extracts each listed field from a profile fixture
    try {
      const ev = await wedmegood.enrich(lead("Fixture Mega Weddings & Events"), depsWith());
      assert.equal(ev.via, "page", "search is blocked so the page read wins the chain");
      assert.equal(ev.channel, "ch-wedmegood");
      assert.equal(ev.untrusted, true, "evidence marked untrusted");
      const want: Record<string, string | number> = {
        name: "Fixture Mega Weddings & Events",
        area: "South Delhi",
        city: "Delhi NCR",
        rating: 5,
        reviewCount: 12,
        photoCount: 3,
        videoCount: 1,
        videoPresent: "yes",
        startingPrice: 400000,
        services: "Venue Consultancy, Design & Decor, Catering, Hospitality",
        yearsInBusiness: 12,
        listedYears: 4,
        website: "https://fixture-wedmegood-vendor.example/",
        instagram: "https://www.instagram.com/fixturevendor",
        facebook: "https://www.facebook.com/fixturevendor",
      };
      for (const [k, v] of Object.entries(want)) {
        assert.deepEqual(ev.fields[k], v, `field ${k} extracted verbatim (got ${JSON.stringify(ev.fields[k])})`);
      }
      assert.ok(ev.signals.includes("has-video-portfolio"), "video portfolio signal on the rich profile");
      assert.ok(ev.signals.includes("price-band-known"), "price signal on the rich profile");
      assert.ok(!ev.signals.includes("portfolio-no-video"), "no portfolio-no-video when a video is present");
      pass(5, "enrich extracts each listed field from a profile fixture");
    } catch (err) {
      fail(5, "enrich extracts each listed field from a profile fixture", err);
    }

    // 6. every signal fires on matching text and not otherwise
    try {
      const pairs: [string, string, string][] = [
        ["Portfolio (5) Albums (2) 5 Photos of floral decor", "Portfolio (5) Albums (2) 5 Photos Videos (1)", "portfolio-no-video"],
        ["Watch our wedding film Reel on youtube.com/xyz", "Portfolio (5) 5 Photos of floral decor", "has-video-portfolio"],
        ["New reel posted 5 days ago", "Last reel posted 200 days ago", "social-video-active"],
        ["Last post 120 days ago", "New post 3 days ago", "social-inactive"],
        ["4.9(175 reviews)", "4.9(6 reviews)", "high-review-count"],
        ["Paid Vendor Handpicked", "Wedding Planners in Delhi NCR", "premium-listing"],
        ["Planned in 13 Cities", "Planned in 1 City", "multi-city"],
        ["Planning Fee ₹2,50,000 Onwards", "Price on Request", "price-band-known"],
      ];
      for (const [pos, neg, mustFire] of pairs) {
        const sPos = wedmegoodSignals(pos);
        const sNeg = wedmegoodSignals(neg);
        assert.ok(sPos.includes(mustFire), `${mustFire} fires on the positive fixture — got [${sPos.join(", ")}]`);
        assert.ok(!sNeg.includes(mustFire), `${mustFire} must NOT fire on the negative fixture — got [${sNeg.join(", ")}]`);
        assert.equal(sPos.filter((s) => s === mustFire).length, 1, "no duplicate signal ids");
      }
      const every = new Set(wedmegoodSignals(PROFILE_VIDEO));
      for (const id of ["has-video-portfolio", "high-review-count", "multi-city", "price-band-known"]) {
        assert.ok(every.has(id), `profile fixture yields ${id}`);
      }
      pass(6, "each signal fires on a fixture that has it and not on one that does not");
    } catch (err) {
      fail(6, "each signal fires on a fixture that has it and not on one that does not", err);
    }

    // 7. every fetched text is untrusted
    try {
      const fetched = await reachOk(PROFILE_RICH);
      assert.equal(fetched.untrusted, true, "injected reach result is untrusted");
      const ev = await wedmegood.enrich(lead("Fixture Video Studio"), depsWith({ readPage: () => reachOk(PROFILE_VIDEO) }));
      assert.equal(ev.untrusted, true, "evidence untrusted is the literal true");
      assert.equal(typeof ev.text, "string", "evidence keeps the quoted text");
      assert.equal(parseProfilePage(PROFILE_VIDEO).videoCount, 4, "second profile parsed");
      pass(7, "every fetched text is marked untrusted: true");
    } catch (err) {
      fail(7, "every fetched text is marked untrusted: true", err);
    }
  } finally {
    if (prev === undefined) delete process.env.CHANNEL_CH_WEDMEGOOD; else process.env.CHANNEL_CH_WEDMEGOOD = prev;
  }

  console.log(`PASS ${results.filter((r) => r.startsWith("PASS")).length}/7 ch-wedmegood-check (Order WE2-ch-wedmegood)`);
  process.exit(0);
}

main().catch(() => {
  process.exitCode = 1;
});
