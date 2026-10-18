// Order WE6-ch-expos-awards proof: offline check for the wedding expos / fairs /
// awards channel adapter.
//
// Everything is injected (search + readPage) and every fixture is clearly fake
// (fixture-*.example domains, fake +91 numbers and a fake event name). The page
// shapes mirror the real public structures confirmed on 2026-10-12:
//  - exhibitor / sponsor lists name one business per line under a role heading
//    ("Exhibitors", "Sponsors") beneath an event + year line;
//  - award pages run a category/role heading then a bare business name per line;
//  - a vendor profile shows labelled fields ("Portfolio Photos:", "Reviews:",
//    "Rating:", "Starting Price:", "Services:", "Years in Business:", links).
// Three listing pages and two profiles are recorded, plus one blocked page.
//
// Does not import src/company/, so the sandbox-company-root preamble is not needed.
// Run (from the repo root):
//   npx tsx src/channels/ch-expos-awards-check.ts
import assert from "node:assert/strict";
import type { ChannelDeps } from "../../src/channels/types.js";
import {
  exposAwards, parseListingPage, parseExposAwardsProfile, exposAwardsSignals,
  guessCategory, buildQueries, entryToLead,
} from "./ch-expos-awards.js";
import { channelAdapters } from "../../src/channels/registry.js";
import type { RawLead } from "../../src/types.js";
import type { ReachResult } from "../../src/reach.js";

// --- fixtures (clearly fake; real expos/awards structure) --------------------

const LISTING_PAGE_1 = `
Mumbai Bridal Expo 2025
Exhibitors
Name: Fixture Bright Rays Photography
Category: photographer
City: Mumbai
Area: Bandra
Phone: +91 22 0000 0001
Website: https://fixture-brightrays.example/
Instagram: https://www.instagram.com/fixturebrightrays
Facebook: https://www.facebook.com/fixturebrightrays

Name: Fixture Bloom Decor Studio
Category: wedding-decorator
City: Mumbai
Area: Andheri
Phone: +91 22 0000 0002
Website: https://fixture-bloomdecor.example/
`;

const LISTING_PAGE_2 = `
Mumbai Bridal Expo 2025
Sponsors
Name: Fixture Grand Banquet Hall
Category: banquet-hall
City: Mumbai
Phone: +91 22 0000 0003
Website: https://fixture-grandbanquet.example/

Name: Fixture Spice Route Caterers
Category: caterer
City: Mumbai
Phone: +91 22 0000 0004
Website: https://fixture-spiceroute.example/
`;

const LISTING_PAGE_3 = `
Fixture Wedding Awards 2024
Winners
Name: Fixture Glow Events
Category: event-company
City: Mumbai
Website: https://fixture-glowevents.example/

Name: Fixture Petal Story Florals
Category: florist
City: Mumbai
Website: https://fixture-petalstory.example/
`;

const CHANGED_PAGE = `Home page only. Nothing listed here.`;

// Real expo exhibitor lists (e.g. the GJS Mumbai exhibitor table) are pipe /
// markdown tables with "Exhibitor Name | City | Category" columns.
const TABLE_PAGE = `
GJS Mumbai Jewellery Expo 2026
Exhibitors
| S.No. | Exhibitor Name | City | Category | Booth |
| --- | --- | --- | --- | --- |
| 1 | Fixture Aaqua Gold | MUMBAI | Gold | 1D10 |
| 2 | Fixture Gemawat and Sons | MUMBAI | Diamond | 1B14 |
| 3 | Fixture Deja Jewels | Chennai | Gold | 1L02 |
`;

const PROFILE_RICH = `
# Fixture Wedding Studios
Name: Fixture Wedding Studios
Event: Fixture Mumbai Bridal Expo
Year: 2025
Role: Exhibitor
City: Mumbai
Category: photographer
Portfolio Photos: 24
Reviews: 175
Rating: 4.9
Starting Price: INR 150000
Services: Wedding Photography, Cinematography
Years in Business: 12
Website: https://fixture-expos.example/
Instagram: https://www.instagram.com/fixturevendor
Facebook: https://www.facebook.com/fixturevendor
Reel posted 5 days ago
`;

const PROFILE_VIDEO = `
# Fixture Reel Studio
Name: Fixture Reel Studio
Role: Winner
City: Mumbai
Portfolio Photos: 8
Reviews: 6
Rating: 5.0
Services: Wedding Films
YouTube: https://www.youtube.com/@fixturereel
`;

// --- fakes -------------------------------------------------------------------

function reachOk(text: string): Promise<ReachResult> {
  return Promise.resolve({ ok: true, channel: "fixture", text, untrusted: true, trace: [] });
}
function reachBlockedFake(): Promise<ReachResult> {
  return Promise.resolve({ ok: false, channel: "fixture", text: "HTTP 403 blocked", untrusted: true, trace: [], error: "HTTP 403" });
}

const URL_1 = "https://fixture-expo.example/mumbai-bridal-expo-2025";
const URL_2 = "https://fixture-expo.example/mumbai-bridal-expo-2025-sponsors";
const URL_3 = "https://fixture-expo.example/fixture-wedding-awards-2024";

function searchWithUrls(): Promise<ReachResult> {
  return reachOk(`${URL_1}\n${URL_2}\n${URL_3}\n`);
}

function listingDispatcher(): (url: string) => Promise<ReachResult> {
  return (url: string) => {
    if (url === URL_1) return reachOk(LISTING_PAGE_1);
    if (url === URL_2) return reachOk(LISTING_PAGE_2);
    if (url === URL_3) return reachOk(LISTING_PAGE_3);
    return reachBlockedFake();
  };
}

// Default deps: search returns the three listing URLs, readPage the rich profile.
function depsWith(overrides: Partial<ChannelDeps> = {}): ChannelDeps {
  return {
    search: () => searchWithUrls(),
    readPage: () => reachOk(PROFILE_RICH),
    limiter: {},
    now: () => Date.parse("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

const lead = (name: string): RawLead => ({
  name,
  category: "photographer",
  city: "Mumbai",
  source: "ch-expos-awards",
  sourceUrl: URL_1,
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
  const prev = process.env.CHANNEL_CH_EXPOS_AWARDS;
  delete process.env.CHANNEL_CH_EXPOS_AWARDS;

  try {
    // 1. registered; status off by default and on only with CHANNEL_CH_EXPOS_AWARDS
    try {
      assert.ok(channelAdapters().includes(exposAwards), "adapter self-registered via import");
      assert.equal(exposAwards.id, "ch-expos-awards");
      assert.equal(exposAwards.tier, "B");
      assert.ok(exposAwards.categories.includes("photographer"), "declares canonical categories");
      assert.ok(exposAwards.categories.includes("jewellery-store"), "declares canonical categories");
      const off = exposAwards.status();
      assert.equal(off.enabled, false, "off by default");
      assert.match(off.why ?? "", /CHANNEL_CH_EXPOS_AWARDS/, `why names the env: ${off.why}`);
      process.env.CHANNEL_CH_EXPOS_AWARDS = "1";
      assert.equal(exposAwards.status().enabled, true, "on with CHANNEL_CH_EXPOS_AWARDS=1");
      process.env.CHANNEL_CH_EXPOS_AWARDS = "0";
      assert.equal(exposAwards.status().enabled, false, "0 means off");
      delete process.env.CHANNEL_CH_EXPOS_AWARDS;
      pass(1, "status is off by default and on only with CHANNEL_CH_EXPOS_AWARDS=1");
    } catch (err) {
      fail(1, "status is off by default and on only with CHANNEL_CH_EXPOS_AWARDS=1", err);
    }

    // 2. discovery returns the expected leads with source URLs
    try {
      const leads = await exposAwards.discover(
        { category: "photographer", city: "Mumbai", limit: 20 },
        depsWith({ readPage: listingDispatcher() }),
      );
      assert.equal(leads.length, 6, `six businesses across three pages, got ${leads.length}`);
      assert.deepEqual(
        leads.map((l) => l.name),
        ["Fixture Bright Rays Photography", "Fixture Bloom Decor Studio", "Fixture Grand Banquet Hall",
          "Fixture Spice Route Caterers", "Fixture Glow Events", "Fixture Petal Story Florals"],
        "names copied from the listing lines in page order",
      );
      assert.equal(leads[0].sourceUrl, URL_1, "page 1 source URL on its leads");
      assert.equal(leads[2].sourceUrl, URL_2, "page 2 source URL on its leads");
      assert.equal(leads[4].sourceUrl, URL_3, "page 3 source URL on its leads");
      for (const l of leads) {
        assert.equal(l.source, "ch-expos-awards", "source is the channel id");
        assert.equal(l.city, "Mumbai");
      }
      assert.equal(leads[0].category, "photographer", "canonical category from the label");
      assert.equal(leads[1].category, "wedding-decorator", "canonical category from the label");
      assert.equal(leads[1].address, "Andheri", "area copied verbatim");
      assert.equal(leads[0].phone, "+91 22 0000 0001", "phone copied verbatim when shown");
      assert.equal(leads[0].website, "https://fixture-brightrays.example/", "website copied verbatim");
      assert.equal((leads[0] as { instagram?: string }).instagram, "https://www.instagram.com/fixturebrightrays", "instagram copied verbatim");
      assert.equal((leads[0] as { facebook?: string }).facebook, "https://www.facebook.com/fixturebrightrays", "facebook copied verbatim");
      assert.equal((leads[0] as { reason?: string }).reason, "Mumbai Bridal Expo 2025", "event + year as reason");
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

      const three = await exposAwards.discover({ category: "photographer", city: "Mumbai", limit: 3 }, deps);
      assert.equal(three.length, 3, "limit 3 respected");
      assert.deepEqual(calls, [URL_1, URL_2], "stops after page 2 for limit 3");
      assert.equal(sleeps.length, 1, "one polite pause between the two pages");

      calls.length = 0;
      sleeps.length = 0;
      const five = await exposAwards.discover({ category: "photographer", city: "Mumbai", limit: 5 }, deps);
      assert.equal(five.length, 5, "limit 5 respected");
      assert.deepEqual(calls, [URL_1, URL_2, URL_3], "reads pages 1-3 for limit 5");
      assert.equal(sleeps.length, 2, "a polite pause between each pair of pages");
      pass(3, "pagination respects the limiter and stops at the limit");
    } catch (err) {
      fail(3, "pagination respects the limiter and stops at the limit", err);
    }

    // 4. blocked or changed page returns [] with no throw
    try {
      const blocked = await exposAwards.discover(
        { category: "photographer", city: "Mumbai", limit: 10 },
        depsWith({ readPage: () => reachBlockedFake() }),
      );
      assert.deepEqual(blocked, [], "blocked page -> []");
      const blockedSearch = await exposAwards.discover(
        { category: "photographer", city: "Mumbai", limit: 10 },
        depsWith({ search: () => reachBlockedFake() }),
      );
      assert.deepEqual(blockedSearch, [], "blocked search -> []");
      const changed = await exposAwards.discover(
        { category: "photographer", city: "Mumbai", limit: 10 },
        depsWith({ readPage: () => reachOk(CHANGED_PAGE) }),
      );
      assert.deepEqual(changed, [], "changed page with no businesses -> []");
      pass(4, "a blocked or changed page returns [] without a throw");
    } catch (err) {
      fail(4, "a blocked or changed page returns [] without a throw", err);
    }

    // 5. enrich extracts each listed field from a profile fixture
    try {
      const ev = await exposAwards.enrich(lead("Fixture Wedding Studios"), depsWith({ search: () => reachBlockedFake() }));
      assert.equal(ev.via, "page", "search blocked so the page read wins the chain");
      assert.equal(ev.channel, "ch-expos-awards");
      assert.equal(ev.untrusted, true, "evidence marked untrusted");
      const want: Record<string, string | number> = {
        name: "Fixture Wedding Studios",
        event: "Fixture Mumbai Bridal Expo",
        year: "2025",
        role: "exhibitor",
        city: "Mumbai",
        category: "photographer",
        portfolioPhotoCount: 24,
        reviewCount: 175,
        rating: 4.9,
        priceBand: "INR 150000",
        services: "Wedding Photography, Cinematography",
        yearsInBusiness: 12,
        website: "https://fixture-expos.example/",
        instagram: "https://www.instagram.com/fixturevendor",
        facebook: "https://www.facebook.com/fixturevendor",
        video: "yes",
      };
      for (const [k, v] of Object.entries(want)) {
        assert.deepEqual(ev.fields[k], v, `field ${k} extracted verbatim (got ${JSON.stringify(ev.fields[k])})`);
      }
      assert.ok(ev.signals.includes("has-video-portfolio"), "video portfolio signal on the rich profile");
      assert.ok(ev.signals.includes("social-video-active"), "recent reel signal on the rich profile");
      assert.ok(ev.signals.includes("high-review-count"), "175 reviews -> high-review-count");
      assert.ok(ev.signals.includes("premium-listing"), "exhibitor -> premium-listing");
      assert.ok(ev.signals.includes("price-band-known"), "starting price -> price-band-known");
      assert.ok(!ev.signals.includes("portfolio-no-video"), "no portfolio-no-video when a video is present");
      pass(5, "enrich extracts each listed field from a profile fixture");
    } catch (err) {
      fail(5, "enrich extracts each listed field from a profile fixture", err);
    }

    // 6. every signal fires on matching text and not otherwise
    try {
      const pairs: [string, string, string][] = [
        ["12 Photos of our latest mandap decor", "12 Photos and a showreel on youtube.com/x", "portfolio-no-video"],
        ["Watch our wedding film on vimeo.com/123", "8 Photos of bridal decor", "has-video-portfolio"],
        ["New reel posted 10 days ago", "Last reel posted 150 days ago", "social-video-active"],
        ["Last post posted 150 days ago", "New reel posted 10 days ago", "social-inactive"],
        ["175 reviews from happy couples", "6 reviews so far", "high-review-count"],
        ["Featured Vendor Premium Partner", "Wedding Photographers in Mumbai", "premium-listing"],
        ["multi-city partner network", "serves Mumbai only", "multi-city"],
        ["Starting price INR 150000", "Price on request", "price-band-known"],
      ];
      for (const [pos, neg, mustFire] of pairs) {
        const sPos = exposAwardsSignals(pos);
        const sNeg = exposAwardsSignals(neg);
        assert.ok(sPos.includes(mustFire), `${mustFire} fires on the positive fixture — got [${sPos.join(", ")}]`);
        assert.ok(!sNeg.includes(mustFire), `${mustFire} must NOT fire on the negative fixture — got [${sNeg.join(", ")}]`);
        assert.equal(sPos.filter((s) => s === mustFire).length, 1, "no duplicate signal ids");
      }
      // non-matching text fires no signal from this set
      const quiet = exposAwardsSignals("Bridal Expo 2025 exhibitor list");
      for (const id of ["portfolio-no-video", "has-video-portfolio", "social-video-active", "social-inactive",
        "high-review-count", "premium-listing", "multi-city", "price-band-known"]) {
        assert.ok(!quiet.includes(id), `quiet text must not fire ${id}`);
      }
      pass(6, "each signal fires on a fixture that has it and not on one that does not");
    } catch (err) {
      fail(6, "each signal fires on a fixture that has it and not on one that does not", err);
    }

    // 7. every fetched text is untrusted
    try {
      const fetched = await reachOk(PROFILE_RICH);
      assert.equal(fetched.untrusted, true, "injected reach result is untrusted");
      const ev = await exposAwards.enrich(lead("Fixture Reel Studio"), depsWith({ search: () => reachBlockedFake(), readPage: () => reachOk(PROFILE_VIDEO) }));
      assert.equal(ev.untrusted, true, "evidence untrusted is the literal true");
      assert.equal(typeof ev.text, "string", "evidence keeps the quoted text");
      assert.equal(parseExposAwardsProfile(PROFILE_VIDEO).reviewCount, 6, "second profile parsed");
      pass(7, "every fetched text is marked untrusted: true");
    } catch (err) {
      fail(7, "every fetched text is marked untrusted: true", err);
    }

    // 8. helpers: category guess, query phrases, listing parser, entry mapping
    try {
      assert.equal(guessCategory("Bridal makeup & hair stylist"), "makeup-artist");
      assert.equal(guessCategory("Kundan and polki jewellery"), "jewellery-store");
      assert.equal(guessCategory("nothing relevant here"), undefined);
      const q = buildQueries("wedding-planner", "Mumbai", "");
      assert.ok(q.some((s) => /wedding expo exhibitors/i.test(s)), "expo query phrase");
      assert.ok(q.some((s) => /wedding awards winners/i.test(s)), "awards query phrase");
      const entries = parseListingPage(LISTING_PAGE_3, URL_3, "any");
      assert.equal(entries.length, 2, "two bare-name winners parsed");
      assert.equal(entries[0].role, "winner");
      assert.equal(entries[0].event, "Fixture Wedding Awards");
      assert.equal(entries[0].year, "2024");
      const built = entryToLead(entries[0], URL_3, "any");
      assert.equal(built.category, "event-company");
      assert.equal((built as { reason?: string }).reason, "Fixture Wedding Awards 2024");
      // real expo exhibitor tables parse as rows with name + city + category
      const table = parseListingPage(TABLE_PAGE, "https://fixture-expo.example/gjs-2026", "any");
      assert.equal(table.length, 3, "three table rows parsed");
      assert.deepEqual(table.map((e) => e.name), ["Fixture Aaqua Gold", "Fixture Gemawat and Sons", "Fixture Deja Jewels"]);
      assert.equal(table[0].city, "MUMBAI");
      assert.equal(table[1].category, "jewellery-store", "Gold/Diamond mapped to jewellery-store");
      assert.equal(table[0].event, "GJS Mumbai Jewellery Expo", "event heading captured above the table");
      assert.equal(table[0].year, "2026");
      pass(8, "helpers map categories, build niche queries and parse roles/tables");
    } catch (err) {
      fail(8, "helpers map categories, build niche queries and parse roles", err);
    }
  } finally {
    if (prev === undefined) delete process.env.CHANNEL_CH_EXPOS_AWARDS; else process.env.CHANNEL_CH_EXPOS_AWARDS = prev;
  }

  console.log(`PASS ${results.filter((r) => r.startsWith("PASS")).length}/8 ch-expos-awards-check (Order WE6-ch-expos-awards)`);
  process.exit(0);
}

main().catch(() => {
  process.exitCode = 1;
});
