// reach.ts — optional wider data layer backed by Agent Reach (docs/leadgen/ORDER_L32-reach.md).
// Canonical upstream: github.com/Panniantong/Agent-Reach (see docs/leadgen/REACH_NOTES.md).
// Thin adapter only: never installs, never authenticates, never stores credentials.
// Node 24 built-ins only; network and exec are injected so tests run offline.

import type { Enrichment } from "./types.js";

export type ReachTrace = { channel: string; target: string; time: string };
export type ReachChannelStatus = { ok: boolean; backend?: string; status?: "warn"; message?: string };
export type ReachStatus = {
  available: boolean;
  channels: Record<string, ReachChannelStatus>;
  install?: string;
  error?: string;
};
export type WebSearchResult = { title?: string; url: string; snippet?: string; untrusted: true };
export type ReachResult = {
  ok: boolean;
  channel: string;
  text: string;
  untrusted: true;
  notice?: string;
  degraded?: boolean;
  error?: string;
  trace: ReachTrace[];
  results?: WebSearchResult[];
};
export type ReachExecFile = (
  file: string,
  args: readonly string[],
  opts: { timeout: number; windowsHide?: boolean },
) => Promise<{ stdout: string; stderr: string }>;
export type ReachDeps = {
  execFile?: ReachExecFile;
  fetchFn?: typeof fetch;
  now?: () => string;
};

// The real `agent-reach doctor --json` probes every channel over the network and takes ~25s on
// this machine, so 20s was too tight and made every call look like "agent-reach unavailable"
// (Order L78 live smoke). 45s leaves headroom for the channel probes.
export const REACH_DOCTOR_TIMEOUT_MS = 45000;
export const REACH_MAX_CHARS = 20000;
export const OPERATOR_NOTICE =
  "Operator notice: platform terms of service apply; the operator is responsible for lawful use of this result.";
export const REACH_INSTALL_CMD =
  "pipx install https://github.com/Panniantong/Agent-Reach/archive/main.zip && agent-reach install --env=auto";

// Upstream commands per the canonical repo README/Quick Reference (REACH_NOTES.md).
export const FEEDPY =
  "import feedparser,json,sys;d=feedparser.parse(sys.argv[1]);print(json.dumps({'title':d.feed.get('title',''),'entries':[(' '.join([e.get('title','') or '',(e.get('summary','') or '')]))[:1500] for e in d.entries[:20]]}))";

export function channelCommand(channel: string, target: string): { file: string; args: string[] } {
  switch (channel) {
    case "web":
      return { file: "curl", args: ["-s", "-m", "15", `https://r.jina.ai/${target}`] };
    case "exa_search":
      return { file: "mcporter", args: ["call", "exa.web_search_exa", `query=${target}`, "numResults=5", "--timeout", "15000"] };
    case "rss":
      return { file: "python3", args: ["-c", FEEDPY, target] };
    case "twitter":
      return { file: "twitter", args: ["search", target, "-n", "10"] };
    case "reddit":
      return { file: "opencli", args: ["reddit", "search", target, "-f", "yaml"] };
    case "facebook":
      return { file: "opencli", args: ["facebook", "search", target, "-f", "yaml"] };
    case "instagram":
      return { file: "opencli", args: ["instagram", "search", target, "-f", "yaml"] };
    case "xiaohongshu":
      return { file: "opencli", args: ["xiaohongshu", "search", target, "-f", "yaml"] };
    case "bilibili":
      return { file: "bili", args: ["search", target, "--type", "video"] };
    case "linkedin":
      return { file: "mcporter", args: ["call", "linkedin.get_person_profile", `linkedin_username=${target}`, "--timeout", "15000"] };
    case "github":
      return { file: "gh", args: ["search", "repos", target] };
    default:
      return { file: "agent-reach", args: ["doctor"] };
  }
}

// --- caps: 1 request/second after our previous call, 200 calls per job ---
const caps = { minIntervalMs: 1000, maxCallsPerJob: 200, resetPerEnrich: true };
let lastCallAt = 0;
let jobCalls = 0;

export function configureReach(p: Partial<typeof caps>): void {
  Object.assign(caps, p);
}
export function resetReachJob(): void {
  jobCalls = 0;
}
async function budget(): Promise<string | null> {
  if (jobCalls >= caps.maxCallsPerJob) return `call cap reached (${caps.maxCallsPerJob}/job)`;
  const wait = caps.minIntervalMs - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
  jobCalls += 1;
  return null;
}

// Windows shims (e.g. %APPDATA%\npm\agent-reach.cmd) are .cmd files and
// Node's execFile cannot run them without a shell (Order L78-reach-windows). Wrap every tool
// (agent-reach and its channel CLIs mcporter/curl/opencli/...) with `cmd.exe /d /s /c <tool> ...`
// on win32; AGENT_REACH_CMD overrides the agent-reach tool command.
function wrapTool(file: string, args: readonly string[], platform: string): { file: string; args: string[] } {
  if (platform === "win32") return { file: "cmd.exe", args: ["/d", "/s", "/c", file, ...args] };
  return { file, args: [...args] };
}

// reachSpawn is the single builder every Agent Reach / channel call goes through: it applies the
// AGENT_REACH_CMD override to the agent-reach tool and wraps the command for the platform.
export function reachSpawn(
  file: string,
  args: readonly string[],
  platform: string = process.platform,
  envCmd?: string,
): { file: string; args: string[] } {
  const tool = file === "agent-reach" ? ((envCmd ?? process.env.AGENT_REACH_CMD ?? "").trim() || "agent-reach") : file;
  return wrapTool(tool, args, platform);
}

export function reachCommand(
  args: readonly string[],
  platform: string = process.platform,
  envCmd?: string,
): { file: string; args: string[] } {
  return reachSpawn("agent-reach", args, platform, envCmd);
}

async function defaultExecFile(file: string, args: readonly string[], opts: { timeout: number; windowsHide?: boolean }): Promise<{ stdout: string; stderr: string }> {
  const { execFile: cb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(cb) as ReachExecFile;
  return run(file, args, { ...opts, windowsHide: true });
}

// runSpawn is the one place that calls an (injected or real) execFile. The command is already
// resolved by reachSpawn/reachCommand, so the win32 cmd.exe shape is used for injected fakes too.
async function runSpawn(
  spawn: { file: string; args: string[] },
  deps: ReachDeps,
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  const ef = deps.execFile ?? defaultExecFile;
  return ef(spawn.file, spawn.args, { timeout, windowsHide: true });
}

function missingTool(e: unknown): boolean {
  const a = e as { code?: string; message?: string };
  return a?.code === "ENOENT" || /enoent|is not recognized|not found|cannot find/i.test(a?.message ?? "");
}

// doctor --json schema not verifiable from README/LICENSE alone; parse defensively.
// Two shapes are accepted (Order L78): the old `{channels: {name: true|{ok,...}}}` and the
// real keyed shape `{name: {status: "ok"|"warn"|"off", name?, message?, tier?, backends?}}`.
// "ok" -> available; "off" -> unavailable; "warn" -> installed but needs configuration or
// login: browser-backed channels (X, Facebook, Instagram, LinkedIn, Reddit) count as
// available only when the browser reader reports the operator logged in, otherwise
// unavailable with the message; other warn channels (CLI backends like Exa/mcporter) are
// treated as available and keep status "warn" visible to callers.
const BROWSER_WARN_CHANNELS = new Set(["twitter", "x", "facebook", "instagram", "linkedin", "reddit"]);
const LOGGED_IN_RE = /logged[- ]?in|已登录|登录成功|cookie (?:saved|present|valid)|身份有效|active session/i;
const LOGGED_OUT_RE = /\bnot logged[- ]?in\b|未登录|需要登录|缺少登录|please log ?in|needs? (?:configuration|login)/i;
function browserWarnLoggedOut(message?: string): boolean {
  const m = String(message ?? "").trim();
  if (!m) return true; // no login confirmation from the browser reader -> unavailable
  return LOGGED_OUT_RE.test(m) || !LOGGED_IN_RE.test(m);
}

export function parseDoctor(output: string): Record<string, ReachChannelStatus> {
  const out = String(output ?? "").trim();
  try {
    const j = JSON.parse(out) as { channels?: unknown };
    const chans = (j && typeof j === "object" && j.channels !== undefined ? j.channels : j) as Record<string, unknown> | null;
    if (chans && typeof chans === "object") {
      const parsed: Record<string, ReachChannelStatus> = {};
      for (const [name, v] of Object.entries(chans)) {
        if (typeof v === "boolean") parsed[name] = { ok: v };
        else if (v && typeof v === "object") {
          const o = v as { ok?: boolean; working?: boolean; status?: unknown; active_backend?: unknown; backend?: unknown; message?: unknown };
          const st = typeof o.status === "string" ? o.status.toLowerCase() : undefined;
          const message = typeof o.message === "string" ? o.message : undefined;
          let ok = o.ok === true || o.working === true || st === "ok";
          const warn = st === "warn";
          if (warn) {
            const browser = BROWSER_WARN_CHANNELS.has(name.toLowerCase());
            if (!browser || !browserWarnLoggedOut(message)) ok = true;
          }
          parsed[name] = {
            ok,
            ...(typeof o.active_backend === "string" ? { backend: o.active_backend } : typeof o.backend === "string" ? { backend: o.backend } : {}),
            ...(warn ? { status: "warn" as const } : {}),
            ...(message !== undefined ? { message } : {}),
          };
        }
      }
      return parsed;
    }
  } catch {
    /* fall through to text parsing */
  }
  const parsed: Record<string, ReachChannelStatus> = {};
  for (const line of out.split(/\r?\n/)) {
    const emoji = line.match(/([a-z][a-z0-9_-]{1,20})[^\n]*?(✅|❌|⚠️)/i);
    const plain = emoji ? undefined : line.match(/([a-z][a-z0-9_-]{1,20})\b[^\n]*\b(ok|fail|missing)\b/i);
    const m = emoji ?? plain;
    const mark = emoji ? emoji[2] : plain ? ` ${plain[2]} ` : undefined;
    if (!m || mark === undefined) continue;
    parsed[m[1].toLowerCase()] = { ok: mark === "✅" || /ok/i.test(mark) };
  }
  return parsed;
}

// parseSearchOutput: parse mcporter/Exa search text into {title, url, snippet} results,
// capped at 8, every result marked untrusted. Accepted forms (layered, defensive):
// 1. JSON with a results array ({title,url,text|snippet}) (e.g. `mcporter call exa.web_search_exa`)
// 2. inline JSON objects {"title":...,"url":...,"text":...}
// 3. markdown links `[title](url)` with a nearby snippet line
// 4. bare `https://` URLs
export const SEARCH_MAX_RESULTS = 8;
export function parseSearchOutput(text: string, cap: number = SEARCH_MAX_RESULTS): WebSearchResult[] {
  const raw = String(text ?? "");
  const out: WebSearchResult[] = [];
  const seen = new Set<string>();
  const push = (title: string | undefined, url: string | undefined, snippet: string | undefined): void => {
    const u = String(url ?? "").trim().replace(/[),.;]+$/, "");
    if (!/^https?:\/\//i.test(u) || seen.has(u) || out.length >= cap) return;
    seen.add(u);
    out.push({ ...(title ? { title: title.replace(/^\d+[.)]\s*/, "").trim() || undefined } : {}), url: u, ...(snippet?.trim() ? { snippet: snippet.trim() } : {}), untrusted: true });
  };
  const tryObj = (s: string): Record<string, unknown> | null => {
    try {
      const j = JSON.parse(s) as unknown;
      return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const itemTo = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    const m = item as Record<string, unknown>;
    const url = typeof m.url === "string" ? m.url : typeof m.link === "string" ? m.link : undefined;
    if (!url) return;
    const title = typeof m.title === "string" ? m.title : undefined;
    const snippet = typeof m.text === "string" ? m.text : typeof m.snippet === "string" ? m.snippet : undefined;
    push(title, url, snippet);
  };
  // 1. whole-output JSON: {results:[...]} | {data:{results:[...]}} | [...]
  const arrs: unknown[] = [];
  let whole: unknown = null;
  try {
    whole = JSON.parse(raw.trim());
  } catch {
    whole = null;
  }
  if (whole) {
    const w = whole as Record<string, unknown>;
    arrs.push(whole, w.results, (w.data as Record<string, unknown> | undefined)?.results);
  }
  for (const a of arrs) {
    if (Array.isArray(a)) for (const item of a) itemTo(item);
  }
  // 2. inline JSON objects embedded in text
  for (const m of raw.matchAll(/\{[^{}]*\}/g)) {
    const o = tryObj(m[0]);
    if (o) itemTo(o);
  }
  // 3. markdown links [title](url); snippet = first following line that is not a link entry.
  // Markdown is parsed even when JSON results exist, so mixed outputs accumulate (Order L78).
  const mdLink = (l: string): [string, string] | null => {
    const m = l.match(/\[([^\]]{0,120})\]\((https?:\/\/[^)\s]+)\)/);
    return m ? [m[1], m[2]] : null;
  };
  const lines = raw.split(/\r?\n/);
  const mdHits: Array<{ idx: number; title: string; url: string }> = [];
  lines.forEach((l, i) => {
    const m = mdLink(l);
    if (m) mdHits.push({ idx: i, title: m[0], url: m[1] });
  });
  for (const h of mdHits) {
    let snippet: string | undefined;
    for (let i = h.idx + 1; i < Math.min(lines.length, h.idx + 6) && snippet === undefined; i++) {
      const l = lines[i].trim();
      if (l && !mdLink(l)) snippet = l;
    }
    push(h.title, h.url, snippet);
  }
  if (out.length) return out;
  // 4. bare URLs; title = a preceding `Title: ...` line, snippet = the rest of the same line
  // after the url, else the line above.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/https?:\/\/[^\s)\]]+/);
    if (!m) continue;
    const after = lines[i].slice((m.index ?? 0) + m[0].length).replace(/^[^A-Za-z0-9]+/, "");
    const prev = i > 0 ? lines[i - 1].trim() : "";
    const titleLine = prev.match(/^Title:\s*(.+)$/i);
    if (titleLine) push(titleLine[1], m[0], after || undefined);
    else push(after || undefined, m[0], after && !after.startsWith("http") ? after : prev);
  }
  return out;
}

let cachedStatus: { at: number; status: ReachStatus } | null = null;

export async function reachStatus(deps: ReachDeps = {}): Promise<ReachStatus> {
  if (!deps.execFile && cachedStatus && Date.now() - cachedStatus.at < 60000) return cachedStatus.status;
  let status: ReachStatus;
  try {
    const { stdout } = await runSpawn(reachCommand(["doctor", "--json"]), deps, REACH_DOCTOR_TIMEOUT_MS);
    status = { available: true, channels: parseDoctor(stdout) };
  } catch (e) {
    if (missingTool(e)) status = { available: false, channels: {}, install: REACH_INSTALL_CMD };
    else status = { available: false, channels: {}, install: REACH_INSTALL_CMD, error: String((e as Error)?.message ?? e) };
  }
  if (!deps.execFile) cachedStatus = { at: Date.now(), status };
  return status;
}
export function resetReachStatusCache(): void {
  cachedStatus = null;
}

function entry(channel: string, target: string, deps: ReachDeps): ReachTrace {
  return { channel, target, time: deps.now?.() ?? new Date().toISOString() };
}

async function runChannel(channel: string, target: string, deps: ReachDeps, notice: boolean): Promise<ReachResult> {
  const trace: ReachTrace[] = [entry(channel, target, deps)];
  const capped = await budget();
  if (capped) return { ok: false, channel, text: "", untrusted: true, error: capped, trace };
  try {
    const cmd = channelCommand(channel, target);
    const { stdout, stderr } = await runSpawn(reachSpawn(cmd.file, cmd.args), deps, REACH_DOCTOR_TIMEOUT_MS);
    const text = sanitizeUntrusted(String(stdout || stderr || ""));
    return { ok: text.length > 0, channel, text, untrusted: true, ...(notice ? { notice: OPERATOR_NOTICE } : {}), trace };
  } catch (e) {
    return { ok: false, channel, text: "", untrusted: true, error: String((e as Error)?.message ?? e), trace };
  }
}

export const SOCIAL_CHANNELS = ["twitter", "reddit", "facebook", "instagram", "xiaohongshu", "bilibili", "linkedin"] as const;
// channels that support name search without a per-item URL
const AUTO_SOCIAL_SEARCH = ["twitter", "reddit", "facebook", "instagram", "xiaohongshu", "bilibili", "linkedin"] as const;
const working = (ch: Record<string, ReachChannelStatus>, name: string): boolean => ch[name]?.ok === true;

// --- sanitiser: strips instruction-like lines, caps length ---
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all )?(the )?previous/i,
  /you are now/i,
  /system prompt/i,
  /disregard (all )?(the )?(above|previous|prior|earlier)/i,
  /^\s*(<\/?(tool|function|invoke)\b[^>]*>|<\|[^|]*\|>)/i,
  /^\s*```/,
];

export function sanitizeUntrusted(text: string, maxLen: number = REACH_MAX_CHARS): string {
  const lines = String(text ?? "").split(/\r?\n/).filter((l) => !INJECTION_PATTERNS.some((r) => r.test(l)));
  const out = lines.join("\n");
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}

type Channels = Record<string, ReachChannelStatus>;

async function webWith(channels: Channels | null, url: string, deps: ReachDeps): Promise<ReachResult> {
  if (channels && working(channels, "web")) return runChannel("web", url, deps, false);
  // degraded mode: plain fetch through the explicitly injected fetchFn only
  if (deps.fetchFn) {
    const capped = await budget();
    if (capped) return { ok: false, channel: "web", text: "", untrusted: true, degraded: true, error: capped, trace: [entry("web-degraded", url, deps)] };
    const reason = channels === null
      ? "reach off (LEADSCOUT_REACH=0) or agent-reach unavailable"
      : "web channel not working";
    try {
      const res = await deps.fetchFn(url);
      const clean = sanitizeUntrusted(await res.text());
      return { ok: res.ok && clean.length > 0, channel: "web", text: clean, untrusted: true, degraded: true, ...(clean.length === 0 || !res.ok ? { error: reason } : {}), trace: [entry("web-degraded", url, deps)] };
    } catch (e) {
      return { ok: false, channel: "web", text: "", untrusted: true, degraded: true, error: String((e as Error)?.message ?? e), trace: [entry("web-degraded", url, deps)] };
    }
  }
  const fallback = channels === null
    ? "reach off (LEADSCOUT_REACH=0) or agent-reach unavailable"
    : "web channel not working and no fetchFn injected";
  return { ok: false, channel: "web", text: "", untrusted: true, degraded: true, error: fallback, trace: [] };
}

const OFF_RESULT_MSG = "reach off by LEADSCOUT_REACH=0";
const offResult = (channel: string): ReachResult => ({ ok: false, channel, text: "", untrusted: true, degraded: true, error: OFF_RESULT_MSG, trace: [] });

function envOff(): boolean {
  return process.env.LEADSCOUT_REACH === "0";
}

export async function readPage(url: string, deps: ReachDeps = {}): Promise<ReachResult> {
  if (envOff()) return offResult("web");
  return webWith((await channelsFor(deps)), url, deps);
}

export async function searchWeb(query: string, deps: ReachDeps = {}): Promise<ReachResult> {
  if (envOff()) return offResult("exa_search");
  const channels = await channelsFor(deps);
  if (!channels) return { ok: false, channel: "exa_search", text: "", untrusted: true, error: "agent-reach unavailable", trace: [] };
  if (!working(channels, "exa_search")) return { ok: false, channel: "exa_search", text: "", untrusted: true, error: "exa_search channel not working", trace: [] };
  const r = await runChannel("exa_search", query, deps, false);
  const results = parseSearchOutput(r.text);
  return { ...r, results };
}

export async function readFeed(url: string, deps: ReachDeps = {}): Promise<ReachResult> {
  if (envOff()) return offResult("rss");
  const channels = await channelsFor(deps);
  if (!channels) return { ok: false, channel: "rss", text: "", untrusted: true, error: "agent-reach unavailable", trace: [] };
  if (!working(channels, "rss")) return { ok: false, channel: "rss", text: "", untrusted: true, error: "rss channel not working", trace: [] };
  return runChannel("rss", url, deps, false);
}

async function channelsFor(deps: ReachDeps): Promise<Channels | null> {
  const status = await reachStatus(deps);
  return status.available ? status.channels : null;
}

// --- extraction helpers (only what was actually fetched) ---
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+\d{1,3}[- ]?)?(?:\d[\d\s()-]{6,}\d)/g;
const SOCIAL_LINK_RES: [keyof Enrichment["socials"], RegExp][] = [
  ["linkedin", /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9_\-%]+\/?/i],
  ["instagram", /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]+\/?/i],
  ["facebook", /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9_.\-%]+\/?/i],
  ["twitter", /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+\/?/i],
  ["youtube", /https?:\/\/(?:www\.)?youtube\.com\/(?:@[A-Za-z0-9_.-]+|channel\/[A-Za-z0-9_-]+)\/?/i],
  ["whatsapp", /https?:\/\/(?:wa\.me\/\+?\d+|api\.whatsapp\.com\/send\?phone=\+?\d+)/i],
];

export function extractContacts(text: string): { emails: string[]; phones: string[] } {
  const uniq = (xs: string[]): string[] => [...new Set(xs)];
  const emails = uniq((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())).slice(0, 5);
  const phones = uniq((text.match(PHONE_RE) ?? []).map((p) => p.trim()).filter((p) => {
    const d = p.replace(/\D/g, "");
    return d.length >= 8 && d.length <= 15;
  })).slice(0, 5);
  return { emails, phones };
}
export function extractSocialLinks(text: string): Enrichment["socials"] {
  const s: Record<string, string> = {};
  for (const [k, re] of SOCIAL_LINK_RES) {
    const m = text.match(re);
    if (m) s[k] = m[0];
  }
  return s;
}
// mergeSocials copies found links into an Enrichment.socials object without widening its type.
function mergeSocials(socials: Enrichment["socials"], text: string): void {
  const found = extractSocialLinks(text) as Record<string, string | undefined>;
  const target = socials as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(found)) if (v !== undefined && target[k] === undefined) target[k] = v;
}
export function parseJina(out: string): { title?: string; body: string } {
  const lines = out.split(/\r?\n/);
  let title: string | undefined;
  let body = out;
  if (lines[0]?.startsWith("Title:")) title = lines[0].slice(6).trim() || undefined;
  const idx = out.indexOf("Markdown Content:");
  if (idx >= 0) body = out.slice(idx + 17);
  return { title, body: body.trim() };
}
function summariseFromText(text: string): string {
  const body = text.replace(/\s+/g, " ").trim();
  const sentences = body.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20);
  return sentences.slice(0, 2).join(" ").slice(0, 300);
}

// --- reachEnrich: returns Enrichment-shaped fields (Order L32) ---
export type ReachEnrichment = {
  fetchedUrl?: string;
  title?: string;
  description?: string;
  summary?: string;
  emails: string[];
  phones: string[];
  socials: Enrichment["socials"];
  signals: string[];
  language?: string;
  untrusted: true;
  notices: string[];
  trace: ReachTrace[];
};

export async function reachEnrich(
  lead: { name: string; website?: string; city?: string; emails?: string[]; phones?: string[] },
  deps: ReachDeps = {},
): Promise<ReachEnrichment> {
  const out: ReachEnrichment = {
    emails: [...(lead.emails ?? [])],
    phones: [...(lead.phones ?? [])],
    socials: {},
    signals: [],
    untrusted: true,
    notices: [],
    trace: [],
  };
  if (caps.resetPerEnrich) jobCalls = 0;
  if (process.env.LEADSCOUT_REACH === "0") return out;

  const channels = await channelsFor(deps);
  if (!channels || !Object.values(channels).some((c) => c.ok)) return out;

  let pageBody = "";
  if (lead.website) {
    const page = await webWith(channels, lead.website, deps);
    out.trace.push(...page.trace);
    if (page.ok) {
      const j = parseJina(page.text);
      if (j.title && out.title === undefined) out.title = j.title;
      pageBody = j.body;
      out.fetchedUrl = lead.website;
      const c = extractContacts(pageBody);
      out.emails.push(...c.emails);
      out.phones.push(...c.phones);
      mergeSocials(out.socials, pageBody);
      if (pageBody) out.summary = summariseFromText(pageBody);
    }
  }
  if (out.summary === undefined && working(channels, "exa_search")) {
    const s = await runChannel("exa_search", `${lead.name}${lead.city ? ` ${lead.city}` : ""} business description`, deps, false);
    out.trace.push(...s.trace);
    if (s.ok) {
      const c = extractContacts(s.text);
      out.emails.push(...c.emails);
      out.phones.push(...c.phones);
      mergeSocials(out.socials, s.text);
      if (pageBody === "") out.summary = summariseFromText(s.text);
    }
  }
  // social channels: used automatically only when the doctor reports them working;
  // the adapter never asks for, stores or prints cookies or passwords.
  for (const ch of AUTO_SOCIAL_SEARCH) {
    if (!working(channels, ch)) continue;
    const r = await runChannel(ch, `${lead.name}${lead.city ? ` ${lead.city}` : ""}`, deps, true);
    out.trace.push(...r.trace);
    if (r.notice) out.notices.push(r.notice);
    if (r.ok) {
      const c = extractContacts(r.text);
      out.emails.push(...c.emails);
      out.phones.push(...c.phones);
      mergeSocials(out.socials, r.text);
    }
  }
  out.emails = [...new Set(out.emails)].slice(0, 5);
  out.phones = [...new Set(out.phones)].slice(0, 5);
  if (out.emails.length) out.signals.push("has-email");
  if (out.phones.length) out.signals.push("has-phone");
  if (Object.keys(out.socials).length) out.signals.push("social-active-links");
  return out;
}
