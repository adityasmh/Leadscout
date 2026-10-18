// Order L54E-route-path-fix: the L54B adapter report must not shadow the
// existing GET /api/channels/status route owned by routes-intake.ts.
// Offline proof: read server.ts and routes-intake.ts as strings, then run
// the existing routes-intake-check.ts as a child process. Run once:
//   npx tsx src/channels/route-shadow-check.ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, "..");
const CHANNELS_GUARD = 'parts[1] === "channels"';
const ADAPTERS_GUARD = 'parts[2] === "adapters"';
const STATUS_GUARD = 'parts[2] === "status"';
const COMMENT_PREFIX = "//";
const INTAKE_STATUS_PATH = "/api/channels/status";
const ADAPTERS_PATH = "/api/channels/adapters";
const TSX_BIN = process.execPath;
const USE_SHELL = process.platform === "win32";
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const NO_FAILURES = 0;

let failures = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`PASS: ${name} (${detail})`);
  } else {
    failures += 1;
    console.log(`FAIL: ${name} (${detail})`);
  }
}

const serverSrc = readFileSync(join(SRC_DIR, "server.ts"), "utf8");
const intakeSrc = readFileSync(join(SRC_DIR, "routes-intake.ts"), "utf8");

check(
  "server exposes adapters route",
  serverSrc.includes(ADAPTERS_PATH),
  `contains ${ADAPTERS_PATH}`,
);

const adapterLine = serverSrc
  .split("\n")
  .find((line) => line.includes(CHANNELS_GUARD) && line.includes(ADAPTERS_GUARD));
check(
  "server adapters guard present",
  adapterLine !== undefined,
  (adapterLine ?? "missing adapters guard").trim(),
);

const statusShadow = serverSrc
  .split("\n")
  .find((line) => {
    const code = line.trimStart();
    if (code.startsWith(COMMENT_PREFIX)) {
      return false;
    }
    return code.includes(CHANNELS_GUARD) && code.includes(STATUS_GUARD);
  });
check(
  "server has no channels status handler",
  statusShadow === undefined,
  statusShadow === undefined ? "no code line pairs channels with status" : `shadowing line: ${statusShadow.trim()}`,
);

check(
  "routes-intake still owns channels status",
  intakeSrc.includes(INTAKE_STATUS_PATH),
  `contains ${INTAKE_STATUS_PATH}`,
);

const intakeResult = spawnSync(TSX_BIN, ["node_modules/tsx/dist/cli.mjs", "src/routes-intake-check.ts"], {
  stdio: "inherit",
  shell: false,
});
check(
  "routes-intake-check exits 0",
  intakeResult.status === EXIT_OK,
  `status=${String(intakeResult.status)}`,
);

console.log(failures === NO_FAILURES ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === NO_FAILURES ? EXIT_OK : EXIT_FAIL);
