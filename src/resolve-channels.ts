// src/resolve-channels.ts
// Order L54D: let enabled channel adapters contribute contacts to contact resolution.
// Gathers literal phone/email/website string fields from each adapter's ChannelEvidence
// (never invents or combines values) for optional merging in resolveContacts.
// Node 24 built-ins only, ESM, .js import suffixes.
import { adaptersFor } from "./channels/registry.js";
import type { ChannelDeps, ChannelEvidence } from "./channels/types.js";
import { canonicalPhone } from "./resolve.js";
import type { RawLead } from "./types.js";

export const MAX_CHANNEL_ADAPTERS = 3;

export type ChannelContactKind = "phone" | "email" | "website";
export type ChannelContact = {
  kind: ChannelContactKind;
  value: string;
  source: string;
  via: ChannelEvidence["via"];
};
export type ChannelContactsResult = { contacts: ChannelContact[]; notes: string[] };
export type ChannelContactsOptions = { now?: () => Date };

const CHANNEL_FIELD_KINDS: ChannelContactKind[] = ["phone", "email", "website"];

function evidenceSource(evidence: ChannelEvidence, adapterId: string): string {
  const url = String(evidence?.url ?? "").trim();
  return url !== "" ? url : `channel:${adapterId}`;
}

function pushField(
  out: ChannelContact[],
  notes: string[],
  adapterId: string,
  evidence: ChannelEvidence,
  kind: ChannelContactKind,
  raw: unknown,
): void {
  if (typeof raw !== "string") return;
  const trimmed = raw.trim();
  if (trimmed === "") return;
  if (kind === "phone") {
    const canon = canonicalPhone(trimmed);
    if (!canon) {
      notes.push(`channel ${adapterId} phone dropped: rejected by canonicalPhone`);
      return;
    }
    out.push({ kind, value: canon, source: evidenceSource(evidence, adapterId), via: evidence.via });
    return;
  }
  if (kind === "email") {
    out.push({ kind, value: trimmed.toLowerCase(), source: evidenceSource(evidence, adapterId), via: evidence.via });
    return;
  }
  out.push({ kind, value: trimmed, source: evidenceSource(evidence, adapterId), via: evidence.via });
}

/**
 * Ask the enabled channel adapters for `lead.category` (at most MAX_CHANNEL_ADAPTERS)
 * for contact evidence. Each `enrich` runs in its own try/catch; a throwing adapter is
 * skipped with a note. Only fields literally named phone/email/website holding strings
 * are returned; phones pass through canonicalPhone (dropped when rejected).
 */
export async function channelContactsFor(
  lead: RawLead,
  channelDeps: ChannelDeps,
  options?: ChannelContactsOptions,
): Promise<ChannelContactsResult> {
  void options;
  const contacts: ChannelContact[] = [];
  const notes: string[] = [];
  let adapters;
  try {
    adapters = await adaptersFor(lead.category);
  } catch (err) {
    notes.push(`channel adapters unavailable: ${String((err as Error)?.message ?? err)}`);
    return { contacts, notes };
  }
  const enabled: typeof adapters = [];
  for (const adapter of adapters) {
    let on = false;
    try {
      on = adapter.status().enabled;
    } catch (err) {
      notes.push(`channel ${adapter.id} skipped: status failed (${String((err as Error)?.message ?? err)})`);
      continue;
    }
    if (on) enabled.push(adapter);
  }
  for (const adapter of enabled.slice(0, MAX_CHANNEL_ADAPTERS)) {
    let evidence: ChannelEvidence;
    try {
      evidence = await adapter.enrich(lead, channelDeps);
    } catch (err) {
      notes.push(`channel ${adapter.id} skipped: enrich threw (${String((err as Error)?.message ?? err)})`);
      continue;
    }
    if (!evidence || typeof evidence !== "object" || !evidence.fields || typeof evidence.fields !== "object") {
      notes.push(`channel ${adapter.id} skipped: no evidence fields`);
      continue;
    }
    for (const kind of CHANNEL_FIELD_KINDS) {
      pushField(contacts, notes, adapter.id, evidence, kind, evidence.fields[kind]);
    }
  }
  return { contacts, notes };
}
