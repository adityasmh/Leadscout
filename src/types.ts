// Shared types for leadscout. The first block is the manager contract (docs/leadgen/CONTRACT.md),
// copied exactly. The block after it holds the store/server shapes L2 also owns.

export type RawLead = {
  name: string; category: string; address?: string; city?: string; country?: string;
  lat?: number; lon?: number; phone?: string; email?: string; website?: string;
  source: string;            // e.g. "osm"
  sourceUrl: string;         // page or record the lead came from
};
export type Enrichment = {
  fetchedUrl?: string; title?: string; description?: string;
  summary: string;           // 1-2 sentences, what the company does, built only from fetched text
  emails: string[]; phones: string[];
  socials: { linkedin?: string; instagram?: string; facebook?: string; twitter?: string; youtube?: string; whatsapp?: string };
  signals: string[];         // stable ids, see SIGNALS below
  language?: string;
};
export type Offer = { services: string[]; description: string }; // e.g. services: ["website","automation","ai-chatbot","seo","crm-setup"]
export type FitService = { service: string; score: number; reason: string }; // score 0-100, reason cites a signal
export type Match = { score: number; fit: FitService[]; angle: string }; // angle: one outreach sentence built from signals, no invented facts
export type Lead = RawLead & Enrichment & Match & { id: string; workspaceId: string; status: "new"|"shortlisted"|"contacted"|"replied"|"won"|"rejected"; notes: string; createdAt: string; enrichedAt?: string; gate?: "hidden" | "template" | "llm" };

// ---------------------------------------------------------------------------
// Store / server shapes (L2). Other workers may copy these locally.

export type LeadStatus = Lead["status"];
export const LEAD_STATUSES: LeadStatus[] = ["new", "shortlisted", "contacted", "replied", "won", "rejected"];

export type Icp = { categories: string[]; cities: string[]; countries: string[] };
export type Workspace = { id: string; name: string; offer: Offer; icp: Icp; createdAt: string };

export type JobStatus = "queued" | "running" | "done" | "failed";
export type JobQuery = { category: string; city?: string; country?: string; limit?: number };
export type Job = {
  id: string; workspaceId: string; query: JobQuery; status: JobStatus;
  found: number; enriched: number; error?: string; createdAt: string;
};

export type LeadFilter = {
  workspaceId: string;
  status?: string; minScore?: number; city?: string; category?: string; signal?: string; q?: string;
  sort?: "score" | "createdAt"; limit?: number; offset?: number; includeHidden?: boolean;
};
