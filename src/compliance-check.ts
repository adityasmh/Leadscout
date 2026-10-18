// Proof harness for compliance.ts: opt-out normalisers, suppression and outreach checklists.
// Uses a temp database via LEADSCOUT_DB set before importing any module that opens the DB.

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = mkdtempSync(join(tmpdir(), "leadscout-compliance-check-"));
const dbPath = join(tmpDir, "test.db");
process.env.LEADSCOUT_DB = dbPath;

const {
  normaliseDomain,
  normaliseEmail,
  normalisePhone,
  normaliseBizKey,
  addOptOut,
  removeOptOut,
  listOptOuts,
  isSuppressed,
  outreachChecklist,
  validateOptOutInput,
} = await import("./compliance.js");
const { closeDb } = await import("./store.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const checks: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
  checks.push({ name, ok: condition, detail });
  const status = condition ? "PASS" : "FAIL";
  console.log(`${status}: ${name}${detail ? ` (${detail})` : ""}`);
  return condition;
}

function fail(name: string, detail: string) {
  return check(name, false, detail);
}

// ---------------------------------------------------------------- fixtures

const WS_A = "ws-fake-a";
const WS_B = "ws-fake-b";

// ---------------------------------------------------------------- normalisers

check(
  "normaliseDomain-url-with-www-and-path",
  normaliseDomain("https://www.Example.com./path/to/page?q=1") === "example.com",
  normaliseDomain("https://www.Example.com./path/to/page?q=1")
);

check(
  "normaliseDomain-bare-host",
  normaliseDomain("WWW.leadscout.example") === "leadscout.example"
);

check(
  "normaliseEmail-mixed-case-and-spaces",
  normaliseEmail("  Test.User@EXAMPLE.COM  ") === "test.user@example.com"
);

check(
  "normalisePhone-indian-mobile-with-plus91",
  normalisePhone(" +91-98765 43210 ") === "919876543210"
);

check(
  "normalisePhone-indian-mobile-without-country",
  normalisePhone("98765 43210") === "919876543210"
);

check(
  "normalisePhone-leading-00-stripped",
  normalisePhone("0091-98765-43210") === "919876543210"
);

check(
  "normaliseBizKey-trims",
  normaliseBizKey("  acme|mumbai  ") === "acme|mumbai"
);

// ---------------------------------------------------------------- kind detection

{
  const emailRow = addOptOut({ value: "Owner@Fixture.example", scope: "global", source: "test" });
  check("kind-detection-email", emailRow.kind === "email", emailRow.kind);

  const phoneRow = addOptOut({ value: "+91 98765 43210", scope: "global", source: "test" });
  check("kind-detection-phone", phoneRow.kind === "phone", phoneRow.kind);

  const domainRow = addOptOut({ value: "Fixture.example", scope: "global", source: "test" });
  check("kind-detection-domain", domainRow.kind === "domain", domainRow.kind);
}

// ---------------------------------------------------------------- duplicates

{
  const first = addOptOut({ value: "dup@fixture.example", scope: "global", source: "test" });
  const second = addOptOut({ value: "DUP@fixture.example", scope: "global", source: "test" });
  check("duplicate-add-returns-same-id", first.id === second.id, `${first.id} vs ${second.id}`);
}

// ---------------------------------------------------------------- suppression scopes

{
  addOptOut({ value: "global-opted.example", scope: "global", source: "test" });
  const a = isSuppressed({ website: "https://global-opted.example/about" }, WS_A);
  const b = isSuppressed({ website: "https://global-opted.example/about" }, WS_B);
  check("global-row-suppresses-ws-a", a.suppressed, a.reason);
  check("global-row-suppresses-ws-b", b.suppressed, b.reason);
}

{
  addOptOut({ value: "workspace-only.example", scope: WS_A, source: "test" });
  const a = isSuppressed({ website: "https://workspace-only.example" }, WS_A);
  const b = isSuppressed({ website: "https://workspace-only.example" }, WS_B);
  check("workspace-row-suppresses-own-workspace", a.suppressed, a.reason);
  check("workspace-row-does-not-suppress-other-workspace", !b.suppressed, JSON.stringify(b));
}

// ---------------------------------------------------------------- email-domain suppression

{
  addOptOut({ value: "blocked-domain.example", scope: "global", source: "test" });
  const lead = { emails: ["different-user@blocked-domain.example"] };
  const result = isSuppressed(lead, WS_A);
  check(
    "email-domain-match-suppresses-different-address",
    result.suppressed && result.reason?.startsWith("domain"),
    result.reason
  );
}

// ---------------------------------------------------------------- remove lifts suppression

{
  const row = addOptOut({ value: "to-remove.example", scope: "global", source: "test" });
  const before = isSuppressed({ website: "https://to-remove.example" }, WS_A);
  const removed = removeOptOut(row.id);
  const after = isSuppressed({ website: "https://to-remove.example" }, WS_A);
  check("remove-returns-true", removed);
  check("remove-lifts-suppression", before.suppressed && !after.suppressed, `before=${before.suppressed} after=${after.suppressed}`);
}

// ---------------------------------------------------------------- outreach checklists

{
  const inList = outreachChecklist("in");
  const firstLine = inList[0];
  check(
    "in-checklist-starts-with-disclaimer",
    firstLine === "Not legal advice. Check with counsel before outreach.",
    firstLine
  );
  const text = inList.join("\n");
  check("in-checklist-mentions-dnd", /DND/i.test(text));
  check("in-checklist-mentions-whatsapp-opt-in", /WhatsApp.*opt-in/i.test(text));
}

{
  const generic = outreachChecklist("ZZ");
  check(
    "unknown-country-returns-generic-set",
    generic.length > 0 && generic[0] === "Not legal advice. Check with counsel before outreach.",
    `items=${generic.length}`
  );
  const text = generic.join("\n");
  check("generic-set-has-collection-items", /Public business information/.test(text));
  check("generic-set-has-resale-line", /Resale:/.test(text));
}

// ---------------------------------------------------------------- input validation

{
  const markup = validateOptOutInput({ value: "<script>alert(1)</script>" });
  check("validator-rejects-markup", !markup.ok && markup.errors.some((e) => /markup/.test(e)), JSON.stringify(markup));

  const tooLong = validateOptOutInput({ value: "x".repeat(201) });
  check("validator-rejects-overlong-value", !tooLong.ok && tooLong.errors.some((e) => /200/.test(e)), JSON.stringify(tooLong));

  const noteTooLong = validateOptOutInput({ value: "valid@fixture.example", note: "x".repeat(301) });
  check("validator-rejects-overlong-note", !noteTooLong.ok && noteTooLong.errors.some((e) => /300/.test(e)), JSON.stringify(noteTooLong));

  const ok = validateOptOutInput({ value: "  Valid@Fixture.example  ", kind: "email", note: "Please remove" });
  check(
    "validator-accepts-clean-input",
    ok.ok && ok.value === "valid@fixture.example" && ok.kind === "email" && ok.note === "Please remove",
    JSON.stringify(ok)
  );
}

// ---------------------------------------------------------------- optout.html

{
  const html = readFileSync(join(HERE, "..", "public", "optout.html"), "utf-8");
  check("optout-html-has-form-id", /id=["']optout-form["']/.test(html));
  check("optout-html-has-value-id", /id=["']value["']/.test(html));
  check("optout-html-has-note-id", /id=["']note["']/.test(html));
  check("optout-html-has-result-id", /id=["']result["']/.test(html));
  check("optout-html-no-external-src", !/\bsrc\s*=\s*["']/i.test(html));
  check(
    "optout-html-title-text",
    /<title>Stop Leadscout from listing your business<\/title>/.test(html)
  );
  check(
    "optout-html-h1-text",
    /<h1>Stop Leadscout from listing your business<\/h1>/.test(html)
  );
}

// ---------------------------------------------------------------- summary

closeDb();
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup failures */ }

const failures = checks.filter((c) => !c.ok);
const overall = failures.length === 0 ? "PASS" : "FAIL";
console.log(`\n${overall}: ${checks.length - failures.length}/${checks.length} checks passed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail ?? ""}`);
  process.exit(1);
}
