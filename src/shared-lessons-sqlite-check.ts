// src/shared-lessons-sqlite-check.ts
// Order XC1F-sqlite-import-fix: offline string-reader check.
// Reads files as strings only; never opens a live SQLite file.
// Source of truth for the exact comment line is src/store.ts.
// Node 24 built-ins only; ES modules with .js import suffixes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const ZERO = 0;
const ONE = 1;

const TSX_BIN = process.execPath;
const CHECK_ARG = "src/shared-lessons-check.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const storePath = join(repoRoot, "src", "store.ts");
const targetPaths = [
  join(repoRoot, "src", "shared-lessons.ts"),
  join(repoRoot, "src", "shared-lessons-check.ts"),
];

let failures = ZERO;

function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += ONE;
  console.log(`FAIL ${name}`);
}

function isSqliteImportLine(line: string): boolean {
  if (line.includes("node:sqlite") === false) return false;
  if (line.includes("from \"node:sqlite\"") || line.includes("from 'node:sqlite'")) return true;
  if (line.includes("import(\"node:sqlite\")") || line.includes("import('node:sqlite')")) return true;
  if (line.includes("import (\"node:sqlite\")") || line.includes("import ('node:sqlite')")) return true;
  return false;
}

// Source of truth: exact comment line directly above the node:sqlite import in store.ts.
const storeText = readFileSync(storePath, "utf8");
const storeLines = storeText.split("\n");
let expected = "";
for (let i = ONE; i < storeLines.length; i += ONE) {
  const line = storeLines[i] ?? "";
  if (isSqliteImportLine(line)) {
    expected = (storeLines[i - ONE] ?? "").trim();
    break;
  }
}
check("expected comment line read from store.ts", expected !== "");
check(
  "expected line is the exact node:sqlite convention",
  expected ===
    "// @ts-ignore node:sqlite is a Node 24 built-in; ambient types are not available in this environment.",
);

for (const targetPath of targetPaths) {
  const short = targetPath.split("products")[ONE] ?? targetPath;
  const text = readFileSync(targetPath, "utf8");
  const lines = text.split("\n");
  let sqliteCount = ZERO;
  let precededOk = true;
  for (let i = ZERO; i < lines.length; i += ONE) {
    const line = lines[i] ?? "";
    if (isSqliteImportLine(line) === false) continue;
    sqliteCount += ONE;
    const prev = i === ZERO ? "" : (lines[i - ONE] ?? "").trim();
    if (prev !== expected) precededOk = false;
  }
  check(`(${short}) at least one node:sqlite import found`, sqliteCount > ZERO);
  check(`(${short}) every node:sqlite import directly preceded by exact comment`, precededOk);
  let strayIgnore = false;
  let expectError = false;
  for (const line of lines) {
    if (line.includes("@ts-expect-error")) expectError = true;
    if (line.includes("@ts-ignore") && line.trim() !== expected) strayIgnore = true;
  }
  check(`(${short}) no other @ts-ignore`, strayIgnore === false);
  check(`(${short}) no @ts-expect-error`, expectError === false);
}

// shared-lessons-check.ts must still pass as a child process (fixed argument list).
// TSX_BIN uses forward slashes exactly as named in the order
// (node_modules/.bin/tsx.cmd); quoted for cmd.exe under shell:true.
const run = spawnSync(TSX_BIN, ["node_modules/tsx/dist/cli.mjs", CHECK_ARG], { encoding: "utf8" });
const childOutput = `${run.stdout ?? ""}${run.stderr ?? ""}`;
process.stdout.write(childOutput);
check("shared-lessons-check.ts child process exit code is 0", run.status === EXIT_OK);

if (failures === ZERO) {
  console.log("shared-lessons-sqlite-check: PASS");
} else {
  console.log(`shared-lessons-sqlite-check: FAIL (${failures} failing assertions)`);
}
process.exitCode = failures === ZERO ? EXIT_OK : EXIT_FAIL;
