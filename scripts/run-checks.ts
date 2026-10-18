// Runs every offline *-check.ts (src/, plugins/, deploy/) and prints one PASS/FAIL line each.
// Usage: npm run check:all            (all checks)
//        npm run check:all -- billing (only files whose path contains "billing")
// Checks are plain scripts that exit non-zero on failure. Plugins are force-enabled
// so the plugin checks and the registry wiring checks can see every adapter.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const TIMEOUT_MS = 180_000;
const CONCURRENCY = Number(process.env.CHECK_CONCURRENCY ?? 3);
const filter = process.argv.slice(2).filter((a) => !a.startsWith("-"));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith("-check.ts")) out.push(p);
  }
  return out;
}

const files = ["src", "plugins", "adapters", "deploy"]
  .flatMap((d) => walk(join(ROOT, d)))
  .map((p) => relative(ROOT, p).split(sep).join("/"))
  .filter((p) => filter.length === 0 || filter.some((f) => p.includes(f)))
  .sort();

const tmp = mkdtempSync(join(tmpdir(), "leadscout-checks-"));
const tsx = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function runOne(file: string): Promise<{ file: string; ok: boolean; ms: number; tail: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LEADSCOUT_PLUGINS: "all",
      LEADSCOUT_DB: join(tmp, file.replace(/[^a-z0-9]/gi, "_") + ".db"),
    };
    delete env.LEADSCOUT_LLM_OFF; // some checks assert that the model is (or is not) called
    const child = spawn(process.execPath, [tsx, file], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stdout.on("data", (d) => (buf += d));
    child.stderr.on("data", (d) => (buf += d));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0, ms: Date.now() - started, tail: buf.split("\n").slice(-12).join("\n") });
    });
  });
}

const queue = [...files];
const results: Awaited<ReturnType<typeof runOne>>[] = [];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const r = await runOne(f);
      results.push(r);
      console.log(`${r.ok ? "PASS" : "FAIL"} ${r.file} (${(r.ms / 1000).toFixed(1)}s)`);
      if (!r.ok) console.log(r.tail.replace(/^/gm, "    "));
    }
  }),
);
rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
