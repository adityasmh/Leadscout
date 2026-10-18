// src/gate-delivery-check.ts
// Order LG2-gate-delivery proof. Offline: temp database via env LEADSCOUT_DB (set before
// any module that opens the DB is dynamically imported), a fake phone verifier, temp DND
// folders. No network, no model, no router, no server.
// Run once: npx tsx src/gate-delivery-check.ts
//
// This check does NOT import src/company/, so the sandbox root import (PITFALLS 1) is not
// needed. The live database data/leadscout.db is never opened.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Lead } from "./types.js";
import type { Dossier } from "./types-v2.js";

const DB_FILE = join(tmpdir(), `leadscout-gate-delivery-check-${randomUUID()}.db`);
process.env.LEADSCOUT_DB = DB_FILE;
delete process.env.LEADSCOUT_REQUIRE_KEYS;
delete process.env.LEADSCOUT_DND_DIR; // never inherit an operator folder by accident

const DND_DIR = mkdtempSync(join(tmpdir(), "leadscout-dnd-yes-"));
const NO_DND_DIR = mkdtempSync(join(tmpdir(), "leadscout-dnd-no-"));
writeFileSync(join(DND_DIR, "operator-export.csv"), "phone\n+919876500008\n# comment\n", "utf8");

// ------------------------------------------------------------------ harness

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`PASS ${name}`);
    })
    .catch((err: unknown) => {
      failed += 1;
      const message = err instanceof Error ? err.stack ?? err.message : String(err);
      console.log(`FAIL ${name}\n     ${message.split("\n").join("\n     ")}`);
    });
}

// ------------------------------------------------------------------ fixtures

const fakeVerifier = (phone: string): { e164?: string; result: "mobile" | "landline" | "invalid"; reason?: string } => {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits === "" || /^0+$/.test(digits)) return { result: "invalid", reason: "fake: dead or empty number" };
  return verifyMod.classifyPhone(phone);
};

function mkLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: randomUUID(),
    workspaceId: "ws-fixture",
    name: "Fake Business",
    category: "dentist",
    source: "fake",
    sourceUrl: "https://example.invalid/lead",
    summary: "clearly fake fixture",
    emails: [],
    phones: [],
    socials: {},
    signals: [],
    score: 10,
    fit: [],
    angle: "",
    status: "new",
    notes: "",
    gate: "template",
    createdAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  } as unknown as Lead;
}

function makeDossier(workspaceId: string, leadId: string): Dossier {
  return {
    leadId,
    workspaceId,
    bizKey: "fixture-special",
    level: 0,
    facts: {},
    gap: null,
    sayThis: { value: 'Say "hi" to <b>them</b> & smile', evidence: ["E1"] },
    pushback: null,
    offers: [
      {
        rank: 1,
        service: 'web<&>"',
        title: "Website",
        description: { value: "a site", evidence: ["E1"] },
        whyItMatters: { value: "they need one", evidence: ["E1"] },
        buildDays: null,
        quote: null,
        assumption: "fixture",
        doorOpener: true,
      },
    ],
    evidence: [
      { id: "E1", kind: "listing", url: "https://example.invalid/special", quote: 'Line one, "quoted" & <tag>', fetchedAt: "2026-10-12T00:00:00.000Z" },
    ],
    callStatus: "not-called",
    dropped: [],
    inputHash: "fixture-hash",
    promptVersion: "fixture-v1",
    tokensIn: 0,
    tokensOut: 0,
    createdAt: "2026-10-12T00:00:00.000Z",
  };
}

let phoneSeq = 100_000_000;
function nextPhone(): string {
  phoneSeq += 1;
  return `+919${String(phoneSeq).slice(-9)}`;
}

// ------------------------------------------------------------------ modules

const store = await import("./store.js");
const evidence = await import("./evidence.js");
const gate = await import("./gate.js");
const delivery = await import("./delivery.js");
const dossierMod = await import("./dossier.js");
const routes = await import("./routes-delivery.js");
const verifyMod = await import("./verify.js");

function makeWorkspace(name: string) {
  return store.createWorkspace({
    name,
    offer: { services: ["website", "automation"], description: "fake offer for checks only" },
    icp: { categories: ["dentist"], cities: ["Fake City"], countries: ["IN"] },
  });
}

function seedLeads(workspaceId: string, count: number, prefix: string, scoreAt: (i: number) => number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const index = String(i + 1).padStart(3, "0");
    const lead = store.upsertLead({
      workspaceId,
      name: `Fake ${prefix} Lead ${index}`,
      category: "dentist",
      source: "fake",
      sourceUrl: `https://fake-${prefix.toLowerCase()}-${index}.example`,
      phone: nextPhone(),
      score: scoreAt(i),
      summary: "clearly fake fixture",
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
    });
    ids.push(lead.id);
  }
  return ids;
}

// ------------------------------------------------------------------ run

async function main(): Promise<void> {
  // ---------------------------------------------------------- gate

  await check("gate: a good lead passes and the phone is normalised to +91", () => {
    const res = gate.gateLead(mkLead({ name: "Fake Good", phone: "+91 98765 00001" }), {
      verifier: fakeVerifier,
      dndDir: NO_DND_DIR,
    });
    assert.equal(res.pass, true, `reasons=${res.reasons.join("; ")}`);
    assert.equal(res.callable, true);
    assert.equal(res.phone, "+919876500001");
    assert.ok(res.tags.includes("dnd-unchecked"));
  });

  await check("gate: a dead number fails on the phone reason", () => {
    const res = gate.gateLead(mkLead({ name: "Fake Dead", phone: "0000000000" }), {
      verifier: fakeVerifier,
      dndDir: NO_DND_DIR,
    });
    assert.equal(res.pass, false);
    assert.equal(res.callable, false);
    assert.equal(res.phone, null);
    assert.ok(res.reasons.some((r) => /phone/i.test(r)), `reasons=${res.reasons.join("; ")}`);
  });

  await check("gate: no phone fails", () => {
    const res = gate.gateLead(mkLead({ name: "Fake No Phone" }), { verifier: fakeVerifier, dndDir: NO_DND_DIR });
    assert.equal(res.pass, false);
    assert.ok(res.reasons.some((r) => /phone/i.test(r)));
  });

  await check("gate: no business name fails", () => {
    const res = gate.gateLead(mkLead({ name: "   ", phone: "+919876500004" }), {
      verifier: fakeVerifier,
      dndDir: NO_DND_DIR,
    });
    assert.equal(res.pass, false);
    assert.ok(res.reasons.some((r) => /business name/i.test(r)));
  });

  await check("gate: duplicate by phone fails", () => {
    const res = gate.gateLead(mkLead({ name: "Fake Dup Phone", website: "https://fake-dup-phone.example", phone: "+919876500005" }), {
      verifier: fakeVerifier,
      deliveredPhones: ["+919876500005"],
      dndDir: NO_DND_DIR,
    });
    assert.equal(res.pass, false);
    assert.ok(res.tags.includes("duplicate"));
    assert.ok(res.reasons.some((r) => /duplicate/i.test(r) && /phone/i.test(r)), `reasons=${res.reasons.join("; ")}`);
  });

  await check("gate: duplicate by business key fails", () => {
    const lead = mkLead({ name: "Fake Dup Biz", website: "https://dup.example", phone: "+919876500006" });
    const key = evidence.bizKey(lead, ["+919876500006"]);
    assert.equal(key, "dup.example");
    const res = gate.gateLead(lead, { verifier: fakeVerifier, deliveredBizKeys: [key], dndDir: NO_DND_DIR });
    assert.equal(res.pass, false);
    assert.ok(res.reasons.some((r) => /business key/i.test(r)), `reasons=${res.reasons.join("; ")}`);
  });

  await check("gate: chain branch fails only when the workspace excludes chains", () => {
    const lead = mkLead({ name: "Mega Chains Dental - Branch 2", category: "dentist", phone: "+919876500007" });
    const excluded = gate.gateLead(lead, { verifier: fakeVerifier, exclusions: ["chains"], dndDir: NO_DND_DIR });
    assert.equal(excluded.pass, false);
    assert.ok(excluded.tags.includes("chain-branch"));
    assert.ok(excluded.reasons.some((r) => /chain/i.test(r)));
    const allowed = gate.gateLead(lead, { verifier: fakeVerifier, exclusions: [], dndDir: NO_DND_DIR });
    assert.equal(allowed.pass, true, `chain lead must pass without chains: ${allowed.reasons.join("; ")}`);
  });

  await check("gate: a number in the operator DND file is tagged dnd and not callable", () => {
    const res = gate.gateLead(mkLead({ name: "Fake DND", phone: "+919876500008" }), {
      verifier: fakeVerifier,
      dndDir: DND_DIR,
    });
    assert.equal(res.pass, false);
    assert.equal(res.callable, false);
    assert.ok(res.tags.includes("dnd"), `tags=${res.tags.join(",")}`);
    assert.ok(!res.tags.includes("dnd-unchecked"));
    assert.ok(res.reasons.some((r) => /do-not-call|DND/i.test(r)));
  });

  await check("gate: no DND file tags every lead dnd-unchecked and never dnd", () => {
    const res = gate.gateLead(mkLead({ name: "Fake Unchecked", phone: "+919876500009" }), {
      verifier: fakeVerifier,
      dndDir: NO_DND_DIR,
    });
    assert.equal(res.pass, true);
    assert.ok(res.tags.includes("dnd-unchecked"));
    assert.ok(!res.tags.includes("dnd"));
  });

  // ---------------------------------------------------------- call sheet

  await check("sheet: 70 leads split evenly across 3 callers, no lead twice", () => {
    const ws = makeWorkspace("Fake Sheet 70");
    seedLeads(ws.id, 70, "Sheet70", (i) => 100 - (i % 20));
    const sheet = delivery.buildCallSheet(ws.id, { date: "2026-10-12", callers: ["a", "b", "c"], perCaller: 25 });
    assert.equal(sheet.rows.length, 70, `rows=${sheet.rows.length}`);
    assert.equal(new Set(sheet.rows.map((r) => r.leadId)).size, 70, "no lead twice");
    const counts = ["a", "b", "c"].map((c) => sheet.rows.filter((r) => r.caller === c).length);
    assert.deepEqual(counts, [24, 23, 23], `counts=${counts.join(",")}`);
    assert.ok(sheet.rows.every((r) => r.tel === `tel:${r.phone}` && /^tel:\+91/.test(r.tel)));
    assert.ok(sheet.rows.every((r) => r.tags.includes("dnd-unchecked")), "dnd-unchecked on every row");
    const scores = sheet.rows.map((r) => r.score);
    assert.deepEqual(scores, [...scores].sort((x, y) => y - x), "sorted by score");
  });

  await check("sheet: same-day rebuild is idempotent (no double assignment)", () => {
    const ws = makeWorkspace("Fake Sheet Idem");
    seedLeads(ws.id, 5, "SheetIdem", (i) => 100 - i);
    const first = delivery.buildCallSheet(ws.id, { date: "2026-10-12", callers: ["a", "b"], perCaller: 10 });
    assert.equal(first.rows.length, 5);
    const second = delivery.buildCallSheet(ws.id, { date: "2026-10-12", callers: ["a", "b"], perCaller: 10 });
    assert.equal(second.rows.length, 5, `second=${second.rows.length}`);
    assert.deepEqual(
      second.rows.map((r) => r.leadId).sort(),
      first.rows.map((r) => r.leadId).sort(),
      "same date returns the same assignment"
    );
  });

  await check("sheet: a next-day call gives only different leads", () => {
    const ws = makeWorkspace("Fake Sheet Next");
    seedLeads(ws.id, 70, "SheetNext", (i) => 100 - i);
    const day1 = delivery.buildCallSheet(ws.id, { date: "2026-10-12", callers: ["a", "b", "c"], perCaller: 25 });
    const day1Ids = new Set(day1.rows.map((r) => r.leadId));
    assert.equal(day1Ids.size, 70);
    delivery.persistCallSheet(day1);
    const freshIds = seedLeads(ws.id, 10, "SheetNext2", (i) => 50 - i);
    const day2 = delivery.buildCallSheet(ws.id, { date: "2026-10-13", callers: ["a", "b", "c"], perCaller: 25 });
    assert.equal(day2.rows.length, 10, `day2 rows=${day2.rows.length}`);
    for (const row of day2.rows) assert.ok(!day1Ids.has(row.leadId), `lead ${row.leadId} repeated`);
    assert.ok(day2.rows.every((r) => freshIds.includes(r.leadId)), "day2 only uses fresh leads");
  });

  await check("sheet: perCaller cap and default single caller", () => {
    const ws = makeWorkspace("Fake Sheet Cap");
    seedLeads(ws.id, 10, "SheetCap", (i) => 100 - i);
    const capped = delivery.buildCallSheet(ws.id, { date: "2026-10-12", callers: ["x", "y"], perCaller: 3 });
    assert.equal(capped.rows.length, 6, `capped=${capped.rows.length}`);
    const ws2 = makeWorkspace("Fake Sheet One");
    seedLeads(ws2.id, 5, "SheetOne", (i) => 100 - i);
    const single = delivery.buildCallSheet(ws2.id, { date: "2026-10-12" });
    assert.deepEqual(single.callers, ["Caller 1"]);
    assert.ok(single.rows.length > 0 && single.rows.every((r) => r.caller === "Caller 1"));
  });

  await check("sheet: minScore filters lower leads out", () => {
    const ws = makeWorkspace("Fake Sheet Min");
    seedLeads(ws.id, 3, "SheetMin", (i) => [10, 60, 90][i]);
    const sheet = delivery.buildCallSheet(ws.id, { date: "2026-10-12", minScore: 50 });
    assert.equal(sheet.rows.length, 2, `rows=${sheet.rows.length}`);
    assert.ok(sheet.rows.every((r) => r.score >= 50));
  });

  await check("sheet: rows carry the dossier say-this, top service and one evidence line", () => {
    const ws = makeWorkspace("Fake Sheet Row");
    const lead = store.upsertLead({
      workspaceId: ws.id,
      name: "Fake Row Dental",
      category: "dentist",
      source: "fake",
      sourceUrl: "https://fake-row.example",
      phone: "+919876500099",
      score: 80,
      summary: "clearly fake fixture",
    });
    dossierMod.saveDossier(makeDossier(ws.id, lead.id));
    const sheet = delivery.buildCallSheet(ws.id, { date: "2026-10-12" });
    const row = sheet.rows.find((r) => r.leadId === lead.id);
    assert.ok(row, "lead must be on the sheet");
    assert.equal(row.phone, "+919876500099");
    assert.equal(row.tel, "tel:+919876500099");
    assert.equal(row.sayThis, 'Say "hi" to <b>them</b> & smile');
    assert.equal(row.topService, 'web<&>"');
    assert.equal(row.evidence, 'Line one, "quoted" & <tag>');
  });

  // ---------------------------------------------------------- rendering

  await check("render: CSV escapes values and keeps tel: links", () => {
    const ws = makeWorkspace("Fake Render Csv");
    const lead = store.upsertLead({
      workspaceId: ws.id,
      name: 'Fix & Co <Ltd>, "quoted"',
      category: "dentist",
      source: "fake",
      sourceUrl: "https://example.invalid/special",
      phone: "+919876599999",
      score: 50,
      summary: "clearly fake fixture",
    });
    dossierMod.saveDossier(makeDossier(ws.id, lead.id));
    const sheet = delivery.buildCallSheet(ws.id, { date: "2026-02-01", callers: ["Eve"], perCaller: 5 });
    assert.equal(sheet.rows.length, 1);
    const csv = delivery.renderCallSheetCsv(sheet);
    assert.ok(csv.includes("tel:+919876599999"), "csv keeps the tel: value");
    assert.ok(csv.includes('"Fix & Co <Ltd>, ""quoted"""'), `csv quotes and doubles the name: ${csv}`);
    assert.ok(csv.includes('""hi""'), "csv doubles quotes in say-this");
    assert.ok(csv.includes("dnd-unchecked"), "csv shows the dnd-unchecked tag");
  });

  await check("render: HTML escapes values, keeps tel: links and shows outcome boxes", () => {
    const ws = makeWorkspace("Fake Render Html");
    const lead = store.upsertLead({
      workspaceId: ws.id,
      name: 'Fix & Co <Ltd>, "quoted"',
      category: "dentist",
      source: "fake",
      sourceUrl: "https://example.invalid/special",
      phone: "+919876599999",
      score: 50,
      summary: "clearly fake fixture",
    });
    dossierMod.saveDossier(makeDossier(ws.id, lead.id));
    const sheet = delivery.buildCallSheet(ws.id, { date: "2026-02-01", callers: ["Eve"], perCaller: 5 });
    assert.equal(sheet.rows.length, 1);
    const html = delivery.renderCallSheetHtml(sheet);
    assert.ok(html.includes('href="tel:+919876599999"'), "html tel: link");
    assert.ok(html.includes("&lt;Ltd&gt;"), "html escapes the name");
    assert.ok(html.includes("&amp;"), "html escapes ampersand");
    assert.ok(html.includes("&quot;hi&quot;"), "html escapes quotes in say-this");
    assert.ok(html.includes("&lt;b&gt;them&lt;/b&gt;"), "html escapes tags in say-this");
    assert.ok(!html.includes("<b>them</b>"), "raw say-this markup must not leak");
    assert.ok(html.includes("dnd-unchecked"), "html shows the dnd-unchecked tag");
    for (const label of ["answered", "interested", "call back", "not interested", "wrong number"]) {
      assert.ok(html.includes(`value="${label}"`), `missing outcome box ${label}`);
    }
  });

  // ---------------------------------------------------------- routes

  await check("routes: GET callsheet answers json/csv/html and POST assign persists", async () => {
    const ws = makeWorkspace("Fake Routes");
    for (let i = 0; i < 2; i += 1) {
      store.upsertLead({
        workspaceId: ws.id,
        name: `Fake Route ${i}`,
        category: "dentist",
        source: "fake",
        sourceUrl: `https://example.invalid/route/${i}`,
        phone: `+9198765111${String(i).padStart(2, "0")}`,
        score: 40,
        summary: "clearly fake fixture",
      });
    }
    const handlers = new Map<string, (ctx: unknown) => Promise<unknown> | unknown>();
    routes.registerDeliveryRoutes((method, pattern, handler) => {
      handlers.set(`${method} ${pattern}`, handler as (ctx: unknown) => Promise<unknown> | unknown);
    });
    assert.ok(handlers.has("GET /api/workspaces/:ws/callsheet"), "GET route registered");
    assert.ok(handlers.has("POST /api/workspaces/:ws/callsheet/assign"), "POST route registered");

    const ctxFor = (format: string, query: Record<string, string> = {}) => ({
      method: format === "POST" ? "POST" : "GET",
      params: { ws: ws.id },
      query: new URLSearchParams({ format, ...query }),
      header: () => undefined,
      readJson: async () => ({}),
      readText: async () => "",
    });

    const get = handlers.get("GET /api/workspaces/:ws/callsheet")!;
    const asJson = (await get(ctxFor("json", { date: "2026-05-01" }))) as { status: number; json?: { sheet?: unknown } };
    assert.equal(asJson.status, 200);
    assert.ok(asJson.json && asJson.json.sheet, "json reply carries a sheet");
    const asCsv = (await get(ctxFor("csv", { date: "2026-05-01" }))) as { status: number; contentType?: string };
    assert.ok((asCsv.contentType ?? "").includes("text/csv"));
    const asHtml = (await get(ctxFor("html", { date: "2026-05-01" }))) as { status: number; contentType?: string };
    assert.ok((asHtml.contentType ?? "").includes("text/html"));

    const post = handlers.get("POST /api/workspaces/:ws/callsheet/assign")!;
    const assigned = (await post(ctxFor("json", { date: "2026-05-01" }))) as { status: number; json?: { rows?: number } };
    assert.equal(assigned.status, 201);
    assert.equal(assigned.json?.rows, 2, "POST assigned the two leads");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  rmSync(DND_DIR, { recursive: true, force: true });
  rmSync(NO_DND_DIR, { recursive: true, force: true });
}
