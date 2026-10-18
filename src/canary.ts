// Self-healing channel canaries (Order SH1). Offline-testable: every outside
// read goes through injected deps (search / readPage / browser); live runs are
// OFF unless env LEADSCOUT_CANARY=1. Node 24 built-ins only, ES modules.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelAdapter, ChannelDeps, ChannelStatus } from "./channels/types.js";

export const DRIFT_REASON = "layout drift suspected (canary)";
export const CANARY_ENV = "LEADSCOUT_CANARY";
export const RATE_LIMIT_MS = 20 * 60 * 60 * 1000; // 20 hours between runs per channel
export const REQUEST_GAP_MS = 1000; // one request per second
export const MAX_HISTORY = 10;

export type CanaryExpected = {
  fields: string[];
  patterns?: Record<string, string>; // field -> RegExp source, tested against the found value
  minLeads?: number;
};

export type CanaryDef = {
  id: string;
  adapterId: string;
  kind: "discover" | "enrich";
  category?: string;
  city?: string;
  area?: string;
  url?: string;
  searchQuery?: string;
  leadName?: string;
  expected: CanaryExpected;
  enabled?: boolean;
  verified?: boolean;
  note?: string;
};

export type CanaryResult = {
  adapterId: string;
  canaryId: string;
  at: string; // ISO time
  ok: boolean;
  missingFields: string[];
  ratio: number; // found / expected, 0..1
  foundFields: string[];
  textSize: number;
  leads?: number;
};

export type EvalOut = { ok: boolean; missingFields: string[]; ratio: number };

export type CanaryDeps = ChannelDeps & {
  now?: () => number;
};

export function canaryEnabled(): boolean {
  return process.env[CANARY_ENV] === "1";
}

// ---- evaluate ---------------------------------------------------------------

function valuePresent(v: string | number | undefined): boolean {
  if (v === undefined || v === null) return false;
  return String(v).trim() !== "";
}

/** Compare found fields against expected. ok = nothing missing. */
export function evaluate(
  found: Record<string, string | number | undefined>,
  expected: CanaryExpected,
): EvalOut {
  const fields = Array.isArray(expected?.fields) ? expected.fields : [];
  const missing: string[] = [];
  for (const f of fields) {
    if (!valuePresent(found[f])) {
      missing.push(f);
      continue;
    }
    const pat = expected?.patterns?.[f];
    if (pat) {
      let re: RegExp;
      try {
        re = new RegExp(pat);
      } catch {
        missing.push(f);
        continue;
      }
      if (!re.test(String(found[f]))) missing.push(f);
    }
  }
  const total = fields.length;
  const ratio = total === 0 ? 1 : (total - missing.length) / total;
  return { ok: missing.length === 0, missingFields: missing, ratio };
}

// ---- runCanary --------------------------------------------------------------

/** Run one canary through the adapter's discover (or enrich for kind=enrich),
 * using only the injected search / readPage / browser (a normal single page read). */
export async function runCanary(
  adapter: ChannelAdapter,
  canary: CanaryDef,
  deps: CanaryDeps,
): Promise<CanaryResult> {
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  let found: Record<string, string | number | undefined> = {};
  let textSize = 0;
  let leads = 0;
  if (canary.kind === "enrich") {
    const lead = {
      name: String(canary.leadName ?? canary.searchQuery ?? canary.id),
      category: String(canary.category ?? "retail"),
      city: canary.city,
      source: "canary",
      sourceUrl: String(canary.url ?? ""),
    };
    const ev = await adapter.enrich(lead, deps);
    found = ev.fields ?? {};
    textSize = String(ev.text ?? "").length;
  } else {
    const q = {
      category: String(canary.category ?? "retail"),
      city: String(canary.city ?? ""),
      area: canary.area,
      limit: 5,
    };
    const list = await adapter.discover(q, deps);
    leads = list.length;
    const first = list[0];
    if (first) {
      found = {
        name: first.name,
        phone: first.phone,
        email: first.email,
        website: first.website,
        address: first.address,
        city: first.city,
      };
      textSize = JSON.stringify(first).length;
    }
    const minLeads = canary.expected?.minLeads ?? 1;
    if (leads < minLeads) found = { ...found, __leads: undefined };
  }
  const expectedFields = [...(canary.expected?.fields ?? [])];
  // minLeads gate reports as a pseudo-field so drift sees empty results.
  const evalFound = { ...found };
  const ev = evaluate(evalFound, { ...canary.expected, fields: expectedFields });
  const missing = [...ev.missingFields];
  const minLeads = canary.expected?.minLeads ?? (canary.kind === "discover" ? 1 : 0);
  let ratio = ev.ratio;
  if (canary.kind === "discover" && leads < minLeads) {
    if (!missing.includes("__empty")) missing.push("__empty");
    const total = expectedFields.length + 1;
    const got = total - missing.length;
    ratio = total === 0 ? (leads > 0 ? 1 : 0) : got / total;
  }
  const foundFields = Object.keys(found).filter((k) => valuePresent(found[k]));
  return {
    adapterId: adapter.id,
    canaryId: canary.id,
    at,
    ok: missing.length === 0,
    missingFields: missing,
    ratio,
    foundFields,
    textSize,
    leads,
  };
}

// ---- detectDrift ------------------------------------------------------------

/** Drift = ratio below 0.5 on two consecutive runs, OR a field that was
 * present in the last good runs (up to 5) and is now missing.
 * history is chronological (oldest first); uses the trailing runs. */
export function detectDrift(history: CanaryResult[]): { drift: boolean; reason?: string } {
  if (history.length === 0) return { drift: false };
  const last = history[history.length - 1];
  const prev = history.length > 1 ? history[history.length - 2] : undefined;
  if (last && prev && last.ratio < 0.5 && prev.ratio < 0.5) {
    return { drift: true, reason: `ratio below 0.5 twice in a row (${prev.ratio} then ${last.ratio})` };
  }
  // Field regression: a field present in every one of the last up to 5 good
  // runs, now missing on TWO consecutive runs. Two-in-a-row is required so a
  // single failed run never disables a channel by itself.
  const goodRuns: CanaryResult[] = [];
  if (last && prev && !last.ok && !prev.ok) {
    for (let i = history.length - 3; i >= 0 && goodRuns.length < 5; i -= 1) {
      const r = history[i];
      if (r.ok) goodRuns.push(r);
      else break; // only the good streak just before the bad streak counts
    }
  }
  if (goodRuns.length > 0 && !last.ok) {
    const stable = goodRuns[0].foundFields.filter((f) => goodRuns.every((g) => g.foundFields.includes(f)));
    const regressed = stable.filter((f) => last.missingFields.includes(f) || !last.foundFields.includes(f));
    if (regressed.length > 0) {
      return { drift: true, reason: `field(s) regressed after ${goodRuns.length} good run(s): ${regressed.join(", ")}` };
    }
  }
  return { drift: false };
}

// ---- disabled-by-canary hook ------------------------------------------------
// Small hook for channels/registry.ts (one-line call site):
//   import { isChannelDisabled } from "../canary.js";
//   ... in runDiscovery/runEnrichment: if (isChannelDisabled(a.id)) treat as disabled with disableReason(a.id).
// Kept here (not in registry.ts) so this order touches no existing file.

const disabledByCanary = new Map<string, string>();

export function isChannelDisabled(id: string): boolean {
  return disabledByCanary.has(String(id));
}

export function disableReason(id: string): string | undefined {
  return disabledByCanary.get(String(id));
}

export function markDisabled(id: string, why: string): void {
  disabledByCanary.set(String(id), why);
}

export function markEnabled(id: string): void {
  disabledByCanary.delete(String(id));
}

export function resetCanaryFlags(): void {
  disabledByCanary.clear();
}

// ---- state (atomic writes, corrupt file ignored) ----------------------------

export type ChannelState = {
  results: CanaryResult[];
  lastRunAt: string;
  disabled: boolean;
  proposalWritten: boolean;
  consecutivePasses: number;
};

export type CanaryState = { channels: Record<string, ChannelState> };

export function emptyState(): CanaryState {
  return { channels: {} };
}

export function defaultStatePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "data", "canary-state.json");
}

export function defaultCanariesPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "data", "canaries.json");
}

export function defaultProposalsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "docs", "leadgen", "proposals");
}

export async function loadState(statePath?: string): Promise<CanaryState> {
  const p = statePath ?? defaultStatePath();
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as CanaryState;
    if (!parsed || typeof parsed !== "object" || !parsed.channels || typeof parsed.channels !== "object") {
      return emptyState();
    }
    return parsed;
  } catch {
    return emptyState(); // missing or corrupt -> ignored without a throw
  }
}

/** Atomic write: tmp file + rename. Creates parent dirs. */
export async function saveState(state: CanaryState, statePath?: string): Promise<void> {
  const p = statePath ?? defaultStatePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, p);
}

// ---- proposals --------------------------------------------------------------

export function proposalName(adapterId: string): string {
  return `canary-${String(adapterId)}.md`;
}

export async function writeProposalOnce(
  proposalsDir: string,
  adapterId: string,
  st: ChannelState,
  driftReason: string,
): Promise<boolean> {
  if (st.proposalWritten) return false;
  const last = st.results[st.results.length - 1];
  const lines = [
    `# Canary drift proposal: ${adapterId}`,
    ``,
    `- Date: ${last?.at ?? new Date().toISOString()}`,
    `- Adapter: ${adapterId}`,
    `- Drift reason: ${driftReason}`,
    `- Expected fields: see data/canaries.json entry for canary ${last?.canaryId ?? "(unknown)"}`,
    `- Found fields: ${(last?.foundFields ?? []).join(", ") || "(none)"}`,
    `- Missing fields: ${(last?.missingFields ?? []).join(", ") || "(none)"}`,
    `- Ratio: ${last?.ratio ?? "n/a"}`,
    `- Fetched text size: ${last?.textSize ?? 0} chars`,
    ``,
    `## Evidence (expected vs found)`,
    ``,
    `- canary: ${last?.canaryId ?? "(unknown)"}`,
    `- ok: ${last?.ok ?? false}`,
    `- found: ${(last?.foundFields ?? []).join(", ") || "(none)"}`,
    `- missing: ${(last?.missingFields ?? []).join(", ") || "(none)"}`,
    `- text bytes: ${last?.textSize ?? 0}`,
    `- at: ${last?.at ?? "(unknown)"}`,
    ``,
    `## Draft fix order (standard format)`,
    ``,
    `TITLE: Fix ${adapterId} layout drift (canary)`,
    `FILES: src/channels/${adapterId}.ts`,
    `PROOF: npx tsx src/canary-check.ts prints PASS; canary for ${adapterId} passes twice and the channel re-enables.`,
    `STEPS:`,
    `1. Fetch the canary page with the injected readPage/browser reader (single page read, honor robots.txt and hourly caps).`,
    `2. Diff the fetched markup against the adapter's selectors for the missing field(s).`,
    `3. Update the selectors; re-run the canary until it passes twice.`,
    ``,
  ];
  await fs.mkdir(proposalsDir, { recursive: true });
  await fs.writeFile(path.join(proposalsDir, proposalName(adapterId)), lines.join("\n"), "utf8");
  st.proposalWritten = true;
  return true;
}

// ---- runAll -----------------------------------------------------------------

export type RunAllDeps = CanaryDeps & {
  adapters?: ChannelAdapter[];
  canaries?: CanaryDef[];
  canariesPath?: string;
  statePath?: string;
  proposalsDir?: string;
  sleep?: (ms: number) => Promise<void>;
};

export type RunAllSummary = {
  ran: string[];
  skippedRateLimit: string[];
  skippedCap: string[];
  drifted: string[];
  reEnabled: string[];
};

async function loadCanaries(canariesPath?: string, inline?: CanaryDef[]): Promise<CanaryDef[]> {
  if (inline) return inline;
  const p = canariesPath ?? defaultCanariesPath();
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as { canaries: CanaryDef[] };
    if (Array.isArray(parsed?.canaries)) return parsed.canaries;
    return [];
  } catch {
    return [];
  }
}

function browserCapHit(deps: RunAllDeps): boolean {
  try {
    const b = deps.browser;
    if (!b) return false;
    const st = b.status();
    const caps = st.caps ?? {};
    const used = st.usedThisHour ?? {};
    // Hit when ANY platform reached its cap (canary must stay within caps).
    for (const [platform, cap] of Object.entries(caps)) {
      if ((used[platform] ?? 0) >= (cap as number)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Run every enabled channel's canary at most once per 20h, one request per
 * second, within the browser reader's per-platform caps. Updates state
 * (last 10 results per channel), disables on drift, re-enables after 2 passes. */
export async function runAll(deps: RunAllDeps): Promise<RunAllSummary> {
  const summary: RunAllSummary = { ran: [], skippedRateLimit: [], skippedCap: [], drifted: [], reEnabled: [] };
  const adapters = deps.adapters ?? [];
  const canaries = await loadCanaries(deps.canariesPath, deps.canaries);
  const statePath = deps.statePath ?? defaultStatePath();
  const proposalsDir = deps.proposalsDir ?? defaultProposalsDir();
  const state = await loadState(statePath);
  const nowMs = (deps.now ?? Date.now)();
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let first = true;

  // Restore in-memory disabled flags from persisted state.
  for (const [id, ch] of Object.entries(state.channels)) {
    if (ch.disabled) markDisabled(id, DRIFT_REASON);
  }

  for (const adapter of adapters) {
    const defs = canaries.filter((c) => c.adapterId === adapter.id && c.enabled !== false);
    if (defs.length === 0) continue;
    let st: ChannelStatus | undefined;
    try {
      st = adapter.status();
    } catch {
      continue;
    }
    if (!st.enabled) continue;
    // NOTE: drift-disabled channels are still probed when due (rate-limited)
    // so two passing runs re-enable them automatically via recordResult().
    const ch = state.channels[adapter.id];
    if (ch?.lastRunAt) {
      const age = nowMs - Date.parse(ch.lastRunAt);
      if (Number.isFinite(age) && age < RATE_LIMIT_MS) {
        summary.skippedRateLimit.push(adapter.id);
        continue;
      }
    }
    if (browserCapHit(deps)) {
      summary.skippedCap.push(adapter.id);
      continue;
    }
    if (!first) await sleep(REQUEST_GAP_MS);
    first = false;
    for (const def of defs.slice(0, 2)) {
      let result: CanaryResult;
      try {
        result = await runCanary(adapter, def, deps);
      } catch (err) {
        result = {
          adapterId: adapter.id,
          canaryId: def.id,
          at: new Date(nowMs).toISOString(),
          ok: false,
          missingFields: [...(def.expected?.fields ?? [])],
          ratio: 0,
          foundFields: [],
          textSize: 0,
          leads: 0,
        };
        void err;
      }
      const cur = state.channels[adapter.id] ?? {
        results: [],
        lastRunAt: result.at,
        disabled: false,
        proposalWritten: false,
        consecutivePasses: 0,
      };
      cur.results = [...cur.results, result].slice(-MAX_HISTORY);
      cur.lastRunAt = result.at;
      cur.consecutivePasses = result.ok ? cur.consecutivePasses + 1 : 0;
      const dd = detectDrift(cur.results);
      if (dd.drift && !cur.disabled) {
        cur.disabled = true;
        markDisabled(adapter.id, DRIFT_REASON);
        await writeProposalOnce(proposalsDir, adapter.id, cur, dd.reason ?? "drift detected");
        summary.drifted.push(adapter.id);
      }
      if (cur.disabled && cur.consecutivePasses >= 2) {
        cur.disabled = false;
        cur.proposalWritten = false;
        markEnabled(adapter.id);
        summary.reEnabled.push(adapter.id);
      }
      if (cur.disabled) markDisabled(adapter.id, DRIFT_REASON);
      state.channels[adapter.id] = cur;
      summary.ran.push(adapter.id);
      break; // one canary per channel per runAll pass (at most once per 20h)
    }
  }

  await saveState(state, statePath);
  return summary;
}

/** Record one canary result (used by runAll and by tests/scheduler probes):
 * handles drift-disable, single proposal per episode, and auto re-enable
 * after two consecutive passes. Returns what happened. */
export async function recordResult(
  result: CanaryResult,
  opts: { statePath?: string; proposalsDir?: string; driftReason?: string } = {},
): Promise<{ drifted: boolean; reEnabled: boolean; proposalWritten: boolean }> {
  const statePath = opts.statePath ?? defaultStatePath();
  const proposalsDir = opts.proposalsDir ?? defaultProposalsDir();
  const state = await loadState(statePath);
  const cur = state.channels[result.adapterId] ?? {
    results: [],
    lastRunAt: result.at,
    disabled: false,
    proposalWritten: false,
    consecutivePasses: 0,
  };
  cur.results = [...cur.results, result].slice(-MAX_HISTORY);
  cur.lastRunAt = result.at;
  cur.consecutivePasses = result.ok ? cur.consecutivePasses + 1 : 0;
  let drifted = false;
  let proposalWritten = false;
  let reEnabled = false;
  const dd = detectDrift(cur.results);
  if (dd.drift && !cur.disabled) {
    cur.disabled = true;
    drifted = true;
    markDisabled(result.adapterId, DRIFT_REASON);
    proposalWritten = await writeProposalOnce(proposalsDir, result.adapterId, cur, dd.reason ?? opts.driftReason ?? "drift detected");
  }
  if (cur.disabled && cur.consecutivePasses >= 2) {
    cur.disabled = false;
    cur.proposalWritten = false; // next episode writes a fresh proposal
    reEnabled = true;
    markEnabled(result.adapterId);
  }
  if (cur.disabled) markDisabled(result.adapterId, DRIFT_REASON);
  state.channels[result.adapterId] = cur;
  await saveState(state, statePath);
  return { drifted, reEnabled, proposalWritten };
}
