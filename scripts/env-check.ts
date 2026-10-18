// Verifies .env.example documents every environment variable the code reads.
// Run: npm run check:env   (also picked up by check:all)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const example = readFileSync(join(ROOT, ".env.example"), "utf8");
const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith("-check.ts")) out.push(p);
  }
  return out;
}

const used = new Map<string, string>();
for (const dir of ["src", "plugins", "adapters", "deploy"]) {
  for (const file of walk(join(ROOT, dir))) {
    const text = readFileSync(file, "utf8");
    const patterns = [
      /(?:process\.env|\benv)\.([A-Z][A-Z0-9_]{2,})/g,
      /(?:process\.env|\benv)\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g,
      /\b[A-Z_]*ENV[A-Z_]*\s*=\s*["']((?:LEADSCOUT|CHANNEL)_[A-Z0-9_]+)["']/g,
      /\benvOn\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
    ];
    for (const re of patterns) for (const m of text.matchAll(re)) used.set(m[1]!, file.slice(ROOT.length + 1));
  }
}

// Variables that are built from a prefix at runtime are documented in comments instead.
const SKIP = new Set(["NODE_ENV", "PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "SystemRoot", "CI"]);
const missing = [...used].filter(([name]) => !documented.has(name) && !SKIP.has(name));
for (const [name, file] of missing) console.log(`FAIL ${name} is read in ${file} but missing from .env.example`);
if (missing.length) process.exit(1);
console.log(`PASS env-check: ${used.size} variables used, all documented in .env.example`);
