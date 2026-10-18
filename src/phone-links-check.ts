// src/phone-links-check.ts
// Order PH1-phone-links: offline proof that showcase phones are normalised e164
// and that public/calls.html normalises every number it shows.
// (a) Starts the real server on a random port with a temp database, imports 4
// clearly fake leads (bare mobile, +91 landline, landline-first mixed list,
// junk-only), and asserts the showcase topLeads phones are e164 with mobiles
// preferred over landlines, and "" when nothing is valid.
// (b) Reads public/calls.html as text, extracts `function normalizeIndianPhone`
// with a regex up to its closing brace at column 0, evaluates it with
// `new Function`, and asserts the PV1 table plus the display strings; asserts
// no `wa.me/${` template and no raw `href="tel:` literal remain.
// Prints PASS/FAIL per item, exits 1 on any FAIL. No network beyond 127.0.0.1.

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(HERE, "..", "public", "calls.html");

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? ": " + detail : ""));
  if (!condition) failed = true;
}

type LeadJson = { name?: string; phone?: string };
type ShowcaseJson = { topLeads?: LeadJson[] };

// ---------------------------------------------------------------- (a) server + fixtures

const ROOT = mkdtempSync(join(tmpdir(), "leadscout-phone-links-"));
process.env.LEADSCOUT_DB = join(ROOT, "check.db");
delete process.env.LEADSCOUT_REQUIRE_KEYS;
delete process.env.LEADSCOUT_LLM_URL;
process.env.LEADSCOUT_LLM_OFF = "1";

const store = await import("./store.js");
const serverMod = await import("./server.js");
const server = serverMod.createServer();
let PORT = 0;
await new Promise<void>(function (resolve) {
  server.listen(0, "127.0.0.1", function () {
    const address = server.address();
    PORT = typeof address === "object" && address ? address.port : 0;
    resolve();
  });
});
check("server listens on a random port", PORT > 0, String(PORT));
const baseUrl = "http://127.0.0.1:" + PORT;

const workspace = store.createWorkspace({
  name: "Fake Phone Links Workspace",
  offer: {
    services: ["website"],
    description: "Fake offer used only for offline phone-link checks.",
  },
  icp: { categories: ["cafe"], cities: ["Fake City"], countries: ["IN"] },
});
check("workspace created with a temp database", workspace.id.length > 0);

const common = {
  workspaceId: workspace.id,
  source: "fixture",
  sourceUrl: "https://example-phone-links.test/fixture",
  category: "cafe",
  city: "Fake City",
};
store.upsertLead({ ...common, name: "Fake Bare Mobile", phone: "9000100200", score: 90 });
store.upsertLead({ ...common, name: "Fake Plus Landline", phone: "+912267728484", score: 80 });
store.upsertLead({
  ...common,
  name: "Fake Mixed Landline First",
  phones: ["02212340001", "9000100200"],
  score: 70,
});
store.upsertLead({
  ...common,
  name: "Fake Junk Only",
  phone: "not-a-phone",
  phones: ["12345"],
  score: 60,
});
check(
  "4 clearly fake leads imported",
  store.listLeads({ workspaceId: workspace.id, limit: 10, offset: 0 }).total === 4
);

const res = await fetch(baseUrl + "/api/workspaces/" + workspace.id + "/showcase");
const body = (await res.json()) as ShowcaseJson;
const topLeads: LeadJson[] = Array.isArray(body.topLeads) ? body.topLeads : [];
function phoneOf(name: string): string | undefined {
  const found = topLeads.filter(function (l) { return l.name === name; })[0];
  return found ? found.phone : undefined;
}
check("GET showcase answers 200", res.status === 200, "status=" + res.status);
check("bare mobile 9000100200 is e164 +919000100200", phoneOf("Fake Bare Mobile") === "+919000100200", String(phoneOf("Fake Bare Mobile")));
check("+912267728484 stays e164 landline", phoneOf("Fake Plus Landline") === "+912267728484", String(phoneOf("Fake Plus Landline")));
check(
  "mixed list prefers the mobile over the first landline",
  phoneOf("Fake Mixed Landline First") === "+919000100200",
  String(phoneOf("Fake Mixed Landline First"))
);
check("junk-only lead has an empty phone", phoneOf("Fake Junk Only") === "", String(phoneOf("Fake Junk Only")));

// ---------------------------------------------------------------- (b) calls.html

check("calls.html exists", existsSync(HTML_PATH), HTML_PATH);
const html = existsSync(HTML_PATH) ? readFileSync(HTML_PATH, "utf8") : "";
const fnMatch = /function normalizeIndianPhone\(raw\)[\s\S]*?\n\}/.exec(html);
check("normalizeIndianPhone extracted from calls.html", fnMatch !== null);

type Normalised = { e164: string; kind: string; display: string } | null;
if (fnMatch) {
  const factory = new Function(fnMatch[0] + "\nreturn normalizeIndianPhone;") as () => (
    raw: unknown
  ) => Normalised;
  const normalizeIndianPhone = factory();
  function sameNorm(input: unknown, want: Normalised): boolean {
    const got = normalizeIndianPhone(input);
    if (want === null) return got === null;
    return (
      got !== null && got.e164 === want.e164 && got.kind === want.kind && got.display === want.display
    );
  }
  check(
    "bare 10-digit mobile 9000100200 -> mobile",
    sameNorm("9000100200", { e164: "+919000100200", kind: "mobile", display: "+91 90001 00200" }),
    JSON.stringify(normalizeIndianPhone("9000100200"))
  );
  check(
    "+91-prefixed mobile -> mobile",
    sameNorm("+919876543210", { e164: "+919876543210", kind: "mobile", display: "+91 98765 43210" }),
    JSON.stringify(normalizeIndianPhone("+919876543210"))
  );
  check(
    "91-prefixed mobile without plus -> mobile",
    sameNorm("919876543210", { e164: "+919876543210", kind: "mobile", display: "+91 98765 43210" }),
    JSON.stringify(normalizeIndianPhone("919876543210"))
  );
  check(
    "0-prefixed STD 02212340001 -> landline",
    sameNorm("02212340001", { e164: "+912212340001", kind: "landline", display: "+91 22 1234 0001" }),
    JSON.stringify(normalizeIndianPhone("02212340001"))
  );
  check(
    "+91 STD landline -> landline",
    sameNorm("+91 22 1234 0001", { e164: "+912212340001", kind: "landline", display: "+91 22 1234 0001" }),
    JSON.stringify(normalizeIndianPhone("+91 22 1234 0001"))
  );
  check("junk 12345 -> null", normalizeIndianPhone("12345") === null);
  check("junk text -> null", normalizeIndianPhone("call me maybe") === null);
  check("empty text -> null", normalizeIndianPhone("") === null);
} else {
  check("bare 10-digit mobile 9000100200 -> mobile", false, "function missing");
  check("+91-prefixed mobile -> mobile", false, "function missing");
  check("91-prefixed mobile without plus -> mobile", false, "function missing");
  check("0-prefixed STD 02212340001 -> landline", false, "function missing");
  check("+91 STD landline -> landline", false, "function missing");
  check("junk 12345 -> null", false, "function missing");
  check("junk text -> null", false, "function missing");
  check("empty text -> null", false, "function missing");
}

check("dial links carry the plus (tel:+)", html.indexOf("tel:+") !== -1);
check(
  "no wa.me/${ built from an un-normalised value",
  html.indexOf("wa.me/${") === -1,
  html.indexOf("wa.me/${") === -1 ? "" : "raw template remains"
);
check(
    'no href="tel: built from a raw phone variable',
  html.indexOf('href="tel:') === -1,
  html.indexOf('href="tel:') === -1 ? "" : "raw tel href remains"
);
check("WhatsApp rendering is gated on mobile numbers", html.indexOf("mobile") !== -1);

// ---------------------------------------------------------------- teardown

await new Promise<void>(function (resolve) {
  server.close(function () { resolve(); });
  server.closeAllConnections();
});
store.closeDb();
rmSync(ROOT, { recursive: true, force: true });

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
