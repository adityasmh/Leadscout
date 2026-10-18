// src/lookalike.ts - L31-lookalike (docs/leadgen/ORDER_L31-lookalike.md)
//
// Learn an "ideal customer" profile from 3 to 10 example websites, then rank discovered
// leads 0-100 against it.
//
//   buildProfile(examples, deps)     fetches each example politely through the existing
//                                    enrich() (robots.txt, User-Agent, max 3 pages all come
//                                    from enrich; this module never fetches by itself) and
//                                    aggregates categories, keywords, signal frequencies,
//                                    absent signals, languages, tech stack, contact routes
//                                    and size hints. Skipped examples are recorded with a
//                                    reason; fewer than 2 usable examples is a clear error.
//   scoreLookalike(profile, lead,e)  integer 0-100 plus up to 3 reasons, each citing the
//                                    matching signal id or keyword. Every number derives
//                                    from the exported WEIGHTS.
//   explainProfile(profile)          short plain sentences for the intake review screen,
//                                    built only from values in the profile. Fixed
//                                    connective words live in EXPLAIN_CONNECTIVES so a
//                                    checker can allow them.
//
// Node 24 built-ins only, ES module, .js import suffixes, no new dependencies.

import { enrich } from "./enrich.js";
import type { RawLead, Enrichment } from "./types.js";

export type LookalikeExample = { name: string; website: string; category: string };

export type LookalikeProfile = {
  usedCount: number;                                 // usable examples the profile was built from
  skipped: { example: string; reason: string }[];    // unusable examples and why
  categories: { value: string; count: number }[];    // example categories, count of usable examples
  keywords: { value: string; count: number }[];      // words from example title/description/summary only
  signals: { id: string; count: number; frequency: number }[]; // frequency = count / usable count
  absentSignals: string[];                           // candidate site signals no example has
  languages: { value: string; count: number }[];
  techStack: { id: string; count: number }[];        // wordpress | wix | shopify | custom-cms
  contactRoutes: { route: string; count: number }[]; // email | phone | whatsapp | socials | contact-form
  sizeHints: string[];                               // size statements found in the fetched text only
};

/**
 * Scoring weights, one per profile dimension; the sum is exactly 100.
 *
 * Rationale: signals (34) and keywords (23) carry the most weight because both are watched
 * on the example pages themselves and describe what the ideal sites actually share - the
 * signal ids come from the CONTRACT and the keywords come straight out of the fetched
 * example text. Category (15) is the business type match. Language, tech stack and contact
 * routes (10 each) are weaker hints: language and contact routes only separate leads at the
 * margin and the tech stack is just one signal subset.
 */
export const WEIGHTS: Readonly<{ category: number; signal: number; keyword: number; language: number; tech: number; contact: number }> = {
  category: 15,
  signal: 34,
  keyword: 23,
  language: 10,
  tech: 10,
  contact: 8,
} as const;
// documented sum check: 15 + 34 + 23 + 10 + 10 + 8 = 100

/** Fixed connective words explainProfile may use beyond values taken from the profile. */
export const EXPLAIN_CONNECTIVES: string[] = [
  "ideal", "customer", "profile", "from", "of", "usable", "examples", "skipped", "as", "unusable",
  "categories", "keywords", "common", "signals", "missing", "languages", "tech", "contact",
  "routes", "size", "hints",
  // skip reason codes (not example data, so checker needs to allow them)
  "site-unreachable", "no-website", "robots-disallow", "fetch-error",
];

// --------------------------------------------------------------------------- constants

/** Enrich-detectable site signals worth comparing across examples. Category-driven
 *  high-volume-enquiry-type and the situation signals no-website / site-unreachable are
 *  excluded on purpose: they are not traits a good example site shares. */
const SIGNAL_UNIVERSE = [
  "no-https", "not-mobile-friendly", "no-contact-form", "no-chat-widget", "no-online-booking",
  "no-analytics", "outdated-copyright", "wordpress", "wix", "shopify", "custom-cms",
  "has-whatsapp", "has-email", "has-phone", "social-active-links", "slow-response", "ecommerce",
  "appointment-based",
];

const TECH_IDS = ["wordpress", "wix", "shopify", "custom-cms"] as const;

// enrich.ts builds this exact boilerplate when a site is too thin; it lists no business
// traits, so it is stripped before tokenising rather than filtered word by word.
const THIN_SUMMARY_BOILERPLATE = "Not enough public text on this site to describe what the business does";

/** Small English stopword list plus obvious site chrome; keep it short so real niche
 *  keywords survive. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "our", "your", "you", "are", "was", "not",
  "but", "all", "can", "has", "have", "had", "its", "they", "them", "their", "what", "when",
  "where", "who", "why", "how", "get", "out", "one", "two", "about", "into", "over", "than",
  "then", "only", "per", "off", "will", "may", "more", "also", "etc", "via", "her", "him",
  "she", "did", "just", "now", "new", "home", "page", "site", "website", "web", "read", "click",
  "here", "menu", "search", "skip", "content", "welcome", "please", "call", "phone", "email",
  "address", "rights", "reserved", "copyright", "privacy", "policy", "terms", "powered",
  "follow", "share", "like", "join", "today", "com", "www", "inc", "ltd", "llp", "pvt", "gst",
  "shop",
]);

// --------------------------------------------------------------------------- helpers

function collapseLower(value: string): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Lowercase word tokens (letters first, length >= 3) with the stopword filter applied. */
function tokenize(text: string): string[] {
  const cleaned = String(text ?? "").replace(THIN_SUMMARY_BOILERPLATE, " ");
  return (cleaned.match(/[a-zA-Z][a-zA-Z0-9]{2,}/g) ?? [])
    .map((token) => token.toLowerCase())
    .filter((token) => !STOPWORDS.has(token));
}

/** Maps of value -> count become sorted {key, count} pairs: count descending, then key
 *  ascending, so the profile is deterministic for hand-computed checks. */
function sortedEntries(map: Map<string, number>): { key: string; count: number }[] {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key));
}

/** Routes of contact readable from one enrichment, same rule for examples and leads. */
function routesOf(e: Enrichment): string[] {
  const signals = e.signals ?? [];
  const routes: string[] = [];
  if ((e.emails?.length ?? 0) > 0 || signals.includes("has-email")) routes.push("email");
  if ((e.phones?.length ?? 0) > 0 || signals.includes("has-phone")) routes.push("phone");
  if (e.socials?.whatsapp || signals.includes("has-whatsapp")) routes.push("whatsapp");
  const socialKeys = Object.entries(e.socials ?? {}).filter(([, value]) => !!value).map(([key]) => key);
  if (socialKeys.some((key) => key !== "whatsapp") || signals.includes("social-active-links")) routes.push("socials");
  if (!signals.includes("no-contact-form")) routes.push("contact-form");
  return routes;
}

/** Size statements taken only from the fetched text: "team of 12 staff", "3 branches",
 *  "10+ years", "established 2009". Hints only exist when the words appear around the
 *  number, so nothing is invented. */
function sizeHintsFrom(text: string): string[] {
  const hints: string[] = [];
  const push = (label: string, value: string): void => { hints.push(`${label} ${value}`); };
  const staff = text.match(/\b(?:team\s+of\s+)?(\d{1,4})\s*\+?\s*(?:staff|employees|team\s*members|people)\b/i);
  if (staff && Number(staff[1]) >= 2) push("staff", staff[1]);
  const branches = text.match(/\b(\d{1,3})\s*\+?\s*(?:branches|locations|centres|centers|offices|clinics|studios|showrooms|outlets)\b/i);
  if (branches) push("branches", branches[1]);
  const years = text.match(/\b(\d{1,2})\s*\+?\s*years?\b/i);
  if (years) push("years", years[1]);
  const since = text.match(/\b(?:established|founded|since)\b[^0-9]{0,15}(19|20)(\d{2})\b/i);
  if (since) push("since", `${since[1]}${since[2]}`);
  return hints;
}

/** Why an enrichment cannot stand for an ideal example, or undefined when usable. */
function unusableReason(e: Enrichment): string | undefined {
  if (!e.fetchedUrl) return "no-website";
  if (e.signals?.includes("site-unreachable")) return "site-unreachable";
  if (/\brobots\.txt\b[^.]*\bdisallows?\b/i.test(e.summary ?? "")) return "robots-disallow";
  return undefined;
}

// --------------------------------------------------------------------------- buildProfile

/**
 * Build a lookalike profile from 3 to 10 example websites. Each example is fetched through
 * the existing enrich() with the injected fetchFn (never a direct fetch here). An example
 * whose fetch throws, whose site is unreachable, whose robots.txt disallows us, or which
 * has no website is recorded in `skipped` and left out; fewer than 2 usable examples is a
 * clear error.
 */
export async function buildProfile(
  examples: LookalikeExample[],
  deps: { fetchFn?: typeof fetch } = {},
): Promise<LookalikeProfile> {
  const list = Array.isArray(examples) ? examples : [];
  if (list.length < 3 || list.length > 10) {
    throw new Error(`buildProfile requires 3 to 10 examples, got ${list.length}`);
  }
  if (list.some((example) => !example || typeof example !== "object")) {
    throw new Error("buildProfile: every example must be an object with name, website and category");
  }

  const fetchFn = deps.fetchFn;
  const usable: { name: string; enrichment: Enrichment; category: string; text: string }[] = [];
  const skipped: { example: string; reason: string }[] = [];

  for (const example of list) {
    const name = String(example.name ?? "").trim() || "unnamed-example";
    const website = String(example.website ?? "").trim();
    const lead: RawLead = {
      name,
      category: String(example.category ?? "").trim() || "unknown",
      website,
      source: "lookalike-example",
      sourceUrl: website,
    };
    try {
      const enrichment = await enrich(lead, { fetchFn });
      const reason = unusableReason(enrichment);
      if (reason) {
        skipped.push({ example: name, reason });
        continue;
      }
      const text = [enrichment.title ?? "", enrichment.description ?? "", enrichment.summary ?? ""].join(" ");
      usable.push({ name, enrichment, category: collapseLower(lead.category), text });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push({ example: name, reason: `fetch-error (${message.slice(0, 120)})` });
    }
  }

  if (usable.length < 2) {
    const detail = skipped.map((skip) => `${skip.example} (${skip.reason})`).join(", ") || "none";
    throw new Error(
      `buildProfile needs at least 2 usable examples but only ${usable.length} of ${list.length} were usable (required minimum: 2, example count required: 3 to 10). Skipped: ${detail}`,
    );
  }

  const usedCount = usable.length;

  const categoryCounts = new Map<string, number>();
  const keywordCounts = new Map<string, number>();
  const signalCounts = new Map<string, number>();
  const languageCounts = new Map<string, number>();
  const techCounts = new Map<string, number>();
  const routeCounts = new Map<string, number>();
  const sizeHints = new Set<string>();

  for (const example of usable) {
    if (example.category) categoryCounts.set(example.category, (categoryCounts.get(example.category) ?? 0) + 1);

    const tokens = new Set(tokenize(example.text));
    for (const token of tokens) keywordCounts.set(token, (keywordCounts.get(token) ?? 0) + 1);

    for (const signal of example.enrichment.signals ?? []) {
      signalCounts.set(signal, (signalCounts.get(signal) ?? 0) + 1);
    }

    const language = String(example.enrichment.language ?? "").trim().toLowerCase();
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);

    for (const tech of TECH_IDS) {
      if (example.enrichment.signals?.includes(tech)) techCounts.set(tech, (techCounts.get(tech) ?? 0) + 1);
    }

    for (const route of routesOf(example.enrichment)) routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);

    for (const hint of sizeHintsFrom(example.text)) sizeHints.add(hint);
  }

  const signals = [...signalCounts.entries()]
    .map(([id, count]) => ({ id, count, frequency: count / usedCount }))
    .sort((a, b) => (b.count - a.count) || a.id.localeCompare(b.id));
  const seenSignals = new Set(signals.map((entry) => entry.id));
  const absentSignals = SIGNAL_UNIVERSE.filter((id) => !seenSignals.has(id));

  return {
    usedCount,
    skipped,
    categories: sortedEntries(categoryCounts).map(({ key, count }) => ({ value: key, count })),
    keywords: sortedEntries(keywordCounts).map(({ key, count }) => ({ value: key, count })),
    signals,
    absentSignals,
    languages: sortedEntries(languageCounts).map(({ key, count }) => ({ value: key, count })),
    techStack: sortedEntries(techCounts).map(({ key, count }) => ({ id: key, count })),
    contactRoutes: sortedEntries(routeCounts).map(({ key, count }) => ({ route: key, count })),
    sizeHints: [...sizeHints].sort(),
  };
}

// --------------------------------------------------------------------------- scoreLookalike

type Reason = { points: number; label: string };

/**
 * Score a lead 0-100 against a lookalike profile. Every contribution comes from WEIGHTS
 * scaled by how strongly the profile supports the matched item (count / usable examples).
 * The raw sum is normalised by the ceiling the profile itself allows, so a lead like the
 * examples ranks near the top even when the profile has no language data, and an empty
 * profile always scores 0 with no reasons.
 */
export function scoreLookalike(
  profile: LookalikeProfile,
  lead: RawLead,
  enrichment: Enrichment,
): { score: number; reasons: string[] } {
  const usedCount = profile?.usedCount ?? 0;
  if (usedCount < 1) return { score: 0, reasons: [] };
  const signals = profile.signals ?? [];
  const categories = profile.categories ?? [];
  const keywords = profile.keywords ?? [];
  const languages = profile.languages ?? [];
  const techStack = profile.techStack ?? [];
  const routes = (profile.contactRoutes ?? []).filter((entry) => entry.count > 0);

  // ceiling the profile itself allows, same shape as the raw sum below
  const ceiling =
    WEIGHTS.category * ((categories[0]?.count ?? 0) / usedCount) +
    WEIGHTS.signal * Math.min(1, signals.reduce((sum, entry) => sum + entry.frequency, 0)) +
    WEIGHTS.keyword * Math.min(1, keywords.reduce((sum, entry) => sum + entry.count / usedCount, 0)) +
    WEIGHTS.language * (languages[0]?.count ?? 0) / usedCount +
    WEIGHTS.tech * Math.min(1, techStack.reduce((sum, entry) => sum + entry.count / usedCount, 0)) +
    WEIGHTS.contact;
  if (!(ceiling > 0)) return { score: 0, reasons: [] };

  const raw: { points: number; reasons: Reason[] } = { points: 0, reasons: [] };
  // Reasons carry per-item shares used only to rank the top three; the score itself is the
  // sum of the (capped) per-dimension points, so a reason never double-counts.
  const cite = (points: number, label: string): void => {
    raw.reasons.push({ points, label });
  };

  // category: the lead's category as the examples name it
  const leadCategory = collapseLower(lead?.category ?? "");
  const categoryHit = categories.find((entry) => entry.value === leadCategory);
  if (categoryHit) {
    const points = WEIGHTS.category * (categoryHit.count / usedCount);
    raw.points += points;
    cite(points, `category ${categoryHit.value} (${categoryHit.count}/${usedCount} examples)`);
  }

  // signals: matched signal ids weighted by their frequency among the usable examples
  const leadSignals = enrichment?.signals ?? [];
  const matchedSignals = signals.filter((entry) => leadSignals.includes(entry.id));
  for (const entry of matchedSignals) {
    cite(WEIGHTS.signal * entry.frequency, `signal ${entry.id} (${entry.count}/${usedCount} examples)`);
  }
  raw.points += WEIGHTS.signal * Math.min(1, matchedSignals.reduce((sum, entry) => sum + entry.frequency, 0));

  // keywords: words from the lead's title/description/summary that the examples also used
  const leadTokens = new Set(tokenize([enrichment?.title, enrichment?.description, enrichment?.summary].filter(Boolean).join(" ")));
  const matchedKeywords = keywords.filter((entry) => leadTokens.has(entry.value));
  for (const entry of matchedKeywords) {
    cite(WEIGHTS.keyword * (entry.count / usedCount), `keyword ${entry.value} (${entry.count}/${usedCount} examples)`);
  }
  raw.points += WEIGHTS.keyword * Math.min(1, matchedKeywords.reduce((sum, entry) => sum + entry.count / usedCount, 0));

  // language
  const leadLanguage = String(enrichment?.language ?? "").trim().toLowerCase();
  const languageHit = languages.find((entry) => entry.value === leadLanguage);
  if (languageHit) {
    const points = WEIGHTS.language * (languageHit.count / usedCount);
    raw.points += points;
    cite(points, `language ${languageHit.value} (${languageHit.count}/${usedCount} examples)`);
  }

  // tech stack
  const matchedTech = techStack.filter((entry) => entry.count > 0 && leadSignals.includes(entry.id));
  for (const entry of matchedTech) {
    cite(WEIGHTS.tech * (entry.count / usedCount), `tech ${entry.id} (${entry.count}/${usedCount} examples)`);
  }
  raw.points += WEIGHTS.tech * Math.min(1, matchedTech.reduce((sum, entry) => sum + entry.count / usedCount, 0));

  // contact routes: how many of the profile's routes this lead also has
  const leadRoutes = routesOf(enrichment);
  const matchedRoutes = routes.filter((entry) => leadRoutes.includes(entry.route));
  for (const entry of matchedRoutes) {
    cite(WEIGHTS.contact * (entry.count / usedCount), `contact route ${entry.route} (${entry.count}/${usedCount} examples)`);
  }
  raw.points += WEIGHTS.contact * Math.min(1, matchedRoutes.reduce((sum, entry) => sum + entry.count / usedCount, 0));

  const score = Math.max(0, Math.min(100, Math.round((raw.points / ceiling) * 100)));
  const top = raw.reasons
    .filter((reason) => reason.points > 0)
    .sort((a, b) => (b.points - a.points) || a.label.localeCompare(b.label))
    .slice(0, 3)
    .map((reason) => reason.label);
  return { score, reasons: top };
}

// --------------------------------------------------------------------------- explainProfile

/**
 * Short plain sentences for the intake review screen, built only from values in the
 * profile; the fixed connective words are listed in EXPLAIN_CONNECTIVES so a checker can
 * allow them. No invented traits, no fallback adjectives.
 */
export function explainProfile(profile: LookalikeProfile): string {
  const usedCount = profile?.usedCount ?? 0;
  const parts: string[] = [`Ideal customer profile from ${usedCount} usable examples`];

  const skipped = profile?.skipped ?? [];
  if (skipped.length) {
    const list = skipped.map((skip) => `${skip.example} skipped as unusable (${skip.reason})`).join(", ");
    parts.push(list);
  }

  const categories = profile?.categories ?? [];
  if (categories.length) {
    parts.push(`categories ${categories.slice(0, 5).map((entry) => entry.value).join(", ")}`);
  }

  const keywords = profile?.keywords ?? [];
  if (keywords.length) {
    parts.push(`keywords ${keywords.slice(0, 8).map((entry) => entry.value).join(", ")}`);
  }

  const signals = profile?.signals ?? [];
  if (signals.length) {
    const list = signals.slice(0, 5).map((entry) => `${entry.id} (${entry.count} of ${usedCount})`).join(", ");
    parts.push(`common signals ${list}`);
  }

  const absent = profile?.absentSignals ?? [];
  if (absent.length) {
    parts.push(`missing signals ${absent.join(", ")}`);
  }

  const languages = profile?.languages ?? [];
  if (languages.length) {
    parts.push(`languages ${languages.map((entry) => entry.value).join(", ")}`);
  }

  const techStack = profile?.techStack ?? [];
  if (techStack.length) {
    const list = techStack.map((entry) => `${entry.id} (${entry.count} of ${usedCount})`).join(", ");
    parts.push(`tech ${list}`);
  }

  const routes = profile?.contactRoutes ?? [];
  if (routes.length) {
    parts.push(`contact routes ${routes.map((entry) => entry.route).join(", ")}`);
  }

  const sizeHints = profile?.sizeHints ?? [];
  if (sizeHints.length) {
    parts.push(`size hints ${sizeHints.join(", ")}`);
  }

  return parts.join("; ") + ".";
}
