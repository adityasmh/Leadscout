// Plugin loader. Plugins live in plugins/<id>/ and are OFF unless named in
// LEADSCOUT_PLUGINS (comma list, or "all"). Importing plugins/<id>/index.ts
// registers that plugin's channel adapters with channels/registry.ts.
// Contract + template: plugins/README.md and plugins/_template/.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const PLUGINS_DIR = fileURLToPath(new URL("../plugins/", import.meta.url));

/** Plugin ids on disk (folders with an index.ts, ignoring _template). */
export function availablePlugins(): string[] {
  if (!existsSync(PLUGINS_DIR)) return [];
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(join(PLUGINS_DIR, d.name, "index.ts")))
    .map((d) => d.name)
    .sort();
}

/** Ids requested by the operator through LEADSCOUT_PLUGINS. */
export function requestedPlugins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = String(env.LEADSCOUT_PLUGINS ?? "").trim();
  if (raw === "") return [];
  if (raw.toLowerCase() === "all") return availablePlugins();
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export type PluginLoadReport = { loaded: string[]; failed: { id: string; error: string }[] };

/** Import each requested plugin once. A broken plugin never stops the server. */
export async function loadPlugins(env: NodeJS.ProcessEnv = process.env): Promise<PluginLoadReport> {
  const known = new Set(availablePlugins());
  const report: PluginLoadReport = { loaded: [], failed: [] };
  for (const id of requestedPlugins(env)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !known.has(id)) {
      report.failed.push({ id, error: "unknown plugin (no plugins/<id>/index.ts)" });
      continue;
    }
    try {
      await import(pathToFileURL(join(PLUGINS_DIR, id, "index.ts")).href);
      report.loaded.push(id);
    } catch (err) {
      report.failed.push({ id, error: (err as Error).message });
    }
  }
  if (report.loaded.length) console.log(`plugins loaded: ${report.loaded.join(", ")}`);
  for (const f of report.failed) console.warn(`plugin "${f.id}" not loaded: ${f.error}`);
  return report;
}
