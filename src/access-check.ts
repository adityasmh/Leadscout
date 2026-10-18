// Self-contained PASS/FAIL harness for src/access.ts
// Sets a temp LEADSCOUT_DB before dynamically importing the module under test.

import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDb = join(
  tmpdir(),
  `leadscout-access-check-${randomBytes(8).toString("hex")}.db`
);
process.env.LEADSCOUT_DB = tmpDb;

const access = await import("./access.js");
const { closeDb, getDb } = await import("./store.js");

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, run: fn });
}

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(a: T, b: T, msg?: string) {
  if (a !== b) {
    throw new Error(
      msg ? `${msg}: expected ${String(b)}, got ${String(a)}` : `expected ${String(b)}, got ${String(a)}`
    );
  }
}

function assertIncludes(haystack: string, needle: string, msg?: string) {
  if (!haystack.includes(needle)) {
    throw new Error(
      msg ? `${msg}: expected '${haystack}' to include '${needle}'` : `expected '${haystack}' to include '${needle}'`
    );
  }
}

function throws(fn: () => void, expected?: string) {
  try {
    fn();
  } catch (e) {
    if (expected && !(e instanceof Error && e.message.includes(expected))) {
      throw new Error(`expected error containing '${expected}', got ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  throw new Error(expected ? `expected throw: ${expected}` : "expected throw");
}

// ------------------------------------------------------------------ API keys

test("created key verifies", () => {
  const { id, key } = access.createApiKey("ws-a", ["read"]);
  assert(key.startsWith("ls_"), "key must start with ls_");
  const verified = access.verifyApiKey(key);
  assert(verified, "key must verify");
  assertEqual(verified.workspaceId, "ws-a");
  assertEqual(JSON.stringify(verified.scopes), JSON.stringify(["read"]));
});

test("stored row contains no clear key", () => {
  const { key } = access.createApiKey("ws-a", ["read"]);
  const rows = getDb().prepare("SELECT * FROM api_keys").all() as Array<Record<string, unknown>>;
  const dump = JSON.stringify(rows);
  assert(!dump.includes(key), "stored rows must not contain the full raw key");
});

test("wrong key fails", () => {
  access.createApiKey("ws-a", ["read"]);
  const wrong = "ls_" + randomBytes(32).toString("base64url");
  assertEqual(access.verifyApiKey(wrong), null);
});

test("revoked key fails", () => {
  const { id, key } = access.createApiKey("ws-a", ["read"]);
  assert(access.revokeApiKey("ws-a", id), "revoke must succeed");
  assertEqual(access.verifyApiKey(key), null);
});

test("workspace A cannot revoke workspace B key", () => {
  const { id } = access.createApiKey("ws-a", ["read"]);
  assertEqual(access.revokeApiKey("ws-b", id), false);
});

test("list shows prefix only", () => {
  const { key } = access.createApiKey("ws-a", ["read", "write"]);
  const list = access.listApiKeys("ws-a");
  const dump = JSON.stringify(list);
  assert(!dump.includes("hash"), "list JSON must not include hash");
  assert(!dump.includes(key), "list JSON must not include the raw key");
  const match = list.find((k) => k.prefix === key.slice(0, 8));
  assert(match, "list must contain the newly created key");
  assertEqual(JSON.stringify(match.scopes), JSON.stringify(["read", "write"]));
});

test("lastUsedAt is set after verify", () => {
  const { id, key } = access.createApiKey("ws-a", ["read"]);
  const before = access.listApiKeys("ws-a").find((k) => k.id === id)?.lastUsedAt;
  assertEqual(before, null, "lastUsedAt must be null before verify");
  const now = new Date("2026-03-04T00:00:00.000Z");
  access.verifyApiKey(key, now);
  const after = access.listApiKeys("ws-a").find((k) => k.id === id)?.lastUsedAt;
  assertEqual(after, now.toISOString(), "lastUsedAt must match verify clock");
});

// ------------------------------------------------------------------ metering

test("metering adds up within a month", () => {
  access.meter("ws-a", "discovered", 5);
  access.meter("ws-a", "discovered", 3);
  const u = access.getUsage("ws-a");
  assertEqual(u.discovered, 8);
});

test("new month starts at zero", () => {
  const jan = new Date(Date.UTC(2026, 0, 15));
  access.meter("ws-a", "discovered", 10, jan);
  const feb = new Date(Date.UTC(2026, 1, 1));
  const u = access.getUsage("ws-a", undefined, feb);
  assertEqual(u.discovered, 0);
  assertEqual(u.month, "2026-02");
});

// ------------------------------------------------------------------ limits

test("checkLimit allows under limit", () => {
  const r = access.checkLimit("ws-limit", "discovered", 10);
  assert(r.ok, "must be ok under limit");
  assertEqual(r.remaining, access.DEFAULT_LIMITS.leadsPerMonth - 10);
  assertEqual(r.message, "");
});

test("checkLimit refuses over limit with plain message", () => {
  access.setLimits("ws-limit", { leadsPerMonth: 5 });
  access.meter("ws-limit", "discovered", 3);
  const r = access.checkLimit("ws-limit", "discovered", 10);
  assert(!r.ok, "must refuse over limit");
  assert(r.remaining === 0, "remaining must be 0 when over");
  assertIncludes(r.message, "leads per month");
  assertIncludes(r.message, "used 3");
  assertIncludes(r.message, "allowed 5");
  assertIncludes(r.message, "next month");
});

test("tokens limit counts tokensIn+tokensOut together", () => {
  access.setLimits("ws-tokens", { tokensPerMonth: 1000 });
  access.meter("ws-tokens", "tokensIn", 300);
  access.meter("ws-tokens", "tokensOut", 200);
  const r = access.checkLimit("ws-tokens", "tokensIn", 400);
  assert(r.ok, "400 more tokens fit within 1000 after 500 used");
  assertEqual(r.remaining, 100);
  const r2 = access.checkLimit("ws-tokens", "tokensOut", 501);
  assert(!r2.ok, "501 more output tokens should exceed 1000 after 500 used");
});

// ------------------------------------------------------------------ share tokens

test("share token resolves", () => {
  const token = access.createShareToken("ws-a", { leadIds: ["l1"] });
  const resolved = access.resolveShareToken(token);
  assert(resolved, "token must resolve");
  assertEqual(resolved.workspaceId, "ws-a");
  assertEqual(JSON.stringify(resolved.scope), JSON.stringify({ leadIds: ["l1"] }));
});

test("share token expires after its days", () => {
  const now = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
  const token = access.createShareToken("ws-a", { x: 1 }, 30, now);
  const before = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000);
  assert(access.resolveShareToken(token, before), "token valid before expiry");
  const after = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  assertEqual(access.resolveShareToken(token, after), null);
});

test("unknown share token null", () => {
  const fake = randomBytes(24).toString("base64url");
  assertEqual(access.resolveShareToken(fake), null);
});

// ------------------------------------------------------------------ parseBearer

test("parseBearer handles missing and malformed headers", () => {
  assertEqual(access.parseBearer(undefined as unknown as string), null);
  assertEqual(access.parseBearer(""), null);
  assertEqual(access.parseBearer("Bearer"), null);
  assertEqual(access.parseBearer("Bearer   "), null);
  assertEqual(access.parseBearer("Basic abc"), null);
  assertEqual(access.parseBearer("Bearer token extra"), null);
  assertEqual(access.parseBearer("bearer lowercase"), "lowercase");
  assertEqual(access.parseBearer("  Bearer  spaced  "), "spaced");
  assertEqual(access.parseBearer("Bearer ls_realkey"), "ls_realkey");
});

// ------------------------------------------------------------------ edge cases

test("invalid scopes", () => {
  throws(() => access.createApiKey("ws-a", []), "empty");
  throws(() => access.createApiKey("ws-a", ["admin"]), "invalid scope");
  throws(() => access.createApiKey("ws-a", "read" as unknown as string[]), "array");
  const { key } = access.createApiKey("ws-a", ["write", "write", "read"]);
  const v = access.verifyApiKey(key);
  assert(v);
  assertEqual(JSON.stringify(v.scopes), JSON.stringify(["write", "read"]));
});

test("revoke unknown id", () => {
  assertEqual(access.revokeApiKey("ws-a", "not-a-real-id"), false);
});

test("verifyApiKey junk inputs", () => {
  assertEqual(access.verifyApiKey(null), null);
  assertEqual(access.verifyApiKey(""), null);
  assertEqual(access.verifyApiKey("ls_"), null);
  assertEqual(access.verifyApiKey(123 as unknown as string), null);
});

test("month boundary", () => {
  const lastMs = new Date(Date.UTC(2026, 0, 31, 23, 59, 59, 999));
  const firstMs = new Date(Date.UTC(2026, 1, 1, 0, 0, 0, 0));
  access.meter("ws-b", "discovered", 1, lastMs);
  const uJan = access.getUsage("ws-b", undefined, lastMs);
  assertEqual(uJan.month, "2026-01");
  assertEqual(uJan.discovered, 1);
  const uFeb = access.getUsage("ws-b", undefined, firstMs);
  assertEqual(uFeb.month, "2026-02");
  assertEqual(uFeb.discovered, 0);
});

test("boundary limit used+n===limit", () => {
  access.setLimits("ws-b", { exportsPerMonth: 5 });
  access.meter("ws-b", "exports", 3);
  const r = access.checkLimit("ws-b", "exports", 2);
  assert(r.ok, "exactly at limit must be ok");
  assertEqual(r.remaining, 0, "remaining at exact limit must be 0");
});

test("setLimits rejects", () => {
  throws(() => access.setLimits("ws-a", { leadsPerMonth: -1 }), "non-negative");
  throws(() => access.setLimits("ws-a", { leadsPerMonth: 1.5 }), "integer");
  throws(() => access.setLimits("ws-a", { leadsPerMonth: NaN }), "integer");
  throws(() => access.setLimits("ws-a", { leadsPerMonth: "100" as unknown as number }), "integer");
  throws(() => access.setLimits("ws-a", { unknownKey: 5 } as unknown as Record<string, number>), "unknown");
});

test("malformed share token", () => {
  assertEqual(access.resolveShareToken(""), null);
  assertEqual(access.resolveShareToken("short"), null);
  assertEqual(access.resolveShareToken("notbase64!!!notbase64!!!notbase64"), null);
  assertEqual(access.resolveShareToken(null), null);
});

test("createShareToken rejects invalid days", () => {
  throws(() => access.createShareToken("ws-a", { x: 1 }, -1), "non-negative");
  throws(() => access.createShareToken("ws-a", { x: 1 }, 1.5), "integer");
});

// ------------------------------------------------------------------ run

let failed = 0;
for (const t of tests) {
  try {
    await t.run();
    console.log(`PASS: ${t.name}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`FAIL: ${t.name}: ${msg}`);
  }
}

closeDb();
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const path = tmpDb + suffix;
  if (existsSync(path)) {
    try {
      rmSync(path);
    } catch {
      // ignore cleanup errors
    }
  }
}

process.exit(failed > 0 ? 1 : 0);
