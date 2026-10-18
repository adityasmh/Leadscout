// src/phone-classify-check.ts
// PV1-phone-classify: offline table-driven check for classifyPhone (src/verify.ts).
// Every case names its input; prints one PASS/FAIL line per item plus one line
// for the 200-random-mobiles group. Exits non-zero on any failure.

import { classifyPhone } from "./verify.js";

type Expected = {
  input: string;
  result: "mobile" | "landline" | "invalid";
  e164?: string;
  reason?: string;
};

const cases: Expected[] = [
  // Bare 10-digit mobiles.
  { input: "9000100200", result: "mobile", e164: "+919000100200" },
  { input: "9000100300", result: "mobile", e164: "+919000100300" },
  { input: "98765 43210", result: "mobile", e164: "+919876543210" },
  { input: "98765-43210", result: "mobile", e164: "+919876543210" },
  { input: "(98765) 43210", result: "mobile", e164: "+919876543210" },
  // Single leading 0 dropped.
  { input: "09000100200", result: "mobile", e164: "+919000100200" },
  { input: "0 98765 43210", result: "mobile", e164: "+919876543210" },
  // +91 / 91 prefixed mobiles.
  { input: "+91 98765 43210", result: "mobile", e164: "+919876543210" },
  { input: "+919876543210", result: "mobile", e164: "+919876543210" },
  { input: "919876543210", result: "mobile", e164: "+919876543210" },
  { input: "91-9876543210", result: "mobile", e164: "+919876543210" },
  // 0-prefixed STD landlines.
  { input: "02212340001", result: "landline", e164: "+912212340001" },
  { input: "022 1234 0001", result: "landline", e164: "+912212340001" },
  { input: "(022) 12340001", result: "landline", e164: "+912212340001" },
  // +91 / 91 prefixed STD landlines.
  { input: "+91 22 1234 0001", result: "landline", e164: "+912212340001" },
  { input: "+912212340001", result: "landline", e164: "+912212340001" },
  { input: "912212340001", result: "landline", e164: "+912212340001" },
  // Other +91 STD form not starting 6-9 stays landline.
  { input: "+911124567890", result: "landline", e164: "+911124567890" },
  // Toll-free / service numbers.
  { input: "1800123456", result: "invalid", reason: "toll-free or service number" },
  { input: "1800 123 456", result: "invalid", reason: "toll-free or service number" },
  { input: "1860123456", result: "invalid", reason: "toll-free or service number" },
  { input: "1900123456", result: "invalid", reason: "toll-free or service number" },
  { input: "+911800123456", result: "invalid", reason: "toll-free or service number" },
  // Malformed input stays invalid.
  { input: "12345", result: "invalid" },
  { input: "abcdefghij", result: "invalid" },
  { input: "0000000000", result: "invalid" },
  { input: "5551234567", result: "invalid" },
  { input: "", result: "invalid" },
  // Non-Indian international keeps the generic behaviour.
  { input: "+44 20 7946 0958", result: "landline", e164: "+442079460958" },
];

let failures = 0;

for (const c of cases) {
  let got: { e164?: string; result: string; reason?: string };
  try {
    got = classifyPhone(c.input);
  } catch (err) {
    failures += 1;
    console.log(`FAIL classify ${JSON.stringify(c.input)} threw ${(err as Error).message}`);
    continue;
  }
  const resultOk = got.result === c.result;
  const e164Ok = c.e164 === undefined ? got.e164 === undefined : got.e164 === c.e164;
  const reasonOk = c.reason === undefined ? true : got.reason === c.reason;
  const ok = resultOk && e164Ok && reasonOk;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} classify ${JSON.stringify(c.input)} -> ${got.result} ${got.e164 ?? "-"} ${got.reason ?? ""}` +
      ` (expected ${c.result} ${c.e164 ?? "-"}${c.reason ? ` reason=${JSON.stringify(c.reason)}` : ""})`
  );
}

// Null-like text must never throw.
for (const v of [null, undefined] as unknown as string[]) {
  try {
    const got = classifyPhone(v);
    const ok = got.result === "invalid";
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"} classify ${String(v)} -> ${got.result} (expected invalid, never throw)`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL classify ${String(v)} threw ${(err as Error).message} (must never throw)`);
  }
}

// 200 random 10-digit strings starting 6-9: all mobile, e164 exactly 13 chars.
let randFails = 0;
let firstBad = "";
for (let i = 0; i < 200; i += 1) {
  const head = String(6 + Math.floor(Math.random() * 4));
  let rest = "";
  for (let j = 0; j < 9; j += 1) rest += String(Math.floor(Math.random() * 10));
  const digits = head + rest;
  const got = classifyPhone(digits);
  const ok = got.result === "mobile" && got.e164 === `+91${digits}` && (got.e164?.length ?? 0) === 13;
  if (!ok) {
    randFails += 1;
    if (!firstBad) firstBad = `${digits} -> ${got.result} ${got.e164 ?? "-"}`;
  }
}
failures += randFails;
console.log(
  `${randFails === 0 ? "PASS" : "FAIL"} random-200-mobiles all mobile with 13-char e164` +
    (randFails > 0 ? ` (${randFails} failed, first ${firstBad})` : "")
);

if (failures > 0) {
  console.log(`FAIL total ${failures} failing item(s)`);
  process.exit(1);
} else {
  console.log("PASS all phone-classify cases");
}
