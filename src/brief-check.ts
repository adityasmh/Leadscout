// src/brief-check.ts
// Order DEMO7-clean-brief-page: offline proof for the new public/brief.html.
// Pure string checks over the files as text; nothing is extracted or evaluated
// from the HTML at runtime. No imports from src/company/, no database, no
// server, no network. Node 24 built-ins only.
//
// Run once (foreground): npx tsx src/brief-check.ts

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

let failed = false;
function check(name: string, condition: boolean, detail?: string): void {
  console.log((condition ? "PASS " : "FAIL ") + name + (detail ? ": " + detail : ""));
  if (!condition) failed = true;
}

// Byte size of public/dossier.html recorded BEFORE this
// order's edit. This order must not change dossier.html, so it must not drift.
const DOSSIER_BYTES_BEFORE = 58684;

const briefPath = fileURLToPath(new URL("../public/brief.html", import.meta.url));
const showcase2Path = fileURLToPath(new URL("../public/showcase2.html", import.meta.url));
const dossierPath = fileURLToPath(new URL("../public/dossier.html", import.meta.url));

function readText(path: string): { ok: boolean; text: string } {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch {
    return { ok: false, text: "" };
  }
}

const brief = readText(briefPath);
const showcase2 = readText(showcase2Path);

check("brief.html exists", brief.ok, briefPath);
check("showcase2.html exists", showcase2.ok, showcase2Path);

if (brief.ok) {
  const exactStrings = [
    "Source captures (for audit)",
    "RateLimit",
    "captcha",
    "prefers-color-scheme",
    "@media print",
    "showcase2.html?ws=",
  ];
  for (const value of exactStrings) {
    check("brief.html contains " + JSON.stringify(value), brief.text.indexOf(value) !== -1);
  }

  // The two regexes that strip markdown link/image syntax.
  const mdLink = "\\[([^\\]]*)\\]\\([^)]*\\)";
  const mdImage = "!\\[([^\\]]*)\\]\\([^)]*\\)";
  check("brief.html contains the markdown link regex", brief.text.indexOf(mdLink) !== -1, mdLink);
  check("brief.html contains the markdown image regex", brief.text.indexOf(mdImage) !== -1, mdImage);

  const badUrl = /(?:src|href)\s*=\s*["']\s*https?:\/\//i.exec(brief.text);
  check("brief.html has no http:// or https:// in any src or href", badUrl === null, badUrl ? badUrl[0] : "");
} else {
  failed = true;
}

if (showcase2.ok) {
  check("showcase2.html contains brief.html?ws=", showcase2.text.indexOf("brief.html?ws=") !== -1);

  // The orders's intent is that the "Open pitch brief" link no longer targets the
  // raw dossier page. That link is the per-lead card and is the only caller that
  // builds its href with encodeURIComponent(WS). The nav "Pitch brief" link keeps
  // dossier.html?ws= because the existing showcase2 checks pin that literal string
  // and this order requires that both of those checks still pass.
  check(
    "showcase2.html's Open pitch brief link no longer targets dossier.html?ws=",
    showcase2.text.indexOf('"dossier.html?ws=" + encodeURIComponent(WS)') === -1
  );
} else {
  failed = true;
}

let dossierSize = -1;
try {
  dossierSize = statSync(dossierPath).size;
} catch {
  dossierSize = -1;
}
check(
  "dossier.html is unchanged (byte size " + DOSSIER_BYTES_BEFORE + ")",
  dossierSize === DOSSIER_BYTES_BEFORE,
  "size=" + dossierSize
);

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
