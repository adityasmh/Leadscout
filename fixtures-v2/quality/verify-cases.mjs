import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const NO_BAD_QUOTES = 0;
const FIRST_INDEX = 0;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const casesPath = path.join(currentDir, "cases.json");

let raw = "";
try {
  raw = readFileSync(casesPath, "utf8");
} catch (error) {
  console.error(`cannot read cases.json at ${casesPath}: ${String(error)}`);
  process.exit(EXIT_FAILURE);
}

const cases = JSON.parse(raw);
const badIds = [];

for (const item of cases) {
  const texts = item.pages.map((page) => page.text);
  for (const fact of item.truth.facts) {
    const found = texts.some((text) => text.includes(fact.quote));
    if (found === false) {
      badIds.push(item.id);
      break;
    }
  }
}

const totalCases = cases.length;
const badCount = badIds.length;

if (badCount === NO_BAD_QUOTES) {
  console.log(`${totalCases} cases, ${badCount} bad quotes`);
  process.exit(EXIT_SUCCESS);
}

console.log(`FAIL ${badIds.slice(FIRST_INDEX).join(", ")} (${totalCases} cases, ${badCount} bad quotes)`);
process.exit(EXIT_FAILURE);
