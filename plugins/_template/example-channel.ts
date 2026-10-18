// Example channel for a Leadscout plugin. Copy this folder, rename things, replace the parsing.
//
// What it demonstrates (all of it offline-testable):
//   - status(): OFF by default, tells the operator why and how to turn it on
//   - discover(): ask the web search, turn "Name - address - phone" lines into RawLead[]
//   - enrich(): read one page through readWithFallback (search -> page -> browser only if blocked)
//   - treating every fetched string as untrusted text
//
// The imports below use ../../src/... because plugins sit next to src/.
import { sanitizeUntrusted } from "../../src/reach.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";

export const EXAMPLE_CHANNEL_ID = "example-directory";
const ENABLE_FLAG = "CHANNEL_EXAMPLE_DIRECTORY"; // set to 1 to turn this channel on
const MAX_TEXT = 20_000;

/** "Acme Dental - 12 High St, Springfield - +1 555 0100" -> fields. Anything unmatched stays undefined. */
export function parseListingLine(line: string): { name?: string; address?: string; phone?: string } {
  const parts = line.split(" - ").map((p) => p.trim());
  const phone = /\+?\d[\d\s().-]{6,}\d/.exec(line)?.[0];
  return { name: parts[0] || undefined, address: parts[1] || undefined, phone };
}

export const exampleDirectory: ChannelAdapter = {
  id: EXAMPLE_CHANNEL_ID,
  name: "Example directory",
  tier: "B", // B = public pages. Use C if the channel needs a browser or is ToS-sensitive.
  categories: ["any"],
  status: () =>
    process.env[ENABLE_FLAG] === "1"
      ? { enabled: true }
      : { enabled: false, why: `${ENABLE_FLAG} is not 1, so the example directory channel is off` },

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const read = await readWithFallback(deps, { searchQuery: `${q.category} ${q.city}` });
    const text = sanitizeUntrusted(read.text);
    const leads: RawLead[] = [];
    for (const line of text.split(/\r?\n/)) {
      const f = parseListingLine(line);
      if (!f.name || !f.phone) continue; // only keep rows that look like real listings
      leads.push({
        name: f.name,
        category: q.category,
        ...(f.address ? { address: f.address } : {}),
        city: q.city,
        phone: f.phone,
        source: EXAMPLE_CHANNEL_ID,
        sourceUrl: read.url,
      });
      if (leads.length >= limit) break;
    }
    return leads;
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    const read = await readWithFallback(deps, {
      searchQuery: `"${lead.name}" ${lead.city ?? ""}`.trim(),
      url: lead.sourceUrl,
    });
    const text = sanitizeUntrusted(read.text);
    return {
      channel: EXAMPLE_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields: { ...parseListingLine(text.split(/\r?\n/)[0] ?? "") },
      signals: exampleSignals(text),
      text: text.slice(0, MAX_TEXT),
      untrusted: true, // always, for anything fetched from the outside
    };
  },

  signals: (text: string): string[] => exampleSignals(text),
};

/** Stable signal ids that scoring can react to. Keep them lowercase-with-hyphens. */
function exampleSignals(text: string): string[] {
  const out: string[] = [];
  if (/book online|book now/i.test(text)) out.push("has-online-booking");
  else out.push("no-online-booking");
  return out;
}

registerChannel(exampleDirectory);
