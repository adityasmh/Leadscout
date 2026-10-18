// Offline check for the intake page (public/intake.html).
//
// No browser engine is available: the page's `loadFromData` source is extracted
// from the HTML and run against a plain state object, and the static HTML is
// inspected for the mock-banner CSS/visibility rules.
//
// Run: npx tsx src/intake-page-check.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.resolve(here, "..", "public", "intake.html");
const html = fs.readFileSync(HTML_PATH, "utf8");

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log("PASS: " + name);
  } catch (err) {
    failures++;
    console.log("FAIL: " + name + " -> " + (err instanceof Error ? err.message : String(err)));
  }
}

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

// --- extract the loadFromData function source from the page script --------
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error("could not find " + signature + " in intake.html");
  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      depth++;
      seenBrace = true;
    } else if (ch === "}") {
      depth--;
      if (seenBrace && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces while extracting " + signature);
}

const loadFromDataSource = extractFunction(html, "function loadFromData(data) {");

interface Section {
  id: string;
  title: string;
  letter: string;
  order: number;
  questions: unknown[];
}

interface CheckState {
  sections: Section[];
  answers: Record<string, unknown>;
  packs: unknown;
  prevBrief: unknown;
  index: number;
  compiled: unknown;
}

function freshState(): CheckState {
  return { sections: [], answers: {}, packs: null, prevBrief: null, index: 0, compiled: null };
}

function buildLoader(state: CheckState): (data: unknown) => void {
  const builder = new Function(
    "state",
    "applyServerFollowUps",
    loadFromDataSource + "\nreturn loadFromData;"
  ) as (s: CheckState, apply: (f: unknown) => void) => (data: unknown) => void;
  return builder(state, () => undefined);
}

// --- 1. flat server response: 6 questions across 2 sections, interleaved ---
check("flat response -> 2 sections grouped by first appearance with correct counts/titles", () => {
  const state = freshState();
  const q = (sectionId: string, sectionTitle: string, id: string) => ({
    id,
    sectionId,
    sectionTitle,
    text: "fixture " + id
  });
  const data = {
    workspaceId: "ws-fixture",
    questions: [
      q("seller", "Seller", "q1"),
      q("niche", "Niche", "q2"),
      q("seller", "Seller", "q3"),
      q("niche", "Niche", "q4"),
      q("seller", "Seller", "q5"),
      q("niche", "Niche", "q6")
    ],
    answers: { q1: "saved" }
  };
  buildLoader(state)(data);
  assert(state.sections.length === 2, "expected 2 sections, got " + state.sections.length);
  assert(state.sections[0].id === "seller", "section 0 id=" + state.sections[0].id);
  assert(state.sections[1].id === "niche", "section 1 id=" + state.sections[1].id);
  assert(state.sections[0].title === "Seller", "section 0 title=" + state.sections[0].title);
  assert(state.sections[1].title === "Niche", "section 1 title=" + state.sections[1].title);
  assert(state.sections[0].questions.length === 3, "section 0 count=" + state.sections[0].questions.length);
  assert(state.sections[1].questions.length === 3, "section 1 count=" + state.sections[1].questions.length);
  assert(state.sections[0].order === 0 && state.sections[1].order === 1, "section orders wrong");
  assert(state.sections[0].letter === "", "letter should be empty, got " + state.sections[0].letter);
});

// --- 2. flat response: missing sectionTitle falls back to sectionId --------
check("flat response -> empty sectionTitle falls back to sectionId", () => {
  const state = freshState();
  buildLoader(state)({
    questions: [
      { id: "a1", sectionId: "alpha", sectionTitle: "", text: "t" },
      { id: "b1", sectionId: "beta", text: "t" }
    ]
  });
  assert(state.sections[0].title === "alpha", "fallback title=" + state.sections[0].title);
  assert(state.sections[1].title === "beta", "fallback title=" + state.sections[1].title);
});

// --- 3. nested (old / mock) response still loads --------------------------
check("nested response (old shape) still loads unchanged", () => {
  const state = freshState();
  buildLoader(state)({
    questions: [
      {
        id: "seller",
        letter: "a",
        title: "Seller",
        order: 1,
        questions: [{ id: "s1", text: "t" }, { id: "s2", text: "t" }]
      },
      {
        id: "niche",
        letter: "c",
        title: "Niche",
        order: 2,
        questions: [{ id: "n1", text: "t" }]
      }
    ],
    state: { answers: { s1: "x" } }
  });
  assert(state.sections.length === 2, "expected 2 sections, got " + state.sections.length);
  assert(state.sections[0].id === "seller" && state.sections[0].questions.length === 2, "seller section wrong");
  assert(state.sections[1].id === "niche" && state.sections[1].questions.length === 1, "niche section wrong");
  assert(state.sections[0].letter === "a", "letter lost");
  assert(state.answers.s1 === "x", "nested state.answers not applied");
});

// --- 4. empty questions list still throws the readable error --------------
check("empty questions list throws the readable error", () => {
  const state = freshState();
  let message = "";
  try {
    buildLoader(state)({ questions: [] });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert(message.length > 0, "no error was thrown for an empty questions list");
  assert(/no questions/i.test(message), "error not readable: " + message);
});

// --- 5. saved answers: top-level `answers` accepted -----------------------
check("top-level answers object is accepted as saved answers", () => {
  const state = freshState();
  buildLoader(state)({
    questions: [{ id: "x1", sectionId: "a", sectionTitle: "A", text: "t" }],
    answers: { x1: "top-level" }
  });
  assert(state.answers.x1 === "top-level", "top-level answers not applied");
});

// --- 6. HTML contains the [hidden] display rule for the banner ------------
check("html contains #mock-banner[hidden] display:none rule", () => {
  assert(
    /#mock-banner\[hidden\]\s*\{\s*display:\s*none;?\s*\}/.test(html),
    "missing #mock-banner[hidden] { display: none; } rule"
  );
});

// --- 7. banner is shown only through the isMock branch --------------------
check("banner is shown only inside the isMock branch", () => {
  const marker = '$("mock-banner").hidden = false;';
  const occurrences = html.split(marker).length - 1;
  assert(occurrences === 1, "expected exactly one banner-show assignment, found " + occurrences);
  const at = html.indexOf(marker);
  const before = html.slice(Math.max(0, at - 120), at);
  assert(/if\s*\(\s*isMock\s*\)\s*\{/.test(before), "banner shown outside an isMock branch");
});

console.log("");
if (failures === 0) {
  console.log("ALL CHECKS PASSED");
} else {
  console.log(failures + " CHECK(S) FAILED");
  process.exitCode = 1;
}
