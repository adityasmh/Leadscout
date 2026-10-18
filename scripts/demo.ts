// Offline demo: creates a workspace, imports examples/demo-leads.csv (synthetic data), processes the
// leads and prints the ranked list and today's call sheet.
// By default it starts its OWN throwaway server on a random port with a temp database, so it can never
// touch a real instance. To drive an already running server instead, set LEADSCOUT_URL explicitly.
// Run: npm run demo
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

let BASE = process.env.LEADSCOUT_URL ?? "";
let stop = () => {};
if (!BASE) {
  process.env.LEADSCOUT_DB = join(mkdtempSync(join(tmpdir(), "leadscout-demo-")), "demo.db");
  process.env.LEADSCOUT_LLM_OFF = "1";
  const { startServer } = await import("../src/server.js");
  const server = startServer(0);
  await new Promise((r) => server.once("listening", r));
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = () => server.close();
  console.log(`(demo server on ${BASE}, temp database; nothing is kept)`);
}
const csv = readFileSync(join(import.meta.dirname, "..", "examples", "demo-leads.csv"), "utf8");

async function call(method: string, path: string, body?: unknown, raw = false): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: raw ? { "content-type": "text/csv" } : { "content-type": "application/json" },
    body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

const ws = await call("POST", "/api/workspaces", {
  name: `Demo workspace ${new Date().toISOString().slice(0, 19)}`,
  offer: { services: ["website", "online-booking"], description: "We build websites and booking pages for local clinics." },
  icp: { categories: ["dentist"], cities: ["Faketown"], countries: ["Exampleland"] },
});
console.log(`workspace ${ws.id}`);

const imported = await call("POST", `/api/workspaces/${ws.id}/import-csv`, csv, true);
console.log(`imported ${imported.imported} leads`);

const job = await call("POST", `/api/workspaces/${ws.id}/process`, {});
console.log(`processing ${job.leads} leads (job ${job.jobId}) ...`);
for (let i = 0; i < 60; i++) {
  const jobs = await call("GET", `/api/workspaces/${ws.id}/jobs`);
  const j = jobs.find((x: any) => x.id === job.jobId);
  if (j && (j.status === "done" || j.status === "failed")) { console.log(`job ${j.status}`); break; }
  await new Promise((r) => setTimeout(r, 1000));
}

const leads = await call("GET", `/api/workspaces/${ws.id}/leads?sort=score&limit=10`);
console.log("\nTop leads:");
for (const l of leads.leads ?? leads) console.log(`  ${String(l.score ?? 0).padStart(3)}  ${l.name}  [${l.status}]`);

const sheet = await call("GET", `/api/workspaces/${ws.id}/callsheet?format=json`);
console.log(`\nCall sheet: ${JSON.stringify(sheet).slice(0, 300)}`);
console.log(process.env.LEADSCOUT_URL ? `\nOpen the UI: ${BASE}/   (workspace ${ws.id})` : "\nDemo done. Run `npm start` for a real, persistent instance.");
stop();
process.exit(0);
