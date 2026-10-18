// src/ui-polish-check.ts
// Order UX1-ui-polish: offline proof for packs.html ws preselect,
// brief.html friendly names and repeated place-word dedupe.
// Text checks plus extraction of the two helpers with a regex and new Function.
// Run once, foreground:
//   npx tsx src/ui-polish-check.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? ": " + detail : ""));
  if (!condition) failed = true;
}

const packsPath = fileURLToPath(new URL("../public/packs.html", import.meta.url));
const briefPath = fileURLToPath(new URL("../public/brief.html", import.meta.url));

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const packs = readText(packsPath);
const brief = readText(briefPath);

check("packs.html exists", packs.length > 0, packsPath);
check("brief.html exists", brief.length > 0, briefPath);

check(
  "packs.html reads the ws URL parameter",
  packs.indexOf("URLSearchParams") !== -1 &&
    (packs.indexOf('get("ws")') !== -1 || packs.indexOf("get('ws')") !== -1)
);

function selectsRequestedWs(text: string): boolean {
  const hasFallbackFirst = text.indexOf("list[0].id") !== -1;
  const assignsValue = text.indexOf("ws.value") !== -1 || text.indexOf(".value =") !== -1;
  const mentionsWanted =
    text.indexOf("wanted") !== -1 ||
    text.indexOf("requested") !== -1 ||
    text.indexOf('get("ws")') !== -1 ||
    text.indexOf("get('ws')") !== -1;
  return hasFallbackFirst && assignsValue && mentionsWanted;
}
check("packs.html selects the requested ws with first-workspace fallback", selectsRequestedWs(packs));

function extractFunction(text: string, name: string): { param: string; body: string } | null {
  const re = new RegExp("function\\s+" + name + "\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*\\{");
  const m = re.exec(text);
  if (!m || m.index === undefined) return null;
  const param = String(m[1]);
  let depth = 0;
  let start = -1;
  for (let i = m.index; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      if (start === -1) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        return { param, body: text.slice(start + 1, i) };
      }
    }
  }
  return null;
}

const friendlySrc = extractFunction(brief, "friendlyName");
check("brief.html defines ONE plain function friendlyName(id)", friendlySrc !== null);

let friendlyFn: ((id: string) => string) | null = null;
if (friendlySrc !== null) {
  try {
    const ctor = Function as unknown as new (...args: string[]) => (id: string) => string;
    friendlyFn = new ctor(friendlySrc.param, friendlySrc.body);
  } catch {
    friendlyFn = null;
  }
}
check("friendlyName extracts and evaluates", friendlyFn !== null);

if (friendlyFn !== null) {
  const cases: Array<[string, string]> = [
    ["real-estate-developer", "Real estate developer"],
    ["Property-walkthrough", "Property walkthrough"],
    ["website", "Website"],
    ["seo", "Seo"],
    ["ai-chatbot-2", "Ai chatbot 2"],
    ["crm-setup-360", "Crm setup 360"],
  ];
  for (const [input, expected] of cases) {
    let got = "";
    try {
      got = String(friendlyFn(input));
    } catch {
      got = "";
    }
    check("friendlyName(" + JSON.stringify(input) + ") === " + JSON.stringify(expected), got === expected, "got=" + JSON.stringify(got));
  }
} else {
  failed = true;
}

const addressSrc = extractFunction(brief, "dedupeAddress");
check("brief.html defines ONE plain function dedupeAddress(text)", addressSrc !== null);

let addressFn: ((text: string) => string) | null = null;
if (addressSrc !== null) {
  try {
    const ctor = Function as unknown as new (...args: string[]) => (text: string) => string;
    addressFn = new ctor(addressSrc.param, addressSrc.body);
  } catch {
    addressFn = null;
  }
}
check("dedupeAddress extracts and evaluates", addressFn !== null);

if (addressFn !== null) {
  const cases: Array<[string, string]> = [
    ["Mumbai, Mumbai, India", "Mumbai, India"],
    ["Andheri, Mumbai, India", "Andheri, Mumbai, India"],
    ["Pune, pune", "Pune"],
    ["", ""],
  ];
  for (const [input, expected] of cases) {
    let got = "";
    try {
      got = String(addressFn(input));
    } catch {
      got = "";
    }
    check("dedupeAddress(" + JSON.stringify(input) + ") === " + JSON.stringify(expected), got === expected, "got=" + JSON.stringify(got));
  }
} else {
  failed = true;
}

function countUses(text: string, name: string): number {
  let n = 0;
  let idx = 0;
  const needle = name + "(";
  while (true) {
    const at = text.indexOf(needle, idx);
    if (at === -1) break;
    n++;
    idx = at + needle.length;
  }
  return n;
}
check("brief.html uses friendlyName everywhere a category/service id is shown (>=4 uses)", countUses(brief, "friendlyName") >= 5, "uses=" + String(countUses(brief, "friendlyName")));
check("brief.html uses dedupeAddress everywhere an address/area is shown (>=3 uses)", countUses(brief, "dedupeAddress") >= 4, "uses=" + String(countUses(brief, "dedupeAddress")));

function innerHtmlEscaped(text: string): { ok: boolean; detail: string } {
  const lines = text.split("\n");
  const hasHelper = /function\s+esc\s*\(/.test(text) || /function\s+escapeHtml\s*\(/.test(text);
  if (!hasHelper) return { ok: false, detail: "no escape helper" };
  for (const line of lines) {
    if (line.indexOf("innerHTML") === -1) continue;
    if (line.indexOf("esc(") !== -1 || line.indexOf("escapeHtml(") !== -1) continue;
    const assign = /=/.exec(line);
    if (assign === null) continue;
    const rhs = line.slice(line.indexOf("=") + 1);
    const hasVar = /\+/.test(rhs) || /\$\{/.test(rhs);
    if (hasVar) return { ok: false, detail: line.trim().slice(0, 120) };
  }
  return { ok: true, detail: "" };
}
const packsEsc = innerHtmlEscaped(packs);
check("packs.html: no innerHTML assignment contains an un-escaped variable", packsEsc.ok, packsEsc.detail);
const briefEsc = brief.indexOf("innerHTML") === -1 ? { ok: true, detail: "" } : innerHtmlEscaped(brief);
check("brief.html: no innerHTML assignment contains an un-escaped variable", briefEsc.ok, briefEsc.detail);

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
