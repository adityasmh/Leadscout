// Order WE4-ch-weddingsutra proof: offline check for the WeddingSutra channel adapter.
// All fixtures are clearly fake (fixture-*.example domains and fake phone numbers);
// every transport (search, page read) is injected, so nothing dials out. The page
// shapes mirror the real public structure confirmed on 2026-10-12 by reading the
// live listing https://weddingsutra.com/wedding-vendors/wedding-planners/ :
//   <a href="https://weddingsutra.com/vendor-profile/fb-celebrations/799" title="FB Celebrations">
//     <div class="card"> <div class="vendor-card vendor-inner-card">
//       <div class="card-img-top"><img ... class="wp-post-image vendor-image"></div>
//       <div class="card-body"><h5 class="card-title">FB Celebrations <span>
//         <i class="fa fa-map-marker" aria-hidden="true"></i> Mumbai </span></h5></div>
//   and /vendor/<slug>/ for non-featured vendors. shaadisaga.com could not be
// reached from this environment, so only weddingsutra.com is built (as the order allows).
// Does not import src/company/, so the sandbox-company-root preamble is not needed.
// Run (from the repo root): npx tsx src/channels/ch-weddingsutra-check.ts
import assert from "node:assert/strict";
import type { ChannelDeps } from "../../src/channels/types.js";
import {
  weddingsutra,
  parseListingLeads,
  parseWeddingSutraPage,
  weddingSutraSignals,
  WEDDINGSUTRA_CATEGORIES,
} from "./ch-weddingsutra.js";
import { channelAdapters } from "../../src/channels/registry.js";
import type { RawLead } from "../../src/types.js";
import type { ReachResult } from "../../src/reach.js";

// --- fixtures (clearly fake; real WeddingSutra structure) --------------------

const LISTING_PAGE_1 = `
<div class="vendor-card-main-section">
  <div class="col-md-3">
    <a href="https://weddingsutra.com/vendor-profile/fixture-bliss-events/799" title="Fixture Bliss Events">
      <div class="card"><div class="vendor-card vendor-inner-card">
        <div class="card-img-top"><img src="https://weddingsutra.com/images/fixture-bliss-thumb.jpg" class="wp-post-image vendor-image"></div>
        <div class="card-body"><h5 class="card-title">Fixture Bliss Events <span>
          <i class="fa fa-map-marker" aria-hidden="true"></i> Mumbai </span></h5></div>
      </div></div>
    </a>
    <p class="vendor-phone"><a href="tel:+919900000001">Call</a></p>
  </div>
  <div class="col-md-3">
    <a href="https://weddingsutra.com/vendor/fixture-royal-decor/" title="Fixture Royal Decor">
      <div class="card"><div class="vendor-card vendor-inner-card">
        <div class="card-body"><h5 class="card-title">Fixture Royal Decor <span>
          <i class="fa fa-map-marker" aria-hidden="true"></i> Mumbai </span></h5></div>
      </div></div>
    </a>
    <p class="vendor-phone"><a href="tel:+919900000002">Call</a></p>
  </div>
</div>
`;

const LISTING_PAGE_2 = `
<div class="vendor-card-main-section">
  <div class="col-md-3">
    <a href="https://weddingsutra.com/vendor/fixture-sparkle-events/" title="Fixture Sparkle Events">
      <div class="card"><div class="vendor-card vendor-inner-card">
        <div class="card-body"><h5 class="card-title">Fixture Sparkle Events <span>
          <i class="fa fa-map-marker" aria-hidden="true"></i> Mumbai </span></h5></div>
      </div></div>
    </a>
  </div>
  <div class="col-md-3">
    <a href="https://weddingsutra.com/vendor-profile/fixture-lens-studio/987" title="Fixture Lens Studio">
      <div class="card"><div class="vendor-card vendor-inner-card">
        <div class="card-body"><h5 class="card-title">Fixture Lens Studio <span>
          <i class="fa fa-map-marker" aria-hidden="true"></i> Mumbai </span></h5></div>
      </div></div>
    </a>
  </div>
</div>
`;

const LISTING_PAGE_3 = `
<div class="vendor-card-main-section">
  <div class="col-md-3">
    <a href="https://weddingsutra.com/vendor/fixture-petal-florals/" title="Fixture Petal Florals">
      <div class="card"><div class="vendor-card vendor-inner-card">
        <div class="card-body"><h5 class="card-title">Fixture Petal Florals <span>
          <i class="fa fa-map-marker" aria-hidden="true"></i> Mumbai </span></h5></div>
      </div></div>
    </a>
  </div>
  <div class="col-md-3">
    <a href="https://weddingsutra.com/vendor/fixture-gold-jewels/" title="Fixture Gold Jewels">
      <div class="card"><div class="vendor-card vendor-inner-card">
        <div class="card-body"><h5 class="card-title">Fixture Gold Jewels <span>
          <i class="fa fa-map-marker" aria-hidden="true"></i> Mumbai </span></h5></div>
      </div></div>
    </a>
  </div>
</div>
`;

const CHANGED_PAGE = `Home page only. No vendor cards here.`;

// Featured profile: a portfolio with photos AND a video, ratings, price, website,
// socials, services, years in business and a "WeddingSutra Favorites" label.
const PROFILE_FEATURED = `
<title>Fixture Bliss Events | Mumbai | WeddingSutra</title>
<h2 class="vendor-name">About Fixture Bliss Events</h2>
<span><i class="fa fa-map-marker" aria-hidden="true"></i> Mumbai </span>
<div id="content">Fixture Bliss Events is a fixture wedding planning studio in Mumbai with bespoke decor.</div>
<img src="https://weddingsutra.com/images/Vendor_Images/fixture-bliss/gallery-1.jpg" class="vendor-image">
<img src="https://weddingsutra.com/images/Vendor_Images/fixture-bliss/gallery-2.jpg" class="vendor-image">
<img src="https://weddingsutra.com/images/Vendor_Images/fixture-bliss/gallery-3.jpg" class="vendor-image">
<iframe src="https://www.youtube.com/embed/FIXTUREBLISS"></iframe>
<span class="rating-count-listing">4.8</span>
<div>128 Reviews</div>
<div class="extra_field"><span class="itemExtraFieldsLabel">Price</span><span class="itemExtraFieldsValue">₹ 2,50,000</span></div>
<div class="extra_field"><span class="itemExtraFieldsLabel">Services</span><span class="itemExtraFieldsValue">Wedding Planning, Decor, Catering</span></div>
<div class="extra_field"><span class="itemExtraFieldsLabel">Website</span><span class="itemExtraFieldsValue">https://fixture-bliss.example/</span></div>
<div>12 Years in Business</div>
<div>Cities: Mumbai, Delhi, Goa</div>
<img src="https://weddingsutra.com/images/vendors-img/weddingSutra-favorites/fixture-bliss.png">
<div class="social_vendor">
  <a href="https://www.instagram.com/fixturebliss">Instagram</a>
  <a href="https://www.facebook.com/fixturebliss">Facebook</a>
</div>
<a href="tel:+919900000001">Contact This Member</a>
<a href="mailto:hello@fixture-bliss.example">Email</a>
`;

// Second profile: photos but no video, few reviews, price "on request".
const PROFILE_SECOND = `
<title>Fixture Lens Studio | Pune | WeddingSutra</title>
<h2>About Fixture Lens Studio</h2>
<span><i class="fa fa-map-marker" aria-hidden="true"></i> Pune </span>
<div id="content">Fixture Lens Studio is a fixture wedding photography team documenting Indian weddings.</div>
<img src="https://weddingsutra.com/images/Vendor_Images/fixture-lens/shot-1.jpg" class="vendor-image">
<img src="https://weddingsutra.com/images/Vendor_Images/fixture-lens/shot-2.jpg" class="vendor-image">
<div>12 Reviews</div>
<div class="extra_field"><span class="itemExtraFieldsLabel">Price</span><span class="itemExtraFieldsValue">On request</span></div>
<div class="social_vendor"><a href="https://www.instagram.com/fixturelens">Instagram</a></div>
`;

// The blocked-page fixture: what a 403 wall returns to the reader.
const BLOCKED_PAGE = `HTTP 403 Forbidden - request blocked`;

// --- fakes -------------------------------------------------------------------

function reachOk(text: string): Promise<ReachResult> {
  return Promise.resolve({ ok: true, channel: "fixture", text, untrusted: true, trace: [] });
}
function reachBlockedFake(): Promise<ReachResult> {
  return Promise.resolve({ ok: false, channel: "fixture", text: BLOCKED_PAGE, untrusted: true, trace: [], error: "HTTP 403" });
}

// Listing dispatcher keyed by the /page/<n>/ URL segment (page 1 has none).
function listingDispatcher(): (url: string) => Promise<ReachResult> {
  return (url: string) => {
    const page = Number(url.match(/\/page\/(\d+)\//)?.[1] ?? "1");
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
    readPage: () => reachOk(PROFILE_FEATURED),
    limiter: {},
    now: () => Date.parse("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

const lead = (name: string): RawLead => ({
  name,
  category: "wedding-planner",
  city: "Mumbai",
  source: "ch-weddingsutra",
  sourceUrl: "https://weddingsutra.com/vendor/fixture-bliss-events/",
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
  const prev = process.env.CHANNEL_CH_WEDDINGSUTRA;
  delete process.env.CHANNEL_CH_WEDDINGSUTRA;

  try {
    // 1. registered; status off by default and on with CHANNEL_CH_WEDDINGSUTRA;
    //    metadata + only the categories this source really lists.
    try {
      assert.ok(channelAdapters().includes(weddingsutra), "adapter self-registered via import");
      assert.equal(weddingsutra.id, "ch-weddingsutra");
      assert.equal(weddingsutra.tier, "B");
      const off = weddingsutra.status();
      assert.equal(off.enabled, false, "off by default");
      assert.match(off.why ?? "", /CHANNEL_CH_WEDDINGSUTRA/, `why names the env: ${off.why}`);
      process.env.CHANNEL_CH_WEDDINGSUTRA = "1";
      assert.equal(weddingsutra.status().enabled, true, "on with CHANNEL_CH_WEDDINGSUTRA=1");
      process.env.CHANNEL_CH_WEDDINGSUTRA = "0";
      assert.equal(weddingsutra.status().enabled, false, "0 means off");
      delete process.env.CHANNEL_CH_WEDDINGSUTRA;
      for (const id of [
        "wedding-planner", "banquet-hall", "wedding-decorator", "caterer", "bridal-wear",
        "makeup-artist", "photographer", "dj-entertainer", "invitation-designer", "jewellery-store",
      ]) {
        assert.ok(WEDDINGSUTRA_CATEGORIES.includes(id), `declares canonical category ${id}`);
      }
      for (const id of ["event-company", "florist", "destination-wedding-agent"]) {
        assert.ok(!WEDDINGSUTRA_CATEGORIES.includes(id), `omits category the source does not list: ${id}`);
      }
      pass(1, "status is off by default and on only with CHANNEL_CH_WEDDINGSUTRA=1; metadata correct");
    } catch (err) {
      fail(1, "status is off by default and on only with CHANNEL_CH_WEDDINGSUTRA=1; metadata correct", err);
    }

    // 2. discovery returns the expected leads with source URLs
    try {
      const leads = await weddingsutra.discover(
        { category: "wedding-planner", city: "Mumbai", limit: 10 },
        depsWith({ readPage: listingDispatcher() }),
      );
      assert.equal(leads.length, 6, `six vendors across three pages, got ${leads.length}`);
      assert.deepEqual(
        leads.map((l) => l.name),
        ["Fixture Bliss Events", "Fixture Royal Decor", "Fixture Sparkle Events", "Fixture Lens Studio", "Fixture Petal Florals", "Fixture Gold Jewels"],
        "names copied from the card links in page order",
      );
      for (const l of leads) {
        assert.match(l.sourceUrl, /^https:\/\/weddingsutra\.com\/(?:vendor|vendor-profile)\//, `sourceUrl is a vendor URL: ${l.sourceUrl}`);
        assert.equal(l.source, "ch-weddingsutra");
        assert.equal(l.category, "wedding-planner");
        assert.equal(l.city, "Mumbai", `city copied from the card: ${l.city}`);
      }
      assert.equal(leads[0].phone, "+919900000001", `phone copied from the listing tel: link: ${leads[0].phone}`);
      // a changed page with no cards must never yield a lead
      assert.ok(!leads.some((l) => /Home page/.test(l.name)), "no phantom vendor from non-vendor links");
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

      const three = await weddingsutra.discover({ category: "wedding-planner", city: "Mumbai", limit: 3 }, deps);
      assert.equal(three.length, 3, "limit 3 respected");
      assert.deepEqual(calls.map((u) => u.match(/\/page\/(\d+)\//)?.[1] ?? "1"), ["1", "2"], "stops after page 2 for limit 3");
      assert.equal(sleeps.length, 1, "one polite pause between the two pages");

      calls.length = 0;
      sleeps.length = 0;
      const five = await weddingsutra.discover({ category: "wedding-planner", city: "Mumbai", limit: 5 }, deps);
      assert.equal(five.length, 5, "limit 5 respected");
      assert.deepEqual(calls.map((u) => u.match(/\/page\/(\d+)\//)?.[1] ?? "1"), ["1", "2", "3"], "pages 1-3 for limit 5");
      assert.equal(sleeps.length, 2, "two polite pauses across three pages");
      pass(3, "pagination respects the limiter and stops at the limit");
    } catch (err) {
      fail(3, "pagination respects the limiter and stops at the limit", err);
    }

    // 4. blocked or changed page returns [] with no throw
    try {
      const blocked = await weddingsutra.discover(
        { category: "wedding-planner", city: "Mumbai", limit: 10 },
        depsWith({ readPage: () => reachBlockedFake() }),
      );
      assert.deepEqual(blocked, [], "blocked page -> []");
      const changed = await weddingsutra.discover(
        { category: "wedding-planner", city: "Mumbai", limit: 10 },
        depsWith({ readPage: () => reachOk(CHANGED_PAGE) }),
      );
      assert.deepEqual(changed, [], "changed page with no cards -> []");
      pass(4, "a blocked or changed page returns [] without a throw");
    } catch (err) {
      fail(4, "a blocked or changed page returns [] without a throw", err);
    }

    // 5. enrich extracts each listed field from a profile fixture
    try {
      const ev = await weddingsutra.enrich(lead("Fixture Bliss Events"), depsWith());
      assert.equal(ev.via, "page", "search is blocked so the page read wins the chain");
      assert.equal(ev.channel, "ch-weddingsutra");
      assert.equal(ev.untrusted, true, "evidence marked untrusted");
      const want: Record<string, string | number> = {
        name: "Fixture Bliss Events",
        city: "Mumbai",
        photoCount: 3,
        hasVideo: "yes",
        reviewCount: 128,
        rating: 4.8,
        price: "₹ 2,50,000",
        startingPrice: "₹ 2,50,000",
        services: "Wedding Planning, Decor, Catering",
        yearsInBusiness: 12,
        website: "https://fixture-bliss.example/",
        instagram: "https://www.instagram.com/fixturebliss",
        facebook: "https://www.facebook.com/fixturebliss",
        youtube: "https://www.youtube.com/embed/FIXTUREBLISS",
        premium: "yes",
        phone: "+919900000001",
      };
      for (const [k, v] of Object.entries(want)) {
        assert.deepEqual(ev.fields[k], v, `field ${k} extracted verbatim (got ${JSON.stringify(ev.fields[k])})`);
      }
      assert.ok(ev.signals.includes("has-video-portfolio"), "video portfolio signal on the rich profile");
      assert.ok(ev.signals.includes("premium-listing"), "premium-listing on the Favorites profile");
      assert.ok(ev.signals.includes("high-review-count"), "high-review-count on 128 reviews");
      assert.ok(ev.signals.includes("multi-city"), "multi-city on 'Cities: Mumbai, Delhi, Goa'");
      assert.ok(ev.signals.includes("price-band-known"), "price-band-known on the published price");
      assert.ok(!ev.signals.includes("portfolio-no-video"), "no portfolio-no-video when a video is present");
      pass(5, "enrich extracts each listed field from a profile fixture");
    } catch (err) {
      fail(5, "enrich extracts each listed field from a profile fixture", err);
    }

    // 6. every signal fires on matching text and not otherwise
    try {
      const pairs: [string, string, string][] = [
        ["<div id=\"content\">Fixture floral decor portfolio photos</div>",
          "<div id=\"content\">Fixture floral decor portfolio photos</div><iframe src=\"https://www.youtube.com/embed/ABC\"></iframe>",
          "portfolio-no-video"],
        ["Watch our wedding film https://www.youtube.com/watch?v=ABC",
          "Portfolio of 5 photos of floral decor",
          "has-video-portfolio"],
        ["New reel posted 3 days ago", "New reel posted 2 years ago", "social-video-active"],
        ["Last post 4 months ago", "New post 3 days ago", "social-inactive"],
        ["175 Reviews", "6 Reviews", "high-review-count"],
        ["Featured Vendor", "Wedding Planners in Mumbai", "premium-listing"],
        ["Cities: Mumbai, Delhi, Goa", "City: Mumbai", "multi-city"],
        ["Starting price ₹ 25000", "Price on request", "price-band-known"],
      ];
      for (const [pos, neg, mustFire] of pairs) {
        const sPos = weddingsutra.signals(pos);
        const sNeg = weddingsutra.signals(neg);
        assert.ok(sPos.includes(mustFire), `${mustFire} fires on the positive fixture — got [${sPos.join(", ")}]`);
        assert.ok(!sNeg.includes(mustFire), `${mustFire} must NOT fire on the negative fixture — got [${sNeg.join(", ")}]`);
        assert.equal(sPos.filter((s) => s === mustFire).length, 1, "no duplicate signal ids");
      }
      const second = weddingSutraSignals(parseWeddingSutraPage(PROFILE_SECOND), PROFILE_SECOND);
      assert.ok(second.includes("portfolio-no-video"), "second profile (photos, no video) yields portfolio-no-video");
      assert.ok(!second.includes("has-video-portfolio"), "second profile has no video signal");
      pass(6, "each signal fires on a fixture that has it and not on one that does not");
    } catch (err) {
      fail(6, "each signal fires on a fixture that has it and not on one that does not", err);
    }

    // 7. every fetched text is untrusted
    try {
      const fetched = await reachOk(PROFILE_FEATURED);
      assert.equal(fetched.untrusted, true, "injected reach result is untrusted");
      const ev = await weddingsutra.enrich(lead("Fixture Lens Studio"), depsWith({ readPage: () => reachOk(PROFILE_SECOND) }));
      assert.equal(ev.untrusted, true, "evidence untrusted is the literal true");
      assert.equal(typeof ev.text, "string", "evidence keeps the quoted text");
      assert.equal(ev.text.length > 0, true, "quoted text is non-empty");
      const parsed = parseWeddingSutraPage(PROFILE_SECOND);
      assert.equal(parsed.photoCount, 2, "second profile photo count parsed");
      assert.equal(parseListingLeads(LISTING_PAGE_1, "wedding-planner", 10)[0].phone, "+919900000001", "listing phone parsed");
      pass(7, "every fetched text is marked untrusted: true");
    } catch (err) {
      fail(7, "every fetched text is marked untrusted: true", err);
    }
  } finally {
    if (prev === undefined) delete process.env.CHANNEL_CH_WEDDINGSUTRA; else process.env.CHANNEL_CH_WEDDINGSUTRA = prev;
  }

  console.log(`PASS ${results.filter((r) => r.startsWith("PASS")).length}/7 ch-weddingsutra-check (Order WE4-ch-weddingsutra)`);
  process.exit(0);
}

main().catch(() => {
  process.exitCode = 1;
});
