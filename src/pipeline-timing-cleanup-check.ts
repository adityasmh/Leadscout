// src/pipeline-timing-cleanup-check.ts
// Verification script for the pipeline-timing-wiring-check.ts cleanup fix.

import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

const wiringCheckPath = resolve(__dirname, "pipeline-timing-wiring-check.ts");
const wiringCheckSource = readFileSync(wiringCheckPath, "utf8");

const results: { name: string; ok: boolean; detail?: string }[] = [];

function pass(name: string, detail?: string): void {
  results.push({ name, ok: true, detail });
}

function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail });
}

function checkNoThenOnImport(source: string): void {
  const importThenRegex = /import\s*\([^)]+\)\s*\.\s*then\s*\(/;
  if (importThenRegex.test(source)) {
    fail("no .then( on import(", "found .then( chained to import()");
  } else {
    pass("no .then( on import(");
  }
}

function checkNoEmptyCatch(source: string): void {
  const catchRegex = /catch\s*\([^)]*\)\s*\{\s*(?:\/\/.*|\/\*[\s\S]*?\*\/)?\s*\}/g;
  const matches = source.match(catchRegex);
  if (matches && matches.length > 0) {
    // Filter out the main().catch() which is a method call, not a catch block
    const realEmptyCatches = matches.filter(m => !m.includes("main().catch"));
    if (realEmptyCatches.length > 0) {
      fail("no empty catch block", `found ${realEmptyCatches.length} empty catch block(s)`);
      return;
    }
  }
  pass("no empty catch block");
}

function checkRmSyncInFinally(source: string): void {
  const mainIndex = source.indexOf("async function main(): Promise<void> {");
  if (mainIndex === -1) {
    fail("rmSync in finally", "main function not found");
    return;
  }
  const afterMain = source.slice(mainIndex);
  const finallyIndex = afterMain.indexOf("finally {");
  if (finallyIndex === -1) {
    fail("rmSync in finally", "no finally block found in main function");
    return;
  }
  const afterFinally = afterMain.slice(finallyIndex);
  let braceDepth = 0;
  let braceEnd = -1;
  for (let i = 0; i < afterFinally.length; i++) {
    const ch = afterFinally[i];
    if (ch === "{") braceDepth++;
    else if (ch === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd === -1) {
    fail("rmSync in finally", "could not find matching closing brace for finally block");
    return;
  }
  const finallyBlock = afterFinally.slice(0, braceEnd + 1);
  if (finallyBlock.includes("rmSync(")) {
    pass("rmSync in finally");
  } else {
    fail("rmSync in finally", "no rmSync( call inside finally block");
  }
}

function extractTempPrefix(source: string): string | null {
  const match = source.match(/mkdtempSync\([^)]*join\(tmpdir\(\),[^)]*"([^"]+)"\)/);
  return match ? match[1] : null;
}

function countTempDirs(prefix: string): number {
  const tempDir = tmpdir();
  try {
    const entries = readdirSync(tempDir);
    return entries.filter((name) => name.startsWith(prefix)).length;
  } catch {
    return 0;
  }
}

function checkSpawnExitCode(wiringCheckPath: string, prefix: string): { exitCode: number; stdout: string; stderr: string; beforeCount: number; afterCount: number } {
    const beforeCount = countTempDirs(prefix);
  const result = spawnSync("node", ["--import", "tsx", wiringCheckPath], {
    encoding: "utf8",
    cwd: resolve("."),
  });
  const afterCount = countTempDirs(prefix);
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    beforeCount,
    afterCount,
  };
}

async function main(): Promise<void> {
  checkNoThenOnImport(wiringCheckSource);
  checkNoEmptyCatch(wiringCheckSource);
  checkRmSyncInFinally(wiringCheckSource);

  const tempPrefix = extractTempPrefix(wiringCheckSource);
  if (!tempPrefix) {
    fail("extract TEMP_PREFIX", "could not find temp prefix in wiring check");
  } else {
    pass("extract TEMP_PREFIX", `prefix="${tempPrefix}"`);

    const { exitCode, stdout, stderr, beforeCount, afterCount } = checkSpawnExitCode(wiringCheckPath, tempPrefix);

    if (exitCode === 0) {
      pass("spawn exits 0", `exitCode=${exitCode}`);
    } else {
      fail("spawn exits 0", `exitCode=${exitCode} stdout=${stdout.trim()} stderr=${stderr.trim()}`);
    }

    if (afterCount <= beforeCount) {
      pass("no net temp dir increase", `before=${beforeCount} after=${afterCount}`);
    } else {
      fail("no net temp dir increase", `before=${beforeCount} after=${afterCount} (increase of ${afterCount - beforeCount})`);
    }
  }

  let passed = 0;
  for (const r of results) {
    const label = r.ok ? "PASS" : "FAIL";
    console.log(`${label}: ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
    if (r.ok) passed++;
  }
  const total = results.length;
  const overall = passed === total ? "PASS" : "FAIL";
  console.log(`${overall} ${passed}/${total}`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error("cleanup check crashed:", err);
  process.exit(1);
});