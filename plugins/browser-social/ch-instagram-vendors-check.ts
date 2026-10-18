// Order WE8-ch-instagram-vendors proof: offline check for the Instagram
// wedding/event vendors channel adapter. Every fixture is clearly fake
// (fixture_* handles, *.example domains) and the page structure mirrors the
// public Instagram profile/hashtag structure recorded in channels/instagram.ts
// (Order L50-ch-instagram, header verified 2026-10-09) - no live page was
// reachable through a read in this run, so no live read is claimed. Every
// transport (search, readPage, fetchFn, browser) is injected, so nothing dials
// out. Imports the adapter DIRECTLY (never via channels/index.ts). Does not
// import src/company/, so the sandbox-company-root preamble is not needed.
// Run (from the repo root):
//   npx tsx src/channels/ch-instagram-vendors-check.ts
import assert from "node:assert/strict";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { BrowserReaderLike, ChannelDeps } from "../../src/channels/types.js";
import {
  chInstagramVendors,
  instagramVendorSignals,
  parseInstagramListing,
  parseInstagramVendorPage,
  listingUrls,
  CATEGORY_BASE_TAGS,
  CH_INSTAGRAM_VENDORS_CATEGORIES,
  CH_INSTAGRAM_VENDORS_CHANNEL_ID,
} from "./ch-instagram-vendors.js";
import { channelAdapters } from "../../src/channels/registry.js";
import type { RawLead } from "../../src/types.js";
import type { ReachResult } from "../../src/reach.js";

// --- fixtures (clearly fake; structure mirrors the public page shape recorded
// --- in channels/instagram.ts) -----------------------------------------------

const P1 = listingUrls("wedding-planner", "Mumbai")[0]; // mumbaiweddingplanner
const P2 = listingUrls("wedding-planner", "Mumbai")[1]; // weddingplannermumbai
const P3 = listingUrls("wedding-planner", "Mumbai")[2]; // weddingplanner
const PROFILE_A = "https://www.instagram.com/fixture_planner_a/";
const PROFILE_BLOCKED = "https://www.instagram.com/fixture_planner_blocked/";

const EMPTY_PAGE = `
#weddingplanner
No posts to show.
`;

const LISTING_PAGE_1 = `
#mumbaiweddingplanner
Top posts

https://www.instagram.com/fixture_planner_a/
Photo by fixture_planner_a on October 1, 2026.
Located in Bandra, Mumbai
Phone: +91 90000 00001
Website: https://fixture-planner-a.example/

https://www.instagram.com/fixture_planner_b/
Photo by fixture_planner_b on October 2, 2026.
Located in Andheri, Mumbai
`;

const LISTING_PAGE_2 = `
#weddingplannermumbai
Recent

https://www.instagram.com/fixture_planner_c/
Photo by fixture_planner_c on October 3, 2026.
Located in Powai, Mumbai

https://www.instagram.com/fixture_planner_d/
Photo by fixture_planner_d on October 4, 2026.
Located in Colaba, Mumbai
`;

const LISTING_PAGE_3 = `
#weddingplanner
Recent

https://www.instagram.com/fixture_planner_e/
Photo by fixture_planner_e on October 5, 2026.
Located in Vashi, Navi Mumbai
Phone: +91 90000 00005
`;

const PROFILE_A_TEXT = `
https://www.instagram.com/fixture_planner_a/
fixture_planner_a's profile picture
12.5K followers
340 following
210 posts
Name: Fixture Planner A
Category: Wedding Planner
Bio: Wedding planning studio in Mumbai.
Link in bio: https://fixture-plana.example/
Call: +91 90000 00001
Email: hello@fixture-plana.example
Bandra, Mumbai
84 photos
36 videos
5.0 out of 5 rating
15 reviews
From ₹2,50,000
Services: Venue selection, Catering, Decoration
10 years of experience
Photo by fixture_planner_a on October 1, 2026.
Video by fixture_planner_a on September 20, 2026.
https://www.youtube.com/fixtureplana
https://www.facebook.com/fixtureplana
`;

// --- signal fixtures ---------------------------------------------------------

const PORTFOLIO_NO_VIDEO_POS = "Fixture Photographer\nPortfolio: 84 photos from real weddings.\nLocated in Bandra, Mumbai";
const HAS_VIDEO_POS = "Fixture Studio\n36 videos 84 photos from weddings.";
const SOCIAL_VIDEO_ACTIVE_POS = "Fixture Planner\nLatest reel posted 5 days ago.";
const SOCIAL_VIDEO_ACTIVE_NEG = "Fixture Planner\nLatest reel posted 120 days ago.";
const SOCIAL_INACTIVE_POS = "Fixture Planner\nLast post 120 days ago.";
const SOCIAL_INACTIVE_NEG = "Fixture Planner\nLast post 10 days ago.";
const HIGH_REVIEW_POS = "Fixture Venue\n120 reviews and 5.0 out of 5 rating.";
const HIGH_REVIEW_NEG = "Fixture Venue\n12 reviews and 5.0 out of 5 rating.";
const PREMIUM_POS = "Verified\n## Fixture Vendor";
const PREMIUM_NEG = "## Fixture Vendor";
const MULTICITY_POS = "Fixture Planner\nServed in Ahmedabad, Mumbai, Pune and Udaipur";
const MULTICITY_NEG = "Fixture Planner\nServed in Mumbai";
const PRICE_POS = "Fixture Planner\nFrom ₹2,50,000";
const PRICE_NEG = "Fixture Planner\nContact for a quote.";

const FIXED_NOW_MS = Date.parse("2026-10-12T00:00:00.000Z");

// --- fakes -------------------------------------------------------------------

function reachOk(text: string): Promise<ReachResult> {
  return Promise.resolve({ ok: true, channel: "fixture", text, untrusted: true, trace: [] });
}
function reachBlocked(): Promise<ReachResult> {
  return Promise.resolve({ ok: false, channel: "fixture", text: "HTTP 403 blocked", untrusted: true, trace: [], error: "HTTP 403" });
}

const readLog: string[] = [];
let sleepCalls = 0;

function fakeFetch(map: Record<string, string> = {}): typeof fetch {
  const fn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    const text = map[url] ?? "";
    return { ok: true, status: 200, text: async () => text } as unknown as Response;
  };
  return fn as unknown as typeof fetch;
}

function depsWith(overrides: Partial<ChannelDeps> = {}): ChannelDeps {
  return {
    search: () => reachBlocked(),
    readPage: (url: string): Promise<ReachResult> => {
      readLog.push(url);
      if (url === P1) return reachOk(LISTING_PAGE_1);
      if (url === P2) return reachOk(LISTING_PAGE_2);
      if (url === P3) return reachOk(LISTING_PAGE_3);
      if (url === PROFILE_A) return reachOk(PROFILE_A_TEXT);
      if (url === PROFILE_BLOCKED) return reachBlocked();
      if (url.includes("blockedcity")) return reachBlocked();
      return reachOk(EMPTY_PAGE);
    },
    fetchFn: fakeFetch(),
    limiter: { sleep: async () => { sleepCalls += 1; } },
    now: () => FIXED_NOW_MS,
    ...overrides,
  };
}

function fakeBrowser(): BrowserReaderLike {
  return {
    read: async (url: string) => ({ text: "", url }),
    search: async (site: string, query: string) => ({ text: "", url: `https://www.${site}/search?q=${query}` }),
    status: () => ({ enabled: true, killSwitch: false, backends: { opencli: { ok: true }, cdp: { ok: false, url: "http://127.0.0.1:9222" } } }),
  } as unknown as BrowserReaderLike;
}

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
  const prev = process.env.CHANNEL_CH_INSTAGRAM_VENDORS;
  delete process.env.CHANNEL_CH_INSTAGRAM_VENDORS;

  try {
    // 1. registered; status off by default, on only when the env var is "1"
    try {
      assert.ok(channelAdapters().includes(chInstagramVendors), "adapter self-registered via import");
      assert.equal(chInstagramVendors.id, "ch-instagram-vendors");
      assert.equal(chInstagramVendors.tier, "B");
      const off = chInstagramVendors.status();
      assert.equal(off.enabled, false, "disabled by default");
      assert.match(off.why ?? "", /CHANNEL_CH_INSTAGRAM_VENDORS/, `why names the env: ${off.why}`);
      process.env.CHANNEL_CH_INSTAGRAM_VENDORS = "1";
      assert.equal(chInstagramVendors.status().enabled, true, "enabled with CHANNEL_CH_INSTAGRAM_VENDORS=1");
      process.env.CHANNEL_CH_INSTAGRAM_VENDORS = "0";
      assert.equal(chInstagramVendors.status().enabled, false, "=0 is still off");
      delete process.env.CHANNEL_CH_INSTAGRAM_VENDORS;
      pass(1, "status is off by default and on only with CHANNEL_CH_INSTAGRAM_VENDORS=1");
    } catch (err) {
      fail(1, "status is off by default and on only with CHANNEL_CH_INSTAGRAM_VENDORS=1", err);
    }

    // 2. discover returns the expected leads with their source URLs
    try {
      readLog.length = 0;
      assert.ok(P1.includes("mumbaiweddingplanner"), `hashtag #mumbaiweddingplanner built: ${P1}`);
      assert.ok(P2.includes("weddingplannermumbai"), `base+city tag built: ${P2}`);
      assert.ok(P3.includes("/tags/weddingplanner/"), `plain base tag built: ${P3}`);
      const leads = await chInstagramVendors.discover(
        { category: "wedding-planner", city: "Mumbai", limit: 5 },
        depsWith(),
      );
      assert.equal(leads.length, 5, `five leads across three listing pages, got ${leads.length}`);
      const names = leads.map((l) => l.name);
      assert.deepEqual(names, ["fixture_planner_a", "fixture_planner_b", "fixture_planner_c", "fixture_planner_d", "fixture_planner_e"]);
      for (const l of leads as RawLead[]) {
        assert.match(l.sourceUrl, /^https:\/\/www\.instagram\.com\//, `sourceUrl is an Instagram URL: ${l.sourceUrl}`);
        assert.equal(l.source, CH_INSTAGRAM_VENDORS_CHANNEL_ID, "source is the channel id");
        assert.equal(l.category, "wedding-planner", "category is the requested canonical id");
      }
      assert.equal(leads[0].sourceUrl, PROFILE_A, `source URL recorded: ${leads[0].sourceUrl}`);
      assert.equal(leads[0].address, "Bandra", `area copied: ${leads[0].address}`);
      assert.equal(leads[0].city, "Mumbai", `city copied: ${leads[0].city}`);
      assert.equal(leads[0].phone, "+91 90000 00001", `phone copied: ${leads[0].phone}`);
      assert.equal(leads[0].website, "https://fixture-planner-a.example/", `website copied: ${leads[0].website}`);
      pass(2, "discover turns fixture listing pages into RawLead with source URLs, area, city, phone and website");
    } catch (err) {
      fail(2, "discover turns fixture listing pages into RawLead with source URLs, area, city, phone and website", err);
    }

    // 3. pagination: reads pages 1..3, pauses between pages
    try {
      readLog.length = 0;
      sleepCalls = 0;
      await chInstagramVendors.discover({ category: "wedding-planner", city: "Mumbai", limit: 5 }, depsWith());
      assert.ok(readLog.includes(P1), "listing page 1 read");
      assert.ok(readLog.includes(P2), "listing page 2 read");
      assert.ok(readLog.includes(P3), "listing page 3 read");
      assert.equal(sleepCalls, 2, `limiter.sleep called between listing pages (2 pauses), got ${sleepCalls}`);
      pass(3, "pagination pages through listing pages politely and stops at the limit");
    } catch (err) {
      fail(3, "pagination pages through listing pages politely and stops at the limit", err);
    }

    // 4. limit is respected: limit 3 stops before page 3 is fetched
    try {
      readLog.length = 0;
      const leads = await chInstagramVendors.discover(
        { category: "wedding-planner", city: "Mumbai", limit: 3 },
        depsWith(),
      );
      assert.equal(leads.length, 3, `limit 3 returns exactly 3, got ${leads.length}`);
      assert.ok(!readLog.includes(P3), "listing page 3 never fetched once the limit is reached");
      pass(4, "the limit is respected and paging stops early");
    } catch (err) {
      fail(4, "the limit is respected and paging stops early", err);
    }

    // 5. blocked listing page returns [] with no throw (no browser configured)
    try {
      const leads = await chInstagramVendors.discover(
        { category: "wedding-planner", city: "Mumbai", limit: 5 },
        depsWith({ readPage: () => reachBlocked(), fetchFn: fakeFetch() }),
      );
      assert.deepEqual(leads, [], `blocked pages return [], got ${JSON.stringify(leads)}`);
      // a single blocked listing page also yields [] and never throws
      const oneBlocked = parseInstagramListing("HTTP 403 forbidden", "wedding-planner");
      assert.deepEqual(oneBlocked, [], "a blocked page body produces no leads");
      pass(5, "a blocked listing page returns [] without a throw");
    } catch (err) {
      fail(5, "a blocked listing page returns [] without a throw", err);
    }

    // 5b. injected fetchFn is used when the page read is blocked (empty body)
    try {
      const leads = await chInstagramVendors.discover(
        { category: "wedding-planner", city: "Mumbai", limit: 2 },
        depsWith({
          readPage: () => reachOk(""),
          fetchFn: fakeFetch({ [P1]: LISTING_PAGE_1 }),
        }),
      );
      assert.equal(leads.length, 2, `fetchFn fallback produced two leads, got ${leads.length}`);
      assert.equal(leads[0].sourceUrl, PROFILE_A, "leads came from the fetched page");
      pass(6, "injected fetchFn is used when the plain page read returns a blocked/empty body");
    } catch (err) {
      fail(6, "injected fetchFn is used when the plain page read returns a blocked/empty body", err);
    }

    // 6. enrich extracts each required field from a fixture profile
    try {
      const ev = await chInstagramVendors.enrich(
        { name: "Fixture Planner A", category: "wedding-planner", city: "Mumbai", source: CH_INSTAGRAM_VENDORS_CHANNEL_ID, sourceUrl: PROFILE_A },
        depsWith(),
      );
      assert.equal(ev.via, "page", "fixture search is blocked so the page read wins the chain");
      assert.equal(ev.channel, CH_INSTAGRAM_VENDORS_CHANNEL_ID);
      const want: Record<string, string | number> = {
        handle: "fixture_planner_a",
        name: "Fixture Planner A",
        area: "Bandra",
        city: "Mumbai",
        phone: "+91 90000 00001",
        email: "hello@fixture-plana.example",
        website: "https://fixture-plana.example/",
        portfolioPhotoCount: 84,
        hasVideo: "yes",
        reviewCount: 15,
        rating: 5,
        priceFrom: 250000,
        priceLabel: "₹2,50,000",
        yearsInBusiness: 10,
      };
      for (const [k, v] of Object.entries(want)) {
        assert.deepEqual(ev.fields[k], v, `field ${k} extracted verbatim (got ${JSON.stringify(ev.fields[k])})`);
      }
      assert.match(String(ev.fields.socials), /youtube\.com\/fixtureplana/, `socials: ${String(ev.fields.socials)}`);
      assert.match(String(ev.fields.socials), /facebook\.com\/fixtureplana/, `socials has facebook: ${String(ev.fields.socials)}`);
      assert.match(String(ev.fields.services), /Venue selection, Catering, Decoration/, `services: ${String(ev.fields.services)}`);
      assert.equal(ev.fields.lastVideoDate, "September 20, 2026", `last video date: ${String(ev.fields.lastVideoDate)}`);
      pass(7, "enrich extracts portfolio photos, video, reviews, rating, price, socials, services and years");
    } catch (err) {
      fail(7, "enrich extracts portfolio photos, video, reviews, rating, price, socials, services and years", err);
    }

    // 6b. blocked profile with a login-wall browser read -> needs-human, no throw
    try {
      const ev = await chInstagramVendors.enrich(
        { name: "Fixture Planner Blocked", category: "wedding-planner", city: "Mumbai", source: CH_INSTAGRAM_VENDORS_CHANNEL_ID, sourceUrl: PROFILE_BLOCKED },
        depsWith({
          browser: {
            ...(fakeBrowser() as BrowserReaderLike),
            read: async () => { throw new BrowserBlockedError("sign in to continue (fixture login wall)", CH_INSTAGRAM_VENDORS_CHANNEL_ID, false); },
          },
        }),
      );
      assert.equal(ev.via, "browser", "blocked search+page -> browser fallback");
      assert.equal(ev.signals.includes("needs-human"), true, "login wall -> needs-human signal");
      assert.equal(ev.fields.needsHuman, "true");
      pass(8, "a blocked profile with a login-wall browser read gives needs-human without a throw");
    } catch (err) {
      fail(8, "a blocked profile with a login-wall browser read gives needs-human without a throw", err);
    }

    // 7. each signal fires only on matching text (positive and negative cases)
    try {
      const pairs: [string, string, string][] = [
        [PORTFOLIO_NO_VIDEO_POS, HAS_VIDEO_POS, "portfolio-no-video"],
        [HAS_VIDEO_POS, PORTFOLIO_NO_VIDEO_POS, "has-video-portfolio"],
        [SOCIAL_VIDEO_ACTIVE_POS, SOCIAL_VIDEO_ACTIVE_NEG, "social-video-active"],
        [SOCIAL_INACTIVE_POS, SOCIAL_INACTIVE_NEG, "social-inactive"],
        [HIGH_REVIEW_POS, HIGH_REVIEW_NEG, "high-review-count"],
        [PREMIUM_POS, PREMIUM_NEG, "premium-listing"],
        [MULTICITY_POS, MULTICITY_NEG, "multi-city"],
        [PRICE_POS, PRICE_NEG, "price-band-known"],
      ];
      for (const [pos, neg, mustFire] of pairs) {
        const sPos = instagramVendorSignals(pos, FIXED_NOW_MS);
        const sNeg = instagramVendorSignals(neg, FIXED_NOW_MS);
        assert.ok(sPos.includes(mustFire), `${mustFire} fires on the positive fixture - got [${sPos.join(", ")}]`);
        assert.ok(!sNeg.includes(mustFire), `${mustFire} must NOT fire on the negative fixture - got [${sNeg.join(", ")}]`);
        assert.equal(sPos.filter((s) => s === mustFire).length, 1, "no duplicate signal ids");
        assert.deepEqual(chInstagramVendors.signals(pos), sPos, "adapter.signals uses the exported signal function");
      }
      pass(9, "each signal fires only on matching text (positive and negative cases)");
    } catch (err) {
      fail(9, "each signal fires only on matching text (positive and negative cases)", err);
    }

    // 8. every fetched text is untrusted: true
    try {
      const ev = await chInstagramVendors.enrich(
        { name: "Fixture Planner A", category: "wedding-planner", city: "Mumbai", source: CH_INSTAGRAM_VENDORS_CHANNEL_ID, sourceUrl: PROFILE_A },
        depsWith(),
      );
      assert.equal(ev.untrusted, true, "evidence is untrusted: true");
      assert.equal((await reachOk("x")).untrusted, true, "reach ok result untrusted: true");
      assert.equal((await reachBlocked()).untrusted, true, "reach blocked result untrusted: true");
      assert.ok(ev.text.length > 0, "evidence text is quoted material only");
      pass(10, "every fetched text is untrusted: true");
    } catch (err) {
      fail(10, "every fetched text is untrusted: true", err);
    }

    // 9. categories are limited to canonical ids this source really lists
    try {
      for (const c of CH_INSTAGRAM_VENDORS_CATEGORIES) {
        assert.ok(Object.prototype.hasOwnProperty.call(CATEGORY_BASE_TAGS, c), `category ${c} has hashtags`);
      }
      assert.deepEqual(chInstagramVendors.categories, [...CH_INSTAGRAM_VENDORS_CATEGORIES], "adapter categories mirror the declared list");
      const none = await chInstagramVendors.discover({ category: "unsupported-cat", city: "Mumbai" }, depsWith());
      assert.deepEqual(none, [], "an unsupported category returns [] without a throw");
      pass(11, "categories are limited to the canonical ids this source lists");
    } catch (err) {
      fail(11, "categories are limited to the canonical ids this source lists", err);
    }

    // 10. parsers never invent a field the page does not show
    try {
      const parsed = parseInstagramVendorPage("Fixture Minimal\nNothing else here.");
      assert.equal(parsed.rating, undefined, "rating stays missing");
      assert.equal(parsed.priceFrom, undefined, "priceFrom stays missing");
      assert.equal(parsed.services, undefined, "services stays missing");
      assert.equal(parsed.socials, undefined, "socials stays missing");
      assert.equal(parsed.portfolioPhotoCount, undefined, "portfolioPhotoCount stays missing");
      const leadsNoUrl = parseInstagramListing("No profile links here.", "wedding-planner");
      assert.deepEqual(leadsNoUrl, [], "a changed/empty listing yields []");
      pass(12, "a field the page does not show stays missing");
    } catch (err) {
      fail(12, "a field the page does not show stays missing", err);
    }
  } finally {
    if (prev === undefined) delete process.env.CHANNEL_CH_INSTAGRAM_VENDORS;
    else process.env.CHANNEL_CH_INSTAGRAM_VENDORS = prev;
  }

  const passed = results.filter((r) => r.startsWith("PASS")).length;
  console.log(`PASS ${passed}/12 ch-instagram-vendors-check (Order WE8-ch-instagram-vendors)`);
  console.log(`FINAL VERDICT: ${passed === 12 ? "PASS" : "FAIL"} (${passed}/12 items passed)`);
  process.exit(0);
}

main().catch(() => {
  console.log("FINAL VERDICT: FAIL");
  process.exitCode = 1;
});
