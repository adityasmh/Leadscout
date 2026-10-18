// BrowserReader (Order L43): reads pages through the operator's own logged-in
// browser. READ ONLY is enforced in code, plus a hard deny list that the
// allowlist file cannot override, per-platform hourly caps, a random 2-6 s
// pause between pages, one page at a time per platform, needs-human lockout,
// and a kill switch (env LEADSCOUT_BROWSER=0). All transports are injectable
// so checks run offline. Never solves or bypasses a login wall / captcha.
import { BrowserBlockedError } from "./types.js";
import type { BrowserOpts, BrowserPageLogEntry, BrowserReadOpts, BrowserReadResult, BrowserStatus, WebSocketLike } from "./types.js";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReachExecFile } from "../reach.js";

const PAUSE_MIN_MS = 2000;
const PAUSE_MAX_MS = 6000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_CAPS: Record<string, number> = { linkedin: 15, instagram: 30, facebook: 30, other: 60 };

// NEVER overridable by the allowlist file: mail, chat assistants, code hosting
// dashboards, cloud storage, password managers, banks/payment sites, and the
// operator's own account surfaces.
const HARD_DENY_DOMAINS = [
  "mail.google.com", "gmail.com", "googlemail.com",
  "chatgpt.com", "claude.ai", "gemini.google.com", "notebooklm.google.com", "copilot.microsoft.com",
  "github.com", "gitlab.com", "bitbucket.org",
  "accounts.google.com", "login.microsoftonline.com",
  "drive.google.com", "docs.google.com", "dropbox.com", "onedrive.live.com", "icloud.com",
  "1password.com", "bitwarden.com", "lastpass.com", "dashlane.com", "keepass.info",
  "paypal.com", "pay.google.com", "paytm.com", "razorpay.com", "stripe.com", "phonepe.com",
  "icicibank.com", "hdfcbank.com", "axisbank.com", "kotak.com", "sbi.co.in", "onlinesbi.sbi", "yesbank.in",
];
// Host fragments that always mean a bank/payment/password surface even when the
// exact domain is not enumerated above.
const HARD_DENY_HOST_RE = /(^|[-.])((?:[a-z0-9-]*bank[a-z0-9-]*)|paypal|paytm|razorpay|stripe|phonepe|1password|bitwarden|lastpass|dashlane|keepass)([.-][a-z]|\.|$)/i;
// Any operator-account settings page, on any host.
const HARD_DENY_PATH_RE = /^\/(settings|account|account-settings|p\/settings|billing|password|profile\/settings)(\/|$)/i;

const NEEDS_HUMAN_RE =
  /sign in to continue|log in or sign up|please log in|login required|captcha|verify you are (?:human|robot)|unusual activity|security checkpoint|too many attempts|verify your (?:account|identity)/i;

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function platformOf(host: string): string {
  if (hostMatches(host, "linkedin.com")) return "linkedin";
  if (hostMatches(host, "instagram.com")) return "instagram";
  if (hostMatches(host, "facebook.com") || hostMatches(host, "fb.com")) return "facebook";
  return "other";
}

function capFor(platform: string): number {
  const raw = process.env[`LEADSCOUT_CAP_${platform.toUpperCase()}`];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_CAPS[platform] ?? DEFAULT_CAPS.other;
}

export class BrowserReader {
  private pageLog: BrowserPageLogEntry[] = [];
  private lockedPlatforms = new Set<string>();
  private stampsByPlatform = new Map<string, number[]>();
  private queues = new Map<string, Promise<unknown>>();
  private allowlistCacheMs = -1;
  private allowlistParsed: { domain: string; paths?: string[] }[] = [];
  private lastProbe: { opencli: BackendProbe; cdp: BackendProbe } | null = null;

  constructor(private o: BrowserOpts = {}) {}

  // ---- status / logs ---------------------------------------------------
  status(): BrowserStatus {
    const caps: Record<string, number> = {};
    for (const p of ["linkedin", "instagram", "facebook", "other"]) caps[p] = capFor(p);
    const used: Record<string, number> = {};
    for (const [p, stamps] of this.stampsByPlatform) used[p] = stamps.length;
    return {
      enabled: this.enabled(),
      killSwitch: process.env.LEADSCOUT_BROWSER === "0",
      backends: this.lastProbe
        ? { opencli: this.lastProbe.opencli, cdp: { ...this.lastProbe.cdp, url: this.cdpUrl() } }
        : {
            opencli: { ok: false, why: "not probed (happens on first read)" },
            cdp: { ok: false, why: "not probed (happens on first read)", url: this.cdpUrl() },
          },
      caps,
      usedThisHour: used,
      lockedPlatforms: [...this.lockedPlatforms],
      pageLog: this.pageLog.slice(),
    };
  }

  pageLogEntries(): BrowserPageLogEntry[] {
    return this.pageLog.slice();
  }

  private enabled(): boolean {
    return process.env.LEADSCOUT_BROWSER === "1";
  }

  /** CDP address for the platform of the URL being read. Precedence: an
   * explicitly injected `cdpUrl` (tests), then `LEADSCOUT_CDP_URL_<PLATFORM>`
   * (upper-case, hyphens -> underscores, the same platform string the hourly
   * caps use), then `LEADSCOUT_CDP_URL`, then the loopback default. */
  private cdpUrl(platform?: string): string {
    if (this.o.cdpUrl) return this.o.cdpUrl;
    if (platform) {
      const perPlatform = process.env[`LEADSCOUT_CDP_URL_${platform.toUpperCase().replace(/-/g, "_")}`];
      if (perPlatform) return perPlatform;
    }
    return process.env.LEADSCOUT_CDP_URL ?? "http://127.0.0.1:9222";
  }

  // ---- gates (run BEFORE every navigation) ------------------------------
  denyReason(url: string): string | undefined {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return `browser: not a valid URL: ${url.slice(0, 120)}`;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return `browser: refused non-http(s) URL "${url.slice(0, 120)}"`;
    }
    if (process.env.LEADSCOUT_BROWSER === "0") {
      return "browser: kill switch LEADSCOUT_BROWSER=0 is set; reader disabled";
    }
    if (!this.enabled()) {
      return "browser: reader is OFF by default; set LEADSCOUT_BROWSER=1 to enable";
    }
    const host = u.hostname.toLowerCase();
    // 1. HARD DENY LIST FIRST, subdomain-aware, never overridable by the file.
    const noWww = host.replace(/^www\./, "");
    for (const d of HARD_DENY_DOMAINS) {
      if (hostMatches(host, d) || hostMatches(noWww, d)) {
        return `browser: hard-denied domain ${d} (operator accounts, mail, chat assistants, banking, code hosting); the allowlist file cannot override`;
      }
    }
    if (HARD_DENY_HOST_RE.test(noWww)) {
      return `browser: hard-denied host ${noWww} (bank/payment/password surface)`;
    }
    if (HARD_DENY_PATH_RE.test(u.pathname)) {
      return `browser: hard-denied path ${u.pathname} (operator account settings)`;
    }
    // 2. Allowlist file (operator-editable).
    const entry = this.allowlist().find((a) => hostMatches(noWww, a.domain));
    if (!entry) {
      return `browser: domain "${noWww}" is not on the allowlist (data/browser-allowlist.json); add it before reading`;
    }
    if (entry.paths && entry.paths.length > 0) {
      const p = u.pathname || "/";
      const ok = entry.paths.some((pre) => p === pre || p.startsWith(pre.endsWith("/") ? pre : `${pre}/`));
      if (!ok) {
        return `browser: ${entry.domain} is allowlisted for paths [${entry.paths.join(", ")}] only; refused ${p}`;
      }
    }
    return undefined;
  }

  private allowlist(): { domain: string; paths?: string[] }[] {
    const file = fileURLToPath(new URL("../../data/browser-allowlist.json", import.meta.url));
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime !== this.allowlistCacheMs) {
        this.allowlistCacheMs = mtime;
        const raw = JSON.parse(readFileSync(file, "utf8")) as { domains?: { domain: string; paths?: string[] }[] };
        this.allowlistParsed = (raw.domains ?? []).filter((d) => d && typeof d.domain === "string");
      }
    } catch (err) {
      this.allowlistCacheMs = -1;
      this.allowlistParsed = [];
      throw new Error(`browser: cannot read data/browser-allowlist.json: ${(err as Error).message}`);
    }
    return this.allowlistParsed;
  }

  // ---- read-only enforcement -------------------------------------------
  private static READ_OPS = new Set(["navigate", "read"]);

  /** Only navigate/read are sanctioned; any write-like op (click, type, submit,
   * form, key, screenshot) throws, so the reader cannot act on a page. */
  apply(op: string): never {
    if (!BrowserReader.READ_OPS.has(op)) {
      throw new Error(`browser: read-only reader; operation "${op}" is not permitted (only navigate and read)`);
    }
    throw new Error("browser: internal misuse; use read() or search()");
  }

  // ---- read / search -----------------------------------------------------
  async read(url: string, opts: BrowserReadOpts = {}): Promise<BrowserReadResult> {
    const timeMs = this.now();
    const deny = this.denyReason(url);
    if (deny) throw new Error(deny);
    const host = new URL(url).hostname.toLowerCase();
    const platform = opts.platform ?? platformOf(host);

    if (this.lockedPlatforms.has(platform)) {
      throw new BrowserBlockedError(
        `browser: platform "${platform}" is locked after a needs-human stop; no further reads this session`,
        platform,
        true,
      );
    }
    const stamps = this.stamps(platform);
    const cap = capFor(platform);
    if (stamps.length >= cap) {
      throw new Error(`browser: hourly cap reached for "${platform}" (${stamps.length} reads, cap ${cap}); try later`);
    }
    // one page at a time per platform: serialize on a per-platform queue.
    const prev = this.queues.get(platform) ?? Promise.resolve();
    let release: () => void = () => {};
    const ticket = new Promise<void>((r) => (release = r));
    this.queues.set(
      platform,
      prev.then(() => ticket),
    );
    await prev;
    try {
      // Random 2-6 s pause BETWEEN pages on the same platform. ALWAYS applied
      // when a page was already read on this platform this hour: the injected
      // `pause` wins (tests), otherwise the built-in REAL sleep below runs —
      // production must never skip the pause.
      if (stamps.length > 0) {
        const ms = PAUSE_MIN_MS + Math.floor(Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS + 1));
        if (ms < PAUSE_MIN_MS || ms > PAUSE_MAX_MS) {
          throw new Error(`browser: generated pause ${ms}ms outside 2000-6000ms window`);
        }
        await this.pauseFn()(ms);
      }
      this.pageLog.push({ platform, url, time: new Date(timeMs).toISOString() });
      const res = await this.readViaBackends(url, platform);
      stamps.push(timeMs);
      return res;
    } catch (err) {
      if (err instanceof BrowserBlockedError) this.lockedPlatforms.add(platform);
      throw err;
    } finally {
      release();
    }
  }

  /** Search pages of one site via google.com/search (allowlisted path). */
  async search(site: string, query: string): Promise<BrowserReadResult> {
    const q = encodeURIComponent(`site:${site} ${query}`);
    return this.read(`https://www.google.com/search?q=${q}`, { platform: "google", reason: "site search" });
  }

  // ---- backends ------------------------------------------------------------
  private async readViaBackends(url: string, platform: string): Promise<BrowserReadResult> {
    let lastErr = "no backend available";
    // (a) OpenCLI via Agent Reach, documented read commands only.
    const oc = await this.probeOpenCli();
    if (oc.ok && oc.commands && oc.commands.length > 0) {
      try {
        const text = await this.opencliRead(oc.commands[0], url);
        if (typeof text === "string") {
          this.blockedCheck(text, platform);
          return { text, url };
        }
      } catch (err) {
        if (err instanceof BrowserBlockedError) throw err;
        lastErr = `opencli: ${(err as Error).message}`;
      }
    } else if (oc.why) {
      lastErr = `opencli unavailable: ${oc.why}`;
    }
    // (b) Chrome DevTools Protocol (Node's global WebSocket).
    try {
      return await this.cdpRead(url, platform);
    } catch (err) {
      if (err instanceof BrowserBlockedError) throw err;
      lastErr = `cdp: ${(err as Error).message}`;
    }
    throw new Error(`browser: all backends failed for ${url}: ${lastErr}`);
  }

  private async execFileFn(): Promise<ReachExecFile> {
    if (this.o.execFile) return this.o.execFile;
    const cp = await import("node:child_process");
    return (file, args, opts) =>
      new Promise((resolve, reject) => {
        cp.execFile(file, args as string[], opts, (err, stdout, stderr) => {
          if (err) reject(new Error(`${(err as Error).message}${stderr ? ` ${stderr}` : ""}`.trim()));
          else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        });
      });
  }

  private async fetchFn(): Promise<typeof fetch> {
    if (this.o.fetchFn) return this.o.fetchFn;
    return globalThis.fetch;
  }

  private async probeOpenCli(): Promise<BackendProbe> {
    if (this.lastProbe?.opencli) return this.lastProbe.opencli;
    let probe: BackendProbe = { ok: false, why: "no opencli probe yet" };
    try {
      const execFile = await this.execFileFn();
      const doctor = await execFile("agent-reach", ["doctor", "--json"], { timeout: 20000 });
      const help = await execFile("opencli", ["--help"], { timeout: 20000 });
      const parsed = parseDoctorOk(doctor.stdout);
      probe = { ok: parsed.ok, why: parsed.ok ? undefined : parsed.why, commands: documentedReadCommands(help.stdout) };
    } catch (err) {
      probe = { ok: false, why: (err as Error).message };
    }
    const lp: { opencli: BackendProbe; cdp: BackendProbe } = { opencli: probe, cdp: this.lastProbe?.cdp ?? { ok: false, url: this.cdpUrl() } };
    this.lastProbe = lp;
    return lp.opencli;
  }

  private async probeCdp(platform: string): Promise<BackendProbe> {
    const url = this.cdpUrl(platform);
    if (this.lastProbe?.cdp && this.lastProbe.cdp.probed && this.lastProbe.cdp.url === url) return this.lastProbe.cdp;
    let probe: BackendProbe = { ok: false, why: "cdp probe failed" };
    try {
      const f = await this.fetchFn();
      const res = await f(`${url}/json/version`, { method: "GET" });
      probe = { ok: res.ok, why: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      probe = { ok: false, why: (err as Error).message };
    }
    this.lastProbe = { opencli: this.lastProbe?.opencli ?? { ok: false }, cdp: { ...probe, url, probed: true } };
    return this.lastProbe!.cdp;
  }

  /** Run a documented OpenCLI read command over a URL. Never a write command. */
  private async opencliRead(command: string, url: string): Promise<string> {
    if (!/^(read|get|view|page|fetch|search|url)$/i.test(command)) {
      throw new Error(`command "${command}" is not a documented read command; refusing`);
    }
    const execFile = await this.execFileFn();
    const out = await execFile("opencli", [command, url], { timeout: 30000 });
    return out.stdout;
  }

  private timeout(ms: number, what: string): Promise<never> {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${what}`)), ms));
  }

  /** Open tab -> navigate -> wait for load -> read location.href, then
   * document.body.innerText -> close tab. Via Node's global WebSocket over CDP. */
  private async cdpRead(url: string, platform: string): Promise<BrowserReadResult> {
    const probe = await this.probeCdp(platform);
    if (!probe.ok) throw new Error(probe.why ?? "cdp not reachable");
    const f = await this.fetchFn();
    const tabRes = await f(`${this.cdpUrl(platform)}/json/new?url=${encodeURIComponent(url)}`, { method: "PUT" });
    if (!tabRes.ok) throw new Error(`cannot open tab: HTTP ${tabRes.status}`);
    const target = (await tabRes.json()) as { webSocketDebuggerUrl?: string; targetId?: string };
    if (!target.webSocketDebuggerUrl) throw new Error("no webSocketDebuggerUrl from /json/new");

    const ws: WebSocketLike = (this.o.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike))(target.webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const eventWaiters: { method: string; resolve: () => void }[] = [];
    let wsClosed = false;

    const failAll = (e: Error) => {
      for (const [, p] of pending) p.reject(new Error(e.message));
      pending.clear();
    };
    ws.onmessage = (ev: { data: unknown }) => {
      let msg: CdpMsg;
      try {
        msg = JSON.parse(String(ev.data)) as CdpMsg;
      } catch {
        return;
      }
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`cdp: ${msg.error.message ?? "error"}`));
        else p.resolve(msg.result);
      } else if (msg.method === "Page.loadEventFired") {
        for (const w of eventWaiters.splice(0)) if (w.method === msg.method) w.resolve();
      }
    };
    (ws as { onerror?: unknown }).onerror = () => failAll(new Error("ws error"));

    const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
          pending.delete(id);
          reject(new Error(`ws send failed: ${(err as Error).message}`));
        }
      });
    };
    const waitEvent = (method: string): Promise<void> =>
      new Promise((resolve) => eventWaiters.push({ method, resolve }));

    try {
      await send("Page.enable");
      const pLoad = waitEvent("Page.loadEventFired");
      await send("Page.navigate", { url });
      await Promise.race([pLoad, this.timeout(20000, "page load")]);
      // Check the FINAL URL after redirects before reading the text.
      const hrefRes = (await send("Runtime.evaluate", { expression: "location.href", returnByValue: true })) as CdpEval;
      const finalUrl: string = hrefRes?.result?.value ?? url;
      const deny = this.denyReason(finalUrl);
      if (deny) throw new Error(deny);
      const textRes = (await send("Runtime.evaluate", {
        expression: "document.body ? document.body.innerText : ''",
        returnByValue: true,
      })) as CdpEval;
      const titleRes = (await send("Runtime.evaluate", { expression: "document.title", returnByValue: true })) as CdpEval;
      const text: string = textRes?.result?.value ?? "";
      this.blockedCheck(text, platform);
      return { text, url: finalUrl, title: titleRes?.result?.value };
    } finally {
      try {
        if (target.targetId && !wsClosed) await send("Target.closeTarget", { targetId: target.targetId });
        wsClosed = true;
        ws.close();
      } catch {
        /* best-effort close */
      }
    }
  }

  // needs-human detection: report and lock the platform; never bypass.
  blockedCheck(text: string, platform: string): void {
    if (NEEDS_HUMAN_RE.test(text.slice(0, 4000))) {
      throw new BrowserBlockedError(
        `browser: page looks like a login wall / captcha / checkpoint / unusual-activity notice; needs-human; platform "${platform}" will not be read again this session`,
        platform,
        false,
      );
    }
  }

  // ---- helpers ---------------------------------------------------------------
  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** Pause used between pages on one platform: the injected `pause` wins
   * (tests); otherwise a REAL setTimeout sleep, so the account-safety pause is
   * enforced even when nothing was injected. `timer` is injectable only so the
   * offline check can assert the default sleeps inside 2000-6000 ms. */
  private pauseFn(): (ms: number) => Promise<void> {
    if (this.o.pause) return this.o.pause;
    const timer = this.o.timer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
    return (ms: number) => new Promise<void>((resolve) => timer(() => resolve(), ms));
  }

  private stamps(platform: string): number[] {
    const now = this.now();
    const arr = (this.stampsByPlatform.get(platform) ?? []).filter((t) => now - t < HOUR_MS);
    this.stampsByPlatform.set(platform, arr);
    return arr;
  }
}

type BackendProbe = { ok: boolean; why?: string; commands?: string[]; url?: string; probed?: boolean };
type CdpMsg = { id?: number; method?: string; result?: unknown; error?: { message?: string } };
type CdpEval = { result?: { value?: string } };

// Parse `agent-reach doctor --json` defensively (schema not fully verified; REACH_NOTES.md).
function parseDoctorOk(stdout: string): { ok: boolean; why?: string } {
  const s = String(stdout ?? "").trim();
  if (!s) return { ok: false, why: "empty doctor output" };
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    if (typeof j.opencli === "boolean") return { ok: j.opencli };
    const b = (j.backends ?? j.channels ?? {}) as Record<string, unknown>;
    const oc = b.opencli;
    if (typeof oc === "boolean") return { ok: oc };
    if (oc && typeof oc === "object") {
      const o = oc as Record<string, unknown>;
      return { ok: o.ok === true || o.status === "ok" || o.active_backend !== undefined, why: typeof o.error === "string" ? o.error : undefined };
    }
    return { ok: false, why: "doctor json has no opencli/backend entry" };
  } catch {
    return { ok: /opencli[^{}\n]{0,40}(ok|up|ready)/i.test(s), why: "doctor output not JSON" };
  }
}

// From the `opencli --help` text, keep ONLY documented read commands.
function documentedReadCommands(help: string): string[] {
  const names = new Set<string>();
  for (const line of String(help ?? "").split("\n")) {
    const m = line.match(/^\s{2}(read|get|view|page|fetch|search|url)\b/i);
    if (m) names.add(m[1].toLowerCase());
  }
  return ["read", "get", "view", "page", "fetch", "search", "url"].filter((p) => names.has(p));
}
