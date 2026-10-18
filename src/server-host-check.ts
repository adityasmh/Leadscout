// Proof that the HTTP server binds to loopback by default and only widens on request.
//   default (no arg, no env)  -> 127.0.0.1
//   LEADSCOUT_HOST=0.0.0.0    -> all interfaces
//   startServer(port, host)   -> the explicit argument wins over the env var
//   blank LEADSCOUT_HOST      -> still 127.0.0.1
// Run: npx tsx src/server-host-check.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.LEADSCOUT_DB = join(mkdtempSync(join(tmpdir(), "leadscout-host-check-")), "check.db");
const { resolveHost, startServer } = await import("./server.js");

assert.equal(resolveHost(undefined, {}), "127.0.0.1", "default is loopback");
assert.equal(resolveHost(undefined, { LEADSCOUT_HOST: "  " }), "127.0.0.1", "blank env is loopback");
assert.equal(resolveHost(undefined, { LEADSCOUT_HOST: "0.0.0.0" }), "0.0.0.0", "env widens");
assert.equal(resolveHost("127.0.0.1", { LEADSCOUT_HOST: "0.0.0.0" }), "127.0.0.1", "explicit argument beats env");

async function boundAddress(server: Server): Promise<string> {
  await new Promise((r) => server.once("listening", r));
  const addr = (server.address() as AddressInfo).address;
  await new Promise((r) => server.close(r));
  return addr;
}

delete process.env.LEADSCOUT_HOST;
assert.equal(await boundAddress(startServer(0)), "127.0.0.1", "really listens on loopback by default");

process.env.LEADSCOUT_HOST = "0.0.0.0";
const wide = await boundAddress(startServer(0));
assert.ok(wide === "0.0.0.0" || wide === "::", `LEADSCOUT_HOST=0.0.0.0 listens on all addresses (got ${wide})`);
assert.equal(await boundAddress(startServer(0, "127.0.0.1")), "127.0.0.1", "explicit host wins over LEADSCOUT_HOST");

console.log("PASS server-host-check");
