// Offline check for the example channel. No network: search and page reads are injected fakes.
// Run: npx tsx plugins/_template/example-channel-check.ts
import assert from "node:assert/strict";
import { exampleDirectory, parseListingLine, EXAMPLE_CHANNEL_ID } from "./example-channel.js";
import type { ChannelDeps } from "../../src/channels/types.js";

const fakeText = [
  "Fixture Dental - 1 Example Road, Faketown - +1 555 0100",
  "Not a listing line",
  "Book online today",
].join("\n");

const deps: ChannelDeps = {
  search: async () => ({ ok: true, text: fakeText } as never),
  readPage: async () => ({ ok: true, text: fakeText } as never),
  limiter: { sleep: async () => {} },
  now: () => 0,
};

delete process.env.CHANNEL_EXAMPLE_DIRECTORY;
assert.equal(exampleDirectory.status().enabled, false, "off by default");
assert.ok(exampleDirectory.status().why, "says why it is off");

process.env.CHANNEL_EXAMPLE_DIRECTORY = "1";
assert.equal(exampleDirectory.status().enabled, true, "on when the flag is 1");

assert.deepEqual(parseListingLine("A - B - +1 555 0100"), { name: "A", address: "B", phone: "+1 555 0100" });

const leads = await exampleDirectory.discover({ category: "dentist", city: "Faketown" }, deps);
assert.equal(leads.length, 1);
assert.equal(leads[0]!.name, "Fixture Dental");
assert.equal(leads[0]!.source, EXAMPLE_CHANNEL_ID);

const ev = await exampleDirectory.enrich(leads[0]!, deps);
assert.equal(ev.untrusted, true, "fetched evidence is always untrusted");
assert.ok(ev.signals.includes("has-online-booking"));

console.log("PASS example-channel-check");
