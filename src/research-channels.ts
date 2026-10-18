// src/research-channels.ts
// L54C-research-channels: optional channel evidence for researchBusiness.
// Ranked adapters from channels/registry.ts, enabled-only, capped at
// DEFAULT_MAX_CHANNELS. Each enrich() runs in its own try/catch: a throwing
// adapter is skipped with a note, never fatal. Channel text is untrusted:
// nothing is marked verified (untrusted: true on every item).
import { adaptersFor } from "./channels/registry.js";
import type { ChannelDeps, ChannelEvidence } from "./channels/types.js";
import type { RawLead } from "./types.js";
import type { Evidence } from "./types-v2.js";
import type { ResearchEvidence } from "./research.js";

export const DEFAULT_MAX_CHANNELS = 3;

const QUOTE_MAX_CHARS = 240;

function channelKindFor(via: ChannelEvidence["via"]): Evidence["kind"] {
  if (via === "search") return "listing";
  if (via === "page") return "page-text";
  if (via === "browser") return "page-text";
  const exhaustive: never = via;
  return exhaustive;
}

export type ChannelEvidenceOptions = { maxChannels?: number };

export type ChannelEvidenceResult = {
  evidence: ResearchEvidence[];
  signals: string[];
  notes: string[];
};

function quoteOf(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, QUOTE_MAX_CHARS);
}

function capOf(options?: ChannelEvidenceOptions): number {
  const raw = options?.maxChannels ?? DEFAULT_MAX_CHANNELS;
  return Math.max(0, Math.floor(raw));
}

export async function channelEvidenceFor(
  lead: RawLead,
  channelDeps: ChannelDeps,
  options?: ChannelEvidenceOptions,
): Promise<ChannelEvidenceResult> {
  const cap = capOf(options);
  const ranked = await adaptersFor(lead.category);
  const enabled = ranked.filter((a) => {
    try {
      return a.status().enabled === true;
    } catch {
      return false;
    }
  });
  const picked = enabled.slice(0, cap);
  const evidence: ResearchEvidence[] = [];
  const seen = new Set<string>();
  const signals: string[] = [];
  const notes: string[] = [];
  let n = 0;
  for (const adapter of picked) {
    let got: Awaited<ReturnType<typeof adapter.enrich>> | undefined;
    try {
      got = await adapter.enrich(lead, channelDeps);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      notes.push(`channel ${adapter.id} skipped: ${detail}`);
      continue;
    }
    if (!got) continue;
    n += 1;
    const item = {
      id: `C${n}`,
      kind: channelKindFor(got.via),
      url: got.url,
      quote: quoteOf(got.text),
      fetchedAt: got.fetchedAt,
      channel: got.channel,
      via: got.via,
      untrusted: true as const,
    };
    evidence.push(item);
    for (const s of got.signals ?? []) {
      const key = String(s ?? "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      signals.push(key);
    }
  }
  return { evidence, signals, notes };
}
