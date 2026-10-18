// Order WE3-ch-weddingwire-in proof: offline check for the WeddingWire India
// channel adapter. All fixtures are clearly fake (fixture-*.example domains and
// fake names); the page structure mirrors the real weddingwire.in listing and
// profile pages confirmed on 2026-10-12 (direct GET is 403, read through a
// proxy). Every transport (search, page read, browser) is injected, so nothing
// dials out. Does not import src/company/, so the sandbox-company-root
// preamble is not needed.
// Run (from the repo root): npx tsx src/channels/ch-weddingwire-in-check.ts
import assert from "node:assert/strict";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { BrowserReaderLike, ChannelDeps } from "../../src/channels/types.js";
import {
  weddingwireIn,
  parseListingPage,
  parseWeddingwirePage,
  weddingwireSignals,
  CATEGORY_PATHS,
  WEDDINGWIRE_IN_CHANNEL_ID,
} from "./ch-weddingwire-in.js";
import { channelAdapters } from "../../src/channels/registry.js";
import type { RawLead } from "../../src/types.js";
import type { ReachResult } from "../../src/reach.js";

// --- fixtures (clearly fake; structure mirrors the real pages confirmed on
// --- 2026-10-12) -------------------------------------------------------------

const BASE = "https://www.weddingwire.in/wedding-planners/mumbai";
const BASE_P2 = `${BASE}?page=2`;
const BASE_P3 = `${BASE}?page=3`;
const BASE_AREA = "https://www.weddingwire.in/wedding-planners/mumbai/mumbai-central-byculla";
const BASE_BLOCKED = "https://www.weddingwire.in/wedding-planners/blocked-city";
const PROFILE_A = "https://www.weddingwire.in/wedding-planners/fixture-plan-a--e111111";
const PROFILE_BLOCKED = "https://www.weddingwire.in/wedding-planners/fixture-plan-blocked--e999999";

const LISTING_PAGE_1 = `
# Wedding Planners Mumbai

80 results

![Image 1](https://cdn0.weddingwire.in/x.jpeg)View 159 more photos     TOP  ## [Fixture Plan A](https://www.weddingwire.in/wedding-planners/fixture-plan-a--e111111)

4.9 (7)  ·Mumbai Central - Byculla, Mumbai 
Get acquainted with Fixture Plan A, an established wedding planner...Read more specialising in bespoke weddings.

 From ₹2,50,000   1 promotion    Request pricing  Responds within 24 hours     
*   ![Image 2](https://cdn0.weddingwire.in/y.jpeg)View 50 more photos     PREMIUM  ## [Fixture Plan B](https://www.weddingwire.in/wedding-planners/fixture-plan-b--e222222)

5.0 (23)  ·Santacruz East, Mumbai 
Revel in celebrations planned by Fixture Plan B...Read more.

 From ₹1,50,000   1 promotion    Request pricing  Responds within 24 hours     
`;

const LISTING_PAGE_2 = `
# Wedding Planners Mumbai

## [Fixture Plan C](https://www.weddingwire.in/wedding-planners/fixture-plan-c--e333333)

4.8 (12)  ·Bandra, Mumbai 
Fixture Plan C is a wedding planner...Read more.

 From ₹3,00,000   Request pricing     

## [Fixture Plan D](https://www.weddingwire.in/wedding-planners/fixture-plan-d--e444444)

4.6 (4)  ·Powai, Mumbai 
Fixture Plan D is a wedding planner...Read more.

 From ₹80,000   Request pricing     
`;

// changed / empty page: no cards -> discovery stops cleanly
const LISTING_PAGE_3 = `
# Wedding Planners Mumbai

No vendors found. Please adjust your filters.
`;

const PROFILE_A_TEXT = `
# Fixture Plan A

 5.0 out of 5 rating 5.0 Fantastic 15 reviews 

 Mumbai Central - Byculla, Mumbai 

 Planning fee ₹2,50,000 

 PREMIUM 

 Recommended by 100% of couples 

36 videos 84 photos 

## About this vendor

 On Weddingwire.in since 2021 

Plan your wedding with Fixture Plan A, an expert wedding planner in Mumbai with 10 years of experience in creating beautifully organised celebrations.

 Website: https://fixture-plana.example/ 

 Instagram https://www.instagram.com/fixtureplana 
 Facebook https://www.facebook.com/fixtureplana 

### What is the price range of your fixed planning fee?

 ₹2,50,000 - ₹2,99,999 

## Awards

 15 

### Served in 

Ahmedabad, Mumbai, Pune and Udaipur 

 What specific wedding planning services does Fixture Plan A provide? 

 Fixture Plan A expertises in the following wedding planning services: 

- Venue selection 
- Catering 
- Photography/ Videography 
- Decoration 
- DJ & entertainment 
`;

// --- signal fixtures ---------------------------------------------------------

const PORTFOLIO_NO_VIDEO_POS = "Fixture Photographer\nPortfolio: 84 photos from real weddings.\nWedding photography and candid shoots.";
const HAS_VIDEO_POS = "Fixture Photographer\n36 videos 84 photos from weddings.";

const SOCIAL_VIDEO_ACTIVE_POS = "Fixture Planner\nLatest reel posted 5 days ago.";
const SOCIAL_VIDEO_ACTIVE_NEG = "Fixture Planner\nLatest reel posted 120 days ago.";
const SOCIAL_INACTIVE_POS = "Fixture Planner\nLast post 120 days ago.";
const SOCIAL_INACTIVE_NEG = "Fixture Planner\nLast post 10 days ago.";
const HIGH_REVIEW_POS = "Fixture Venue\n120 reviews and 5.0 out of 5 rating.";
const HIGH_REVIEW_NEG = "Fixture Venue\n12 reviews and 5.0 out of 5 rating.";
const PREMIUM_POS = "PREMIUM\n## Fixture Vendor\nFrom ₹50,000";
const PREMIUM_NEG = "## Fixture Vendor\nFrom ₹50,000";
const MULTICITY_POS = "Fixture Planner\nServed in \nAhmedabad, Mumbai, Pune and Udaipur";
const MULTICITY_NEG = "Fixture Planner\nServed in Mumbai";
const PRICE_POS = "Fixture Planner\nFrom ₹2,50,000";
const PRICE_NEG = "Fixture Planner\nContact for a quote.";

// --- fakes -------------------------------------------------------------------

function reachOk(text: string): Promise<ReachResult> {
  return Promise.resolve({ ok: true, channel: "fixture", text, untrusted: true, trace: [] });
}
function reachBlocked(): Promise<ReachResult> {
  return Promise.resolve({ ok: false, channel: "fixture", text: "HTTP 403 blocked", untrusted: true, trace: [], error: "HTTP 403" });
}

const readLog: string[] = [];
let sleepCalls = 0;

function depsWith(overrides: Partial<ChannelDeps> = {}): ChannelDeps {
  return {
    search: () => reachBlocked(),
    readPage: (url: string): Promise<ReachResult> => {
      readLog.push(url);
      if (url === BASE_BLOCKED) return reachBlocked();
      if (url === PROFILE_BLOCKED) return reachBlocked();
      if (url === BASE_P3) return reachOk(LISTING_PAGE_3);
      if (url === BASE_P2) return reachOk(LISTING_PAGE_2);
      if (url === PROFILE_A) return reachOk(PROFILE_A_TEXT);
      if (url === BASE_AREA) return reachOk(LISTING_PAGE_1);
      return reachOk(LISTING_PAGE_1);
    },
    limiter: { sleep: async () => { sleepCalls += 1; } },
    now: () => 0,
    ...overrides,
  };
}

function fakeBrowser(text: string): BrowserReaderLike {
  return {
    read: async (url: string) => ({ text, url }),
    search: async (site: string, query: string) => ({ text, url: `https://www.${site}/search?q=${query}` }),
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
  const prev = process.env.CHANNEL_CH_WEDDINGWIRE_IN;
  delete process.env.CHANNEL_CH_WEDDINGWIRE_IN;

  try {
    // 1. registered; status off by default, on only when the env var is "1"
    try {
      assert.ok(channelAdapters().includes(weddingwireIn), "adapter self-registered via import");
      assert.equal(weddingwireIn.id, "ch-weddingwire-in");
      assert.equal(weddingwireIn.tier, "B");
      const off = weddingwireIn.status();
      assert.equal(off.enabled, false, "disabled by default");
      assert.match(off.why ?? "", /CHANNEL_CH_WEDDINGWIRE_IN/, `why names the env: ${off.why}`);
      process.env.CHANNEL_CH_WEDDINGWIRE_IN = "1";
      assert.equal(weddingwireIn.status().enabled, true, "enabled with CHANNEL_CH_WEDDINGWIRE_IN=1");
      process.env.CHANNEL_CH_WEDDINGWIRE_IN = "0";
      assert.equal(weddingwireIn.status().enabled, false, "=0 is still off");
      delete process.env.CHANNEL_CH_WEDDINGWIRE_IN;
      pass(1, "status is off by default and on only with CHANNEL_CH_WEDDINGWIRE_IN=1");
    } catch (err) {
      fail(1, "status is off by default and on only with CHANNEL_CH_WEDDINGWIRE_IN=1", err);
    }

    // 2. discovery: fixture listing cards -> RawLead with source URLs, area, city
    try {
      readLog.length = 0;
      const leads = await weddingwireIn.discover(
        { category: "wedding-planner", city: "Mumbai", limit: 3 },
        depsWith(),
      );
      assert.equal(leads.length, 3, `three leads across two pages with limit 3, got ${leads.length}`);
      for (const l of leads as RawLead[]) {
        assert.match(l.sourceUrl, /^https:\/\/www\.weddingwire\.in\//, `sourceUrl is a WeddingWire URL: ${l.sourceUrl}`);
        assert.equal(l.source, WEDDINGWIRE_IN_CHANNEL_ID, "source is the channel id");
        assert.equal(l.category, "wedding-planner", "category is the requested canonical id");
      }
      assert.equal(leads[0].name, "Fixture Plan A", `name copied from the card link: ${leads[0].name}`);
      assert.equal(leads[0].address, "Mumbai Central - Byculla", `area copied: ${leads[0].address}`);
      assert.equal(leads[0].city, "Mumbai", `city copied: ${leads[0].city}`);
      assert.equal(leads[1].name, "Fixture Plan B", `second name: ${leads[1].name}`);
      assert.equal(leads[2].name, "Fixture Plan C", `third name from page 2: ${leads[2].name}`);
      pass(2, "discovery turns fixture listing cards into RawLead with source URLs, area and city");
    } catch (err) {
      fail(2, "discovery turns fixture listing cards into RawLead with source URLs, area and city", err);
    }

    // 3. pagination: reads pages 1..3, sleeps between pages, stops on the empty page
    try {
      readLog.length = 0;
      sleepCalls = 0;
      const leads = await weddingwireIn.discover(
        { category: "wedding-planner", city: "Mumbai", limit: 5 },
        depsWith(),
      );
      assert.equal(leads.length, 4, `all four cards across pages 1-2, got ${leads.length}`);
      assert.ok(readLog.includes(BASE), "page 1 (base URL) read");
      assert.ok(readLog.includes(BASE_P2), "page 2 (?page=2) read");
      assert.ok(readLog.includes(BASE_P3), "page 3 (?page=3) read and stopped cleanly");
      assert.equal(sleepCalls, 2, `limiter.sleep called between pages (2 pauses), got ${sleepCalls}`);
      pass(3, "pagination pages through results politely and stops on an empty page");
    } catch (err) {
      fail(3, "pagination pages through results politely and stops on an empty page", err);
    }

    // 4. limit is respected: limit 3 stops before page 3 is fetched
    try {
      readLog.length = 0;
      const leads = await weddingwireIn.discover(
        { category: "wedding-planner", city: "Mumbai", limit: 3 },
        depsWith(),
      );
      assert.equal(leads.length, 3, `limit 3 returns exactly 3, got ${leads.length}`);
      assert.ok(!readLog.includes(BASE_P3), "page 3 never fetched once the limit is reached");
      pass(4, "the limit is respected and paging stops early");
    } catch (err) {
      fail(4, "the limit is respected and paging stops early", err);
    }

    // 4b. area composes the /<city>/<area> URL
    try {
      readLog.length = 0;
      const leads = await weddingwireIn.discover(
        { category: "wedding-planner", city: "Mumbai", area: "Mumbai Central - Byculla", limit: 5 },
        depsWith(),
      );
      assert.ok(readLog.includes(BASE_AREA), `area URL built: ${readLog.join(" | ")}`);
      assert.equal(leads.length, 2, `two leads from the area listing, got ${leads.length}`);
      pass(4, "an area composes the /city/area listing URL");
    } catch (err) {
      fail(4, "an area composes the /city/area listing URL", err);
    }

    // 5. blocked listing page returns [] with no throw (no browser configured)
    try {
      const leads = await weddingwireIn.discover(
        { category: "wedding-planner", city: "Blocked-City", limit: 5 },
        depsWith(),
      );
      assert.deepEqual(leads, [], `blocked page returns [], got ${JSON.stringify(leads)}`);
      pass(5, "a blocked listing page returns [] without a throw");
    } catch (err) {
      fail(5, "a blocked listing page returns [] without a throw", err);
    }

    // 6. enrich extracts each required field from a fixture profile
    try {
      const ev = await weddingwireIn.enrich(
        {
          name: "Fixture Plan A",
          category: "wedding-planner",
          city: "Mumbai",
          source: WEDDINGWIRE_IN_CHANNEL_ID,
          sourceUrl: PROFILE_A,
        },
        depsWith(),
      );
      assert.equal(ev.via, "page", "fixture search is blocked so the page read wins the chain");
      assert.equal(ev.channel, WEDDINGWIRE_IN_CHANNEL_ID);
      const want: Record<string, string | number> = {
        name: "Fixture Plan A",
        area: "Mumbai Central - Byculla",
        city: "Mumbai",
        rating: 5,
        reviewCount: 15,
        priceFrom: 250000,
        priceLabel: "₹2,50,000",
        photoCount: 84,
        videoCount: 36,
        yearsInBusiness: 10,
        premium: "yes",
        website: "https://fixture-plana.example/",
      };
      for (const [k, v] of Object.entries(want)) {
        assert.deepEqual(ev.fields[k], v, `field ${k} extracted verbatim (got ${JSON.stringify(ev.fields[k])})`);
      }
      assert.match(String(ev.fields.services), /Venue selection, Catering, Photography\/ Videography, Decoration, DJ & entertainment/,
        `services listed: ${String(ev.fields.services)}`);
      assert.match(String(ev.fields.socials), /instagram\.com\/fixtureplana/, `socials: ${String(ev.fields.socials)}`);
      assert.match(String(ev.fields.socials), /facebook\.com\/fixtureplana/, `socials includes facebook: ${String(ev.fields.socials)}`);
      pass(6, "enrich extracts photo/video counts, rating, reviews, price, services, years, socials and badges");
    } catch (err) {
      fail(6, "enrich extracts photo/video counts, rating, reviews, price, services, years, socials and badges", err);
    }

    // 6b. blocked profile with a login-wall browser read -> needs-human, no throw
    try {
      const ev = await weddingwireIn.enrich(
        {
          name: "Fixture Plan Blocked",
          category: "wedding-planner",
          city: "Mumbai",
          source: WEDDINGWIRE_IN_CHANNEL_ID,
          sourceUrl: PROFILE_BLOCKED,
        },
        depsWith({
          browser: {
            ...(fakeBrowser("") as BrowserReaderLike),
            read: async () => { throw new BrowserBlockedError("sign in to continue (fixture login wall)", WEDDINGWIRE_IN_CHANNEL_ID, false); },
          },
        }),
      );
      assert.equal(ev.via, "browser", "blocked search+page -> browser fallback");
      assert.equal(ev.signals.includes("needs-human"), true, "login wall -> needs-human signal");
      assert.equal(ev.fields.needsHuman, "true");
      pass(6, "a blocked profile with a login-wall browser read gives needs-human without a throw");
    } catch (err) {
      fail(6, "a blocked profile with a login-wall browser read gives needs-human without a throw", err);
    }

    // 7. every signal fires on its positive fixture and not on its negative
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
        const sPos = weddingwireSignals(pos);
        const sNeg = weddingwireSignals(neg);
        assert.ok(sPos.includes(mustFire), `${mustFire} fires on the positive fixture — got [${sPos.join(", ")}]`);
        assert.ok(!sNeg.includes(mustFire), `${mustFire} must NOT fire on the negative fixture — got [${sNeg.join(", ")}]`);
        assert.equal(sPos.filter((s) => s === mustFire).length, 1, "no duplicate signal ids");
        // adapter.signals is the same function
        assert.deepEqual(weddingwireIn.signals(pos), sPos, "adapter.signals uses the exported signal function");
      }
      pass(7, "each signal fires only on matching text (positive and negative cases)");
    } catch (err) {
      fail(7, "each signal fires only on matching text (positive and negative cases)", err);
    }

    // 8. every fetched text is untrusted: true
    try {
      const ev = await weddingwireIn.enrich(
        {
          name: "Fixture Plan A",
          category: "wedding-planner",
          city: "Mumbai",
          source: WEDDINGWIRE_IN_CHANNEL_ID,
          sourceUrl: PROFILE_A,
        },
        depsWith(),
      );
      assert.equal(ev.untrusted, true, "evidence is untrusted: true");
      const ok = await reachOk("x");
      const blocked = await reachBlocked();
      assert.equal(ok.untrusted, true, "reach page result untrusted: true");
      assert.equal(blocked.untrusted, true, "reach blocked result untrusted: true");
      assert.ok(ev.text.length > 0, "evidence text is quoted material only");
      pass(8, "every fetched text is untrusted: true");
    } catch (err) {
      fail(8, "every fetched text is untrusted: true", err);
    }

    // 9. category/path map is limited to categories this source really lists
    try {
      assert.equal(CATEGORY_PATHS["photographer"], "wedding-photographers");
      assert.equal(CATEGORY_PATHS["banquet-hall"], "wedding-venues");
      assert.equal(CATEGORY_PATHS["jewellery-store"], "bridal-jewellery");
      assert.ok(!("destination-wedding-agent" in CATEGORY_PATHS), "no unverified destination-wedding-agent path");
      assert.deepEqual(weddingwireIn.categories, Object.keys(CATEGORY_PATHS), "adapter categories mirror the path map");
      const none = await weddingwireIn.discover({ category: "unsupported-cat", city: "Mumbai" }, depsWith());
      assert.deepEqual(none, [], "an unsupported category returns [] without a throw");
      pass(9, "categories are limited to real WeddingWire directory paths");
    } catch (err) {
      fail(9, "categories are limited to real WeddingWire directory paths", err);
    }

    // 10. profile parser never invents a field the page does not show
    try {
      const parsed = parseWeddingwirePage("# Fixture Minimal\n\n Some text only. ");
      assert.equal(parsed.rating, undefined, "rating stays missing");
      assert.equal(parsed.priceFrom, undefined, "priceFrom stays missing");
      assert.equal(parsed.services, undefined, "services stays missing");
      assert.equal(parsed.socials, undefined, "socials stays missing");
      pass(10, "a field the page does not show stays missing");
    } catch (err) {
      fail(10, "a field the page does not show stays missing", err);
    }
  } finally {
    if (prev === undefined) delete process.env.CHANNEL_CH_WEDDINGWIRE_IN;
    else process.env.CHANNEL_CH_WEDDINGWIRE_IN = prev;
  }

  console.log(`PASS ${results.filter((r) => r.startsWith("PASS")).length}/10 ch-weddingwire-in-check (Order WE3-ch-weddingwire-in)`);
  process.exit(0);
}

main().catch(() => {
  process.exitCode = 1;
});
