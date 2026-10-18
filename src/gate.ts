// src/gate.ts
// Order LG2-gate-delivery: the quality gate every delivered lead must pass before it
// can reach a human caller's daily call sheet.
//
// gateLead(lead, ctx) -> { pass, reasons, callable, phone, tags }
//   - business name present;
//   - at least one phone the verifier marks mobile or landline (never invalid),
//     normalised to +91 (the verifier's classifyPhone does the normalisation);
//   - not a duplicate of a lead already delivered to this workspace: by business key
//     (evidence.ts bizKey) AND by phone;
//   - not a chain branch when the workspace excludes chains. The chain rule reuses the
//     pipeline S1 brief-exclusion rule (pipeline.ts:435-448): when the workspace's
//     exclusion terms include "chains", a lead whose "name category" text contains a
//     chain exclusion term is dropped. It is not rewritten here;
//   - not on the operator-provided do-not-call screen: reads data/dnd/*.csv (one column
//     of numbers, normalised like lead phones). A match is tagged "dnd" and is not
//     callable; when no file exists every lead is tagged "dnd-unchecked". The module
//     NEVER downloads any registry and NEVER invents a pass.
//
// Everything that leaves the process is injected through `ctx`, so checks run offline:
// the verifier is injected (default is verify.ts classifyPhone, a pure function).
// Node 24 built-ins only, ES module, .js import suffix.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyPhone } from "./verify.js";
import { bizKey } from "./evidence.js";
import type { Lead } from "./types.js";

/** Result of the verifier's phone check (verify.ts classifyPhone). */
export type PhoneVerdict = { e164?: string; result: "mobile" | "landline" | "invalid"; reason?: string };
export type Verifier = (phone: string) => PhoneVerdict;

export type GateCtx = {
  /** Phone verifier. Default: verify.ts classifyPhone (pure, offline). */
  verifier?: Verifier;
  /** Business keys of leads already delivered to this workspace. */
  deliveredBizKeys?: Iterable<string>;
  /** Phones (any form) of leads already delivered to this workspace. */
  deliveredPhones?: Iterable<string>;
  /** Workspace exclusion terms from the intake brief. A term matching /chain/ switches the chain rule on. */
  exclusions?: string[];
  /** Folder holding operator DND exports (one-column *.csv). Default: data/dnd. */
  dndDir?: string;
  /** Pre-loaded DND numbers (offline checks); when given the folder is not read. */
  dndNumbers?: Iterable<string>;
  /** Set false to skip the DND folder read entirely (same effect as "no file"). */
  readDnd?: boolean;
  now?: () => Date;
};

export type GateResult = {
  pass: boolean;
  reasons: string[];
  callable: boolean;
  phone: string | null;
  tags: string[];
};

/** data/dnd, resolved from this module so it works from any cwd. */
export const DEFAULT_DND_DIR = fileURLToPath(new URL("../data/dnd/", import.meta.url));

const CHAIN_TERM = /chain/i;

// ------------------------------------------------------------------ helpers

function allLeadPhones(lead: Lead): string[] {
  const out: string[] = [];
  if (lead.phone && lead.phone.trim() !== "") out.push(lead.phone);
  for (const phone of lead.phones ?? []) {
    if (typeof phone === "string" && phone.trim() !== "" && !out.includes(phone)) out.push(phone);
  }
  return out;
}

/**
 * The canonical comparison key for a phone, used for duplicate and DND matching. Uses the
 * verifier's E.164 when it has one; otherwise falls back to the same +91 normalisation of
 * the digits, so a bare 10-digit operator export still matches the equivalent lead phone.
 */
function phoneKey(value: string, verifier: Verifier): string {
  const verdict = verifier(value);
  if (verdict.e164) return verdict.e164;
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  return digits;
}

/** Chain exclusion terms present in the workspace's exclusion list. */
export function chainTermsOf(exclusions: string[] | undefined): string[] {
  return (exclusions ?? [])
    .map((term) => String(term ?? "").trim().toLowerCase())
    .filter((term) => term.length >= 2 && CHAIN_TERM.test(term));
}

/**
 * Reuses the pipeline S1 chain rule (pipeline.ts:446-448): a lead is a chain branch when
 * its "name category" text contains one of the workspace's chain exclusion terms. Returns
 * false when the workspace does not exclude chains.
 */
export function isChainBranch(lead: Pick<Lead, "name" | "category">, chainTerms: string[]): boolean {
  if (chainTerms.length === 0) return false;
  const haystack = `${lead.name ?? ""} ${lead.category ?? ""}`.toLowerCase();
  return chainTerms.some((term) => haystack.includes(term));
}

/** The .csv files in a DND folder, or [] when the folder is missing/has none. */
function dndCsvFiles(dir: string): string[] {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".csv"));
  } catch {
    return [];
  }
}

/** True when at least one operator-provided DND export exists, so the screen ran. */
export function hasDndSource(dir?: string): boolean {
  return dndCsvFiles(dir ?? DEFAULT_DND_DIR).length > 0;
}

/** Reads data/dnd/*.csv, one number per line (first column only). Never downloads anything. */
function readDndFolder(dir: string): { numbers: Set<string>; checked: boolean } {
  const numbers = new Set<string>();
  const entries = dndCsvFiles(dir);
  if (entries.length === 0) return { numbers, checked: false };
  for (const name of entries) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const cell = line.trim().split(",")[0].trim();
      if (cell === "" || cell.startsWith("#")) continue;
      if (!/\d/.test(cell)) continue; // skip a header row and any non-numeric text
      numbers.add(cell);
    }
  }
  return { numbers, checked: entries.length > 0 };
}

// ------------------------------------------------------------------ gateLead

/**
 * Gates one lead. Pure unless `ctx.dndDir` points at files on disk. Returns the pass
 * decision, the human-readable reasons, whether the lead is callable, the normalised
 * +91 phone and the tags shown on the call sheet.
 */
export function gateLead(lead: Lead, ctx: GateCtx = {}): GateResult {
  const verifier: Verifier = ctx.verifier ?? classifyPhone;
  const reasons: string[] = [];
  const tags = new Set<string>();

  // 1. Business name.
  const name = typeof lead.name === "string" ? lead.name.trim() : "";
  if (name === "") reasons.push("no business name");

  // 2. A phone the verifier marks mobile or landline, normalised to +91.
  const phones = allLeadPhones(lead);
  let phone: string | null = null;
  for (const candidate of phones) {
    const verdict = verifier(candidate);
    if ((verdict.result === "mobile" || verdict.result === "landline") && verdict.e164) {
      phone = verdict.e164;
      break;
    }
  }
  if (phone === null) {
    reasons.push(
      phones.length === 0
        ? "no phone on the lead"
        : "no phone the verifier marks mobile or landline"
    );
  }

  // 3. Duplicates: already delivered to this workspace by business key AND by phone.
  const deliveredBizKeys = new Set<string>(ctx.deliveredBizKeys ?? []);
  const deliveredPhoneKeys = new Set<string>(
    [...(ctx.deliveredPhones ?? [])].map((value) => phoneKey(String(value), verifier))
  );
  if (name !== "") {
    const key = bizKey(lead, phone ? [phone] : []);
    if (deliveredBizKeys.has(key)) {
      reasons.push(`duplicate of an already-delivered lead (business key ${key})`);
      tags.add("duplicate");
    }
  }
  for (const candidate of phones) {
    const key = phoneKey(candidate, verifier);
    if (key !== "" && deliveredPhoneKeys.has(key)) {
      reasons.push(`duplicate of an already-delivered lead (phone ${key})`);
      tags.add("duplicate");
      break;
    }
  }

  // 4. Chain branch, only when the workspace excludes chains (reuses the pipeline rule).
  const chainTerms = chainTermsOf(ctx.exclusions);
  if (isChainBranch(lead, chainTerms)) {
    reasons.push("chain branch (workspace excludes chains)");
    tags.add("chain-branch");
  }

  // 5. Operator-provided do-not-call screen. The code never downloads a registry.
  let dndChecked: boolean;
  let dndKeys: Set<string>;
  if (ctx.dndNumbers !== undefined) {
    dndChecked = true;
    dndKeys = new Set([...ctx.dndNumbers].map((value) => phoneKey(String(value), verifier)));
  } else if (ctx.readDnd === false) {
    dndChecked = false;
    dndKeys = new Set();
  } else {
    const loaded = readDndFolder(ctx.dndDir ?? DEFAULT_DND_DIR);
    dndChecked = loaded.checked;
    dndKeys = new Set([...loaded.numbers].map((value) => phoneKey(value, verifier)));
  }
  if (!dndChecked) {
    tags.add("dnd-unchecked");
  } else {
    const leadKeys = new Set(phones.map((value) => phoneKey(value, verifier)));
    const onDnd = [...leadKeys].some((key) => key !== "" && dndKeys.has(key));
    if (onDnd) {
      reasons.push("on the do-not-call list (DND)");
      tags.add("dnd");
    }
  }

  const pass = reasons.length === 0;
  return { pass, reasons, callable: pass, phone, tags: [...tags] };
}
