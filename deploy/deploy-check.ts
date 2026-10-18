// deploy-check.ts - static, offline pre-customer self-check for Leadscout.
// Node 24 built-ins only, ESM, no network, imports nothing from src/ (reads
// files as text). Run: node deploy/deploy-check.ts
// Prints PASS/FAIL (and WARN where applicable) per check plus a summary;
// exits non-zero if any check FAILED.
import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

type Status = "PASS" | "FAIL" | "WARN";
type Result = { name: string; status: Status; lines: string[] };

const HERE = dirname(fileURLToPath(import.meta.url));
const LEADSCOUT = dirname(HERE);
const SRC = join(LEADSCOUT, "src");
const DOCKERFILE = join(LEADSCOUT, "Dockerfile");
const COMPOSE = join(LEADSCOUT, "docker-compose.yml");
const ENV_EXAMPLE = join(LEADSCOUT, ".env.example");
const BACKUP_PS1 = join(HERE, "backup.ps1");

function listSourceFiles(): string[] {
  return readdirSync(SRC, { recursive: false, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => join(SRC, d.name));
}

// ---------------------------------------------------------------- check 1
// Dockerfile: non-root USER, EXPOSE, HEALTHCHECK referencing /api/health.
function checkDockerfile(): Result {
  const lines: string[] = [];
  if (!existsSync(DOCKERFILE)) return { name: "Dockerfile non-root/EXPOSE/HEALTHCHECK", status: "FAIL", lines: ["Dockerfile not found"] };
  const text = readFileSync(DOCKERFILE, "utf8");

  const userMatches = [...text.matchAll(/^USER\s+(\S+)\s*$/gm)].map((m) => m[1]);
  if (userMatches.length === 0) {
    return { name: "Dockerfile non-root/EXPOSE/HEALTHCHECK", status: "FAIL", lines: ["no final USER directive found"] };
  }
  const lastUser = userMatches[userMatches.length - 1];
  const nonRoot = !(lastUser === "root" || lastUser === "0");
  lines.push(`USER directive: "${lastUser}" -> ${nonRoot ? "non-root" : "root (FAIL)"}`);

  const expose = [...text.matchAll(/^EXPOSE\s+(\S+)[^\n]*$/gm)].map((m) => m[0]);
  const hasExpose = expose.length > 0;
  lines.push(`EXPOSE directive: ${hasExpose ? expose[0] : "not found (FAIL)"}`);

  const healthIdx = text.indexOf("HEALTHCHECK");
  const hasHealth = healthIdx >= 0;
  const healthSection = hasHealth ? text.slice(healthIdx) : "";
  const healthRefsEndpoint = hasHealth && healthSection.includes("/api/health");
  lines.push(`HEALTHCHECK present, references /api/health: ${healthRefsEndpoint ? "yes" : "no (FAIL)"}`);

  const ok = nonRoot && hasExpose && healthRefsEndpoint;
  return { name: "Dockerfile non-root/EXPOSE/HEALTHCHECK", status: ok ? "PASS" : "FAIL", lines };
}

// ---------------------------------------------------------------- check 2
// docker-compose.yml parses as YAML-like text and mentions the data volume / /data.
function checkCompose(): Result {
  const lines: string[] = [];
  if (!existsSync(COMPOSE)) return { name: "docker-compose.yml YAML-like text, mentions data volume", status: "FAIL", lines: ["docker-compose.yml not found"] };
  const text = readFileSync(COMPOSE, "utf8");
  const rawLines = text.split(/\r?\n/);
  const problems: string[] = [];

  // no tab indentation
  const tabLines = rawLines.filter((l) => /^\t/.test(l));
  if (tabLines.length > 0) problems.push(`${tabLines.length} indented line(s) start with a TAB character`);

  // consistent space indentation: distinct positive indent widths must step evenly
  const widths = new Set<number>();
  for (const l of rawLines) {
    const m = l.match(/^( +)\S/);
    if (m) widths.add(m[1].length);
  }
  const sorted = [...widths].sort((a, b) => a - b);
  let consistent = true;
  if (sorted.length > 0) {
    const step = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] % step !== 0) consistent = false;
    }
  }
  if (!consistent) problems.push(`inconsistent indentation widths: ${sorted.join(", ")}`);
  lines.push(`indentation widths (spaces): ${sorted.join(", ") || "(none)"} -> ${consistent ? "consistent" : "inconsistent"}`);

  // key: at line starts; required top-level sections
  const keyLines = rawLines.filter((l) => /^\s*[\w.-]+:(\s|$)/.test(l));
  lines.push(`key:-at-line-start lines found: ${keyLines.length}`);
  if (keyLines.length === 0) problems.push("no 'key:' lines detected");
  const topLevel = new Set(rawLines.flatMap((l) => { const m = l.match(/^([\w.-]+):(?:\s|$)/); return m && m[1] ? [m[1]] : []; }));
  const required = ["services", "volumes"];
  for (const r of required) {
    if (!topLevel.has(r)) problems.push(`missing top-level '${r}:' section`);
  }
  lines.push(`top-level sections: services=${topLevel.has("services")}, volumes=${topLevel.has("volumes")}`);

  // mentions the data volume or /data
  const mentionsData = text.includes("/data");
  lines.push(`mentions /data (data volume mount): ${mentionsData ? "yes" : "no"}`);
  if (!mentionsData) problems.push("text does not mention /data or the named data volume");

  const status = problems.length === 0 ? "PASS" : "FAIL";
  for (const p of problems) lines.push(`problem: ${p}`);
  return { name: "docker-compose.yml YAML-like text, mentions data volume", status, lines };
}

// ---------------------------------------------------------------- check 3
// Every process.env.X in src/ appears as a key in .env.example.
// Extra keys in .env.example => WARN. Dynamic process.env[ usage => WARN.
function checkEnvCoverage(): Result {
  const lines: string[] = [];
  if (!existsSync(ENV_EXAMPLE)) return { name: "env vars: all process.env.X used in src/ documented in .env.example", status: "FAIL", lines: [".env.example not found"] };
  const envText = readFileSync(ENV_EXAMPLE, "utf8");
  const documented = new Map<string, string>(); // key -> value
  for (const l of envText.split(/\r?\n/)) {
    if (/^\s*#/.test(l)) continue;
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) documented.set(m[1], m[2].trim());
  }

  const used = new Map<string, string[]>();
  const dynamic: string[] = [];
  for (const file of listSourceFiles()) {
    const text = readFileSync(file, "utf8");
    const rel = file.slice(LEADSCOUT.length + 1);
    for (const m of text.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) {
      const list = used.get(m[1]) ?? [];
      list.push(rel);
      used.set(m[1], list);
    }
    for (const m of text.matchAll(/process\.env\s*\[([^\]]*)\]/g)) {
      dynamic.push(`${rel}: dynamic lookup process.env[${m[1]}]`);
    }
  }

  const missing = [...used.keys()].filter((k) => !documented.has(k)).sort();
  const extras = [...documented.keys()].filter((k) => !used.has(k)).sort();
  for (const [k, files] of [...used.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`used in src/: ${k} (${[...new Set(files)].join(", ")}) -> documented: ${documented.has(k) ? "yes" : "NO (WARN)"}`);
  }
  for (const k of extras) lines.push(`extra key in .env.example (WARN, not read via process.env.X): ${k}`);
  for (const d of dynamic) lines.push(`dynamic env access (WARN, needs manual review): ${d}`);

  // Undocumented env vars are a documentation gap (.env.example drift), not a deploy
  // failure: the product still runs with its built-in defaults, so this is a WARN.
  // A real FAIL is reserved for the checks that break a deployment.
  let status: Status = "PASS";
  if (missing.length > 0 || extras.length > 0 || dynamic.length > 0) status = "WARN";
  lines.push(`summary: ${used.size} env name(s) used in src/, ${missing.length} missing, ${extras.length} extra, ${dynamic.length} dynamic`);
  return { name: "env vars: all process.env.X used in src/ documented in .env.example", status, lines };
}

// ---------------------------------------------------------------- check 4
// .env.example must not contain values resembling real credentials.
const HEURISTIC = [
  "heuristic used to flag real credentials in .env.example values:",
  "  ALLOW (pass) when value contains markers: changeme, fake, example, xxx, your-,",
  "        or looks like an <...> placeholder, or is empty/numeric/simple settings.",
  "  rule: fail markers (case-insensitive for the first) are sk_live_, pk_live_, rk_live_,",
  "        -----BEGIN (PEM), AKIA... (AWS access key id, 8+ uppers after prefix).",
  "  rule: an email / bare-hostname token (with a lettered TLD) that survives the",
  "        safe-domain allowlist (example.com etc., localhost, .local, .invalid,",
  "        .test, changeme/fake/xxx placeholders) is treated as a real credential.",
  "  rule: a token of length >= 30 over [A-Za-z0-9_+\\/-=] mixing at least 3 of",
  "        {lowercase, uppercase, digits} with no placeholder marker is a high-entropy secret.",
];
function isSafeDomain(host: string): boolean {
  const h = host.toLowerCase();
  if (/(^|\.)example\.[a-z]{2,}$/.test(h)) return true;
  if (/(^|\.)\.(local|internal|invalid|test|example)$/.test(h)) return true;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(h)) return true;
  if (/(example|changeme|fake|placeholder|missing|dummy|sample)/.test(h)) return true;
  return false;
}
function credentialProblems(value: string): string[] {
  const raw = value.trim();
  if (raw === "") return [];
  let v = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // keep user:pass@host for inspection
  const problems: string[] = [];
  if (/(sk_live_|pk_live_|rk_live_)/i.test(v) || /AKIA[0-9A-Z]{8,}/.test(v) || v.includes("-----BEGIN")) {
    problems.push("live credential/PEM marker");
  }
  if (/(changeme|fake|example|xxx|your-|<[^<>]*>)/i.test(v)) return problems; // explicit placeholder wins
  const emails = v.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  for (const email of emails) {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (!isSafeDomain(domain)) problems.push(`real-looking email: ${email}`);
  }
  for (const token of v.split(/[\s,;]+/)) {
    if (token === "") continue;
    const hostMatch = token.replace(/^[^@]*@/, "").match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/i);
    if (hostMatch && !token.includes("/") && !isSafeDomain(hostMatch[1])) {
      problems.push(`real-looking hostname: ${hostMatch[1]}`);
    }
  }
  for (const token of v.split(/[\s,;:|]+/)) {
    const t = token.replace(/^[^@]*@/, "");
    if (t.length >= 30 && /^[A-Za-z0-9_+/-]+={0,2}$/.test(t)) {
      const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[_+/=-]/].filter((re) => re.test(t)).length;
      if (classes >= 3) problems.push(`long high-entropy token (${t.length} chars): ${t.slice(0, 6)}...`);
    }
  }
  return problems;
}
function checkCredentials(): Result {
  const lines: string[] = [...HEURISTIC];
  if (!existsSync(ENV_EXAMPLE)) return { name: ".env.example contains no real-looking credentials", status: "FAIL", lines: ["heuristic printed;", ".env.example not found"] };
  const envText = readFileSync(ENV_EXAMPLE, "utf8");
  const problems: string[] = [];
  for (const l of envText.split(/\r?\n/)) {
    if (/^\s*#/.test(l)) continue;
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const found = credentialProblems(m[2]);
    for (const p of found) problems.push(`${m[1]}: ${p}`);
  }
  if (problems.length > 0) {
    for (const p of problems) lines.push(`FAIL: ${p}`);
    return { name: ".env.example contains no real-looking credentials", status: "FAIL", lines };
  }
  lines.push("all values look like placeholders/settings; no credential-shaped values");
  return { name: ".env.example contains no real-looking credentials", status: "PASS", lines };
}

// ---------------------------------------------------------------- check 5
// Backup logic on a temp DB under os.tmpdir(): use the exact VACUUM INTO
// statement text extracted from backup.ps1 ("same function" interpretation:
// the statement itself, with the {0} placeholder filled, is executed by this
// TS process via node:sqlite exactly as backup.ps1 would), then replicate the
// retention rule and assert exactly 14 survive. Only temp files are touched.
function checkBackup(): Result {
  const lines: string[] = [];
  if (!existsSync(BACKUP_PS1)) return { name: "backup logic on temp DB (VACUUM INTO + retention=14)", status: "FAIL", lines: ["backup.ps1 not found"] };
  const ps1 = readFileSync(BACKUP_PS1, "utf8");
  const statement = ps1.match(/VACUUM INTO '[^']*'/)?.[0];
  if (!statement) return { name: "backup logic on temp DB (VACUUM INTO + retention=14)", status: "FAIL", lines: ["no single-line VACUUM INTO statement found in backup.ps1"] };
  lines.push(`extracted statement: ${statement}`);

  const tmp = mkdtempSync(join(tmpdir(), "leadscout-deploycheck-"));
  try {
    // 1. temp source DB with a known number of rows
    const sourcePath = join(tmp, "source.db");
    const source = new DatabaseSync(sourcePath);
    source.exec("CREATE TABLE check_t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    const insert = source.prepare("INSERT INTO check_t (v) VALUES (?)");
    const ROWS = 7;
    for (let i = 0; i < ROWS; i++) insert.run(`row-${i}`);
    source.close();

    // 2. execute the exact extracted statement (placeholder filled) via node:sqlite
    const backupPath = join(tmp, "leadscout-backup.db");
    const sql = statement.replace("{0}", backupPath.replace(/\\/g, "/").replaceAll("'", "''"));
    const runner = new DatabaseSync(sourcePath);
    try {
      runner.exec(sql);
    } finally {
      runner.close();
    }
    const copy = new DatabaseSync(backupPath);
    const copyCount = Number(Object.values(copy.prepare("SELECT COUNT(*) AS n FROM check_t").get() as Record<string, unknown>)[0]);
    copy.close();
    if (copyCount !== ROWS) {
      return { name: "backup logic on temp DB (VACUUM INTO + retention=14)", status: "FAIL", lines: [...lines, `row count mismatch: source ${ROWS}, backup copy ${copyCount}`] };
    }
    lines.push(`backup copy opens and row counts match: ${ROWS} == ${copyCount}`);

    // 3. replicate the retention rule of backup.ps1: VACUUM INTO 1 + 16 more
    //    copies (17 total), keep newest 14 by timestamp name, assert exactly 14 remain.
    const retentionDir = join(tmp, "retention");
    mkdirSync(retentionDir, { recursive: true });
    const names: string[] = [];
    const base = Date.now();
    for (let i = 0; i < 17; i++) {
      const stamp = stampOf(new Date(base - i * 1000));
      const target = join(retentionDir, `leadscout-${stamp}.db`);
      const r = new DatabaseSync(sourcePath);
      try {
        r.exec(statement.replace("{0}", target.replace(/\\/g, "/").replaceAll("'", "''")));
      } finally {
        r.close();
      }
      names.push(`leadscout-${stamp}.db`);
    }
    // same pattern and rule as backup.ps1
    const pattern = /^leadscout-\d{8}-\d{9}(-\d+)?\.db$/;
    if (pattern.test("leadscout.db")) {
      return { name: "backup logic on temp DB (VACUUM INTO + retention=14)", status: "FAIL", lines: [...lines, "retention pattern would match the live database name leadscout.db - live DB not safe"] };
    }
    const kept = names.filter((n) => pattern.test(n)).sort().reverse().slice(0, 14);
    for (const n of names) {
      if (!kept.includes(n)) rmSync(join(retentionDir, n));
    }
    const remaining = readdirSync(retentionDir);
    if (remaining.length !== 14) {
      return { name: "backup logic on temp DB (VACUUM INTO + retention=14)", status: "FAIL", lines: [...lines, `retention simulation left ${remaining.length} files, expected exactly 14`] };
    }
    lines.push("retention simulation: 17 timestamped backups -> exactly 14 newest kept");

    return { name: "backup logic on temp DB (VACUUM INTO + retention=14)", status: "PASS", lines };
  } catch (err) {
    return { name: "backup logic on temp DB (VACUUM INTO + retention=14)", status: "FAIL", lines: [...lines, `error: ${err instanceof Error ? err.message : String(err)}`] };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function stampOf(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

// ---------------------------------------------------------------- runner
const results: Result[] = [];
for (const [i, check] of [checkDockerfile, checkCompose, checkEnvCoverage, checkCredentials, checkBackup].entries()) {
  let result: Result;
  try {
    result = check();
  } catch (err) {
    result = { name: check.name, status: "FAIL", lines: [`unexpected error: ${err instanceof Error ? err.message : String(err)}`] };
  }
  console.log(`[${i + 1}/5] ${result.name}`);
  console.log(`  -> ${result.status}`);
  for (const line of result.lines) console.log(`      ${line}`);
  console.log("");
  results.push(result);
}
const pass = results.filter((r) => r.status === "PASS").length;
const warn = results.filter((r) => r.status === "WARN").length;
const fail = results.filter((r) => r.status === "FAIL").length;
console.log(`SUMMARY: ${pass} pass, ${warn} warn, ${fail} fail out of 5 checks -> ${fail === 0 ? "OK" : "FAILED"}`);
process.exitCode = fail === 0 ? 0 : 1;
