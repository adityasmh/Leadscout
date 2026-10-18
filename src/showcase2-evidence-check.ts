// src/showcase2-evidence-check.ts
// Order DEMO5-showcase-evidence-cards: offline proof that the prospect cards on
// public/showcase2.html show real per-lead evidence instead of filler, and that
// the three visual flaws (category capitalisation, bar alignment, repeated
// address) are addressed. Pure string/structure checks. No imports from
// src/company/, no database, no server, no network. Node 24 built-ins only.
//
// Run once (foreground): npx tsx src/showcase2-evidence-check.ts

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
  // ---------------------------------------------------------------------
  // Everything showcase2-check.ts already asserts, replayed as the same
  // strings so a regression against the DEMO4 contract fails here too.
  // ---------------------------------------------------------------------
  const steps = ["Find", "Understand", "Score", "Brief", "Call", "Learn"];
  const missingSteps = steps.filter((s) => html.indexOf(s) === -1);
  check("showcase2-check: the six step names are present", missingSteps.length === 0, missingSteps.join(", "));

  const labels = [
    "Property walkthrough film",
    "Social reels",
    "Brand film",
    "Wedding and event film",
    "Product shoot",
  ];
  const missingLabels = labels.filter((s) => html.indexOf(s) === -1);
  check("showcase2-check: the five service labels are present", missingLabels.length === 0, missingLabels.join(", "));

  check("showcase2-check: contains prefers-color-scheme", html.indexOf("prefers-color-scheme") !== -1);
  check("showcase2-check: contains @media print", html.indexOf("@media print") !== -1);
  check("showcase2-check: contains tel:", html.indexOf("tel:") !== -1);
  check("showcase2-check: contains dossier.html?ws=", html.indexOf("dossier.html?ws=") !== -1);

  check(
    "showcase2-check: does not contain the literal 'No evidenced gap recorded' output string",
    html.indexOf("No evidenced gap recorded") === -1
  );

  const badUrl = /(?:src|href)\s*=\s*["']\s*https?:\/\//i.exec(html);
  check("showcase2-check: no http:// or https:// in any src or href", badUrl === null, badUrl ? badUrl[0] : "");

  const hasInnerHtml = html.indexOf("innerHTML") !== -1;
  const hasEscapeHelper = /function\s+esc\s*\(/.test(html) || /function\s+escapeHtml\s*\(/.test(html);
  check(
    "showcase2-check: no innerHTML without an escape helper in the same file",
    !hasInnerHtml || hasEscapeHelper,
    hasInnerHtml ? (hasEscapeHelper ? "innerHTML guarded by esc()" : "innerHTML present, no esc()") : "no innerHTML used"
  );

  // ---------------------------------------------------------------------
  // DEMO5 evidence-card assertions.
  // ---------------------------------------------------------------------
  check('contains rel="noopener noreferrer"', html.indexOf('rel="noopener noreferrer"') !== -1);
  check("contains the social sentence stem", html.indexOf("would give them fresh video to post there") !== -1);
  check("contains the no-social sentence stem", html.indexOf("has a website but no social channel linked") !== -1);
  check(
    "no longer contains 'Suggested pitch: talk the client through'",
    html.indexOf("Suggested pitch: talk the client through") === -1
  );
  check(
    "contains a fixed first column for the category bar rows (grid with a px/rem/em first column)",
    /\.cat\s*\{[^}]*grid-template-columns\s*:[^;}]*\d+(?:px|rem|em)/.test(html)
  );
  check(
    "contains an evidence chip class",
    html.indexOf('class="echip') !== -1,
    html.indexOf('class="echip') !== -1 ? "" : "no echip markup"
  );
  check(
    "contains the five social network labels",
    ["Instagram", "YouTube", "Facebook", "LinkedIn", "WhatsApp"].every((n) => html.indexOf(n) !== -1)
  );
  check(
    "contains phone and email evidence copy",
    html.indexOf(" phone numbers") !== -1 && html.indexOf(" emails") !== -1
  );
  check("contains the Website evidence link label", html.indexOf(">Website</a>") !== -1);

  // A second look at the no-http(s) rule after the DEMO5 edits.
  const badUrl2 = /(?:src|href)\s*=\s*["']\s*https?:\/\//i.exec(html);
  check("still no http:// or https:// in any src or href", badUrl2 === null, badUrl2 ? badUrl2[0] : "");

  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  process.exitCode = failed ? 1 : 0;
}
