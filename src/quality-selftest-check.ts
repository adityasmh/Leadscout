// src/quality-selftest-check.ts
// Runs quality-check.ts once as a child process and verifies the metric
// self-test section plus the unchanged honest/harness verdicts.

import { spawnSync } from "node:child_process";

const TSX_BIN = process.execPath;
const QUALITY_CHECK = "src/quality-check.ts";
const SELFTEST_HEADING = "METRIC SELF-TEST";
const HONEST_PASS_LINE = "HONEST OVERALL: PASS";
const HARNESS_PASS_LINE = "HARNESS: PASS";
const EXPECTED_SELFTEST_PASSES = 5;
const EXPECTED_SELFTEST_FAILURES = 0;
const NEXT_LINE_OFFSET = 1;
const EXIT_OK = 0;
const EXIT_FAIL = 1;

type Check = { name: string; ok: boolean };

function sectionLines(output: string): string[] | undefined {
  const lines = output.split("\n");
  const headingIndex = lines.findIndex((line) => line.includes(SELFTEST_HEADING));
  if (headingIndex < EXPECTED_SELFTEST_FAILURES) return undefined;
  const section: string[] = [];
  for (
    let index = headingIndex + NEXT_LINE_OFFSET;
    index < lines.length;
    index += NEXT_LINE_OFFSET
  ) {
    const line = lines[index] ?? "";
    if (line.trim() === "") break;
    section.push(line);
  }
  return section;
}

const run = spawnSync(TSX_BIN, ["node_modules/tsx/dist/cli.mjs", QUALITY_CHECK], { encoding: "utf8" });
if (run.error !== undefined) {
  console.log(`FAIL: spawn ${TSX_BIN} failed: ${String(run.error)}`);
  process.exitCode = EXIT_FAIL;
} else {
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const section = sectionLines(output);
  const passCount =
    section === undefined
      ? EXPECTED_SELFTEST_FAILURES
      : section.filter((line) => line.startsWith("PASS:")).length;
  const failCount =
    section === undefined
      ? EXPECTED_SELFTEST_PASSES
      : section.filter((line) => line.startsWith("FAIL:")).length;
  const checks: Check[] = [
    {
      name: "output contains heading METRIC SELF-TEST",
      ok: section !== undefined,
    },
    {
      name: "exactly five PASS lines under that heading and no FAIL line there",
      ok:
        passCount === EXPECTED_SELFTEST_PASSES &&
        failCount === EXPECTED_SELFTEST_FAILURES,
    },
    {
      name: "output still contains HONEST OVERALL: PASS",
      ok: output.includes(HONEST_PASS_LINE),
    },
    {
      name: "output still contains HARNESS: PASS",
      ok: output.includes(HARNESS_PASS_LINE),
    },
  ];
  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}: ${check.name}`);
  }
  process.exitCode = checks.every((check) => check.ok) ? EXIT_OK : EXIT_FAIL;
}
