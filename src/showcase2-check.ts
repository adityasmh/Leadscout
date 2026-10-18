// src/showcase2-check.ts
// Order DEMO4-showcase-design: offline proof for the polished showcase page.
// Pure string/structure checks over public/showcase2.html. No imports from
// src/company/, no database, no server, no network. Node 24 built-ins only.
//
// Run once (foreground): npx tsx src/showcase2-check.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? ": " + detail : ""));
  if (!condition) failed = true;
}

const pagePath = fileURLToPath(new URL("../public/showcase2.html", import.meta.url));

let html = "";
let exists = true;
try {
  html = readFileSync(pagePath, "utf8");
} catch {
  exists = false;
}

check("showcase2.html exists", exists, pagePath);

if (!exists) {
  console.log("RESULT: FAIL");
  process.exitCode = 1;
} else {
  const steps = ["Find", "Understand", "Score", "Brief", "Call", "Learn"];
  const missingSteps = steps.filter((s) => html.indexOf(s) === -1);
  check("the six step names are present", missingSteps.length === 0, missingSteps.join(", "));

  const labels = [
    "Property walkthrough film",
    "Social reels",
    "Brand film",
    "Wedding and event film",
    "Product shoot",
  ];
  const missingLabels = labels.filter((s) => html.indexOf(s) === -1);
  check("the five service labels are present", missingLabels.length === 0, missingLabels.join(", "));

  check("contains prefers-color-scheme", html.indexOf("prefers-color-scheme") !== -1);
  check("contains @media print", html.indexOf("@media print") !== -1);
  check("contains tel:", html.indexOf("tel:") !== -1);
  check("contains dossier.html?ws=", html.indexOf("dossier.html?ws=") !== -1);

  check(
    "does not contain the literal 'No evidenced gap recorded' output string",
    html.indexOf("No evidenced gap recorded") === -1
  );

  const badUrl = /(?:src|href)\s*=\s*["']\s*https?:\/\//i.exec(html);
  check("no http:// or https:// in any src or href", badUrl === null, badUrl ? badUrl[0] : "");

  const hasInnerHtml = html.indexOf("innerHTML") !== -1;
  const hasEscapeHelper = /function\s+esc\s*\(/.test(html) || /function\s+escapeHtml\s*\(/.test(html);
  check(
    "no innerHTML without an escape helper in the same file",
    !hasInnerHtml || hasEscapeHelper,
    hasInnerHtml ? (hasEscapeHelper ? "innerHTML guarded by esc()" : "innerHTML present, no esc()") : "no innerHTML used"
  );

  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  process.exitCode = failed ? 1 : 0;
}
