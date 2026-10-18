// Channel registry (Order L43): registration, category ranking using
// india-sources.ts when present (else adapter-declared order), runDiscovery
// with a per-job call budget and cross-adapter dedupe, and runEnrichment.
// Adapters self-register by being imported from channels/index.ts.
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "./types.js";
import { reachBlocked } from "./types.js";
import type { RawLead } from "../types.js";

const registry = new Map<string, ChannelAdapter>();
let registrationOrder = 0;

export function registerChannel(a: ChannelAdapter): void {
  if (!a.id || !a.discover || !a.enrich) throw new Error("registry: invalid adapter");
  if (!registry.has(a.id)) registrationOrder += 1;
  (a as { _order?: number })._order = registrationOrder;
  registry.set(a.id, a);
}

export function channelAdapters(): ChannelAdapter[] {
  return [...registry.values()];
}

export function resetRegistry(): void {
  registry.clear();
  registrationOrder = 0;
}

/** Adapters for a category, ranked: when india-sources.ts (Order L41) lists the
 * category, adapters whose ids follow that registry's channel order come first;
 * anything it does not mention, and unknown categories, keep the
 * adapter-declared (registration) order. */
export async function adaptersFor(category: string): Promise<ChannelAdapter[]> {
  const cat = String(category ?? "").trim().toLowerCase();
  const eligible = channelAdapters().filter((a) => a.categories.includes(cat) || a.categories.includes("any"));
  let rank: Map<string, number> | undefined;
  try {
    const india = await import("../india-sources.js");
    rank = new Map(india.channelsFor(cat).map((ch, i) => [ch.id, i]));
  } catch {
    rank = undefined;
  }
  const orderOf = (a: ChannelAdapter): number => (a as { _order?: number })._order ?? Number.MAX_SAFE_INTEGER;
  const sorted = eligible.sort((a, b) => {
    const ra = rank?.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank?.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || orderOf(a) - orderOf(b);
  });
  // ST1-source-trust: refine the registry order by learned source trust, per
  // category. Falls back to `sorted` when no adapter has recorded data.
  try {
    const st = await import("../source-trust.js");
    const adjusted = st.rankAdapters(sorted, cat);
    if (adjusted) {
      if (adjusted.changed) {
        console.log(`source-trust: channel order for "${cat}" changed to ${adjusted.reason}`);
      }
      return adjusted.order;
    }
  } catch {
    /* source-trust unavailable: keep the registry order */
  }
  return sorted;
}

// ---- per-read chain: search, then page read, then browser ------------------

export type FallbackRead = { via: "search" | "page" | "browser"; text: string; url: string; untrusted: true };

/** The per-read order CHANNELS_CONTRACT.md documents: search first, then the
 * page itself, then the operator browser ONLY when search and page read both
 * returned a blocked result (403 / 429 / captcha / empty body) - never on
 * normal content. */
export async function readWithFallback(
  deps: ChannelDeps,
  opts: { searchQuery?: string; url?: string },
): Promise<FallbackRead> {
  if (opts.searchQuery) {
    const r = await deps.search(opts.searchQuery);
    if (!reachBlocked(r)) return { via: "search", text: r.text, url: `search:${opts.searchQuery}`, untrusted: true };
  }
  if (opts.url) {
    const r = await deps.readPage(opts.url);
    if (!reachBlocked(r)) return { via: "page", text: r.text, url: opts.url, untrusted: true };
  }
  if (deps.browser) {
    const b = opts.url
      ? await deps.browser.read(opts.url)
      : await deps.browser.read(opts.searchQuery ?? "");
    return { via: "browser", text: b.text, url: b.url, untrusted: true };
  }
  throw new Error("registry: search and page read are blocked and no browser fallback is configured");
}

// ---- discovery / enrichment ------------------------------------------------

export type DiscoveryRun = { id: string; ok: boolean; error?: string; leads: number };
export type DiscoveryResult = { leads: RawLead[]; runs: DiscoveryRun[]; callsUsed: number };

export const DEFAULT_CALL_BUDGET = 60;

function dedupeKey(l: RawLead): string {
  const norm = (s?: string) => String(s ?? "").trim().toLowerCase();
  const digits = (s?: string) => String(s ?? "").replace(/\D/g, "");
  return `${norm(l.name)}|${norm(l.address ?? l.city ?? "")}|${digits(l.phone)}`;
}

/** Run the enabled adapters for (category, city) one by one, stop when the
 * per-job call budget is spent, then merge and dedupe by name + area + phone. */
export async function runDiscovery(
  q: DiscoverQuery,
  deps: ChannelDeps,
  opts: { callBudget?: number } = {},
): Promise<DiscoveryResult> {
  const budget = opts.callBudget ?? DEFAULT_CALL_BUDGET;
  const adapters = await adaptersFor(q.category);
  const leads: RawLead[] = [];
  const seen = new Set<string>();
  const runs: DiscoveryRun[] = [];
  let callsUsed = 0;
  for (const a of adapters) {
    if (callsUsed >= budget) {
      runs.push({ id: a.id, ok: false, error: `call budget (${budget}) exhausted`, leads: 0 });
      continue;
    }
    const st = a.status();
    if (!st.enabled) {
      runs.push({ id: a.id, ok: false, error: st.why ? `disabled: ${st.why}` : "disabled", leads: 0 });
      continue;
    }
    callsUsed += 1;
    try {
      const found = await a.discover(q, deps);
      let added = 0;
      for (const lead of found) {
        const key = dedupeKey(lead);
        if (seen.has(key)) continue;
        seen.add(key);
        leads.push(lead);
        added += 1;
      }
      runs.push({ id: a.id, ok: true, leads: added });
    } catch (err) {
      runs.push({ id: a.id, ok: false, error: (err as Error).message, leads: 0 });
    }
  }
  return { leads, runs, callsUsed };
}

/** Enrich one lead through the first enabled adapter that produces evidence. */
export async function runEnrichment(lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> {
  const adapters = await adaptersFor(lead.category);
  let lastErr = "no enabled adapter offered enrichment";
  for (const a of adapters) {
    if (!a.status().enabled) continue;
    try {
      return await a.enrich(lead, deps);
    } catch (err) {
      lastErr = (err as Error).message;
    }
  }
  throw new Error(`registry: enrichment failed for "${lead.name.slice(0, 60)}": ${lastErr}`);
}
