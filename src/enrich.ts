// src/enrich.ts
// L4-enrich: learn what a business does from its own website.
//
//   enrich(lead, deps)               fetch robots.txt + the homepage + (when linked) one contact
//                                    page and one about page, then build an Enrichment from the
//                                    fetched text only. Network access goes through deps.fetchFn,
//                                    so the proof suite runs offline.
//   extractContacts(html)            emails (plain, mailto:, obfuscated), phones (Indian formats and
//                                    international E.164), wa.me / api.whatsapp.com numbers.
//   extractSocials(html)             linkedin / instagram / facebook / twitter / youtube / whatsapp.
//   detectSignals(html, headers,url) every CONTRACT signal id that can be read off a page.
//   summarize(html)                  1 to 2 sentences built only from title, meta description,
//                                    og:description and the first headings.
//
// Politeness limits, per the order: max 3 pages, 8 second timeout each, 1.5 MB cap per page,
// User-Agent "Leadscout/0.1", robots.txt respected.
//
// Node 24 built-ins only, ES module, .js import suffixes. Types come from the CONTRACT through
// ./types.js (worker L2 owns that file).

import { Buffer } from "node:buffer";
import type { RawLead, Enrichment } from "./types.js";

export const USER_AGENT = "Leadscout/0.1";
export const MAX_BYTES = 1_572_864; // 1.5 MB per page
export const PAGE_TIMEOUT_MS = 8000;
export const MAX_PAGES = 3; // homepage + one contact page + one about page
export const SLOW_RESPONSE_MS = 3000; // homepage slower than this gets the slow-response signal

export type FetchFn = typeof fetch;
export type Deps = { fetchFn?: FetchFn };
export type Socials = Enrichment["socials"];
export type Contacts = { emails: string[]; phones: string[]; whatsapp: string[] };

export type PageFacts = {
  https: boolean;
  viewport: boolean;
  contactForm: boolean;
  chatWidget: boolean;
  bookingWidget: boolean;
  analytics: boolean;
  copyrightYear?: number;
  outdatedCopyright: boolean;
  cms?: "wordpress" | "wix" | "shopify" | "other";
  ecommerce: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
  hasWhatsapp: boolean;
  socialActive: boolean;
};

export type RobotRule = { allow: boolean; path: string; pattern: RegExp };

// --------------------------------------------------------------------------- small text helpers

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026",
};

export function decodeEntities(input: string): string {
  return String(input ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, ent: string) => {
    if (ent.charAt(0) === "#") {
      const hex = ent.charAt(1) === "x" || ent.charAt(1) === "X";
      const code = parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[ent.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

function collapse(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** HTML to one line of readable text (script/style/comments dropped, entities decoded). */
export function stripTags(html: string): string {
  return collapse(
    decodeEntities(
      String(html ?? "")
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]*>/g, " "),
    ),
  );
}

const MARKDOWN_IMAGE_RE = /!\[[^\]\n]*\]\([^()\n]*\)/g;
const MARKDOWN_LINK_RE = /\[([^\[\]\n]*)\]\([^()\n]*\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)]+/g;
const WWW_URL_RE = /(^|[\s(])www\.[^\s)]+/g;
const CONTACT_TARGET_RE = /\b(?:mailto|tel):[^\s)]+/gi;
const REPEATED_PUNCT_RE = /([!?.,;:])\1+/g;

/**
 * Reader markdown to plain words. Turns [label](url) into label, drops images,
 * bare urls, mailto:/tel: targets, table pipes, bullet and heading marks and
 * extra whitespace. Never throws; non-string input returns "".
 */
export function stripMarkdown(text: string): string {
  if (typeof text !== "string") return "";
  let out = text;
  out = out.replace(MARKDOWN_IMAGE_RE, " ");
  let next = out.replace(MARKDOWN_LINK_RE, "$1");
  for (let i = 0; i < 2 && next !== out; i++) {
    out = next;
    next = out.replace(MARKDOWN_LINK_RE, "$1");
  }
  out = next;
  out = out.replace(BARE_URL_RE, " ");
  out = out.replace(WWW_URL_RE, "$1 ");
  out = out.replace(CONTACT_TARGET_RE, " ");
  out = out.replace(/\|/g, " ");
  out = out.replace(/\*/g, " ");
  out = out.replace(/[#<>]/g, " ");
  out = out.replace(/^[ \t]*-[ \t]+/gm, " ");
  out = out.replace(/[ \t]-[ \t]/g, " ");
  out = out.replace(REPEATED_PUNCT_RE, "$1");
  return collapse(out);
}

const NAV_WORDS = new Set([
  "home", "about", "us", "contact", "menu", "login", "sign", "signin", "signup",
  "up", "services", "service", "products", "product", "blog", "careers", "career",
  "privacy", "terms", "policy", "facebook", "twitter", "instagram", "linkedin",
  "youtube", "follow", "share", "search", "sitemap",
]);

const NAV_PREFIX_RE =
  /^(?:(?:home|about(?:\s+us)?|contact(?:\s+us)?|menu|log\s*in|sign\s*(?:in|up)?|services?|products?|blog|careers?|privacy(?:\s+policy)?|terms|facebook|twitter|instagram|linkedin|youtube|follow(?:\s+us)?|share|search|sitemap)\b[\s,|*.>\-]*)+/i;

function letterWordCount(sentence: string): number {
  let count = 0;
  for (const word of sentence.split(/\s+/)) {
    if (/[A-Za-z]/.test(word)) count++;
  }
  return count;
}

function isNavOnly(sentence: string): boolean {
  const words = sentence.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((word) => NAV_WORDS.has(word));
}

function cutAtWordBoundary(text: string, max: number): string {
  const value = text.trim();
  if (value.length <= max) return value;
  const slice = value.slice(0, max + 1);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 0) return slice.slice(0, lastSpace).trimEnd();
  return value.slice(0, max).trimEnd();
}

/** First sentence of at least 40 chars with at least 5 letter-words, or "". */
function selectCleanSentence(cleaned: string): string {
  for (const raw of splitSentences(cleaned)) {
    const sentence = raw.replace(NAV_PREFIX_RE, "").trim();
    if (sentence.length < 40) continue;
    if (letterWordCount(sentence) < 5) continue;
    if (isNavOnly(sentence)) continue;
    return cutAtWordBoundary(sentence, 280);
  }
  return "";
}

/** Lowercase words that read like a business describing itself (never navigation filler). */
const VERB_WORDS = new Set([
  "is", "are", "was", "were", "be", "been", "being",
  "has", "have", "had", "offers", "offer", "offering",
  "provides", "provide", "providing", "serves", "serve", "serving",
  "sells", "sell", "selling", "builds", "build", "building",
  "makes", "make", "making", "manages", "manage", "managing",
  "designs", "design", "creates", "create", "creating",
  "runs", "run", "running", "operates", "operate",
  "helps", "help", "supports", "support",
  "includes", "include", "including", "features", "featuring",
  "specializes", "specialises",
]);

/** First word of a stripped candidate, lowercased without punctuation. */
function firstWord(candidate: string): string {
  const words = String(candidate ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  return words[0].toLowerCase().replace(/[^a-z]/g, "");
}

/** True when a stripped candidate reads like a real business paragraph (order MD2 rule 2). */
function isRealParagraph(candidate: string): boolean {
  const value = String(candidate ?? "").trim();
  if (value.length < 80) return false;
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 12) return false;
  const letters = (value.match(/[A-Za-z ]/g) ?? []).length;
  if (value.length === 0 || letters / value.length < 0.7) return false;
  if (NAV_WORDS.has(firstWord(value))) return false;
  for (const word of words) {
    if (word !== word.toLowerCase()) continue;
    const clean = word.toLowerCase().replace(/[^a-z]/g, "");
    if (clean.length < 2) continue;
    if (VERB_WORDS.has(clean)) return true;
  }
  return false;
}

/** First real paragraph (order MD2 rule 2): stripped, de-prefixed, cut at 280, else "". */
function selectRealParagraph(text: string): string {
  const blocks = String(text ?? "").split(/\r?\n+/);
  const candidates: string[] = [];
  for (const block of blocks) {
    const stripped = stripMarkdown(block).trim();
    if (stripped) candidates.push(stripped);
  }
  if (candidates.length === 0) {
    const fallback = stripMarkdown(String(text ?? "")).trim();
    if (fallback) candidates.push(fallback);
  }
  for (const candidate of candidates) {
    const deprefixed = candidate.replace(NAV_PREFIX_RE, "").trim();
    if (!deprefixed) continue;
    for (const raw of splitSentences(deprefixed)) {
      const sentence = raw.trim();
      if (isRealParagraph(sentence)) return cutAtWordBoundary(sentence, 280);
    }
    if (isRealParagraph(deprefixed)) return cutAtWordBoundary(deprefixed, 280);
  }
  return "";
}

/** Meta description for a summary (order MD2 rule 1): og then meta, stripped, cut at 280, else "". */
function selectMetaSummary(html: string): string {
  const og = metaContent(html, (meta) => meta.property === "og:description" || meta.name === "og:description");
  const desc = metaContent(html, (meta) => meta.name === "description");
  for (const raw of [og, desc]) {
    if (!raw) continue;
    const candidate = stripMarkdown(collapse(raw)).trim();
    if (candidate.length < 40) continue;
    if (isNavOnly(candidate)) continue;
    return cutAtWordBoundary(candidate, 280);
  }
  return "";
}

/** HTML to readable text that keeps line breaks (used for phones, so numbers on separate lines never merge). */
function visibleText(html: string): string {
  const stripped = String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "\n")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped);
}

function parseAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+))|([a-zA-Z_:][-a-zA-Z0-9_:.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) {
    if (m[1]) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    else if (m[5]) out[m[5].toLowerCase()] = "";
  }
  return out;
}

function metaTags(html: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const re = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(html ?? "")))) {
    const a = parseAttributes(m[0]);
    const rec: Record<string, string> = {};
    if (a.name) rec.name = a.name.toLowerCase();
    if (a.property) rec.property = a.property.toLowerCase();
    if (a["http-equiv"]) rec.httpEquiv = a["http-equiv"].toLowerCase();
    if (a.content !== undefined) rec.content = a.content;
    if (a.charset) rec.charset = a.charset;
    out.push(rec);
  }
  return out;
}

function hrefs(html: string): string[] {
  const out: string[] = [];
  const re = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(html ?? "")))) {
    const value = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
    if (value) out.push(value);
  }
  return out;
}

function absoluteUrl(href: string): URL | undefined {
  const raw = String(href ?? "").trim();
  if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(raw)) return undefined;
  const withScheme = raw.startsWith("//") ? "https:" + raw : raw;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function resolveUrl(href: string, base: URL): URL | undefined {
  const raw = String(href ?? "").trim();
  if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(raw)) return undefined;
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function toHeaderRecord(input?: Record<string, string> | Headers | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (typeof input === "object") {
    for (const [key, value] of Object.entries(input)) {
      out[String(key).toLowerCase()] = String(value);
    }
  }
  return out;
}

// --------------------------------------------------------------------------- contacts

const EMAIL_RE = /[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}/g;
const PHONE_RE = /(\(?\+?\d(?:[ \t\-().]*\d){5,})/g;

const IMAGE_TLDS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif", "tif", "tiff", "apng", "jfif",
  "css", "js", "woff", "woff2", "ttf", "eot", "mp4", "webm", "mp3", "pdf",
]);
const PLACEHOLDER_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "yourdomain.com", "your-domain.com", "domain.com",
  "email.com", "yourcompany.com", "mycompany.com", "companyname.com", "site.com", "website.com", "test.com",
]);
const PLACEHOLDER_LOCALS = new Set([
  "your", "you", "youremail", "your-email", "youremailaddress", "yourname", "name", "email",
  "emailaddress", "username", "user", "someone", "example", "test", "demo", "abc",
]);

function isEmail(value: string): boolean {
  const email = String(value ?? "").trim();
  if (email.length < 6 || email.length > 254) return false;
  if (!/^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) return false;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (IMAGE_TLDS.has(tld)) return false; // logo@2x.png and friends
  if (/(^|[._+-])\d+(\.\d+)?x$/i.test(local)) return false; // retina asset suffix
  if (PLACEHOLDER_DOMAINS.has(domain)) return false;
  if (PLACEHOLDER_LOCALS.has(local.toLowerCase())) return false;
  return true;
}

function deobfuscate(text: string): string {
  return String(text ?? "")
    .replace(/[ \t]*[\[({][ \t]*(?:at|@)[ \t]*[\])}][ \t]*/gi, "@")
    .replace(/[ \t]*[\[({][ \t]*(?:dot|\.)[ \t]*[\])}][ \t]*/gi, ".");
}

/** Normalise an Indian or international number to one canonical string, or drop it. */
export function normalizePhone(raw: string): string | undefined {
  const value = String(raw ?? "").trim();
  if (!value) return undefined;
  const plus = value.startsWith("+");
  const digits = value.replace(/\D/g, "");
  if (!digits) return undefined;
  if (plus) {
    if (digits.length < 8 || digits.length > 15) return undefined;
    if (digits.startsWith("0")) return undefined;
    return "+" + digits;
  }
  if (digits.length === 10 && /^[6-9]/.test(digits)) return digits; // Indian mobile
  if (digits.startsWith("0") && digits.length >= 10 && digits.length <= 12) return digits; // 0xx-xxxxxxx
  return undefined;
}

function phoneKey(phone: string): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function whatsappFromHref(href: string): string | undefined {
  const url = absoluteUrl(href);
  if (!url) return undefined;
  const host = url.host.replace(/^www\./i, "").toLowerCase();
  if (host !== "wa.me" && host !== "api.whatsapp.com" && host !== "web.whatsapp.com" && host !== "web.whatsapp.com") {
    if (host !== "chat.whatsapp.com" && host !== "whatsapp.com") return undefined;
  }
  let digits = "";
  const phone = url.searchParams.get("phone");
  if (phone) digits = phone.replace(/\D/g, "");
  else {
    const m = url.pathname.match(/(\d{7,15})/);
    if (m) digits = m[1];
  }
  if (digits.length >= 7 && digits.length <= 15) return `https://wa.me/${digits}`;
  return undefined;
}

/**
 * Emails (plain, mailto:, obfuscated like "name [at] domain [dot] com"), phones (Indian formats and
 * international E.164) and WhatsApp links. Image file names and obvious template fields are dropped.
 */
export function extractContacts(html: string): Contacts {
  const raw = String(html ?? "");
  const text = visibleText(raw);
  const emails: string[] = [];
  const phones: string[] = [];
  const whatsapp: string[] = [];
  const seenEmail = new Set<string>();
  const seenPhone = new Set<string>();

  const addEmail = (candidate: string): void => {
    const value = String(candidate ?? "").replace(/^mailto:/i, "").split(/[?#]/)[0].trim();
    if (!isEmail(value)) return;
    const key = value.toLowerCase();
    if (seenEmail.has(key)) return;
    seenEmail.add(key);
    emails.push(value);
  };

  const addPhone = (candidate: string): void => {
    const normalized = normalizePhone(candidate);
    if (!normalized) return;
    const key = phoneKey(normalized);
    if (seenPhone.has(key)) return;
    seenPhone.add(key);
    phones.push(normalized);
  };

  for (const href of hrefs(raw)) {
    if (/^mailto:/i.test(href)) {
      const value = href.slice(href.indexOf(":") + 1);
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        decoded = value;
      }
      addEmail(decoded);
      continue;
    }
    if (/^tel:/i.test(href)) {
      const value = href.slice(href.indexOf(":") + 1);
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        decoded = value;
      }
      addPhone(decoded);
      continue;
    }
    const wa = whatsappFromHref(href);
    if (wa) {
      if (!whatsapp.includes(wa)) whatsapp.push(wa);
      const digits = wa.replace(/\D/g, "");
      addPhone("+" + digits);
    }
  }

  // Cheap guard: a page with no "@" and no bracketed "at" cannot hold an email address, and the
  // guard keeps a multi-megabyte page of plain text from being rescanned character by character.
  if (raw.includes("@") || /[\[(][ \t]*at[ \t]*[\])]/i.test(text)) {
    for (const match of deobfuscate(text).matchAll(EMAIL_RE)) addEmail(match[0]);
    for (const match of decodeEntities(raw).matchAll(EMAIL_RE)) addEmail(match[0]);
  }
  for (const match of text.matchAll(PHONE_RE)) addPhone(match[1]);

  return { emails, phones, whatsapp };
}

const SOCIAL_HOSTS: Array<{ key: keyof Socials; host: RegExp }> = [
  { key: "linkedin", host: /(^|\.)linkedin\.com$/ },
  { key: "instagram", host: /(^|\.)instagram\.com$/ },
  { key: "facebook", host: /(^|\.)facebook\.com$/ },
  { key: "twitter", host: /(^|\.)(twitter\.com|x\.com)$/ },
  { key: "youtube", host: /(^|\.)youtube\.com$/ },
];

// Share buttons, pixels, login walls and content links are not the business's profile page.
const SOCIAL_SKIP = /\/(sharer|sharing|sharearticle|share|intent|plugins|widgets|tr|login|signup|policies|privacy|terms|embed|watch|shorts|reel|reels|p|explore|results|playlist|hashtag|dialog|i)\b/i;

function cleanSocialUrl(url: URL): string {
  const keep = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (/^utm_/i.test(key) || key === "fbclid" || key === "gclid") continue;
    keep.append(key, value);
  }
  const query = keep.toString();
  const host = url.host.replace(/^www\./i, "").toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  return `https://${host}${path}${query ? `?${query}` : ""}`;
}

export function extractSocials(html: string): Socials {
  const out: Socials = {};
  for (const href of hrefs(String(html ?? ""))) {
    const wa = whatsappFromHref(href);
    if (wa) {
      if (!out.whatsapp) out.whatsapp = wa;
      continue;
    }
    const url = absoluteUrl(href);
    if (!url) continue;
    const host = url.host.replace(/^www\./i, "").toLowerCase();
    const entry = SOCIAL_HOSTS.find((item) => item.host.test(host));
    if (!entry || out[entry.key]) continue;
    if (entry.key === "youtube" && !/^\/(channel|c|user|@)/i.test(url.pathname)) continue;
    if (SOCIAL_SKIP.test(url.pathname)) continue;
    if (!url.pathname.replace(/\/+$/, "")) continue;
    out[entry.key] = cleanSocialUrl(url);
  }
  return out;
}

// --------------------------------------------------------------------------- page facts / signals

const CHAT_PATTERNS = [
  /tawk\.to|embed\.tawk/i,
  /intercom/i,
  /crisp\.chat|client\.crisp/i,
  /drift\.com|driftt\.com/i,
  /tidio/i,
  /wati\.(io|ai|com)|getwati/i,
  /livechatinc|livechat\.com/i,
  /zopim|zendesk/i,
];
const BOOKING_PATTERNS = [
  /calendly\.com/i,
  /\bcal\.com\b/i,
  /practo\.com/i,
  /setmore\.com/i,
  /simplybook/i,
  /youcanbook\.me/i,
  /book(?:ing)?[ \t-]?an[ \t-]?appointment/i,
];
const ANALYTICS_PATTERNS = [
  /googletagmanager\.com|gtag\(/i,
  /google-analytics\.com|googleanalytics/i,
  /\bga\('|\bga\("/,
  /\bG-[A-Z0-9]{6,}\b/,
  /\bUA-\d{4,}-\d+\b/,
  /plausible\.io/i,
  /fbq\(|connect\.facebook\.net/i,
  /matomo|piwik/i,
  /clarity\.ms/i,
];
const ECOMMERCE_PATTERNS = [
  /add[ \t_-]?to[ \t_-]?(cart|bag|basket)/i,
  /\bshopping[ \t_-]?(cart|bag)\b/i,
  /\bview[ \t_-]?cart\b/i,
  /href\s*=\s*["'][^"']*\/(cart|checkout|collections)(\/|["'])/i,
  /\bcart[ \t_-]?(drawer|icon|count|items)\b/i,
  /woocommerce|wc-add-to-cart|shopify-payment|cdn\.shopify\.com|razorpay|checkout\.shopify/i,
  /buy[ \t_-]?now/i,
];

function hasViewport(html: string): boolean {
  return metaTags(html).some((meta) => meta.name === "viewport");
}

function hasContactForm(html: string): boolean {
  const forms = String(html ?? "").match(/<form\b[\s\S]*?<\/form>/gi) ?? [];
  return forms.some((form) => {
    const fields = form.match(/<(?:input|textarea|select)\b[^>]*>/gi) ?? [];
    return fields.some(
      (field) =>
        /type\s*=\s*["']?(?:email|tel)["']?/i.test(field) ||
        /name\s*=\s*["']?[^"'>]*(?:email|e-mail|phone|mobile|tel|message|enquir|enquire|contact)/i.test(field),
    );
  });
}

function detectChatWidget(html: string): boolean {
  const value = String(html ?? "");
  return CHAT_PATTERNS.some((re) => re.test(value));
}

function detectBookingWidget(html: string): boolean {
  const value = String(html ?? "");
  return BOOKING_PATTERNS.some((re) => re.test(value));
}

function detectAnalytics(html: string): boolean {
  const value = String(html ?? "");
  return ANALYTICS_PATTERNS.some((re) => re.test(value));
}

function detectEcommerce(html: string): boolean {
  const value = String(html ?? "");
  return ECOMMERCE_PATTERNS.some((re) => re.test(value));
}

/** True when a page carries its own video or a YouTube/Vimeo embed or link. */
function hasVideo(html: string): boolean {
  return /<video\b|youtube\.com|youtu\.be|vimeo\.com/i.test(String(html ?? ""));
}

function detectCopyrightYear(html: string): number | undefined {
  const text = stripTags(html);
  const years: number[] = [];
  const re = /(?:©|\(c\)|copyright)[^0-9]{0,24}((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) years.push(Number(m[1]));
    if (m[2]) years.push(Number(m[2]));
  }
  if (!years.length) return undefined;
  return Math.max(...years);
}

function isHttps(url: string): boolean {
  const value = String(url ?? "").trim();
  if (!value) return true; // unknown: do not claim the site is insecure
  return /^https:/i.test(value);
}

function detectCms(html: string, headers: Record<string, string>, url: string): PageFacts["cms"] {
  const generator = (metaTags(html).find((meta) => meta.name === "generator")?.content ?? "").trim();
  const powered = `${headers["x-generator"] ?? ""} ${headers["x-powered-by"] ?? ""}`.trim();
  const hay = `${generator} ${powered} ${html}`;
  let host = "";
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.host.toLowerCase();
    path = parsed.pathname;
  } catch {
    host = "";
    path = "";
  }
  if (/wordpress|wp-content|wp-includes|wp-json|api\.w\.org|woocommerce|wp\.me/i.test(hay) || /\/wp-(?:content|includes|json)\//.test(path)) {
    return "wordpress";
  }
  if (/wix\.com|wixstatic|wix-image|wix-code|wixapps/i.test(hay)) return "wix";
  if (/shopify|cdn\.shopify\.com|myshopify/i.test(hay) || headers["x-shopid"] || headers["x-shardid"] || /\.myshopify\.com$/i.test(host)) {
    return "shopify";
  }
  if (generator) return "other";
  if (/squarespace|webflow|drupal|joomla|magento|ghost|jimdo|weebly|bigcommerce|prestashop|opencart/i.test(hay)) return "other";
  if (/\/sites\/default\/|\/catalog\/view\//.test(path)) return "other";
  return undefined;
}

export function analyzePage(htmlInput: string, headersInput?: Record<string, string> | Headers | null, url = ""): PageFacts {
  const html = String(htmlInput ?? "");
  const headers = toHeaderRecord(headersInput);
  const contacts = extractContacts(html);
  const socials = extractSocials(html);
  const copyrightYear = detectCopyrightYear(html);
  const currentYear = new Date().getFullYear();
  return {
    https: isHttps(url),
    viewport: hasViewport(html),
    contactForm: hasContactForm(html),
    chatWidget: detectChatWidget(html),
    bookingWidget: detectBookingWidget(html),
    analytics: detectAnalytics(html),
    copyrightYear,
    outdatedCopyright: copyrightYear !== undefined && copyrightYear < currentYear - 2,
    cms: detectCms(html, headers, url),
    ecommerce: detectEcommerce(html),
    hasEmail: contacts.emails.length > 0,
    hasPhone: contacts.phones.length > 0,
    hasWhatsapp: contacts.whatsapp.length > 0 || !!socials.whatsapp,
    socialActive: (["linkedin", "instagram", "facebook", "twitter", "youtube"] as const).some(
      (key) => !!socials[key],
    ),
  };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Map page facts to CONTRACT signal ids. */
export function signalsFromFacts(facts: PageFacts): string[] {
  const signals: string[] = [];
  if (!facts.https) signals.push("no-https");
  if (!facts.viewport) signals.push("not-mobile-friendly");
  if (!facts.contactForm) signals.push("no-contact-form");
  if (!facts.chatWidget) signals.push("no-chat-widget");
  if (!facts.bookingWidget) signals.push("no-online-booking");
  if (!facts.analytics) signals.push("no-analytics");
  if (facts.bookingWidget) signals.push("appointment-based");
  if (facts.outdatedCopyright) signals.push("outdated-copyright");
  if (facts.cms === "wordpress") signals.push("wordpress");
  if (facts.cms === "wix") signals.push("wix");
  if (facts.cms === "shopify") signals.push("shopify");
  if (facts.cms === "other") signals.push("custom-cms");
  if (facts.ecommerce) signals.push("ecommerce");
  if (facts.hasEmail) signals.push("has-email");
  if (facts.hasPhone) signals.push("has-phone");
  if (facts.hasWhatsapp) signals.push("has-whatsapp");
  if (facts.socialActive) signals.push("social-active-links");
  return dedupe(signals);
}

/**
 * Signal ids readable off one page. `headers` accepts a fetch Headers object or a plain record.
 * Signals that need a category (high-volume-enquiry-type) or a live fetch (no-website,
 * site-unreachable, slow-response) are added by enrich, not here.
 */
export function detectSignals(html: string, headers?: Record<string, string> | Headers | null, url = ""): string[] {
  return signalsFromFacts(analyzePage(html, headers, url));
}

// --------------------------------------------------------------------------- summary

export function getTitle(html: string): string | undefined {
  const m = String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = m ? collapse(decodeEntities(m[1])) : "";
  return title || undefined;
}

function metaContent(html: string, matcher: (meta: Record<string, string>) => boolean): string | undefined {
  const hit = metaTags(html).find(matcher);
  return hit?.content ? collapse(hit.content) : undefined;
}

export function bestDescription(html: string): string | undefined {
  const description = metaContent(html, (meta) => meta.name === "description");
  const og = metaContent(html, (meta) => meta.property === "og:description" || meta.name === "og:description");
  if (description && og) return og.length > description.length ? og : description;
  return description ?? og;
}

export function getHeadings(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(html ?? "")))) {
    const text = collapse(decodeEntities(stripTags(m[2])));
    if (text.length < 3) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 6) break;
  }
  return out;
}

export function extractLanguage(html: string): string | undefined {
  const source = String(html ?? "");
  const m = source.match(/<html\b[^>]*\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  let lang = m ? m[1] ?? m[2] ?? m[3] : undefined;
  if (!lang) {
    const meta = metaTags(source).find((tag) => tag.httpEquiv === "content-language");
    lang = meta?.content;
  }
  if (!lang) return undefined;
  const value = collapse(lang).toLowerCase().replace(/_/g, "-");
  return value || undefined;
}

function asSentence(text: string): string {
  const value = String(text ?? "").trim();
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function splitSentences(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

const THIN_SUMMARY = "Not enough public text on this site to describe what the business does";

/**
 * 1 to 2 sentences built ONLY from the title, meta description, og:description and the first
 * headings of this exact page. Order MD2: a qualifying og/meta description wins first, then the
 * first real reader paragraph; navigation-only text is never returned. Thin pages keep the
 * explicit thin note instead of guessing.
 */
export function summarize(html: string): string {
  const meta = selectMetaSummary(html);
  if (meta) return meta;
  const real = selectRealParagraph(visibleText(html));
  if (real) return real;
  const title = getTitle(html);
  const description = bestDescription(html);
  const headings = getHeadings(html).filter((heading) => !isNavOnly(heading));
  const sentences: string[] = [];

  if (description && description.length >= 40 && !isNavOnly(stripMarkdown(description))) {
    sentences.push(...splitSentences(stripMarkdown(description)).slice(0, 2));
  }
  if (sentences.length === 0 && headings.length > 0) sentences.push(asSentence(headings[0]));
  if (sentences.length === 1 && headings.length > 0) {
    const heading = headings[0];
    if (!sentences[0].toLowerCase().includes(heading.toLowerCase())) sentences.push(asSentence(heading));
  }

  let summary = stripMarkdown(sentences.slice(0, 2).join(" ").trim());
  if (summary.length > 400) summary = summary.slice(0, 397).trimEnd() + "...";
  if (summary && isNavOnly(summary)) return "";
  if (summary.replace(/[^A-Za-z0-9]/g, "").length < 15) {
    return title ? `${THIN_SUMMARY}; the page title is "${title}".` : `${THIN_SUMMARY}.`;
  }
  return summary;
}

// --------------------------------------------------------------------------- robots.txt

function robotsPattern(value: string): RegExp {
  let path = String(value ?? "");
  let anchored = false;
  if (path.endsWith("$")) {
    anchored = true;
    path = path.slice(0, -1);
  }
  const escaped = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + (anchored ? "$" : ""));
}

/** Parse robots.txt into rules for User-agent Leadscout (or * when no Leadscout group exists). */
export function parseRobots(text: string): RobotRule[] {
  const groups: Array<{ agents: string[]; rules: RobotRule[] }> = [];
  let current: { agents: string[]; rules: RobotRule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "disallow" || field === "allow") {
      current.rules.push({ allow: field === "allow", path: value, pattern: robotsPattern(value) });
    }
  }
  const specific = groups.filter((group) => group.agents.some((agent) => agent.startsWith("leadscout")));
  const wildcard = groups.filter((group) => group.agents.includes("*"));
  const chosen = specific.length ? specific : wildcard;
  return chosen.flatMap((group) => group.rules);
}

/** Longest matching rule wins, like the robots.txt standard. */
export function robotsAllows(pathWithQuery: string, rules: RobotRule[]): boolean {
  let best: RobotRule | null = null;
  for (const rule of rules) {
    if (!rule.path) continue; // "Disallow:" with no path allows everything
    if (!rule.pattern.test(pathWithQuery)) continue;
    if (!best || rule.path.replace(/\*/g, "").length > best.path.replace(/\*/g, "").length) best = rule;
  }
  return best ? best.allow : true;
}

// --------------------------------------------------------------------------- fetching

type FetchedPage = { url: string; ok: boolean; status: number; html: string; headers: Record<string, string>; truncated: boolean };

async function readCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (body && typeof body.getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = MAX_BYTES - total;
      if (remaining <= 0) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total = MAX_BYTES;
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    return { text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"), truncated };
  }
  if (typeof res.arrayBuffer === "function") {
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) return { text: buffer.subarray(0, MAX_BYTES).toString("utf8"), truncated: true };
    return { text: buffer.toString("utf8"), truncated: false };
  }
  const text = await res.text();
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength > MAX_BYTES) return { text: buffer.subarray(0, MAX_BYTES).toString("utf8"), truncated: true };
  return { text, truncated: false };
}

async function fetchPage(url: string, fetchFn: FetchFn): Promise<FetchedPage> {
  const res = await fetchFn(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  const status = Number(res.status);
  const ok = Number.isFinite(status) ? status >= 200 && status < 300 : res.ok !== false;
  const { text, truncated } = await readCapped(res);
  return { url, ok, status, html: text, headers: toHeaderRecord(res.headers), truncated };
}

async function loadRobots(home: URL, fetchFn: FetchFn): Promise<RobotRule[]> {
  try {
    const res = await fetchFn(new URL("/robots.txt", home.origin).toString(), {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    const status = Number(res.status);
    if (!(status >= 200 && status < 300)) return [];
    const { text } = await readCapped(res);
    return parseRobots(text);
  } catch {
    return [];
  }
}

const CONTACT_PATTERN = /(contact|get[ \t-]?in[ \t-]?touch|reach[ \t-]?us|enquir|enquire)/i;
const ABOUT_PATTERN = /(about|our[ \t-]?story|who[ \t-]?we[ \t-]?are)/i;

function findPageLink(html: string, base: URL, kind: "contact" | "about"): string | undefined {
  const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  const pattern = kind === "contact" ? CONTACT_PATTERN : ABOUT_PATTERN;
  const baseHost = base.host.replace(/^www\./i, "").toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(html ?? "")))) {
    const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
    if (!href || href.startsWith("#")) continue;
    const url = resolveUrl(href, base);
    if (!url) continue;
    if (url.host.replace(/^www\./i, "").toLowerCase() !== baseHost) continue;
    const anchorText = collapse(stripTags(m[4] ?? ""));
    if (pattern.test(`${url.pathname} ${anchorText}`)) return url.toString();
  }
  return undefined;
}

// --------------------------------------------------------------------------- enrich

function normalizeUrl(website: string): URL | undefined {
  const raw = String(website ?? "").trim();
  if (!raw) return undefined;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function place(lead: RawLead): string {
  return [lead.city, lead.country].map((value) => String(value ?? "").trim()).filter(Boolean).join(", ");
}

const HIGH_VOLUME_CATEGORIES = new Set([
  "clinic", "school", "real estate", "travel", "restaurant", "salon", "gym", "logistics", "repair", "coaching",
]);

/** Normalise a category string the same way discover.ts produces ids, then check whether any
 *  high-volume keyword from the CONTRACT appears as a whole word. */
function isHighVolumeCategory(category: string | undefined): boolean {
  const normalized = " " + (category ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
  return [...HIGH_VOLUME_CATEGORIES].some((keyword) => normalized.includes(" " + keyword + " "));
}

function noWebsiteSummary(lead: RawLead): string {
  const category = String(lead.category ?? "").trim() || "unknown";
  const where = place(lead);
  return where
    ? `No website is on record for this business. Only its category (${category}) and place (${where}) are known.`
    : `No website is on record for this business. Only its category (${category}) is known.`;
}

function reasonOf(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  const message = (error as { message?: string } | null)?.message ?? String(error);
  if (name === "TimeoutError" || name === "AbortError" || /timeout|abort/i.test(message)) {
    return `the request timed out after ${PAGE_TIMEOUT_MS / 1000} seconds`;
  }
  return "the network request failed";
}

function unreachable(lead: RawLead, url: string, reason: string, emails: string[], phones: string[]): Enrichment {
  const where = place(lead);
  const category = String(lead.category ?? "").trim() || "unknown";
  const signals = ["site-unreachable"];
  if (isHighVolumeCategory(lead.category)) signals.push("high-volume-enquiry-type");
  return {
    fetchedUrl: url,
    summary: `The website could not be read (${reason}); only the category (${category})${where ? ` and place (${where})` : ""} are known.`,
    emails,
    phones,
    socials: {},
    signals,
  };
}

function mergeFacts(list: PageFacts[]): PageFacts {
  const any = (fn: (facts: PageFacts) => boolean): boolean => list.some(fn);
  const years = list.map((facts) => facts.copyrightYear).filter((year): year is number => typeof year === "number");
  const maxYear = years.length ? Math.max(...years) : undefined;
  const currentYear = new Date().getFullYear();
  return {
    https: list[0]?.https ?? true,
    viewport: any((facts) => facts.viewport),
    contactForm: any((facts) => facts.contactForm),
    chatWidget: any((facts) => facts.chatWidget),
    bookingWidget: any((facts) => facts.bookingWidget),
    analytics: any((facts) => facts.analytics),
    copyrightYear: maxYear,
    outdatedCopyright: maxYear !== undefined && maxYear < currentYear - 2,
    cms: list.find((facts) => facts.cms)?.cms,
    ecommerce: any((facts) => facts.ecommerce),
    hasEmail: any((facts) => facts.hasEmail),
    hasPhone: any((facts) => facts.hasPhone),
    hasWhatsapp: any((facts) => facts.hasWhatsapp),
    socialActive: any((facts) => facts.socialActive),
  };
}

function mergeContacts(list: Contacts[]): Contacts {
  const emails: string[] = [];
  const phones: string[] = [];
  const whatsapp: string[] = [];
  const seenEmail = new Set<string>();
  const seenPhone = new Set<string>();
  for (const contacts of list) {
    for (const email of contacts.emails) {
      const key = email.toLowerCase();
      if (seenEmail.has(key)) continue;
      seenEmail.add(key);
      emails.push(email);
    }
    for (const phone of contacts.phones) {
      const key = phoneKey(phone);
      if (seenPhone.has(key)) continue;
      seenPhone.add(key);
      phones.push(phone);
    }
    for (const link of contacts.whatsapp) if (!whatsapp.includes(link)) whatsapp.push(link);
  }
  return { emails, phones, whatsapp };
}

const SOCIAL_KEYS_ORDER = ["linkedin", "instagram", "facebook", "twitter", "youtube", "whatsapp"] as const;

function mergeSocials(list: Socials[]): Socials {
  const out: Socials = {};
  for (const socials of list) {
    for (const key of SOCIAL_KEYS_ORDER) {
      const value = socials[key];
      if (value && !out[key]) out[key] = value;
    }
  }
  return out;
}

/**
 * enrich: read a business's public website and describe it from the fetched text only.
 * Never throws on a bad site: timeouts and unreachable hosts come back as the site-unreachable
 * signal. Network access goes through deps.fetchFn so tests run offline.
 */
export async function enrich(lead: RawLead, deps: Deps = {}): Promise<Enrichment> {
  const fetchFn: FetchFn = deps.fetchFn ?? fetch;
  const emails: string[] = [];
  const phones: string[] = [];
  if (lead.email) {
    const value = String(lead.email).trim();
    if (value) emails.push(value);
  }
  if (lead.phone) {
    const raw = String(lead.phone).trim();
    const value = normalizePhone(raw) ?? raw;
    if (value) phones.push(value);
  }

  const website = String(lead.website ?? "").trim();
  if (!website) {
    const signals = ["no-website"];
    if (isHighVolumeCategory(lead.category)) signals.push("high-volume-enquiry-type");
    return { summary: noWebsiteSummary(lead), emails, phones, socials: {}, signals };
  }

  const home = normalizeUrl(website);
  if (!home) {
    const signals = ["site-unreachable"];
    if (isHighVolumeCategory(lead.category)) signals.push("high-volume-enquiry-type");
    return {
      fetchedUrl: website,
      summary: `The website address "${website}" could not be parsed, so the business could not be read from its site.`,
      emails,
      phones,
      socials: {},
      signals,
    };
  }

  const robots = await loadRobots(home, fetchFn);
  if (!robotsAllows(home.pathname + home.search, robots)) {
    const signals: string[] = [];
    if (isHighVolumeCategory(lead.category)) signals.push("high-volume-enquiry-type");
    return {
      fetchedUrl: home.toString(),
      summary: `robots.txt on ${home.host} disallows crawling this page, so the business could not be described from its site.`,
      emails,
      phones,
      socials: {},
      signals,
    };
  }

  const startedAt = Date.now();
  let homePage: FetchedPage;
  try {
    homePage = await fetchPage(home.toString(), fetchFn);
  } catch (error) {
    return unreachable(lead, home.toString(), reasonOf(error), emails, phones);
  }
  const elapsedMs = Date.now() - startedAt;
  if (!homePage.ok) {
    return unreachable(lead, home.toString(), `the site answered HTTP ${homePage.status}`, emails, phones);
  }

  const pages: Array<{ url: string; html: string; headers: Record<string, string> }> = [
    { url: home.toString(), html: homePage.html, headers: homePage.headers },
  ];
  const visited = new Set<string>([home.toString()]);
  for (const kind of ["contact", "about"] as const) {
    if (pages.length >= MAX_PAGES) break;
    const found = findPageLink(pages[0].html, home, kind);
    if (!found || visited.has(found)) continue;
    const target = new URL(found);
    if (!robotsAllows(target.pathname + target.search, robots)) continue;
    try {
      const page = await fetchPage(found, fetchFn);
      if (!page.ok) continue;
      pages.push({ url: found, html: page.html, headers: page.headers });
      visited.add(found);
    } catch {
      // a secondary page that will not load must not fail the job
    }
  }

  const contacts = mergeContacts(pages.map((page) => extractContacts(page.html)));
  for (const email of emails) {
    if (!contacts.emails.some((value) => value.toLowerCase() === email.toLowerCase())) contacts.emails.unshift(email);
  }
  for (const phone of phones) {
    if (!contacts.phones.some((value) => phoneKey(value) === phoneKey(phone))) contacts.phones.unshift(phone);
  }
  const socials = mergeSocials(pages.map((page) => extractSocials(page.html)));

  const merged = mergeFacts(pages.map((page) => analyzePage(page.html, page.headers, page.url)));
  const facts: PageFacts = {
    ...merged,
    hasEmail: contacts.emails.length > 0,
    hasPhone: contacts.phones.length > 0,
    hasWhatsapp: contacts.whatsapp.length > 0 || !!socials.whatsapp,
    socialActive: (["linkedin", "instagram", "facebook", "twitter", "youtube"] as const).some(
      (key) => !!socials[key],
    ),
  };
  const signals = signalsFromFacts(facts);
  if (!hasVideo(pages[0].html)) signals.push("no-video-on-site");
  if (elapsedMs > SLOW_RESPONSE_MS) signals.push("slow-response");
  if (isHighVolumeCategory(lead.category)) signals.push("high-volume-enquiry-type");

  const enrichment: Enrichment = {
    fetchedUrl: home.toString(),
    summary: summarize(pages[0].html),
    emails: contacts.emails,
    phones: contacts.phones,
    socials,
    signals: dedupe(signals),
  };
  const title = getTitle(pages[0].html);
  const description = bestDescription(pages[0].html);
  const language = pages.map((page) => extractLanguage(page.html)).find((value) => !!value);
  if (title) enrichment.title = title;
  if (description) enrichment.description = description;
  if (language) enrichment.language = language;
  return enrichment;
}

// --------------------------------------------------------------------------- research hook (L33)

/** One page of text handed over from research.ts (reach page text or plain-fetched HTML). */
export type ReachPage = { url: string; text: string; fetchedAt?: string };

/**
 * Summary built from reader text (reach page text is markdown/plain, not HTML), same shape
 * and discipline as summarize(): the first real paragraph (order MD2 rule 2), else "".
 * Never raw navigation text.
 */
function summarizeText(text: string): string {
  const source = String(text ?? "");
  const plain = /<[a-z!/]/i.test(source) ? visibleText(source) : source;
  return selectRealParagraph(plain);
}

/**
 * enrichFromPages: run the same structured extractors enrich() runs over its fetched pages
 * (extractContacts / extractSocials / analyzePage / summary / language), but over page text
 * handed in by the caller (Agent Reach page text). Pure: no network, no env reads.
 * enrich() output never changes because of this export.
 */
export function enrichFromPages(lead: RawLead, pages: ReachPage[]): Enrichment {
  const emails: string[] = [];
  const phones: string[] = [];
  if (lead.email) {
    const value = String(lead.email).trim();
    if (value) emails.push(value);
  }
  if (lead.phone) {
    const value = normalizePhone(String(lead.phone).trim()) ?? String(lead.phone).trim();
    if (value) phones.push(value);
  }

  const contacts = mergeContacts(pages.map((page) => extractContacts(page.text)));
  for (const email of emails) {
    if (!contacts.emails.some((value) => value.toLowerCase() === email.toLowerCase())) contacts.emails.unshift(email);
  }
  for (const phone of phones) {
    if (!contacts.phones.some((value) => phoneKey(value) === phoneKey(phone))) contacts.phones.unshift(phone);
  }
  const socials = mergeSocials(pages.map((page) => extractSocials(page.text)));

  const htmlish = pages.filter((page) => /<[a-z!/]/i.test(page.text));
  const signals: string[] = [];
  if (htmlish.length > 0) {
    // Real HTML was seen: absence signals (no-contact-form and friends) are legitimate here.
    const merged = mergeFacts(htmlish.map((page) => analyzePage(page.text, {}, page.url)));
    const facts: PageFacts = {
      ...merged,
      hasEmail: contacts.emails.length > 0,
      hasPhone: contacts.phones.length > 0,
      hasWhatsapp: contacts.whatsapp.length > 0 || !!socials.whatsapp,
      socialActive: (["linkedin", "instagram", "facebook", "twitter", "youtube"] as const).some(
        (key) => !!socials[key],
      ),
    };
    signals.push(...signalsFromFacts(facts));
  } else if (pages.length > 0) {
    // Plain text without markup: claim only what was actually found, never an absence.
    if (contacts.emails.length) signals.push("has-email");
    if (contacts.phones.length) signals.push("has-phone");
    if (contacts.whatsapp.length || socials.whatsapp) signals.push("has-whatsapp");
    if ((["linkedin", "instagram", "facebook", "twitter", "youtube"] as const).some((key) => !!socials[key])) {
      signals.push("social-active-links");
    }
  }
  if (isHighVolumeCategory(lead.category)) signals.push("high-volume-enquiry-type");

  const enrichment: Enrichment = {
    summary: summarizeText(pages[0]?.text ?? ""),
    emails: contacts.emails,
    phones: contacts.phones,
    socials,
    signals: dedupe(signals),
  };
  if (pages[0]) enrichment.fetchedUrl = pages[0].url;
  const firstHtml = htmlish[0];
  if (firstHtml) {
    const metaSummary = selectMetaSummary(firstHtml.text);
    if (metaSummary) enrichment.summary = metaSummary;
    const title = getTitle(firstHtml.text);
    const description = bestDescription(firstHtml.text);
    if (title) enrichment.title = title;
    if (description) enrichment.description = description;
  }
  const language = pages.map((page) => extractLanguage(page.text)).find((value) => !!value);
  if (language) enrichment.language = language;
  return enrichment;
}
