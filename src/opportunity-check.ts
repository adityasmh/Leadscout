// src/opportunity-check.ts
// Order OM1-opportunity-map: offline proof. Clearly-fake 30-lead fixture.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

process.env.LEADSCOUT_DB = join(tmpdir(), `leadscout-opp-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);

const { default: assert } = await import("node:assert/strict");
const opp = await import("./opportunity.js");
const store = await import("./store.js");
const routes = await import("./routes-opportunity.js");
import type { Lead } from "./types.js";

let pass = 0;
function report(name: string, cond: unknown, extra = ""): void {
  if (cond) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    console.error(`FAIL ${name} ${extra}`);
    process.exitCode = 1;
  }
}

const ws = store.createWorkspace({
  name: "Fixture Workspace",
  offer: { services: ["website", "automation"], description: "fake offer for offline check" },
  icp: { categories: ["dental-clinic"], cities: ["Mumbai"], countries: ["India"] },
});

function fakeLead(i: number, patch: Partial<Lead>): Lead {
  return store.upsertLead({
    workspaceId: ws.id,
    name: `Fixture Biz ${i}`,
    category: "dental-clinic",
    source: "osm",
    sourceUrl: `https://example.invalid/osm/${i}`,
    status: "new",
    enrichedAt: new Date().toISOString(),
    ...patch,
  } as Partial<Lead> & { workspaceId: string; name: string; category: string; source: string; sourceUrl: string });
}

// 12 reachable gap leads in Bandra West / dental-clinic
for (let i = 1; i <= 12; i++) {
  fakeLead(i, {
    address: `Shop ${i}, Bandra West, Mumbai`,
    city: "Mumbai",
    category: "dental-clinic",
    score: 70,
    signals: ["no-online-booking"],
    fit: [{ service: "website", score: 80, reason: "no online booking was found" }],
    email: `owner${i}@example.invalid`,
    emails: [`owner${i}@example.invalid`],
  });
}
// 10 reachable no-gap leads in Pune / salon
for (let i = 13; i <= 22; i++) {
  fakeLead(i, {
    city: "Pune",
    category: "salon",
    score: 50,
    signals: [],
    fit: [{ service: "website", score: 60, reason: "some fit" }],
    phone: `+9198000000${String(i).padStart(2, "0")}`,
    phones: [`+9198000000${String(i).padStart(2, "0")}`],
  });
}
// 8 unreachable non-offer-fit leads in Kothrud / dental-clinic
for (let i = 23; i <= 30; i++) {
  fakeLead(i, {
    address: "Kothrud, Pune",
    city: "Pune",
    category: "dental-clinic",
    score: 40,
    signals: ["no-website"],
    fit: [{ service: "seo", score: 30, reason: "seo fit but not offered" }],
  });
}
store.createJob(ws.id, { category: "dental-clinic", city: "Navi Mumbai", limit: 25 });

const loaded = opp.loadOpportunity(ws.id);
report("30 processed leads loaded", loaded.processed === 30, `got ${loaded.processed}`);

const bandra = loaded.groups.find((g) => g.locality === "Bandra West" && g.category === "dental-clinic");
report("bandra group exists", Boolean(bandra));
report("bandra count 12", bandra?.count === 12, JSON.stringify(bandra));
report("bandra gapShare 1", bandra?.gapShare === 1, JSON.stringify(bandra));
report("bandra avgScore 70", bandra?.avgScore === 70, JSON.stringify(bandra));
report("bandra reachableShare 1", bandra?.reachableShare === 1, JSON.stringify(bandra));
report("bandra opportunity 9.6", bandra?.opportunityScore === 9.6, JSON.stringify(bandra));
report("bandra confidence medium", bandra?.confidence === "medium", JSON.stringify(bandra));

const puneSalon = loaded.groups.find((g) => g.locality === "Pune" && g.category === "salon");
report("pune/salon count 10, no gap, reachable", puneSalon?.count === 10 && puneSalon?.gapShare === 0 && puneSalon?.reachableShare === 1, JSON.stringify(puneSalon));
report("pune/salon opportunity 0", puneSalon?.opportunityScore === 0, JSON.stringify(puneSalon));

const kothrud = loaded.groups.find((g) => g.locality === "Kothrud");
report("address area fallback to Kothrud", Boolean(kothrud), JSON.stringify(loaded.groups.map((g) => g.locality)));
report("kothrud gapShare 0 (seo not in offer)", kothrud?.gapShare === 0, JSON.stringify(kothrud));
report("kothrud reachableShare 0", kothrud?.reachableShare === 0, JSON.stringify(kothrud));
report("kothrud confidence low (n<10)", kothrud?.confidence === "low", JSON.stringify(kothrud));
report("confidence thresholds exported", opp.OPPORTUNITY_MIN_SAMPLE === 10 && opp.OPPORTUNITY_HIGH_SAMPLE === 30, "");
report("confidenceFor high at 30", opp.confidenceFor(30) === "high" && opp.confidenceFor(9) === "low", "");

// suggestNext: pure + store wrapper
const seed = { pilot: { cities: ["Navi Mumbai", "Pune"], categories: ["dental-clinic", "salon", "gym"] }, phases: [] };
const pure = opp.suggestNext({
  workspace: ws,
  searched: [{ city: "Navi Mumbai", category: "dental-clinic" }],
  leads: [],
  seed,
});
report("suggestions exclude searched pair", pure.every((s) => !(s.city === "Navi Mumbai" && s.category === "dental-clinic")), JSON.stringify(pure.map((s) => `${s.city}/${s.category}`)));
report("suggestions labelled suggestion", pure.length > 0 && pure.every((s) => s.kind === "suggestion"), "");
const wrapped = opp.loadSuggestions(ws.id);
report("store suggestions exclude searched jobs+leads", wrapped.suggestions.every((s) => !(s.city === "Navi Mumbai" && s.category === "dental-clinic")), "");

// routes through a fake register
const table = new Map<string, (ctx: never) => Promise<{ status: number; json?: unknown }> | { status: number; json?: unknown }>();
routes.registerOpportunityRoutes(((method: string, pattern: string, handler: never) => {
  table.set(`${method} ${pattern}`, handler);
}) as never, {
  ensureWorkspace: () => ws,
  guard: () => null,
});
const oppHandler = table.get("GET /api/workspaces/:ws/opportunity") as (ctx: { params: Record<string, string>; query: URLSearchParams; header: () => undefined; readJson: () => Promise<unknown> }) => Promise<{ status: number; json?: unknown }>;
const nextHandler = table.get("GET /api/workspaces/:ws/opportunity/next") as (ctx: { params: Record<string, string>; query: URLSearchParams; header: () => undefined; readJson: () => Promise<unknown> }) => Promise<{ status: number; json?: unknown }>;
report("both routes registered", Boolean(oppHandler) && Boolean(nextHandler));
const oppReply = await oppHandler({ params: { ws: ws.id }, query: new URLSearchParams(), header: () => undefined, readJson: async () => ({}) });
report("opportunity route 200 with groups", oppReply.status === 200 && Array.isArray((oppReply.json as { groups: unknown[] }).groups), JSON.stringify(oppReply.json).slice(0, 200));
const nextReply = await nextHandler({ params: { ws: ws.id }, query: new URLSearchParams(), header: () => undefined, readJson: async () => ({}) });
const suggestions = (nextReply.json as { suggestions: { kind: string }[] }).suggestions;
report("next route 200 with labelled suggestions", nextReply.status === 200 && suggestions.every((s) => s.kind === "suggestion"), "");

// page checks
const page = readFileSync(new URL("../public/opportunity.html", import.meta.url), "utf8");
report("page has table", page.includes("<table"));
report("page has horizontal bars", page.includes('class="bar'));
report("page has category filter", page.includes('id="cat"'));
report("page has Search here next button", page.includes("Search here next"));
report("page uses discover route", page.includes("/discover") && page.includes("category") && page.includes("city"));
report("page escapes values", page.includes("esc(g.locality)") && page.includes("esc(s.city)"));
report("page has too-few message", /Too few processed leads/.test(page));
function pageEsc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
const hostile = `<script>alert("x")</script>`;
const escaped = pageEsc(hostile);
report("hostile string escaped", !escaped.includes("<script>") && escaped.includes("&lt;script&gt;"), escaped);

console.log(`DONE passes=${pass}`);
if (!process.exitCode) console.log("PASS opportunity-check");
