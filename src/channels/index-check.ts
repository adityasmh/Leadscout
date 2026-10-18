// Proof that the channel index and the plugin folders are wired correctly. Offline.
//  1. every core adapter file in src/channels that calls registerChannel() is imported by index.ts
//  2. every plugin folder's index.ts imports every adapter file in that folder
//  3. with LEADSCOUT_PLUGINS=all the registry holds unique ids (core + all plugins)
//  4. with LEADSCOUT_PLUGINS unset only the core adapters register
// Run: npx tsx src/channels/index-check.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
let failed = false;

function report(ok: boolean, name: string, detail = ""): void {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`);
}

function registeringFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith("-check.ts") && f !== "index.ts")
    .filter((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").some((l) => l.trimStart().startsWith("registerChannel(")))
    .map((f) => f.slice(0, -3));
}

function importedBy(indexFile: string): string[] {
  const text = fs.readFileSync(indexFile, "utf8");
  return [...text.matchAll(/^import "\.\/(.+)\.js";$/gm)].map((m) => String(m[1]));
}

// 1. core
const coreImported = importedBy(path.join(here, "index.ts"));
const coreMissing = registeringFiles(here).filter((n) => !coreImported.includes(n));
report(coreMissing.length === 0, "core-registering-files-imported", coreMissing.length ? `missing: ${coreMissing.join(",")}` : "");
report(new Set(coreImported).size === coreImported.length, "core-no-duplicate-imports");

// 2. plugins
const pluginsDir = path.join(root, "plugins");
const pluginIds = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => d.name);
for (const id of pluginIds) {
  const dir = path.join(pluginsDir, id);
  const imported = importedBy(path.join(dir, "index.ts"));
  const missing = registeringFiles(dir).filter((n) => !imported.includes(n));
  report(missing.length === 0, `plugin-${id}-imports-all-adapters`, missing.length ? `missing: ${missing.join(",")}` : `(${imported.length} adapters)`);
  report(fs.existsSync(path.join(dir, "README.md")) && fs.existsSync(path.join(dir, "plugin.json")), `plugin-${id}-has-readme-and-manifest`);
}

// 3 + 4. registry contents in a fresh process per setting
function adapterIds(plugins: string): string[] {
  const code = `await import("${pathToUrl(path.join(here, "index.ts"))}"); const r = await import("${pathToUrl(path.join(here, "registry.ts"))}"); console.log(JSON.stringify(r.channelAdapters().map(a => a.id)));`;
  const env = { ...process.env, LEADSCOUT_PLUGINS: plugins };
  if (plugins === "") delete (env as Record<string, string | undefined>).LEADSCOUT_PLUGINS;
  const probe = path.join(os.tmpdir(), `leadscout-index-probe-${process.pid}-${Math.random().toString(36).slice(2)}.mts`);
  fs.writeFileSync(probe, code);
  const run = spawnSync(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), probe], { encoding: "utf8", env });
  fs.rmSync(probe, { force: true });
  const line = (run.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("[")).pop();
  if (!line) {
    console.log(run.stderr);
    return [];
  }
  return JSON.parse(line) as string[];
}
function pathToUrl(p: string): string {
  return "file:///" + p.replace(/\\/g, "/");
}

const coreOnly = adapterIds("");
const all = adapterIds("all");
report(coreOnly.length > 0 && coreOnly.length === coreImported.length, "no-plugins: only core adapters register", `count=${coreOnly.length}`);
report(all.length > coreOnly.length && new Set(all).size === all.length, "plugins=all: unique ids, more adapters than core", `count=${all.length}`);

if (failed) process.exitCode = 1;
