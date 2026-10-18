// ChannelAdapter for WhatsApp Business presence (Order L69-ch-whatsapp).
//
// OFF by default. Enabled only by one env var:
//  - LEADSCOUT_WHATSAPP=1 -> the reach/search + page-read path.
//
// Read order per page comes from registry.readWithFallback: search first, then
// a plain page read, then the operator's browser reader ONLY when both are
// blocked (403, 429, captcha, empty body). A login wall / captcha after
// browser escalation surfaces as needs-human and is never solved or retried.
//
// Sources (read-only, never send a message, never probe numbers in bulk): the
// lead's own site and social bios for wa.me / api.whatsapp.com links,
// catalogue links (wa.me/c/<number>), and the public click-to-chat page read
// through the research layer. Per-platform caps / pauses in browser.ts are
// respected by never retrying a blocked page (browser platform: "other").
//
// Rules: every value is copied verbatim from the fetched text or a search
// snippet with its source URL; a field the page does not show stays missing
// (never inferred or invented). Fetched text is neutralised via
// reach.sanitizeUntrusted and stored on evidence marked untrusted: true.
import { sanitizeUntrusted } from "../../src/reach.js";
import { BrowserBlockedError } from "../../src/channels/types.js";
import type { ChannelAdapter, ChannelDeps, ChannelEvidence, DiscoverQuery } from "../../src/channels/types.js";
import type { RawLead } from "../../src/types.js";
import { readWithFallback, registerChannel } from "../../src/channels/registry.js";
import type { FallbackRead } from "../../src/channels/registry.js";

export const WHATSAPP_CHANNEL_ID = "whatsapp-business";
export const WHATSAPP_ENV = "LEADSCOUT_WHATSAPP";
const MAX_TEXT = 20000;

export type WhatsappFields = {
  whatsappNumber?: string;
  catalogueLink?: string;
  businessName?: string;
  greenTick?: string;
  numberMatchesPhone?: string;
} & Record<string, string | number | undefined>;

export type WhatsappSignalOpts = { leadPhone?: string; websiteText?: string };

// ---- patterns ---------------------------------------------------------------

const INJECTION_NEVER_COPY =
  /\bignore (all )?(the )?(previous|prior|above)\b|\bsystem prompt\b|\byou are now\b|\bdisregard (all )?(the )?(above|previous|prior)\b|^\s*(?:<\/?(tool|function|invoke)\b|<\|[^|]*\|>)|^\s*```/i;

// wa.me/<digits> (optional +, query, /c/ catalogue path handled separately),
// api.whatsapp.com/send?phone=<digits>.
const WA_ME_RE = /https?:\/\/(?:www\.)?wa\.me\/\+?(\d{6,15})(?![\d])/i;
const WA_ME_ALL_RE = /https?:\/\/(?:www\.)?wa\.me\/\+?(\d{6,15})(?![\d])/gi;
const WA_API_RE = /https?:\/\/(?:www\.)?api\.whatsapp\.com\/send\?[^ \s"'<>]*phone=\+?(\d{6,15})/i;
const WA_API_ALL_RE = /https?:\/\/(?:www\.)?api\.whatsapp\.com\/send\?[^ \s"'<>]*phone=\+?(\d{6,15})/gi;
const WA_CATALOGUE_RE = /https?:\/\/(?:www\.)?wa\.me\/c\/\+?(\d{6,15})(?![\d])/i;
const WA_CATALOGUE_ALL_RE = /https?:\/\/(?:www\.)?wa\.me\/c\/\+?(\d{6,15})(?![\d])/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const EXT_SITE_RE = /https?:\/\/(?!.*?(?:wa\.me|api\.whatsapp\.com|facebook\.com|instagram\.com))[^ \s"'<>)]+/i;
const GREEN_TICK_RE = /verified business|green tick|✔|✓/i;

function dropInjection(text: string): string {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => !INJECTION_NEVER_COPY.test(l))
    .join("\n");
}

function digitsOf(raw: string | undefined): string {
  return String(raw ?? "").replace(/\D/g, "");
}

// All distinct WhatsApp numbers visible in the text (click-to-chat + catalogue).
export function whatsappNumbersIn(text: string): string[] {
  const out: string[] = [];
  const clean = dropInjection(text);
  for (const m of clean.matchAll(WA_ME_ALL_RE)) out.push(m[1]);
  for (const m of clean.matchAll(WA_API_ALL_RE)) out.push(m[1]);
  for (const m of clean.matchAll(WA_CATALOGUE_ALL_RE)) out.push(m[1]);
  return [...new Set(out)];
}

// ---- page / snippet parser --------------------------------------------------

/** Parse page text (own site, social bio, or the public click-to-chat page)
 *  into fields. Every value is a verbatim copy from the text; anything the
 *  page does not show stays undefined. `leadPhone` is only used for the
 *  number-matches comparison, never to fill a missing number. */
export function parseWhatsappPage(text: string, leadPhone?: string): WhatsappFields {
  const clean = dropInjection(text);
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const f: WhatsappFields = {};

  const labelled = (re: RegExp): string | undefined => {
    const hit = lines.find((l) => re.test(l));
    return hit?.match(re)?.[1]?.trim() || undefined;
  };

  // WhatsApp number as listed: the wa.me / api.whatsapp.com link first
  // (the channel's own evidence), else an explicit phone label.
  f.whatsappNumber =
    clean.match(WA_ME_RE)?.[0] ??
    clean.match(WA_API_RE)?.[0] ??
    labelled(/^(?:WhatsApp(?: number| no\.?| phone)?|Mobile|Phone)\s*[:：]\s*(\+?[\d][\d\s()-]{5,}[\d])/i);
  if (f.whatsappNumber) f.whatsappNumber = f.whatsappNumber.replace(/[.,;]+$/, "");

  // Catalogue link exists: only a verbatim wa.me/c/<number> link.
  const cat = clean.match(WA_CATALOGUE_RE)?.[0] ?? labelled(/^(?:Catalogue|Catalog)\s*[:：]\s*(\S+)/i);
  if (cat) f.catalogueLink = cat.replace(/[.,;]+$/, "");

  // Business name shown on the public page: explicit label, else the first
  // non-nav line — but only when the page carries WhatsApp evidence (a
  // wa.me / api.whatsapp.com link); otherwise the name stays missing
  // rather than being guessed from an unrelated page.
  f.businessName = labelled(/^(?:Business name|Business|Shop name|Name)\s*[:：]\s*(.+)$/i);
  if (!f.businessName && f.whatsappNumber) {
    f.businessName = lines.find(
      (l) =>
        l.length >= 2 &&
        l.length <= 80 &&
        !/^(?:log in|sign up|home|about|chat|send message|continue to chat|whatsapp)/i.test(l) &&
        !/https?:/i.test(l) &&
        !/^\d/.test(l),
    );
  }

  // Green tick / verified business marker shown on the public page.
  if (GREEN_TICK_RE.test(clean)) f.greenTick = "true";

  // Number matches the phone found elsewhere: only when both are present.
  const listed = digitsOf(f.whatsappNumber);
  const other = digitsOf(leadPhone);
  if (listed && other) f.numberMatchesPhone = listed === other ? "true" : "false";

  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f;
}

// ---- signals ----------------------------------------------------------------

/** Stable signal ids (brief: whatsapp-only contact, no catalogue, number
 *  differs across platforms, no click-to-chat on the website). Never fires a
 *  signal the text does not support. */
export function whatsappSignals(
  f: WhatsappFields,
  text: string,
  opts: WhatsappSignalOpts = {},
): string[] {
  const t = dropInjection(text);
  const out: string[] = [];
  const hasNumber = typeof f.whatsappNumber === "string" && f.whatsappNumber.trim() !== "";

  // WhatsApp is the only contact: a number is listed but no email and no
  // other (non-WhatsApp) site link in the text.
  if (hasNumber && !EMAIL_RE.test(t) && !EXT_SITE_RE.test(t)) {
    out.push("whatsapp-only-contact");
  }

  // No catalogue: WhatsApp present but no wa.me/c/ link.
  if (hasNumber && !f.catalogueLink) out.push("no-catalogue");

  // Number differs across platforms: the listed number's digits differ from
  // the phone found elsewhere, or two distinct WhatsApp numbers in the text.
  const listed = digitsOf(f.whatsappNumber);
  const other = digitsOf(opts.leadPhone);
  const nums = whatsappNumbersIn(t).map(digitsOf);
  if ((listed && other && listed !== other) || new Set(nums).size >= 2) {
    out.push("number-differs-across-platforms");
  }

  // No click-to-chat on the website: the lead's site text carries no wa.me /
  // api.whatsapp.com link. Only when the site text was actually read.
  if (opts.websiteText !== undefined) {
    const site = dropInjection(opts.websiteText);
    if (!/wa\.me|api\.whatsapp\.com/i.test(site)) out.push("no-click-to-chat-on-website");
  }

  return [...new Set(out)];
}

// ---- discovery --------------------------------------------------------------

/** Search-snippet lines -> RawLead[]. A line with a wa.me / api.whatsapp.com
 *  link becomes a lead named by a `Name:` label, a markdown title, or
 *  "WhatsApp <digits>"; catalogue links (wa.me/c/) are skipped as leads
 *  (they are enrichment evidence, not discovery). Lines with no link or with
 *  injected instruction text as the only name are skipped. */
export function resultsToLeads(text: string, category: string, limit: number): RawLead[] {
  const leads: RawLead[] = [];
  const seen = new Set<string>();
  let pendingName: string | undefined;
  for (const rawLine of dropInjection(text).split(/\r?\n/)) {
    if (leads.length >= limit) break;
    const line = rawLine.trim();
    if (!line) continue;
    const nameLabel = line.match(/^(?:Name|Business)\s*[:：]\s*(.+)$/i);
    if (nameLabel) {
      pendingName = nameLabel[1].trim();
      continue;
    }
    if (WA_CATALOGUE_RE.test(line) && !WA_ME_RE.test(line.replace(WA_CATALOGUE_RE, "")) && !WA_API_RE.test(line)) {
      pendingName = undefined;
      continue;
    }
    const md = line.match(/\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/);
    let url: string | undefined;
    let title: string | undefined;
    if (md) {
      url = md[2];
      title = md[1];
    } else {
      url = line.match(WA_ME_RE)?.[0] ?? line.match(WA_API_RE)?.[0];
    }
    if (!url || !/wa\.me|api\.whatsapp\.com/i.test(url)) continue;
    const cleanUrl = url.replace(/[\s,.;]+$/, "");
    const num = cleanUrl.match(/(\d{6,15})/)?.[1] ?? "";
    const key = digitsOf(num);
    if (!key || seen.has(key)) {
      pendingName = undefined;
      continue;
    }
    const name = pendingName ?? title ?? (num ? `WhatsApp ${num}` : undefined);
    pendingName = undefined;
    if (!name) continue;
    seen.add(key);
    leads.push({
      name,
      category,
      phone: num || undefined,
      source: WHATSAPP_CHANNEL_ID,
      sourceUrl: cleanUrl,
    });
  }
  return leads;
}

// ---- status -----------------------------------------------------------------

function statusText(): { enabled: boolean; why?: string } {
  if (process.env[WHATSAPP_ENV] === "1") return { enabled: true };
  return {
    enabled: false,
    why:
      `WhatsApp Business adapter is off by default: set ${WHATSAPP_ENV}=1 to enable ` +
      `(current value is "${String(process.env[WHATSAPP_ENV] ?? "<unset>")}"); ` +
      "reads are read-only (never send a message, never probe numbers in bulk) and " +
      "the browser fallback respects the per-platform caps in browser.ts",
  };
}

// ---- the adapter ------------------------------------------------------------

export const whatsapp: ChannelAdapter = {
  id: WHATSAPP_CHANNEL_ID,
  name: "WhatsApp Business presence",
  tier: "C",
  categories: ["any"],
  status: () => statusText(),

  discover: async (q: DiscoverQuery, deps: ChannelDeps): Promise<RawLead[]> => {
    const limit = Math.max(1, Math.min(q.limit ?? 20, 20));
    const loc = [q.area, q.city].filter(Boolean).join(", ");
    const read = await readWithFallback(deps, {
      searchQuery: `"${q.category}" "${loc}" wa.me`.trim(),
    });
    const text = sanitizeUntrusted(read.text);
    return resultsToLeads(text, q.category, limit);
  },

  enrich: async (lead: RawLead, deps: ChannelDeps): Promise<ChannelEvidence> => {
    let read: FallbackRead;
    try {
      // search -> plain page read -> browser only when both are blocked.
      read = await readWithFallback(deps, {
        searchQuery: `"${lead.name}" wa.me OR "api.whatsapp.com" ${lead.city ?? ""}`.trim().replace(/\s+/g, " "),
        url: lead.sourceUrl,
      });
    } catch (err) {
      if (err instanceof BrowserBlockedError) {
        // Login wall / captcha after browser escalation: never solved or
        // bypassed -> needs-human evidence, no fields.
        return {
          channel: WHATSAPP_CHANNEL_ID,
          url: lead.sourceUrl,
          fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
          via: "browser",
          fields: { needsHuman: "true" },
          signals: ["needs-human"],
          text: "",
          untrusted: true,
        };
      }
      throw err;
    }
    const text = sanitizeUntrusted(read.text);
    // The 4th signal compares against the business website. When the lead
    // carries a website, read it best-effort (a normal page read, not part of
    // the main chain); a failure just leaves the signal out.
    let websiteText: string | undefined;
    const website = String(lead.website ?? "").trim();
    if (/^https?:\/\//i.test(website)) {
      try {
        const page = await deps.readPage(website);
        if (page.ok && page.text.trim() !== "") websiteText = sanitizeUntrusted(page.text);
      } catch {
        /* best-effort only */
      }
    }
    const fields: Record<string, string | number | undefined> = {
      ...parseWhatsappPage(text, lead.phone),
    };
    const signals = whatsappSignals(fields as WhatsappFields, text, {
      leadPhone: lead.phone,
      websiteText,
    });
    return {
      channel: WHATSAPP_CHANNEL_ID,
      url: read.url,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      via: read.via,
      fields,
      signals,
      text: text.slice(0, MAX_TEXT),
      untrusted: true,
    };
  },

  signals: (text: string): string[] => {
    const clean = sanitizeUntrusted(text);
    return whatsappSignals(parseWhatsappPage(clean), clean);
  },
};

registerChannel(whatsapp);
