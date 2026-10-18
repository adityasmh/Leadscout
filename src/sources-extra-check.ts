// src/sources-extra-check.ts
// Offline PASS/FAIL proof for sources-extra.ts (Order L23-places).
// Fully offline: fake fetchFn, fake key "FAKE-KEY-0000"; enablement is injected via
// deps.env, so process.env is never read or mutated here.
// Run: npx tsx src/sources-extra-check.ts

import {
  discoverPlaces,
  importScraperCsv,
  PLACES_API_URL,
  PLACES_FIELD_MASK,
  PLACES_MAX_PAGES,
  SOURCE_CSV,
  SOURCE_NOTICE,
  SOURCE_PLACES,
  type CsvMapping,
  type ExtraSourceDeps,
} from "./sources-extra.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `  :: ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- fake fetch

type FakeResponse = { status: number; ok: boolean; json: () => Promise<unknown> };

function res(status: number, body: unknown): FakeResponse {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => String(key) === name);
    return found?.[1];
  }
  return (headers as Record<string, string>)[name];
}

type FetchCall = { url: string; init?: RequestInit };

type Route = { match: (url: string, init?: RequestInit) => boolean; respond: () => FakeResponse };

function fakeFetch(routes: Route[]): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn: typeof fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find((r) => r.match(url, init));
    if (!route) throw new Error(`fake fetch: no route for ${url}`);
    return route.respond() as unknown as Response;
  }) as typeof fetch;
  return { fn, calls };
}

type Body = { textQuery?: string; pageSize?: number; pageToken?: string };

function parseBody(call: FetchCall | undefined): Body {
  const raw = call?.init?.body;
  return typeof raw === "string" ? (JSON.parse(raw) as Body) : {};
}

const FAKE_KEY = "FAKE-KEY-0000";

const enabledDeps = (fn: typeof fetch): ExtraSourceDeps => ({
  fetchFn: fn,
  env: { GOOGLE_PLACES_API_KEY: FAKE_KEY },
});

const DISABLED_DEPS: ExtraSourceDeps = { env: {} };

function makePlace(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `places/${id}`,
    displayName: { text: `Fake Place ${id}` },
    formattedAddress: `${id} Fake Street, Fakeville`,
    nationalPhoneNumber: "+1 555-010-0000",
    websiteUri: `https://fake${id}.example`,
    rating: 4.5,
    userRatingCount: 10 + id,
    googleMapsUri: `https://maps.google.com/?cid=${id}`,
    ...extra,
  };
}

// Fake API that honours pageSize like the real one (1-20 per page) and hands out
// a fresh nextPageToken on the first `keepTokenForFirstPages` calls.
function pagedFaker(keepTokenForFirstPages: number): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn: typeof fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const body = parseBody(calls[calls.length - 1]);
    const n = Number(body.pageSize ?? 0);
    const base = (calls.length - 1) * 100;
    const places = Array.from({ length: n }, (_, i) => makePlace(base + i + 1));
    const nextPageToken = calls.length < keepTokenForFirstPages ? `PAGE_${calls.length}` : undefined;
    return res(200, nextPageToken ? { places, nextPageToken } : { places });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// ------------------------------------------------- 1. request built correctly

{
  const ff = fakeFetch([
    {
      match: (url, init) => url === PLACES_API_URL && init?.method === "POST",
      respond: () => res(200, { places: [makePlace(1)] }),
    },
  ]);

  const result = await discoverPlaces(
    { category: "dental clinic", city: "Fakeville" },
    enabledDeps(ff.fn),
  );

  const call = ff.calls[0];
  const body = parseBody(call);

  check("request: URL is the Places Text Search endpoint", call?.url === PLACES_API_URL, call?.url);
  check("request: method is POST", call?.init?.method === "POST", call?.init?.method);
  check("request: API key header carries the fake key", headerValue(call?.init, "X-Goog-Api-Key") === FAKE_KEY, String(headerValue(call?.init, "X-Goog-Api-Key")));
  check("request: Content-Type is application/json", headerValue(call?.init, "Content-Type") === "application/json", String(headerValue(call?.init, "Content-Type")));
  check("request: field mask is exactly the allowed field list", headerValue(call?.init, "X-Goog-FieldMask") === PLACES_FIELD_MASK, String(headerValue(call?.init, "X-Goog-FieldMask")));
  check("request: body textQuery builds from category+city", body.textQuery === "dental clinic in Fakeville", JSON.stringify(body));
  check("request: body has numeric pageSize and no pageToken on the first page", typeof body.pageSize === "number" && body.pageSize > 0 && body.pageToken === undefined, JSON.stringify(body));
  check("request: single-page response makes one call", ff.calls.length === 1, `calls=${ff.calls.length}`);
  check("request: result enabled with one lead", result.enabled === true && result.leads.length === 1, `enabled=${result.enabled} leads=${result.leads.length}`);
}

// ------------------------------------------ 2. paging, limit cap and pageSize

{
  const ff = pagedFaker(3);
  const result = await discoverPlaces({ category: "paging test", limit: 25 }, enabledDeps(ff.fn));
  check("paging: second page requested via pageToken", ff.calls.length === 2 && parseBody(ff.calls[1]).pageToken === "PAGE_1", JSON.stringify(ff.calls.map((c) => parseBody(c))));
  check("paging: pageSize on page 2 shrinks to what the limit still needs", parseBody(ff.calls[1]).pageSize === 5, String(parseBody(ff.calls[1]).pageSize));
  check("paging: limit of 25 reached exactly across two pages", result.leads.length === 25, `leads=${result.leads.length}`);
  check("paging: paging result also carries facts and notice", result.facts.length === 50 && result.notice === SOURCE_NOTICE, `facts=${result.facts.length}`);
}

{
  const ff = pagedFaker(3);
  const small = await discoverPlaces({ category: "limit test", limit: 5 }, enabledDeps(ff.fn));
  check("limit: smaller than one page — exactly 5 leads, one call", small.leads.length === 5 && ff.calls.length === 1, `leads=${small.leads.length} calls=${ff.calls.length}`);
}

// ------------------------------------------- 3. repeated token + page cap stop

{
  const ff = fakeFetch([
    {
      match: () => true,
      respond: () => res(200, { places: [makePlace(ff.calls.length)], nextPageToken: "SAME_TOKEN" }),
    },
  ]);
  const result = await discoverPlaces({ category: "repeat token", limit: 100 }, enabledDeps(ff.fn));
  check("paging: repeated page token stops the loop (2 calls, no hang)", ff.calls.length === 2, `calls=${ff.calls.length}`);
  check("paging: repeated-token run returns only the two real pages of leads", result.leads.length === 2, `leads=${result.leads.length}`);
}

{
  const ff = fakeFetch([
    {
      match: () => true,
      respond: () => res(200, { places: [makePlace(ff.calls.length)], nextPageToken: `NEW_TOKEN_${ff.calls.length}` }),
    },
  ]);
  const result = await discoverPlaces({ category: "page cap", limit: 500 }, enabledDeps(ff.fn));
  check("paging: an endless stream of fresh tokens stops at the page-cap loop", ff.calls.length === PLACES_MAX_PAGES, `calls=${ff.calls.length} cap=${PLACES_MAX_PAGES}`);
  check("paging: page-capped run stays bounded", result.leads.length === PLACES_MAX_PAGES, `leads=${result.leads.length}`);
}

// -------------------------------------------------------- 4. response mapping

{
  const full = makePlace(42, {
    displayName: { text: "Mapped Cafe" },
    googleMapsUri: "https://maps.google.com/?cid=mapped",
    rating: 4.7,
    userRatingCount: 77,
  });
  const bare = { id: "places/43", displayName: { text: "Bare Cafe" } };
  const ff = fakeFetch([
    {
      match: () => true,
      respond: () => res(200, { places: [full, bare] }),
    },
  ]);

  const result = await discoverPlaces(
    { category: "dental clinic", city: "Fakeville", country: "Fakeland" },
    enabledDeps(ff.fn),
  );

  const leadA = result.leads[0];
  const leadB = result.leads[1];
  check("mapping: source is google-places", leadA?.source === SOURCE_PLACES, leadA?.source);
  check("mapping: sourceUrl is the place's googleMapsUri", leadA?.sourceUrl === "https://maps.google.com/?cid=mapped", leadA?.sourceUrl);
  check("mapping: name comes from displayName.text", leadA?.name === "Mapped Cafe", leadA?.name);
  check("mapping: category comes from the query", leadA?.category === "dental clinic", leadA?.category);
  check("mapping: address, phone and website are copied", leadA?.address === "42 Fake Street, Fakeville" && leadA?.phone === "+1 555-010-0000" && leadA?.website === "https://fake42.example", JSON.stringify(leadA));
  check("mapping: lead carries no rating or reviewCount fields", leadA !== undefined && !("rating" in leadA) && !("reviewCount" in leadA), JSON.stringify(leadA));
  check("mapping: named places kept, with and without rating fields", result.leads.length === 2 && leadB?.name === "Bare Cafe", `leads=${JSON.stringify(result.leads.map((l) => l.name))}`);

  check("mapping: facts exist only for present rating/reviewCount values", result.facts.length === 2, JSON.stringify(result.facts));
  const ratingFact = result.facts[0];
  const reviewFact = result.facts[1];
  check(
    "mapping: rating fact is provenance-labelled (leadIndex 0, value 4.7, source, ISO fetchedAt)",
    ratingFact?.leadIndex === 0 && ratingFact?.field === "rating" && ratingFact?.value === 4.7 && ratingFact?.source === SOURCE_PLACES && /\d{4}-\d{2}-\d{2}T/.test(ratingFact?.fetchedAt ?? ""),
    JSON.stringify(ratingFact),
  );
  check(
    "mapping: reviewCount fact is provenance-labelled (leadIndex 0, value 77, source)",
    reviewFact?.leadIndex === 0 && reviewFact?.field === "reviewCount" && reviewFact?.value === 77 && reviewFact?.source === SOURCE_PLACES,
    JSON.stringify(reviewFact),
  );
  check("mapping: no facts fabricated for the place without rating/reviews", result.facts.every((f) => f.leadIndex === 0), JSON.stringify(result.facts));
}

// ------------------------------------------------------- 5. disabled without key

{
  const ff = fakeFetch([
    {
      match: () => true,
      respond: () => {
        throw new Error("should never be called while disabled");
      },
    },
  ]);
  const result = await discoverPlaces({ category: "disabled test" }, DISABLED_DEPS);
  check("disabled: enabled is false", result.enabled === false, String(result.enabled));
  check("disabled: leads are empty", result.leads.length === 0, `leads=${result.leads.length}`);
  check("disabled: facts are empty", result.facts.length === 0, `facts=${result.facts.length}`);
  check("disabled: notice still present", result.notice === SOURCE_NOTICE);
  check("disabled: fetchFn is never called (zero calls)", ff.calls.length === 0, `calls=${ff.calls.length}`);
}

// ------------------------------- 6. CSV: quoted commas, escaped quotes, two header styles

{
  const csv = [
    "Title,Address,Phone,Website,Rating,Reviews,Category,Link",
    '"Cafe, Inc.",123 Main St,+1 555-1234,https://cafe.example,4.5,100,Cafe,https://maps.example/cafe',
    '"Bakery ""Fresh""",456 Oak Rd,,https://bakery.example,,42,Bakery,https://maps.example/bakery',
  ].join("\r\n") + "\r\n";
  const result = importScraperCsv(csv);

  check("csv: CRLF rows with quoted commas parse to two leads", result.leads.length === 2, `leads=${result.leads.length}`);
  check("csv: embedded quoted comma kept in the name", result.leads[0]?.name === "Cafe, Inc.", result.leads[0]?.name);
  check("csv: escaped double quotes unescaped in the name", result.leads[1]?.name === 'Bakery "Fresh"', result.leads[1]?.name);
  check("csv: source is csv-import and sourceUrl is the Link column", result.leads[0]?.source === SOURCE_CSV && result.leads[0]?.sourceUrl === "https://maps.example/cafe", JSON.stringify(result.leads[0]));
  check("csv: absent rating omitted, values never zero-filled", result.facts.length === 3 && !result.facts.some((f) => f.leadIndex === 1 && f.field === "rating"), JSON.stringify(result.facts));
  check("csv: facts labelled with source csv-import and ISO fetchedAt", result.facts.every((f) => f.source === SOURCE_CSV && /\d{4}-\d{2}-\d{2}T/.test(f.fetchedAt)), JSON.stringify(result.facts));
}

{
  const csv = "name,url\n  Lower Lead  ,  https://maps.example/lower  \n";
  const result = importScraperCsv(csv);
  check(
    "csv: lowercase header style parses with whitespace stripped",
    result.leads.length === 1 && result.leads[0]?.name === "Lower Lead",
    JSON.stringify(result.leads),
  );
  check("csv: url column also maps to the link field (sourceUrl)", result.leads[0]?.sourceUrl === "https://maps.example/lower", result.leads[0]?.sourceUrl);
}

// ----------------------------------------------------------- 7. mapping override

{
  const csv = [
    "Business Name,Biz Addr,Site,Biz Phone,Stars,Count,Type,URL",
    "Mapped Biz,3 St,https://mapped.example,+1 555-7890,4.7,30,shop,https://maps.example/mapped",
  ].join("\n");
  const mapping: CsvMapping = {
    name: "Business Name",
    address: "Biz Addr",
    website: "Site",
    phone: "Biz Phone",
    rating: "Stars",
    reviews: "Count",
    category: "Type",
    link: "URL",
  };
  const result = importScraperCsv(csv, mapping);
  const lead = result.leads[0];
  check("mapping override: all custom columns honoured", result.leads.length === 1 && lead?.name === "Mapped Biz" && lead?.address === "3 St" && lead?.website === "https://mapped.example" && lead?.phone === "+1 555-7890" && lead?.category === "shop", JSON.stringify(lead));
  check("mapping override: rating fact from the Stars column", result.facts.some((f) => f.field === "rating" && f.value === 4.7), JSON.stringify(result.facts));
  check("mapping override: reviewCount fact from the Count column", result.facts.some((f) => f.field === "reviewCount" && f.value === 30), JSON.stringify(result.facts));
  check("mapping override: sourceUrl from the URL column", lead?.sourceUrl === "https://maps.example/mapped", lead?.sourceUrl);
}

{
  const csv = "title,Business Name\nDefault From Title,Override Name";
  const mapped = importScraperCsv(csv, { name: "Business Name" });
  const unmapped = importScraperCsv(csv);
  check("mapping override: override wins over the default header match", mapped.leads[0]?.name === "Override Name" && unmapped.leads[0]?.name === "Default From Title", `${mapped.leads[0]?.name} vs ${unmapped.leads[0]?.name}`);
}

// ------------------------------------------------------- 8. nameless rows dropped

{
  const csv = [
    "Title,URL,Rating,Reviews",
    "Named Row,https://maps.example/a,4.0,5",
    ",,3.0,2",
    "   ,,,",
    "Another,,5.0,10",
    ",,,,",
  ].join("\n");
  const result = importScraperCsv(csv);
  check("nameless: rows without a name are dropped", result.leads.length === 2, `leads=${result.leads.length}`);
  check("nameless: named rows kept in order", result.leads[0]?.name === "Named Row" && result.leads[1]?.name === "Another", JSON.stringify(result.leads.map((l) => l.name)));
  check("nameless: facts leadIndex follows the kept leads", result.facts.length === 4 && result.facts[0].leadIndex === 0 && result.facts[2].leadIndex === 1, JSON.stringify(result.facts));
  check("nameless: link column present or falls back to the csv-import sourceUrl", result.leads[0]?.sourceUrl === "https://maps.example/a" && result.leads[1]?.sourceUrl === SOURCE_CSV, JSON.stringify(result.leads.map((l) => l.sourceUrl)));
}

// ------------------------------------------------------------- 9. notice on both

{
  const ff = fakeFetch([
    { match: () => true, respond: () => res(200, { places: [makePlace(1)] }) },
  ]);
  const enabled = await discoverPlaces({ category: "notice" }, enabledDeps(ff.fn));
  const disabled = await discoverPlaces({ category: "notice" }, DISABLED_DEPS);
  const csv = importScraperCsv("Title\nAny");

  check("notice: discoverPlaces (enabled) result carries SOURCE_NOTICE", enabled.notice === SOURCE_NOTICE);
  check("notice: discoverPlaces (disabled) result carries SOURCE_NOTICE", disabled.notice === SOURCE_NOTICE);
  check("notice: importScraperCsv result carries SOURCE_NOTICE", csv.notice === SOURCE_NOTICE);
}

// ---------------------------------------------------------------- 10. robustness

{
  const ff = fakeFetch([
    {
      match: () => true,
      respond: () => res(403, { error: { code: 403, message: "denied" } }),
    },
  ]);
  const result = await discoverPlaces({ category: "error test" }, enabledDeps(ff.fn));
  check("non-2xx: does not throw and stops after the failed page", result.enabled === true && ff.calls.length === 1, `enabled=${result.enabled} calls=${ff.calls.length}`);
  check("non-2xx: empty leads with notice", result.leads.length === 0 && result.notice === SOURCE_NOTICE);
}

{
  const ff = fakeFetch([]);
  let threw = false;
  try {
    await discoverPlaces({ category: "   " }, enabledDeps(ff.fn));
  } catch {
    threw = true;
  }
  check("discoverPlaces: blank category throws before any fetch", threw && ff.calls.length === 0, `threw=${threw} calls=${ff.calls.length}`);
}

{
  const headerOnly = importScraperCsv("Title,Rating,Reviews\n");
  const emptyText = importScraperCsv("");
  const junk = importScraperCsv(",,,,\n ,\n");
  check("csv: header-only CSV yields no leads", headerOnly.leads.length === 0, `leads=${headerOnly.leads.length}`);
  check("csv: empty text yields no leads", emptyText.leads.length === 0, `leads=${emptyText.leads.length}`);
  check("csv: blank and whitespace-only rows yield no leads", junk.leads.length === 0, `leads=${junk.leads.length}`);
}

// --------------------------------------------------------------------- summary

console.log("");
console.log(`Summary: ${passed + failed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`Failed checks: ${failures.join("; ")}`);
  process.exitCode = 1;
}
