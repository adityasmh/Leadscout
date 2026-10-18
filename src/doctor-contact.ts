// src/doctor-contact.ts - Order DR1-doctor-direct-contact.
// Pure decision-maker finder over already-fetched page text. No network calls,
// no DB access, never writes to the lead's main phone field, never invents a
// name or number: everything returned is exact text found on the pages.
// Phone normalisation reuses the product's existing helper (enrich.normalizePhone;
// verify.ts classifyPhone and resolve.ts canonicalPhone were read first and do the
// same job with heavier dependencies, so no second parser is written here).
// Node 24 built-ins only, ES module, .js import suffixes.

import { normalizePhone } from "./enrich.js";
import type { Evidence } from "./types-v2.js";
import type { ResearchEvidence } from "./research.js";

export type DoctorPage = { url: string; title?: string; body: string; fetchedAt?: string };
export type DoctorLead = { name?: string };
export type DoctorNumberRole = "desk" | "direct" | "unknown";
export type DoctorNumber = {
  phone: string;
  role: DoctorNumberRole;
  confidence: number;
  source: string;
  quote: string;
};
export type WhatsappLink = { url: string; role: "direct" | "desk"; source: string; quote: string };
export type DoctorSocial = {
  platform: "instagram" | "facebook" | "linkedin";
  url: string;
  owner: "doctor" | "clinic";
};
export type DecisionMaker = {
  name?: string;
  title?: string;
  evidenceNote: string;
  numbers: DoctorNumber[];
  whatsappLinks: WhatsappLink[];
  socials: DoctorSocial[];
  found: boolean;
};

const DR_NAME_RE = /\bDr\.?\s+[A-Z][A-Za-z\u00C0-\u024F]*(?:\s+[A-Z][A-Za-z\u00C0-\u024F]*){0,2}/;
const SPECIALTY_RE =
  /\b(BDS|MDS|MBBS|dentist|dental surgeon|orthodontist|dermatologist|pediatrician|gynaecologist|gynecologist|cardiologist|surgeon|physician)\b/i;
const ABOUT_RE = /about|meet the doctor/i;
const PHONE_CANDIDATE_RE = /\+?\d[\d\s().-]{7,21}\d/g;
const WA_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:wa\.me\/(\d{7,15})|api\.whatsapp\.com\/send\?phone=(\d{7,15}))/gi;
const SOCIAL_RE = /https?:\/\/[^\s"'<>()]*?(instagram\.com|facebook\.com|linkedin\.com)(\/[^\s"'<>()]*)?/gi;
const DESK_WORDS = [
  "reception",
  "appointment",
  "booking",
  "enquiry",
  "front desk",
  "helpline",
  "clinic",
];
const DIRECT_WORDS = ["mobile", "personal", "direct", "whatsapp me"];
const DOCTOR_CONTACT_KIND = "doctor-contact" as Evidence["kind"];

function collapse(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function clip(s: string, max: number): string {
  const t = collapse(s);
  return t.length <= max ? t : t.slice(0, max).trim();
}

function surnameOf(name: string): string {
  const parts = String(name ?? "")
    .replace(/^Dr\.?\s+/i, "")
    .split(/[^A-Za-z]+/)
    .filter(Boolean);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

function hasDeskWord(hayLower: string): boolean {
  return DESK_WORDS.some((w) => hayLower.includes(w));
}

/** Gate a raw candidate through the existing phone helper; undefined = not a phone. */
function normaliseNumber(raw: string): string | undefined {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) return undefined;
  let cand = String(raw ?? "").trim();
  if (!cand.startsWith("+") && digits.length === 12 && digits.startsWith("91")) cand = `+${digits}`;
  return normalizePhone(cand);
}

function findName(lead: DoctorLead, pages: DoctorPage[]): string | undefined {
  const fromLead = DR_NAME_RE.exec(String(lead?.name ?? ""));
  if (fromLead) return fromLead[0];
  for (const p of pages) {
    const m = DR_NAME_RE.exec(String(p?.title ?? ""));
    if (m) return m[0];
  }
  for (const p of pages) {
    const body = String(p?.body ?? "");
    const at = body.search(ABOUT_RE);
    if (at === -1) continue;
    const m = DR_NAME_RE.exec(body.slice(at, at + 800));
    if (m) return m[0];
  }
  return undefined;
}

function findTitle(name: string, lead: DoctorLead, pages: DoctorPage[]): string | undefined {
  const combined = [String(lead?.name ?? ""), ...pages.map((p) => `${p?.title ?? ""}\n${p?.body ?? ""}`)].join("\n");
  const at = combined.indexOf(name);
  if (at === -1) return undefined;
  const m = SPECIALTY_RE.exec(combined.slice(Math.max(0, at - 150), at + 150));
  return m ? m[0] : undefined;
}

function lineOf(text: string, idx: number): string {
  const start = text.lastIndexOf("\n", idx - 1) + 1;
  let end = text.indexOf("\n", idx);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

function scanNumbers(name: string | undefined, pages: DoctorPage[]): DoctorNumber[] {
  const surname = name ? surnameOf(name) : "";
  const byDigits = new Map<string, DoctorNumber>();
  for (const p of pages) {
    const text = `${String(p?.title ?? "")}\n${String(p?.body ?? "")}`;
    PHONE_CANDIDATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PHONE_CANDIDATE_RE.exec(text)) !== null) {
      const phone = normaliseNumber(m[0]);
      if (!phone) continue;
      const idx = m.index;
      const before80 = text.slice(Math.max(0, idx - 80), idx).toLowerCase();
      const nearby = text.slice(Math.max(0, idx - 80), idx + m[0].length + 80).toLowerCase();
      const label = lineOf(text, idx).toLowerCase();
      const quote = clip(text.slice(Math.max(0, idx - 60), idx + m[0].length + 60), 120);
      let role: DoctorNumberRole = "unknown";
      if (hasDeskWord(label) || hasDeskWord(before80)) {
        role = "desk";
      } else if (
        (surname && surname.length >= 2 && nearby.includes(surname)) ||
        nearby.includes("dr.") ||
        DIRECT_WORDS.some((w) => nearby.includes(w))
      ) {
        role = "direct";
      }
      const entry: DoctorNumber = {
        phone,
        role,
        confidence: role === "direct" ? 0.8 : role === "unknown" ? 0.4 : 0.2,
        source: String(p?.url ?? ""),
        quote,
      };
      const key = phone.replace(/\D/g, "");
      const prev = byDigits.get(key);
      if (!prev || entry.confidence > prev.confidence) byDigits.set(key, entry);
    }
  }
  return [...byDigits.values()];
}

function scanWhatsapp(pages: DoctorPage[]): WhatsappLink[] {
  const seen = new Map<string, WhatsappLink>();
  for (const p of pages) {
    const text = `${String(p?.title ?? "")}\n${String(p?.body ?? "")}`;
    WA_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WA_RE.exec(text)) !== null) {
      const digits = String(m[1] ?? m[2] ?? "").replace(/\D/g, "");
      if (!digits) continue;
      const nearby = text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80).toLowerCase();
      const quote = clip(text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60), 120);
      const url = `https://wa.me/${digits}`;
      if (!seen.has(digits)) {
        seen.set(digits, {
          url,
          role: hasDeskWord(nearby) ? "desk" : "direct",
          source: String(p?.url ?? ""),
          quote,
        });
      }
    }
  }
  return [...seen.values()];
}

function scanSocials(name: string | undefined, pages: DoctorPage[]): DoctorSocial[] {
  const surname = name ? surnameOf(name) : "";
  const seen = new Map<string, DoctorSocial>();
  for (const p of pages) {
    const text = `${String(p?.title ?? "")}\n${String(p?.body ?? "")}`;
    SOCIAL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SOCIAL_RE.exec(text)) !== null) {
      const url = m[0];
      const host = String(m[1] ?? "").toLowerCase();
      const path = String(m[2] ?? "");
      if (host.includes("linkedin") && !/\/in\//i.test(path)) continue;
      const platform: DoctorSocial["platform"] = host.includes("instagram")
        ? "instagram"
        : host.includes("facebook")
          ? "facebook"
          : "linkedin";
      // Owner comes from the link handle only (never nearby page text, which would
      // leak a doctor's name from an adjacent link onto a clinic profile).
      const handleLower = path.toLowerCase();
      const handleOwner =
        surname &&
        surname.length >= 2 &&
        (handleLower.includes(surname) || handleLower.includes(name!.toLowerCase().replace(/^dr\.?\s+/i, "").replace(/\s+/g, "")));
      const key = url.toLowerCase();
      if (!seen.has(key)) seen.set(key, { platform, url, owner: handleOwner ? "doctor" : "clinic" });
    }
  }
  return [...seen.values()];
}

/** Pure: find the decision maker (doctor) and direct routes from already-fetched page text. */
export function findDecisionMaker(
  lead: DoctorLead,
  pages: DoctorPage[],
  options?: { maxNumbers?: number }
): DecisionMaker {
  const safePages = Array.isArray(pages) ? pages : [];
  const name = findName(lead ?? {}, safePages);
  const title = name ? findTitle(name, lead ?? {}, safePages) : undefined;
  let numbers = scanNumbers(name, safePages);
  if (options?.maxNumbers !== undefined) numbers = numbers.slice(0, Math.max(0, options.maxNumbers));
  const whatsappLinks = scanWhatsapp(safePages);
  const socials = scanSocials(name, safePages);
  const isFound = Boolean(name) || numbers.length > 0 || whatsappLinks.length > 0 || socials.length > 0;
  let evidenceNote: string;
  if (!isFound) {
    evidenceNote = "No doctor direct contact found on the pages checked.";
  } else {
    const parts: string[] = [];
    if (name) parts.push(`Doctor ${name} identified`);
    const direct = numbers.filter((n) => n.role === "direct").length;
    if (direct > 0) parts.push(`${direct} direct number${direct === 1 ? "" : "s"}`);
    if (whatsappLinks.length > 0)
      parts.push(`${whatsappLinks.length} WhatsApp link${whatsappLinks.length === 1 ? "" : "s"}`);
    const doctorOwned = socials.filter((s) => s.owner === "doctor").length;
    if (doctorOwned > 0) parts.push(`${doctorOwned} doctor social profile${doctorOwned === 1 ? "" : "s"}`);
    if (parts.length === 0) parts.push(`${numbers.length} clinic number${numbers.length === 1 ? "" : "s"} (front desk)`);
    evidenceNote = `${parts.join("; ")}; quotes from clinic pages.`;
  }
  return { name, title, evidenceNote, numbers, whatsappLinks, socials, found: isFound };
}

/** Map a found decision maker to evidence items (kind "doctor-contact"); [] when not found. */
export function toEvidence(result: DecisionMaker, fetchedAt?: string): ResearchEvidence[] {
  if (!result?.found) return [];
  const at = fetchedAt ?? new Date().toISOString();
  const out: ResearchEvidence[] = [];
  if (result.name) {
    out.push({
      id: "",
      kind: DOCTOR_CONTACT_KIND,
      url: result.numbers[0]?.source ?? result.whatsappLinks[0]?.source ?? result.socials[0]?.url ?? "",
      quote: result.name,
      field: "doctor-name",
      fetchedAt: at,
      channel: "doctor-contact",
      untrusted: true,
    });
  }
  for (const n of result.numbers) {
    if (n.role !== "direct") continue;
    out.push({
      id: "",
      kind: DOCTOR_CONTACT_KIND,
      url: n.source,
      quote: n.quote,
      field: "doctor-direct-phone",
      fetchedAt: at,
      channel: "doctor-contact",
      untrusted: true,
    });
  }
  for (const w of result.whatsappLinks) {
    out.push({
      id: "",
      kind: DOCTOR_CONTACT_KIND,
      url: w.source,
      quote: w.url,
      field: "doctor-whatsapp",
      fetchedAt: at,
      channel: "doctor-contact",
      untrusted: true,
    });
  }
  for (const s of result.socials) {
    out.push({
      id: "",
      kind: DOCTOR_CONTACT_KIND,
      url: s.url,
      quote: s.url,
      field: "doctor-social",
      fetchedAt: at,
      channel: "doctor-contact",
      untrusted: true,
    });
  }
  return out;
}
