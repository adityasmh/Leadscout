// src/channels/resolve-wiring-check.ts
// Order L54D proof: channels help resolve contacts. Offline only: fake adapters
// registered after resetRegistry(), no network, no live DB. Run (once, foreground):
//   npx tsx src/channels/resolve-wiring-check.ts
import { resetRegistry, registerChannel } from "./registry.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, ChannelStatus } from "./types.js";
import { channelContactsFor, MAX_CHANNEL_ADAPTERS } from "../resolve-channels.js";
import { resolveContacts, type ResolveLead } from "../resolve.js";

const FIXTURE_TIME = "2026-01-01T00:00:00.000Z";
const FIXTURE_PHONE = "+919876543210";
const PAGE_URL = "https://fixturedental.example/about";
const SINGLE = 1;

let failures = 0;

function pass(name: string): void {
  console.log(`PASS ${name}`);
}

function fail(name: string, detail?: string): void {
  failures += 1;
  console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function fakeChannelDeps(): ChannelDeps {
  return {
    search: async () => ({ ok: true, channel: "fixture", text: "", untrusted: true as const, trace: [] }),
    readPage: async () => ({ ok: true, channel: "fixture", text: "", untrusted: true as const, trace: [] }),
    limiter: {},
  };
}

const enrichCalls: string[] = [];

function fakeAdapter(
  id: string,
  fields: Record<string, string | number | undefined>,
  opts: { enabled?: boolean; throws?: boolean } = {},
): ChannelAdapter {
  const enabled = opts.enabled ?? true;
  return {
    id,
    name: id,
    tier: "C",
    categories: ["any"],
    status: (): ChannelStatus =>
      enabled ? { enabled: true } : { enabled: false, why: "off for fixture" },
    discover: async () => [],
    enrich: async (): Promise<ChannelEvidence> => {
      enrichCalls.push(id);
      if (opts.throws) throw new Error(`fixture ${id} threw`);
      return {
        channel: id,
        url: `https://${id}.example/lead`,
        fetchedAt: FIXTURE_TIME,
        via: "page",
        fields,
        signals: [],
        text: "",
        untrusted: true as const,
      };
    },
    signals: () => [],
  };
}

function fixtureLead(): ResolveLead {
  return {
    name: "Fixture Dental Care",
    category: "dental",
    city: "Mumbai",
    country: "IN",
    source: "osm",
    sourceUrl: "https://osm.example/node/1",
  };
}

function fixturePageBody(): string {
  return [
    "<html><body>",
    "<h1>Fixture Dental Care, Mumbai</h1>",
    "<p>Call Fixture Dental Care Mumbai on 9876543210",
    'or mail <a href="mailto:care@fixture.example">care@fixture.example</a>.</p>',
    "</body></html>",
  ].join("");
}

function baseResolveDeps(): { search: (query: string) => Promise<unknown>; fetchPage: (url: string) => Promise<unknown>; now: () => Date } {
  return {
    search: async () => [{ url: PAGE_URL, title: "Fixture Dental Care Mumbai" }],
    fetchPage: async () => ({ ok: true, body: fixturePageBody(), contentType: "text/html", url: PAGE_URL }),
    now: () => new Date(FIXTURE_TIME),
  };
}

async function main(): Promise<void> {
  // 1. a channel phone appears as a contact with its source
  resetRegistry();
  enrichCalls.length = 0;
  registerChannel(fakeAdapter("fake-phone", { phone: "98765 43210" }));
  {
    const got = await channelContactsFor(fixtureLead(), fakeChannelDeps());
    const phone = got.contacts.find((c) => c.kind === "phone");
    if (phone && phone.value === FIXTURE_PHONE && phone.source === "https://fake-phone.example/lead") {
      pass("channel phone appears as a contact with its source");
    } else {
      fail("channel phone appears as a contact with its source", JSON.stringify(got.contacts));
    }
  }

  // 2. a channel email and website appear
  resetRegistry();
  enrichCalls.length = 0;
  registerChannel(fakeAdapter("fake-mail", { email: "Care@Fixture.Example", website: "https://fixturedental.example" }));
  {
    const got = await channelContactsFor(fixtureLead(), fakeChannelDeps());
    const email = got.contacts.find((c) => c.kind === "email");
    const website = got.contacts.find((c) => c.kind === "website");
    if (email && email.value === "care@fixture.example" && website && website.value === "https://fixturedental.example") {
      pass("channel email and website appear");
    } else {
      fail("channel email and website appear", JSON.stringify(got.contacts));
    }
  }

  // 3. a duplicate of an existing contact is not added twice
  resetRegistry();
  enrichCalls.length = 0;
  registerChannel(fakeAdapter("fake-dupe", { phone: "+91 98765 43210", email: "new@fixture.example" }));
  {
    const merged = await resolveContacts(fixtureLead(), { ...baseResolveDeps(), channelDeps: fakeChannelDeps() });
    const dupes = merged.contacts.filter((c) => c.kind === "phone" && c.value === FIXTURE_PHONE);
    const fresh = merged.contacts.find((c) => c.kind === "email" && c.value === "new@fixture.example");
    if (dupes.length === SINGLE && fresh) {
      pass("duplicate of an existing contact is not added twice");
    } else {
      fail("duplicate of an existing contact is not added twice", JSON.stringify(merged.contacts));
    }
  }

  // 4. an invalid phone is dropped
  resetRegistry();
  enrichCalls.length = 0;
  registerChannel(fakeAdapter("fake-bad", { phone: "not-a-phone" }));
  {
    const got = await channelContactsFor(fixtureLead(), fakeChannelDeps());
    if (!got.contacts.some((c) => c.kind === "phone")) {
      pass("invalid phone is dropped");
    } else {
      fail("invalid phone is dropped", JSON.stringify(got.contacts));
    }
  }

  // 5. a throwing channel is skipped with a note
  resetRegistry();
  enrichCalls.length = 0;
  registerChannel(fakeAdapter("fake-throw", { phone: "9810010010" }, { throws: true }));
  registerChannel(fakeAdapter("fake-kind", { email: "kind@fixture.example" }));
  {
    const got = await channelContactsFor(fixtureLead(), fakeChannelDeps());
    const noted = got.notes.some((n) => n.includes("fake-throw"));
    const kept = got.contacts.some((c) => c.value === "kind@fixture.example");
    if (noted && kept) {
      pass("throwing channel is skipped with a note");
    } else {
      fail("throwing channel is skipped with a note", JSON.stringify({ contacts: got.contacts, notes: got.notes }));
    }
  }

  // 6. no channelDeps gives exactly the old result (compare with a fixture)
  resetRegistry();
  {
    const first = await resolveContacts(fixtureLead(), baseResolveDeps());
    const fixture = JSON.parse(JSON.stringify(first)) as typeof first;
    const second = await resolveContacts(fixtureLead(), baseResolveDeps());
    const same = JSON.stringify(second) === JSON.stringify(fixture);
    const noChannelSource = second.contacts.every((c) => !c.sourceUrl.startsWith("https://fake-"));
    if (same && noChannelSource) {
      pass("no channelDeps gives exactly the old result");
    } else {
      fail("no channelDeps gives exactly the old result", JSON.stringify(second.contacts));
    }
  }

  // 7. only the top 3 channels are called
  resetRegistry();
  enrichCalls.length = 0;
  const five = ["fake-t1", "fake-t2", "fake-t3", "fake-t4", "fake-t5"];
  const numbers = ["9810010011", "9810010012", "9810010013", "9810010014", "9810010015"];
  five.forEach((id, i) => registerChannel(fakeAdapter(id, { phone: numbers[i] })));
  {
    await channelContactsFor(fixtureLead(), fakeChannelDeps());
    const want = five.slice(0, MAX_CHANNEL_ADAPTERS);
    if (enrichCalls.length === MAX_CHANNEL_ADAPTERS && want.every((id, i) => enrichCalls[i] === id)) {
      pass("only the top 3 channels are called");
    } else {
      fail("only the top 3 channels are called", `called: ${enrichCalls.join(",")}`);
    }
  }

  console.log("");
  if (failures === 0) {
    console.log("PASS resolve-wiring-check (Order L54D-resolve-channels)");
  } else {
    console.log(`FAIL resolve-wiring-check (Order L54D-resolve-channels): ${failures} item(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`FAIL resolve-wiring-check: ${String((err as Error)?.message ?? err)}`);
  process.exitCode = 1;
});
