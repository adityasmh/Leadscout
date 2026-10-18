// src/routes-showcase.ts
// Order DEMO2-showcase-page: GET /api/workspaces/:ws/showcase
// One JSON overview of a workspace's real lead data for the client-facing
// showcase page. Reads through the existing store functions only; adds no
// schema. Returns false for any path it does not own, like the other route
// modules (routes-calls.ts, routes-intake.ts). Node 24 built-ins only.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getWorkspace, listLeads } from "./store.js";
import { classifyPhone } from "./verify.js";
import type { Lead } from "./types.js";

/** Optional injected deps; the module needs none today (kept for the hook signature). */
export type ShowcaseDeps = Record<string, never>;

const SHOWCASE_RE = /^\/api\/workspaces\/([^/]+)\/showcase$/;
const TOP_LEADS = 12;
const RECENT_CALLS = 3;
const MAX_ROWS = 100000;

type Counts = {
  leads: number;
  enriched: number;
  scored: number;
  withPhone: number;
  withEmail: number;
  withWebsite: number;
};

type Funnel = {
  discovered: number;
  understood: number;
  scored: number;
  dossierReady: number;
  contactable: number;
};

type CategoryRow = { category: string; leads: number; avgScore: number; topService: string };

type TopLead = {
  id: string;
  name: string;
  category: string;
  area: string;
  score: number;
  topService: string;
  gapHeadline: string;
  phone: string;
};

type RecentCall = {
  id: string;
  leadId: string;
  leadName: string;
  at: string;
  channel: string;
  outcome: string;
  nextAction: string;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstPhone(lead: Lead): string {
  const candidates: string[] = [];
  const direct = text(lead.phone);
  if (direct !== "") candidates.push(direct);
  const list = Array.isArray(lead.phones) ? lead.phones : [];
  for (const entry of list) {
    const value = text(entry);
    if (value !== "") candidates.push(value);
  }
  let landline = "";
  for (const candidate of candidates) {
    const found = classifyPhone(candidate);
    if (found.result === "mobile" && found.e164) return found.e164;
    if (landline === "" && found.result === "landline" && found.e164) landline = found.e164;
  }
  return landline;
}

function hasEmail(lead: Lead): boolean {
  if (text(lead.email) !== "") return true;
  const list = Array.isArray(lead.emails) ? lead.emails : [];
  return list.some((entry) => text(entry) !== "");
}

function isEnriched(lead: Lead): boolean {
  if (text(lead.enrichedAt) !== "") return true;
  return text(lead.summary) !== "";
}

function isScored(lead: Lead): boolean {
  return Number(lead.score ?? 0) > 0;
}

function topServiceOf(lead: Lead): string {
  const fit = Array.isArray(lead.fit) ? lead.fit : [];
  for (const entry of fit) {
    const service = text(entry?.service);
    if (service !== "") return service;
  }
  return "";
}

function areaOf(lead: Lead, dossierArea: string): string {
  return text(lead.city) || text(dossierArea) || text(lead.address);
}

/** Dossiers are looked up through the optional module; a missing one yields no headline. */
async function loadDossiers(workspaceId: string, leads: Lead[]): Promise<Map<string, { gapHeadline: string; area: string }>> {
  const out = new Map<string, { gapHeadline: string; area: string }>();
  let getDossier: ((ws: string, leadId: string) => { gap?: { headline?: { value?: string } } | null; facts?: { area?: { value?: string } } } | undefined) | undefined;
  try {
    const mod = (await import("./dossier.js")) as { getDossier?: typeof getDossier };
    getDossier = mod.getDossier;
  } catch {
    getDossier = undefined;
  }
  if (!getDossier) return out;
  for (const lead of leads) {
    try {
      const dossier = getDossier(workspaceId, lead.id);
      if (!dossier) continue;
      out.set(lead.id, {
        gapHeadline: text(dossier.gap?.headline?.value),
        area: text(dossier.facts?.area?.value),
      });
    } catch {
      // A broken dossier row must not break the overview.
    }
  }
  return out;
}

/** The newest call-log entries, or [] when the call-log module is not available. */
async function loadRecentCalls(workspaceId: string, leads: Lead[]): Promise<RecentCall[]> {
  type CallRow = { id?: string; leadId?: string; at?: string; channel?: string; outcome?: string; nextAction?: string };
  let callsForLead: ((ws: string, leadId: string) => CallRow[]) | undefined;
  try {
    const mod = (await import("./calls.js")) as { callsForLead?: typeof callsForLead };
    callsForLead = mod.callsForLead;
  } catch {
    callsForLead = undefined;
  }
  if (!callsForLead) return [];
  const nameById = new Map<string, string>();
  const all: CallRow[] = [];
  for (const lead of leads) {
    nameById.set(lead.id, text(lead.name));
    try {
      const rows = callsForLead(workspaceId, lead.id);
      if (Array.isArray(rows)) all.push(...rows);
    } catch {
      // Ignore a single lead's call read failure.
    }
  }
  return all
    .slice()
    .sort((a, b) => Date.parse(text(b.at)) - Date.parse(text(a.at)))
    .slice(0, RECENT_CALLS)
    .map((call) => ({
      id: text(call.id),
      leadId: text(call.leadId),
      leadName: nameById.get(text(call.leadId)) ?? "",
      at: text(call.at),
      channel: text(call.channel),
      outcome: text(call.outcome),
      nextAction: text(call.nextAction),
    }));
}

function categoryRows(leads: Lead[]): CategoryRow[] {
  const groups = new Map<string, Lead[]>();
  for (const lead of leads) {
    const key = text(lead.category) || "Uncategorised";
    const list = groups.get(key) ?? [];
    list.push(lead);
    groups.set(key, list);
  }
  const rows: CategoryRow[] = [];
  for (const [category, list] of groups) {
    const ordered = list.slice().sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
    const total = ordered.reduce((sum, lead) => sum + Number(lead.score ?? 0), 0);
    const avgScore = ordered.length > 0 ? Math.round(total / ordered.length) : 0;
    const serviceCounts = new Map<string, number>();
    for (const lead of ordered) {
      const service = topServiceOf(lead);
      if (service === "") continue;
      serviceCounts.set(service, (serviceCounts.get(service) ?? 0) + 1);
    }
    let topService = "";
    let best = 0;
    for (const [service, count] of serviceCounts) {
      if (count > best) {
        best = count;
        topService = service;
      }
    }
    rows.push({ category, leads: ordered.length, avgScore, topService });
  }
  rows.sort((a, b) => b.leads - a.leads || a.category.localeCompare(b.category));
  return rows;
}

/**
 * Serves GET /api/workspaces/:ws/showcase and returns true when it handled the
 * request. Returns false for every other path/method so the server continues.
 */
export async function handleShowcaseRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _deps: ShowcaseDeps = {}
): Promise<boolean> {
  if ((req.method ?? "GET") !== "GET") return false;
  const match = SHOWCASE_RE.exec(url.pathname);
  if (!match) return false;

  let workspaceId = match[1];
  try {
    workspaceId = decodeURIComponent(workspaceId);
  } catch {
    // keep the raw segment
  }

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    sendJson(res, 404, { error: "workspace not found" });
    return true;
  }

  const leads = listLeads({ workspaceId, limit: MAX_ROWS, offset: 0 }).leads;
  const dossiers = await loadDossiers(workspaceId, leads);

  const counts: Counts = {
    leads: leads.length,
    enriched: 0,
    scored: 0,
    withPhone: 0,
    withEmail: 0,
    withWebsite: 0,
  };
  for (const lead of leads) {
    if (isEnriched(lead)) counts.enriched += 1;
    if (isScored(lead)) counts.scored += 1;
    if (firstPhone(lead) !== "") counts.withPhone += 1;
    if (hasEmail(lead)) counts.withEmail += 1;
    if (text(lead.website) !== "") counts.withWebsite += 1;
  }

  const funnel: Funnel = {
    discovered: leads.length,
    understood: counts.enriched,
    scored: counts.scored,
    dossierReady: dossiers.size,
    contactable: leads.filter((lead) => firstPhone(lead) !== "" || hasEmail(lead)).length,
  };

  const ranked = leads
    .slice()
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0) || text(a.name).localeCompare(text(b.name)));

  const topLeads: TopLead[] = ranked.slice(0, TOP_LEADS).map((lead) => {
    const info = dossiers.get(lead.id);
    return {
      id: lead.id,
      name: text(lead.name),
      category: text(lead.category),
      area: areaOf(lead, info?.area ?? ""),
      score: Number(lead.score ?? 0),
      topService: topServiceOf(lead),
      gapHeadline: info?.gapHeadline ?? "",
      phone: firstPhone(lead),
    };
  });

  const recentCalls = await loadRecentCalls(workspaceId, leads);

  sendJson(res, 200, {
    workspace: { id: workspace.id, name: text(workspace.name) },
    offer: {
      services: Array.isArray(workspace.offer?.services) ? workspace.offer.services : [],
      description: text(workspace.offer?.description),
    },
    counts,
    funnel,
    categories: categoryRows(leads),
    topLeads,
    recentCalls,
  });
  return true;
}
