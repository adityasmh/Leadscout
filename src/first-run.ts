// src/first-run.ts
// One-shot production-shaped run for Leadscout wave 2.
// Creates an isolated temp DB, seeds a workspace, runs the pipeline once for the
// configured category and city (env FIRST_RUN_CATEGORY / FIRST_RUN_CITY, defaults
// dental clinic / Navi Mumbai), and emits Markdown dossiers for gated leads.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Dossier, CategoryExplainer, PriceBook } from "./types-v2.js";
import type { Workspace, JobQuery, RawLead, Lead } from "./types.js";

// --------------------------------------------------------------------------- constants

const RUN_TIMEOUT_MS = 600_000; // 10 minutes, well under the 900 s hard limit
const DISCOVER_FETCH_MS = 45_000;
const OSM_CHECK_MS = 12_000;
const EXPLAINER_LLM_MS = 20_000;
const POLISH_LLM_MS = 25_000;

// Category and city for this run. Overridable by env for the network fallback run.
const CATEGORY = ((process.env.FIRST_RUN_CATEGORY ?? "").trim() || "dental clinic");
const CITY = ((process.env.FIRST_RUN_CITY ?? "").trim() || "Navi Mumbai");
const COUNTRY = "India";

// --------------------------------------------------------------------------- helpers

function slugify(value: string): string {
  return (value ?? "lead")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function todayIso(): string {
  return new Date().toISOString();
}

function timedFetch(ms: number): typeof fetch {
  return (input, init) =>
    fetch(input, { ...(init ?? {}), signal: AbortSignal.timeout(ms) });
}

function makeQuickLlm(defaultLlm: any, ms: number): any {
  return async function quickLlm(req: { system: string; prompt: string; taskHint?: string }) {
    return await Promise.race([
      defaultLlm(req),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM call timed out")), ms)
      ),
    ]);
  };
}

async function loadModule<T>(path: string, order: string): Promise<T> {
  try {
    return (await import(path)) as T;
  } catch (err) {
    throw new Error(`Failed to load ${path} (order ${order} should have supplied it): ${(err as Error).message}`);
  }
}

function manualExplainer(category: string, country: string): CategoryExplainer {
  const now = new Date().toISOString();
  return {
    id: `manual-${randomUUID()}`,
    category,
    country,
    language: "en",
    promptVersion: "manual-fallback",
    howItWorks: [
      `customers usually find a ${category} by referral or local search and call or walk in to book.`,
      "the front desk answers calls and manually schedules visits during working hours.",
      "follow-ups and reminders are often handled by phone or messaging apps.",
      "records and enquiry details are typically kept in paper files or simple spreadsheets.",
    ],
    whereAutomationHelps: [
      { service: "website", point: "a website lets patients find services and book appointments online." },
      { service: "automation", point: "automated reminders reduce no-shows and save front-desk time." },
      { service: "ai-chatbot", point: "a chatbot can answer common questions and capture enquiries at any hour." },
      { service: "whatsapp-automation", point: "whatsapp automation can confirm bookings and send follow-up messages." },
      { service: "booking-system", point: "online booking lets patients choose slots without calling." },
    ],
    tokensIn: 0,
    tokensOut: 0,
    createdAt: now,
    reviewed: false,
  };
}

async function generateExplainer(
  getExplainer: any,
  defaultLlm: any
): Promise<{ explainer: CategoryExplainer; fallback: boolean }> {
  const quickLlm = makeQuickLlm(defaultLlm, EXPLAINER_LLM_MS);
  try {
    const result = await getExplainer(CATEGORY, COUNTRY, {
      llm: quickLlm,
      allowGenerate: true,
    });
    if (result) return { explainer: result, fallback: false };
    console.log("[first-run] explainer generation returned null (LLM unreachable or answer failed validation); using manual fallback.");
  } catch (err) {
    console.log(`[first-run] explainer LLM failed: ${(err as Error).message}; using manual fallback.`);
  }
  return { explainer: manualExplainer(CATEGORY, COUNTRY), fallback: true };
}

async function checkOsmReachable(resolvePlace: any): Promise<boolean> {
  try {
    await Promise.race([
      resolvePlace(`${CITY}, ${COUNTRY}`, { fetchFn: timedFetch(10_000) }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("OpenStreetMap check timed out")), OSM_CHECK_MS)
      ),
    ]);
    return true;
  } catch (err) {
    console.error("OpenStreetMap is unreachable:", (err as Error).message);
    return false;
  }
}

// --------------------------------------------------------------------------- markdown rendering

function formatQuote(quote: string): string {
  return quote
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPrice(quote: Dossier["offers"][number]["quote"]): string {
  if (!quote) return "price not set";
  return `${quote.currency} ${quote.min.toLocaleString()}–${quote.max.toLocaleString()}`;
}

function formatBuildDays(days: [number, number] | null): string {
  if (!days) return "build time not set";
  return `${days[0]}–${days[1]} days`;
}

function renderDossier(
  dossier: Dossier,
  lead: Lead,
  explainer: CategoryExplainer | null
): string {
  const area = dossier.facts.area?.value ?? lead.city ?? CITY;
  const lines: string[] = [];

  lines.push(`# ${lead.name} — ${area}`);
  lines.push("");

  // Facts
  lines.push("## Facts");
  const facts = dossier.facts;
  const factEntries: Array<{ label: string; value: string; evidence: string[] }> = [];
  if (facts.owner) {
    factEntries.push({ label: "Owner", value: facts.owner.value, evidence: facts.owner.evidence });
  }
  if (facts.sinceYear) {
    factEntries.push({ label: "Since", value: String(facts.sinceYear.value), evidence: facts.sinceYear.evidence });
  }
  if (facts.rating) {
    factEntries.push({ label: "Rating", value: String(facts.rating.value), evidence: facts.rating.evidence });
  }
  if (facts.reviewCount) {
    factEntries.push({ label: "Review count", value: String(facts.reviewCount.value), evidence: facts.reviewCount.evidence });
  }
  if (facts.area) {
    factEntries.push({ label: "Area", value: facts.area.value, evidence: facts.area.evidence });
  }

  if (factEntries.length === 0) {
    lines.push("- No additional business facts were found in fetched text or structured data.");
  } else {
    for (const f of factEntries) {
      lines.push(`- **${f.label}:** ${f.value} *(evidence: ${f.evidence.join(", ")})*`);
    }
  }
  lines.push("");

  // Gap
  if (dossier.gap) {
    lines.push(`## THE GAP — ${dossier.gap.tag}`);
    lines.push(`${dossier.gap.headline.value} *(evidence: ${dossier.gap.headline.evidence.join(", ")})*`);
    lines.push("");
  } else {
    lines.push("## THE GAP");
    lines.push("No evidenced gap was detected for this lead.");
    lines.push("");
  }

  // Say this
  if (dossier.sayThis) {
    lines.push("## SAY THIS");
    lines.push(`${dossier.sayThis.value} *(evidence: ${dossier.sayThis.evidence.join(", ")})*`);
    lines.push("");
  }

  // Fallback / pushback
  if (dossier.pushback) {
    lines.push("## FALLBACK LINE");
    lines.push(`${dossier.pushback.value} *(evidence: ${dossier.pushback.evidence.join(", ")})*`);
    lines.push("");
  }

  // Offers
  lines.push("## Offers");
  if (dossier.offers.length === 0) {
    lines.push("- No matching offers were produced from the workspace price book.");
  } else {
    for (const offer of dossier.offers) {
      const door = offer.doorOpener ? " *(door-opener)*" : "";
      lines.push(`${offer.rank}. **${offer.title}**${door}`);
      lines.push(`   - ${offer.description.value} *(evidence: ${offer.description.evidence.join(", ")})*`);
      lines.push(`   - Why it matters: ${offer.whyItMatters.value} *(evidence: ${offer.whyItMatters.evidence.join(", ")})*`);
      lines.push(`   - Build estimate: ${formatBuildDays(offer.buildDays)}`);
      lines.push(`   - Quote: ${formatPrice(offer.quote)}`);
      lines.push(`   - Assumption: ${offer.assumption}`);
      lines.push("");
    }
  }

  // Explainer
  lines.push("## How this business works");
  lines.push(`*General to ${CATEGORY} in ${COUNTRY}; not about ${lead.name}.*`);
  lines.push("");
  if (explainer) {
    for (const bullet of explainer.howItWorks) {
      lines.push(`- ${bullet}`);
    }
    lines.push("");
    lines.push("Where automation helps:");
    for (const item of explainer.whereAutomationHelps) {
      lines.push(`- **${item.service}:** ${item.point}`);
    }
  } else {
    lines.push("- Category explainer was not generated.");
  }
  lines.push("");

  // Evidence
  lines.push("## Evidence");
  if (dossier.evidence.length === 0) {
    lines.push("- No evidence items recorded.");
  } else {
    for (const ev of dossier.evidence) {
      lines.push(`- **${ev.id}** [${ev.kind}] — ${formatQuote(ev.quote)}`);
      lines.push(`  - Source: ${ev.url}`);
      if (ev.field) lines.push(`  - Field: ${ev.field}`);
    }
  }
  lines.push("");

  // Metadata
  lines.push("---");
  lines.push(`- Dossier level: ${dossier.level} (${dossier.level === 0 ? "rule templates" : "model-polished"})`);
  lines.push(`- Tokens in: ${dossier.tokensIn}, out: ${dossier.tokensOut}`);
  lines.push(`- Generated: ${dossier.createdAt}`);
  if (explainer) {
    lines.push(`- Explainer: ${explainer.id}`);
  }
  lines.push("");

  return lines.join("\n");
}

// --------------------------------------------------------------------------- report writing

type RunReport = {
  lines: string[];
  filePaths: string[];
  tmpDir: string;
  dbPath: string;
  explainerFallback: boolean;
};

function writeFirstRunReport(
  report: RunReport,
  dossiers: { dossier: Dossier; lead: Lead }[],
  priceBook: PriceBook,
  job: any,
  explainer: CategoryExplainer | null
) {
  const lines: string[] = [];
  lines.push("# Leadscout First Run Report");
  lines.push("");
  lines.push(`Generated: ${todayIso()}`);
  lines.push("");

  lines.push("## Command output");
  lines.push("```text");
  for (const line of report.lines) lines.push(line);
  lines.push("```");
  lines.push("");

  lines.push("## Dossier files");
  if (report.filePaths.length === 0) {
    lines.push("- No gated dossiers were emitted.");
  } else {
    for (const p of report.filePaths) lines.push(`- ${p.replace(/\\/g, "/")}`);
  }
  lines.push("");

  lines.push("## Temp artifacts");
  lines.push(`- Temp folder: ${report.tmpDir}`);
  lines.push(`- SQLite DB: ${report.dbPath}`);
  lines.push("- Left in place; no deletes performed.");
  lines.push("");

  lines.push("## API mapping");
  lines.push("- Pipeline job runner: `runJob(workspaceId: string, jobId: string, deps?: Partial<PipelineDeps>): Promise<{ found: number; resolved: number; unreachable: number }>` exported from `src/pipeline.ts` (order L7, counts added by L42).");
  lines.push("- Store: `createWorkspace`, `createJob`, `listJobs`, `listLeads`, `getDossier` from `src/store.ts` (order L2).");
  lines.push("- Dossier: `getDossier` from `src/dossier.ts` (order L8).");
  lines.push("- Explainer: `getExplainer` from `src/explainer.ts` (order L9).");
  lines.push("- The runner discovers, enriches, verifies, scores, builds evidence, and writes dossiers through the store.");
  lines.push(`- This script calls it exactly once with \`{ category: '${CATEGORY}', city: '${CITY}', country: '${COUNTRY}', limit: 8 }\`.`);
  lines.push("- Injected deps:");
  lines.push("  - `discover` wrapper with a 45 s fetch timeout and an internal Overpass limit of 100, so the pipeline's S1 contact-info filter has more candidates while the job still keeps at most 8 leads.");
  lines.push("  - `llm` wrapped with a 25 s per-call timeout for model polish.");
  lines.push("  - `getExplainer` returns the single category explainer generated before the job (or the manual fallback if the LLM was unreachable), so every dossier shares the same explainer.");
  lines.push("  - `checkLimit` (always allows) and `meter` (no-op) because this isolated first-run workspace has no real usage limits.");
  lines.push("");

  lines.push("## Quality-bar self-check");
  const idsFor = (d: Dossier) => new Set(d.evidence.map((e) => e.id));
  const ok = (d: Dossier, arr: string[] | undefined) =>
    Array.isArray(arr) && arr.length > 0 && arr.every((id) => idsFor(d).has(id));
  const allCited = dossiers.every(({ dossier: d }) => {
    return (
      (!d.gap || ok(d, d.gap.headline.evidence)) &&
      (!d.sayThis || ok(d, d.sayThis.evidence)) &&
      (!d.pushback || ok(d, d.pushback.evidence)) &&
      d.offers.every((o) => ok(d, o.description.evidence) && ok(d, o.whyItMatters.evidence))
    );
  });
  const noInvented = dossiers.every(({ dossier: d }) => {
    const hasField = (field: string) => d.evidence.some((e) => e.field === field);
    return (
      (!d.facts.owner || hasField("owner")) &&
      (!d.facts.sinceYear || hasField("since-year")) &&
      (!d.facts.rating || hasField("rating")) &&
      (!d.facts.reviewCount || hasField("rating")) &&
      d.offers.every((o) => o.quote === null)
    );
  });
  const explainerReuse =
    explainer !== null && (dossiers.length === 0 || dossiers.every(({ dossier: d }) => d.explainerId === explainer.id));
  const underBudget = dossiers.every(
    ({ dossier: d }) => d.tokensIn + d.tokensOut <= 5000
  );
  lines.push(`- Citations (every claim has evidence ids): ${allCited ? "PASS" : "FAIL"}`);
  lines.push(`- No invented owner/rating/review/since-year/prices: ${noInvented ? "PASS" : "FAIL"}`);
  lines.push(`- Explainer reused identically across dossiers: ${explainerReuse ? "PASS" : "FAIL"}`);
  lines.push(`- Tokens per dossier ≤ 5,000: ${underBudget ? "PASS" : "FAIL"}`);
  lines.push("");

  lines.push("## Tokens per dossier vs 5,000 limit");
  if (dossiers.length === 0) {
    lines.push("- No gated dossiers to report.");
  } else {
    lines.push("| Name | Tokens in | Tokens out | Total | Under 5,000 |");
    lines.push("|---|---|---|---|---|");
    for (const { dossier: d, lead } of dossiers) {
      const total = d.tokensIn + d.tokensOut;
      lines.push(`| ${lead.name} | ${d.tokensIn} | ${d.tokensOut} | ${total} | ${total <= 5000 ? "yes" : "NO"} |`);
    }
  }
  lines.push("");
  lines.push(`Explainer tokens: ${explainer ? explainer.tokensIn + explainer.tokensOut : 0} (amortised across all dossiers).`);
  lines.push("");

  lines.push("## Comparison vs reference 'Navi Mumbai Call List'");
  lines.push("What our dossiers include:");
  lines.push("- Business name + area");
  lines.push("- Evidenced facts (owner, since-year, rating/review count, area) only when found");
  lines.push("- THE GAP headline with a tag (GOING UNSEEN, LEAKING, OUTDATED, NOT MEASURING)");
  lines.push("- SAY THIS opener and a fallback/pushback line");
  lines.push("- Numbered offers with evidence ids, build estimate, and quote placeholder from the workspace price book");
  lines.push("- Shared category explainer ('how this business works')");
  lines.push("- Numbered evidence list with source URLs");
  lines.push("");
  lines.push("What is missing vs the reference hand-built list:");
  lines.push("- Owner name, since-year, rating and review count are only shown when the business published them; many leads will omit several of these.");
  lines.push("- Call status column (not set during the run; default is 'not-called').");
  lines.push("- A free door-opener offer is not present in this workspace's price book for the seeded services (default items all have doorOpener=false).");
  lines.push("- Model polish depends on the LLM router being reachable; when it is not, dossiers stay at level 0.");
  lines.push("");

  lines.push("## Open issues");
  if (report.explainerFallback) {
    lines.push("- LLM router was not reachable for the category explainer; a manual fallback was used and dossiers were not model-polished.");
  }
  if (dossiers.length === 0) {
    lines.push(`- No leads cleared the score gate; likely causes are thin OSM contact info (no phone/email/website) for ${CATEGORY} leads in ${CITY} or a pre-score filter removing all discovered leads.`);
  }
  lines.push("- Workspace price book for the seeded services currently has unset prices (rendered as 'price not set'); seller must set real prices before outreach.");
  lines.push("- OSM-derived listings vary in completeness; phone/website/address coverage for small Indian clinics may be thin.");
  lines.push("- The static HTML enrichment can miss JavaScript-rendered widgets (chat, booking), so some absence signals may be false negatives.");
  lines.push("");

  writeFileSync(join("docs", "leadgen", "FIRST_RUN.md"), lines.join("\n"));
}

function writeFailureReport(
  report: RunReport,
  error: string,
  stage: string
) {
  const lines: string[] = [];
  lines.push("# Leadscout First Run Report — FAILED");
  lines.push("");
  lines.push(`Generated: ${todayIso()}`);
  lines.push("");
  lines.push("## Failure");
  lines.push(`- Stage: \`${stage}\``);
  lines.push(`- Error: ${error}`);
  lines.push("");
  lines.push("## Command output up to failure");
  lines.push("```text");
  for (const line of report.lines) lines.push(line);
  lines.push("```");
  lines.push("");
  lines.push("## Dossier files");
  lines.push("- None emitted due to failure.");
  lines.push("");
  lines.push("## Temp artifacts");
  lines.push(`- Temp folder: ${report.tmpDir}`);
  lines.push(`- SQLite DB: ${report.dbPath}`);
  lines.push("- Left in place; no deletes performed.");
  lines.push("");
  lines.push("## API mapping");
  lines.push("- Pipeline job runner: `runJob(workspaceId: string, jobId: string, deps?: Partial<PipelineDeps>): Promise<{ found: number; resolved: number; unreachable: number }>` exported from `src/pipeline.ts` (order L7, counts added by L42).");
  lines.push("");
  lines.push("## Quality-bar self-check");
  lines.push("- Could not run because the job failed.");
  lines.push("");
  lines.push("## Comparison vs reference 'Navi Mumbai Call List'");
  lines.push("- Could not run because the job failed.");
  lines.push("");
  lines.push("## Open issues");
  lines.push(`- Run failed at stage ${stage}: ${error}`);
  lines.push("");

  writeFileSync(join("docs", "leadgen", "FIRST_RUN.md"), lines.join("\n"));
}

// --------------------------------------------------------------------------- main

async function main() {
  // This script is the explicit live-run entry point (ORDER_L42): contact resolution is
  // expected to reach the real research layer here, so the live gate is opened ONCE at
  // startup. All other entry points keep the off-by-default behaviour; the defaults in
  // pipeline.ts and resolve.ts are unchanged. Unset-only: an operator who exported the
  // variable keeps control of it.
  if (process.env.LEADSCOUT_RESOLVE_LIVE === undefined) {
    process.env.LEADSCOUT_RESOLVE_LIVE = "1";
  }

  const report: RunReport = {
    lines: [],
    filePaths: [],
    tmpDir: "",
    dbPath: "",
    explainerFallback: false,
  };

  function log(line: string) {
    console.log(line);
    report.lines.push(line);
  }

  // 1. Isolation: temp folder + temp DB.
  const tmpBase = join(tmpdir(), "leadscout-first-run");
  mkdirSync(tmpBase, { recursive: true });
  report.tmpDir = mkdtempSync(join(tmpBase, "run-"));
  report.dbPath = join(report.tmpDir, "leadscout.db");
  if (!process.env.LEADSCOUT_DB) {
    process.env.LEADSCOUT_DB = report.dbPath;
  } else {
    report.dbPath = process.env.LEADSCOUT_DB;
  }
  log(`[first-run] temp artifacts: ${report.tmpDir}`);
  log(`[first-run] LEADSCOUT_DB: ${process.env.LEADSCOUT_DB}`);

  // 2. Load modules AFTER env is set (store/tenant/compliance/cost read it at import time).
  let store: typeof import("./store.js");
  let pipeline: typeof import("./pipeline.js");
  let explainerMod: typeof import("./explainer.js");
  let dossierMod: typeof import("./dossier.js");
  let tenant: typeof import("./tenant.js");
  let llm: typeof import("./llm.js");
  let discoverMod: typeof import("./discover.js");
  let verifyMod: typeof import("./verify.js");
  let scoreMod: typeof import("./score.js");
  let evidenceMod: typeof import("./evidence.js");
  let accessMod: typeof import("./access.js");
  let matchMod: typeof import("./match.js");
  let enrichMod: typeof import("./enrich.js");
  try {
    [
      store,
      pipeline,
      explainerMod,
      dossierMod,
      tenant,
      llm,
      discoverMod,
      verifyMod,
      scoreMod,
      evidenceMod,
      accessMod,
      matchMod,
      enrichMod,
    ] = await Promise.all([
      loadModule<typeof import("./store.js")>("./store.js", "L2"),
      loadModule<typeof import("./pipeline.js")>("./pipeline.js", "L7"),
      loadModule<typeof import("./explainer.js")>("./explainer.js", "L9"),
      loadModule<typeof import("./dossier.js")>("./dossier.js", "L8"),
      loadModule<typeof import("./tenant.js")>("./tenant.js", "L11"),
      loadModule<typeof import("./llm.js")>("./llm.js", "L8"),
      loadModule<typeof import("./discover.js")>("./discover.js", "L3"),
      loadModule<typeof import("./verify.js")>("./verify.js", "L10"),
      loadModule<typeof import("./score.js")>("./score.js", "L10"),
      loadModule<typeof import("./evidence.js")>("./evidence.js", "L15"),
      loadModule<typeof import("./access.js")>("./access.js", "L16"),
      loadModule<typeof import("./match.js")>("./match.js", "L5"),
      loadModule<typeof import("./enrich.js")>("./enrich.js", "L4"),
    ]);
  } catch (err) {
    const message = (err as Error).message;
    log(`[first-run] module load failed: ${message}`);
    writeFailureReport(report, message, "module-load");
    process.exitCode = 1;
    return;
  }

  // Dossiers are owned by dossier.ts (order L8); store.ts never exported a getDossier.
  const { createWorkspace, createJob, listLeads, listJobs } = store;
  const { runJob } = pipeline;
  const { getExplainer } = explainerMod;
  const { getDossier } = dossierMod;
  const { getPriceBook } = tenant;
  const { defaultLlm } = llm;
  const { discover, resolvePlace, resolveCategory } = discoverMod;
  const categoryId = resolveCategory(CATEGORY).id; // OSM category id, e.g. "dental-clinic" / "salon"

  // 3. OSM reachability check.
  if (!(await checkOsmReachable(resolvePlace))) {
    log("[first-run] OpenStreetMap is unreachable. END.");
    writeFailureReport(report, "OpenStreetMap is unreachable", "osm-reachability");
    process.exitCode = 1;
    return;
  }
  log("[first-run] OpenStreetMap reachable.");

  // 4. Seed workspace.
  const services = [
    "automation",
    "ai-chatbot",
    "whatsapp-automation",
    "website",
    "booking-system",
  ];
  const workspace = createWorkspace({
    name: "First Run Workspace",
    offer: {
      services,
      description: "Automation, AI chatbot, WhatsApp automation, website and booking system services for clinics.",
    },
    icp: {
      categories: [categoryId],
      cities: [CITY],
      countries: [COUNTRY],
    },
  });
  log(`[first-run] workspace created: ${workspace.id}`);

  // 5. Generate category explainer once.
  const { explainer, fallback: explainerFallback } = await generateExplainer(getExplainer, defaultLlm);
  report.explainerFallback = explainerFallback;
  if (explainer) {
    log(`[first-run] category explainer: ${explainer.id} (${explainer.tokensIn + explainer.tokensOut} tokens)`);
  } else {
    log("[first-run] category explainer: could not be generated.");
  }

  // 6. Create and run the pipeline job.
  const job = createJob(workspace.id, {
    category: CATEGORY,
    city: CITY,
    country: COUNTRY,
    limit: 8,
  });
  log(`[first-run] job created: ${job.id}`);

  const quickLlm = makeQuickLlm(defaultLlm, POLISH_LLM_MS);
  const longFetch = timedFetch(DISCOVER_FETCH_MS);

  // Wrapper: use our own long-timeout fetch (ignore pipeline's wrapped fetchFn) and ask Overpass
  // for more candidates so the S1 contact-info filter still has a chance to find 8 leads.
  const discoverWrapper = (
    q: JobQuery & { limit?: number },
    _deps?: { fetchFn?: typeof fetch }
  ): Promise<RawLead[]> => {
    const internalLimit = Math.max(q.limit ?? 8, 100);
    return discover({ ...q, limit: internalLimit }, { fetchFn: longFetch });
  };

  // Return the single pre-generated explainer to every caller.
  const explainerProvider = async (
    category: string,
    country: string,
    _deps?: { llm?: any; allowGenerate?: boolean; language?: string }
  ): Promise<CategoryExplainer | null> => {
    if (
      explainer &&
      category.toLowerCase() === String(explainer.category ?? "").trim().toLowerCase() &&
      country.toLowerCase() === String(explainer.country ?? "").trim().toLowerCase()
    ) {
      return explainer;
    }
    return null;
  };

  // Permissive limits for this isolated run.
  const okLimit = () => ({ ok: true as const, remaining: Infinity, message: "" });
  const noopMeter = () => {};

  let runCounts: { found: number; resolved: number; unreachable: number } | undefined;
  try {
    runCounts = await runJob(workspace.id, job.id, {
      discover: discoverWrapper,
      verify: verifyMod.verify,
      // scoreLead is not injected here on purpose: pipeline.ts loads ./score.js itself
      // through resolveDeps, and score.ts's ScoreOpts type does not fit the pipeline
      // dep signature first-run.ts would have to satisfy.
      buildEvidence: evidenceMod.buildEvidence,
      extractFacts: evidenceMod.extractFacts,
      bizKey: evidenceMod.bizKey,
      getExplainer: explainerProvider,
      buildTemplateDossier: dossierMod.buildTemplateDossier,
      polishDossier: dossierMod.polishDossier,
      inputHashOf: dossierMod.inputHashOf,
      saveDossier: dossierMod.saveDossier,
      getDossier,
      getPriceBook,
      checkLimit: okLimit,
      meter: noopMeter,
      llm: quickLlm,
      match: matchMod.match,
      enrich: enrichMod.enrich,
    });
  } catch (err) {
    const message = (err as Error).message;
    log(`[first-run] pipeline runJob failed: ${message}`);
    writeFailureReport(report, message, "pipeline-runJob");
    process.exitCode = 1;
    return;
  }

  const jobs = listJobs(workspace.id);
  const ran = jobs.find((j) => j.id === job.id);
  const foundCount = runCounts?.found ?? ran?.found ?? 0;
  const resolvedCount = runCounts?.resolved ?? 0;
  const unreachableCount = runCounts?.unreachable ?? 0;
  log(
    `[first-run] job status: ${ran?.status ?? "unknown"}, found: ${foundCount}, resolved: ${resolvedCount}, unreachable: ${unreachableCount}, enriched: ${ran?.enriched ?? 0}`
  );
  if (ran?.error) log(`[first-run] job errors: ${ran.error}`);

  if (ran?.status === "failed") {
    const err = ran.error ?? "";
    if (/overpass|nominatim|openstreetmap|504|503|502|429|\baborted\b|timeout/i.test(err)) {
      log("[first-run] OpenStreetMap is unreachable or overloaded. END.");
      writeFailureReport(report, err, "osm-unreachable");
      process.exitCode = 1;
      return;
    }
    log("[first-run] job failed for a non-OSM reason; treating as run failure.");
    writeFailureReport(report, err, "pipeline-failed");
    process.exitCode = 1;
    return;
  }

  // 7. Collect gated leads and their dossiers.
  const gated = listLeads({
    workspaceId: workspace.id,
    minScore: 35,
    sort: "score",
    limit: 100,
  });
  log(`[first-run] gated leads: ${gated.leads.length} / ${gated.total}`);

  const dossiers: { dossier: Dossier; lead: Lead }[] = [];
  for (const lead of gated.leads) {
    const dossier = getDossier(workspace.id, lead.id);
    if (dossier) {
      dossiers.push({ dossier, lead });
    } else {
      log(`[first-run] warning: no dossier stored for lead ${lead.id} (${lead.name})`);
    }
  }

  // 8. Write one Markdown file per gated lead.
  const outDir = join("products", "leadscout", "data", "first-run");
  mkdirSync(outDir, { recursive: true });
  for (const { dossier, lead } of dossiers) {
    const slug = slugify(`${lead.name} ${lead.city ?? ""}`);
    const filePath = join(outDir, `${slug}.md`);
    const md = renderDossier(dossier, lead, explainer);
    writeFileSync(filePath, md);
    report.filePaths.push(filePath);
  }

  // 9. Summary table.
  log("");
  log("## Summary");
  log("| Name | Score | Offers | Tokens used | Run cost | Under 5k limit |");
  log("|---|---|---|---|---|---|");
  let totalTokens = 0;
  for (const { dossier, lead } of dossiers) {
    const tokens = dossier.tokensIn + dossier.tokensOut;
    totalTokens += tokens;
    const under = tokens <= 5000 ? "yes" : "NO";
    log(`| ${lead.name} | ${lead.score} | ${dossier.offers.length} | ${tokens} | not computed | ${under} |`);
  }
  const explainerTokens = explainer ? explainer.tokensIn + explainer.tokensOut : 0;
  log("");
  log(`Total dossier tokens: ${totalTokens}`);
  log(`Explainer tokens: ${explainerTokens}`);
  log("Run cost (money): not computed — no router rate or price book prices are available in this run.");

  // 10. Write FIRST_RUN.md report.
  const priceBook = getPriceBook(workspace.id);
  writeFirstRunReport(report, dossiers, priceBook, ran, explainer);
  log("");
  log(`[first-run] report written to: docs/leadgen/FIRST_RUN.md`);
}

async function runWithTimeout() {
  return Promise.race([
    main(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`first-run exceeded ${RUN_TIMEOUT_MS / 1000}s timeout`)), RUN_TIMEOUT_MS)
    ),
  ]);
}

runWithTimeout().catch((err) => {
  console.error("[first-run] unexpected error:", err);
  process.exitCode = 1;
});
