// src/pricebook-roundtrip-check.ts
// REG1 regression check: the shipped price book must be valid JSON, must not contain the
// unknown field 'priceNote', and must survive a GET -> PUT -> GET round-trip on the real
// HTTP route. validatePriceBook in tenant.ts is NOT exported, so this uses the same
// in-process server pattern as server-check.ts (random port, temp database via LEADSCOUT_DB,
// never the live database in data/). Offline: no network, no model calls.
//
// Run once, foreground: npx tsx src/pricebook-roundtrip-check.ts

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(HERE, "..", "data", "default-pricebook.json");

// The item count recorded from data/default-pricebook.json BEFORE the REG1 edit.
const RECORDED_ITEM_COUNT = 17;

// Set the temp database BEFORE importing the store (it opens LEADSCOUT_DB at import time).
const ROOT = mkdtempSync(join(tmpdir(), "leadscout-reg1-"));
process.env.LEADSCOUT_DB = join(ROOT, "check.db");
delete process.env.LEADSCOUT_REQUIRE_KEYS;

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log(condition ? `PASS ${name}` : `FAIL ${name}${detail ? `: ${detail}` : ""}`);
  if (!condition) failed = true;
}

type PriceItemLike = Record<string, unknown>;
type Res = { status: number; body: unknown; text: string };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readItems(): PriceItemLike[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(DATA_FILE, "utf-8")) as unknown;
  } catch (err) {
    check("default-pricebook.json is valid JSON", false, err instanceof Error ? err.message : String(err));
    return undefined;
  }
  check("default-pricebook.json is valid JSON", true);
  if (!Array.isArray(parsed)) {
    check("default-pricebook.json is a JSON array", false, typeof parsed);
    return undefined;
  }
  check("default-pricebook.json is a JSON array", true);
  return parsed as PriceItemLike[];
}

function itemsOf(res: Res): PriceItemLike[] {
  const raw = obj(res.body).items;
  return Array.isArray(raw) ? (raw as PriceItemLike[]) : [];
}

function itemsWithUnknownField(fetchedItems: PriceItemLike[]): PriceItemLike[] {
  const bad = fetchedItems.map((item) => ({ ...item }));
  if (bad.length > 0) {
    bad[0] = { ...bad[0], unknownField: "not an allowed price book field" };
  } else {
    bad.push({
      service: "bogus",
      label: "Bogus",
      description: "",
      buildDays: null,
      price: null,
      assumption: "placeholder",
      doorOpener: false,
      unknownField: "not an allowed price book field",
    });
  }
  return bad;
}

function finish(): void {
  rmSync(ROOT, { recursive: true, force: true });
  if (failed) {
    console.log("pricebook-roundtrip-check FAILED");
    process.exit(1);
  }
  console.log("pricebook-roundtrip-check PASSED");
}

async function main(): Promise<void> {
  const items = readItems();
  if (!items) {
    finish();
    return;
  }

  check(
    `item count equals the recorded ${RECORDED_ITEM_COUNT}`,
    items.length === RECORDED_ITEM_COUNT,
    `got ${items.length}`,
  );

  const withPriceNote = items.filter((item) => Object.prototype.hasOwnProperty.call(item, "priceNote"));
  check(
    "no item has the unknown key 'priceNote'",
    withPriceNote.length === 0,
    `offending services: ${withPriceNote.map((item) => String(item.service)).join(", ")}`,
  );

  const store = await import("./store.js");
  const serverMod = await import("./server.js");

  const ws = store.createWorkspace({
    name: "Fake REG1 Workspace",
    offer: { services: ["website"], description: "Fake offer for the REG1 check only" },
    icp: { categories: ["cafe"], cities: ["Fake City"], countries: ["IN"] },
  });

  const server = serverMod.createServer();
  let port = 0;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      port = typeof address === "object" && address ? address.port : 0;
      resolve();
    });
  });

  const path = `/api/workspaces/${ws.id}/pricebook`;
  async function call(method: string, body?: unknown): Promise<Res> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: parseJson(text), text };
  }

  const firstGet = await call("GET");
  const fetchedItems = itemsOf(firstGet);
  check(
    "GET pricebook -> 200 with items",
    firstGet.status === 200 && fetchedItems.length > 0,
    `status=${firstGet.status} body=${firstGet.text.slice(0, 160)}`,
  );

  const put = await call("PUT", { items: fetchedItems });
  check("PUT the same items -> 200", put.status === 200, `status=${put.status} body=${put.text.slice(0, 160)}`);

  const secondGet = await call("GET");
  const secondItems = itemsOf(secondGet);
  check(
    "second GET returns the same items (deep equality)",
    secondGet.status === 200 && isDeepStrictEqual(secondItems, fetchedItems),
    `status=${secondGet.status}`,
  );

  const badPut = await call("PUT", { items: itemsWithUnknownField(fetchedItems) });
  check(
    "PUT an item with an unknown field is rejected (4xx/5xx)",
    badPut.status >= 400 && badPut.status <= 599,
    `status=${badPut.status} body=${badPut.text.slice(0, 160)}`,
  );

  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.closeDb();
  finish();
}

await main();
