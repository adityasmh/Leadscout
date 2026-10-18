// src/export.ts - CSV + CRM presets + JSONL dossier export.
// UNVERIFIED: the CRM column-name mapping below is based on offline notes and must be
// checked against each CRM's current import screen before production use.

import { csvCell } from "./store.js";
import type { Lead } from "./types.js";
import type { Dossier, LeadScore } from "./types-v2.js";

export type ExtrasMap = Map<string, { dossier?: Dossier; score?: LeadScore }>;
export type ExportFormat = "generic" | "hubspot" | "zoho" | "twenty" | "jsonl";

const GENERIC_COLUMNS = [
  "name",
  "category",
  "city",
  "country",
  "address",
  "phone",
  "email",
  "website",
  "score",
  "fit",
  "reach",
  "timing",
  "gap_tag",
  "gap_headline",
  "say_this",
  "pushback",
  "offer_1",
  "offer_1_quote",
  "offer_1_assumption",
  "door_opener",
  "owner",
  "since_year",
  "call_status",
  "status",
  "evidence_urls",
  "source_url",
  "attribution",
] as const;

type GenericColumn = (typeof GENERIC_COLUMNS)[number];

// UNVERIFIED CRM column mapping — manager check required before production use.
// "Leadscout " prefix is used for custom fields that are not standard CRM company fields.
const CRM_COLUMN_MAP: Record<
  Exclude<ExportFormat, "generic" | "jsonl">,
  Record<GenericColumn, string>
> = {
  hubspot: {
    name: "Company name",
    category: "Leadscout Category",
    city: "City",
    country: "Country/Region",
    address: "Street Address",
    phone: "Phone Number",
    email: "Email",
    website: "Website URL",
    score: "Leadscout Score",
    fit: "Leadscout Fit",
    reach: "Leadscout Reach",
    timing: "Leadscout Timing",
    gap_tag: "Leadscout Gap Tag",
    gap_headline: "Leadscout Gap Headline",
    say_this: "Leadscout Say This",
    pushback: "Leadscout Pushback",
    offer_1: "Leadscout Offer 1",
    offer_1_quote: "Leadscout Offer 1 Quote",
    offer_1_assumption: "Leadscout Offer 1 Assumption",
    door_opener: "Leadscout Door Opener",
    owner: "Leadscout Owner",
    since_year: "Leadscout Since Year",
    call_status: "Leadscout Call Status",
    status: "Leadscout Status",
    evidence_urls: "Leadscout Evidence URLs",
    source_url: "Leadscout Source URL",
    attribution: "Leadscout Attribution",
  },
  zoho: {
    name: "Account Name",
    category: "Leadscout Category",
    city: "Billing City",
    country: "Billing Country",
    address: "Billing Street",
    phone: "Phone",
    email: "Email",
    website: "Website",
    score: "Leadscout Score",
    fit: "Leadscout Fit",
    reach: "Leadscout Reach",
    timing: "Leadscout Timing",
    gap_tag: "Leadscout Gap Tag",
    gap_headline: "Leadscout Gap Headline",
    say_this: "Leadscout Say This",
    pushback: "Leadscout Pushback",
    offer_1: "Leadscout Offer 1",
    offer_1_quote: "Leadscout Offer 1 Quote",
    offer_1_assumption: "Leadscout Offer 1 Assumption",
    door_opener: "Leadscout Door Opener",
    owner: "Leadscout Owner",
    since_year: "Leadscout Since Year",
    call_status: "Leadscout Call Status",
    status: "Leadscout Status",
    evidence_urls: "Leadscout Evidence URLs",
    source_url: "Leadscout Source URL",
    attribution: "Leadscout Attribution",
  },
  twenty: {
    name: "name",
    category: "Leadscout Category",
    city: "city",
    country: "country",
    address: "address",
    phone: "phone",
    email: "email",
    website: "website",
    score: "Leadscout Score",
    fit: "Leadscout Fit",
    reach: "Leadscout Reach",
    timing: "Leadscout Timing",
    gap_tag: "Leadscout Gap Tag",
    gap_headline: "Leadscout Gap Headline",
    say_this: "Leadscout Say This",
    pushback: "Leadscout Pushback",
    offer_1: "Leadscout Offer 1",
    offer_1_quote: "Leadscout Offer 1 Quote",
    offer_1_assumption: "Leadscout Offer 1 Assumption",
    door_opener: "Leadscout Door Opener",
    owner: "Leadscout Owner",
    since_year: "Leadscout Since Year",
    call_status: "Leadscout Call Status",
    status: "Leadscout Status",
    evidence_urls: "Leadscout Evidence URLs",
    source_url: "Leadscout Source URL",
    attribution: "Leadscout Attribution",
  },
};

function safeCsvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  const guarded = /^[\=\+\-@]/.test(text) ? `'${text}` : text;
  return csvCell(guarded);
}

function quoteRange(quote: { currency: string; min: number; max: number } | null | undefined): string {
  if (!quote) return "price not set";
  return `${quote.currency} ${quote.min}-${quote.max}`;
}

function evidenceUrls(dossier?: Dossier): string {
  if (!dossier?.evidence?.length) return "";
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const item of dossier.evidence) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      urls.push(item.url);
    }
  }
  return urls.join(";");
}

function getExtras(
  lead: Lead,
  extras: ExtrasMap
): { dossier?: Dossier; score?: LeadScore } {
  return extras.get(lead.id) ?? {};
}

function buildGenericRecord(
  lead: Lead,
  score?: LeadScore,
  dossier?: Dossier
): Record<GenericColumn, unknown> {
  const offer1 = dossier?.offers?.[0];
  const doorOpener = dossier?.offers?.find((o) => o.doorOpener);
  return {
    name: lead.name,
    category: lead.category,
    city: lead.city ?? "",
    country: lead.country ?? "",
    address: lead.address ?? "",
    phone: lead.phone ?? "",
    email: lead.email ?? "",
    website: lead.website ?? "",
    score: score ? String(score.total) : String(lead.score ?? ""),
    fit: score ? String(score.fit) : "",
    reach: score ? String(score.reach) : "",
    timing: score ? String(score.timing) : "",
    gap_tag: dossier?.gap?.tag ?? "",
    gap_headline: dossier?.gap?.headline?.value ?? "",
    say_this: dossier?.sayThis?.value ?? "",
    pushback: dossier?.pushback?.value ?? "",
    offer_1: offer1?.title ?? "",
    offer_1_quote: quoteRange(offer1?.quote ?? null),
    offer_1_assumption: offer1?.assumption ?? "",
    door_opener: doorOpener?.title ?? "",
    owner: dossier?.facts?.owner?.value ?? "",
    since_year: dossier?.facts?.sinceYear?.value ?? "",
    call_status: dossier?.callStatus ?? "",
    status: lead.status,
    evidence_urls: evidenceUrls(dossier),
    source_url: lead.sourceUrl,
    attribution: lead.source === "osm" ? "(c) OpenStreetMap contributors" : "",
  };
}

function buildCsv(
  leads: Lead[],
  extras: ExtrasMap,
  format: Exclude<ExportFormat, "jsonl">
): string {
  const headers = GENERIC_COLUMNS.map((column) =>
    format === "generic"
      ? column
      : CRM_COLUMN_MAP[format][column] ?? `Leadscout ${column}`
  );

  const lines: string[] = [headers.map(safeCsvCell).join(",")];

  for (const lead of leads) {
    const { score, dossier } = getExtras(lead, extras);
    if (score?.gate === "hidden") continue;
    const record = buildGenericRecord(lead, score, dossier);
    lines.push(GENERIC_COLUMNS.map((column) => safeCsvCell(record[column])).join(","));
  }

  return `${lines.join("\n")}\n`;
}

export function exportRows(
  leads: Lead[],
  extras: ExtrasMap,
  format: ExportFormat
): { contentType: string; body: string } {
  if (format === "jsonl") {
    const lines: string[] = [];
    for (const lead of leads) {
      const { score, dossier } = getExtras(lead, extras);
      if (score?.gate === "hidden") continue;
      lines.push(
        JSON.stringify({
          lead,
          score: score ?? null,
          dossier: dossier ?? null,
        })
      );
    }
    return {
      contentType: "application/x-ndjson",
      body: lines.length ? `${lines.join("\n")}\n` : "",
    };
  }

  return {
    contentType: "text/csv; charset=utf-8",
    body: buildCsv(leads, extras, format),
  };
}
