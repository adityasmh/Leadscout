// ORDER_SC1: the dossier score parts (fit, reach, timing) must add up to the total.
//
// Offline, temp database (env LEADSCOUT_DB), no network and no real company folder.
// The scorer rule under test is: total = round(0.5 x fit + 0.3 x reach + 0.2 x timing).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "leadscout-score-breakdown-"));
process.env.LEADSCOUT_DB = join(ROOT, "scores.db");
process.env.LEADSCOUT_LLM_OFF = "1";

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  const line = condition ? `PASS ${name}` : `FAIL ${name}${detail ? `: ${detail}` : ""}`;
  console.log(line);
  if (!condition) failed = true;
}

function num(value: unknown, fallback = -1): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

const store = await import("./store.js");
const score = await import("./score.js");
const serverMod = await import("./server.js");

const ws = store.createWorkspace({
  name: "Fake Breakdown Co",
  offer: { services: ["website", "automation"], description: "Fake offer for checks only" },
  icp: { categories: ["dentist", "cafe"], cities: ["Fake City"], countries: ["IN"] },
});

// ---------------------------------------------------------------- fixtures
// Fixture A: a lead that was "processed" by the scorer. The pipeline stores the total
// on the lead but (the bug) never stores the parts, so there is NO lead_scores row.
const processedSignals = ["has-phone", "has-email", "has-whatsapp"];
const processedFit = [{ service: "website", score: 80, reason: "no website (fake fixture)" }];
const processedFields = {
  workspaceId: ws.id,
  name: "Fake Dental Processed",
  category: "dentist",
  city: "Fake City",
  country: "IN",
  address: "1 Fake Street",
  phone: "+919000000001",
  email: "fake-dental@example.test",
  website: "https://fake-dental.example",
  summary: "Fake dental clinic in Fake City.",
  source: "osm",
  sourceUrl: "https://osm.example.invalid/dentist-1",
  signals: processedSignals,
  fit: processedFit,
  status: "new" as const,
  notes: "",
  createdAt: "2026-02-01T00:00:00.000Z",
};
const verification = {
  bizKey: "",
  checkedAt: "2026-02-01T00:00:00.000Z",
  website: "alive" as const,
  emails: [{ value: "fake-dental@example.test", result: "ok" as const }],
  phones: [{ value: "+919000000001", e164: "+919000000001", result: "mobile" as const }],
  whatsapp: true,
  contactable: true,
  reasons: [],
};
// This is exactly what the scorer produces for the fixture, so the stored total is a
// real processed total. scoreLead is pure (no network).
const scored = score.scoreLead(processedFields as never, verification as never);
const processed = store.upsertLead({ ...processedFields, score: scored.total });

// Fixture B: "old format" lead. It has signals and fit, but only a total was stored;
// there is no lead_scores row, so the parts must be recomputed. Total 93 matches the
// number quoted in the bug report.
const oldSignals = ["has-phone", "has-email"];
const oldFields = {
  workspaceId: ws.id,
  name: "Fake Clinic Old Format",
  category: "dentist",
  city: "Fake City",
  country: "IN",
  phone: "+919000000002",
  email: "fake-old@example.test",
  website: "https://fake-old.example",
  summary: "Fake clinic in Fake City.",
  source: "osm",
  sourceUrl: "https://osm.example.invalid/dentist-2",
  signals: oldSignals,
  fit: [{ service: "website", score: 60, reason: "old site (fake fixture)" }],
  status: "new" as const,
  notes: "",
  createdAt: "2026-02-02T00:00:00.000Z",
};
const oldLead = store.upsertLead({ ...oldFields, score: 93 });

// Fixture C: a lead with no signals and nothing to reason about -> zeros, no reasons.
const emptyLead = store.upsertLead({
  workspaceId: ws.id,
  name: "Fake Empty Lead",
  category: "cafe",
  city: "Fake City",
  source: "osm",
  sourceUrl: "https://osm.example.invalid/cafe-3",
  signals: [],
  status: "new" as const,
  notes: "",
  createdAt: "2026-02-03T00:00:00.000Z",
});

// ---------------------------------------------------------------- server
const server = serverMod.createServer();
let PORT = 0;
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    PORT = typeof address === "object" && address ? address.port : 0;
    resolve();
  });
});
check("offline server listens on a random port", PORT > 0);

type Res = { status: number; body: unknown; text: string };
async function call(method: string, path: string): Promise<Res> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { "content-type": "application/json" } });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text) as unknown; } catch { /* not json */ }
  return { status: res.status, body: parsed, text };
}
const dossierPath = (leadId: string) => `/api/workspaces/${ws.id}/leads/${leadId}/dossier`;

const weighted = (fit: number, reach: number, timing: number): number =>
  Math.max(0, Math.min(100, Math.round(0.5 * fit + 0.3 * reach + 0.2 * timing)));

const realTokens = (lead: { signals?: string[]; website?: string; summary?: string; category?: string }): Set<string> => {
  const tokens = new Set<string>(["website", "category", "summary", "fit"]);
  for (const s of lead.signals ?? []) tokens.add(s);
  tokens.add("has-phone"); // present in fixtures that carry a phone signal
  return tokens;
};
const bracketTokens = (reason: string): string[] =>
  [...reason.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
const partOf = (reason: string): string =>
  reason.startsWith("fit:") ? "fit" : reason.startsWith("reach:") ? "reach" : reason.startsWith("timing:") ? "timing" : "other";

// ---------------------------------------------------------------- 1. processed lead
{
  const before = store.getLead(ws.id, processed.id);
  const res = await call("GET", dossierPath(processed.id));
  const sc = obj(obj(res.body).score);
  const fit = num(sc.fit);
  const reach = num(sc.reach);
  const timing = num(sc.timing);
  const total = num(sc.total);

  check("processed lead: GET dossier is 200", res.status === 200, `status=${res.status}`);
  check("processed lead: total matches the scorer's own total", total === scored.total, `total=${total} expected=${scored.total}`);
  check("processed lead: fit, reach, timing sum to the total (weighted rule)",
    weighted(fit, reach, timing) === total, `fit=${fit} reach=${reach} timing=${timing} total=${total}`);

  const reasons = asRecords(sc.reasons).length ? (sc.reasons as unknown[]).map(String) : [];
  const nonzeroParts = (["fit", "reach", "timing"] as const).filter((p) => num(sc[p]) > 0);
  const tokens = realTokens(processedFields);
  check("processed lead: every non-zero part has at least one reason",
    nonzeroParts.every((p) => reasons.some((r) => partOf(r) === p)), JSON.stringify(reasons));
  check("processed lead: every reason names a real signal/field of the fixture",
    reasons.every((r) => {
      const found = bracketTokens(r);
      return found.length > 0 && found.every((t) => tokens.has(t));
    }), JSON.stringify(reasons));
  check("processed lead: reasons are non-empty", reasons.length > 0);

  const after = store.getLead(ws.id, processed.id);
  check("processed lead: recompute never changed the stored total", before?.score === after?.score && after?.score === scored.total,
    `before=${before?.score} after=${after?.score}`);
}

// ---------------------------------------------------------------- 2. old-format lead
{
  check("old format: no stored score row before the GET", score.getScore(ws.id, oldLead.id) === undefined);
  const before = store.getLead(ws.id, oldLead.id);
  const res = await call("GET", dossierPath(oldLead.id));
  const sc = obj(obj(res.body).score);
  const fit = num(sc.fit);
  const reach = num(sc.reach);
  const timing = num(sc.timing);
  const total = num(sc.total);
  const reasons = (Array.isArray(sc.reasons) ? sc.reasons : []).map(String);

  check("old format: GET dossier is 200", res.status === 200, `status=${res.status}`);
  check("old format: stored total is preserved (93)", total === 93, `total=${total}`);
  check("old format: parts were recomputed and are present",
    fit >= 0 && reach > 0 && timing > 0, `fit=${fit} reach=${reach} timing=${timing}`);
  check("old format: recomputed parts sum to the stored total (weighted rule)",
    weighted(fit, reach, timing) === total, `fit=${fit} reach=${reach} timing=${timing} total=${total}`);
  check("old format: reasons are non-empty for non-zero parts",
    (["fit", "reach", "timing"] as const).filter((p) => num(sc[p]) > 0).every((p) => reasons.some((r) => partOf(r) === p)),
    JSON.stringify(reasons));

  const after = store.getLead(ws.id, oldLead.id);
  const storedRow = score.getScore(ws.id, oldLead.id);
  check("old format: recompute never changed the stored total",
    before?.score === after?.score && after?.score === 93 && storedRow === undefined,
    `before=${before?.score} after=${after?.score} row=${JSON.stringify(storedRow)}`);
}

// ---------------------------------------------------------------- 3. lead with no signals
{
  const res = await call("GET", dossierPath(emptyLead.id));
  const sc = obj(obj(res.body).score);
  check("no signals: GET dossier is 200", res.status === 200, `status=${res.status}`);
  check("no signals: total is 0", num(sc.total) === 0, `total=${String(sc.total)}`);
  check("no signals: fit, reach, timing are all zeros",
    num(sc.fit) === 0 && num(sc.reach) === 0 && num(sc.timing) === 0,
    `fit=${String(sc.fit)} reach=${String(sc.reach)} timing=${String(sc.timing)}`);
  check("no signals: reasons list is empty", Array.isArray(sc.reasons) && sc.reasons.length === 0, JSON.stringify(sc.reasons));
}

// ---------------------------------------------------------------- done
await new Promise<void>((resolve) => server.close(() => resolve()));
store.closeDb();
rmSync(ROOT, { recursive: true, force: true });
if (failed) {
  console.log("score-breakdown-check FAILED");
  process.exit(1);
} else {
  console.log("score-breakdown-check PASSED");
}
