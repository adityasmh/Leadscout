// Outreach drafts, sequences and safe sending for Leadscout.
// Builds email, WhatsApp and call-script drafts from a dossier, and sends email through
// an injected or default SMTP-like transport with suppression, cap and pacing guards.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as net from "node:net";
import * as tls from "node:tls";
import { randomUUID } from "node:crypto";
import type { Dossier, Branding } from "./types-v2.js";
import type { Lead } from "./types.js";
import { isSuppressed } from "./compliance.js";
import { getDb } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_PATH = join(HERE, "..", "data", "outreach-templates.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmailDraft = {
  channel: "email";
  workspaceId: string;
  leadId: string;
  to: string;
  domain: string;
  bizKey: string;
  subject: string;
  body: string;
};

export type WhatsAppDraft = {
  channel: "whatsapp";
  number: string;
  message: string;
  link: string;
};

export type CallDraft = {
  channel: "call";
  script: string;
};

export type ChannelDraft = EmailDraft | WhatsAppDraft | CallDraft;

export type SequenceStep = {
  day: number;
  draft: EmailDraft;
  status: "pending" | "sent" | "bounced" | "replied" | "opted-out";
};

export type Sequence = {
  workspaceId: string;
  leadId: string;
  steps: SequenceStep[];
  stopped: boolean;
  stopReason?: string;
};

export type SendResult = {
  sent: boolean;
  dryRun: boolean;
  reason?: string;
  transportResult?: unknown;
};

export type TransportFn = (draft: EmailDraft) => Promise<unknown>;

export type SendDeps = {
  transport?: TransportFn;
  isSuppressed?: (
    lead: {
      website?: string;
      emails?: string[];
      phones?: string[];
      email?: string;
      phone?: string;
    },
    ws: string,
    bizKey?: string
  ) => { suppressed: boolean; reason?: string };
  dailyCap?: number;
  domainGapMs?: number;
  pauseMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
};

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

type Templates = {
  email: { subject: string; body: string };
  whatsapp: { message: string };
  call: { script: string };
  optOutLine: string;
};

const DEFAULT_TEMPLATES: Templates = {
  email: {
    subject: "Quick thought on {business}",
    body:
      "Hi there,\n\n{sayThis}\n\n{pushback}\n\n" +
      "Top suggestion for {business}: {topOfferTitle}.\n" +
      "{topOfferDescription}\n\nWhy it matters: {topOfferWhy}\n\n" +
      "Best,\n{sender}\n{workspace}\n\n{optOutLine}",
  },
  whatsapp: {
    message: "{sayThis} {pushback}",
  },
  call: {
    script: "SAY THIS:\n{sayThis}\n\nFALLBACK LINE:\n{pushback}",
  },
  optOutLine: 'To stop receiving these emails, reply with "unsubscribe".',
};

export function loadTemplates(): Templates {
  if (!existsSync(TEMPLATES_PATH)) return DEFAULT_TEMPLATES;
  try {
    const raw = JSON.parse(readFileSync(TEMPLATES_PATH, "utf-8")) as Partial<Templates>;
    return {
      email: raw.email ?? DEFAULT_TEMPLATES.email,
      whatsapp: raw.whatsapp ?? DEFAULT_TEMPLATES.whatsapp,
      call: raw.call ?? DEFAULT_TEMPLATES.call,
      optOutLine: raw.optOutLine ?? DEFAULT_TEMPLATES.optOutLine,
    };
  } catch {
    return DEFAULT_TEMPLATES;
  }
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

// ---------------------------------------------------------------------------
// Dossier helpers
// ---------------------------------------------------------------------------

function topOffer(dossier: Dossier): Dossier["offers"][number] | undefined {
  return dossier.offers.slice().sort((a, b) => a.rank - b.rank)[0];
}

function senderAndWorkspace(
  branding: Branding,
  fallbackWorkspace: string
): { sender: string; workspace: string } {
  const workspace = branding.displayName || fallbackWorkspace || "Leadscout";
  const sender = branding.senderName || workspace;
  return { sender, workspace };
}

function optOutLine(templates: Templates, branding: Branding): string {
  const base = templates.optOutLine || DEFAULT_TEMPLATES.optOutLine;
  const contact = branding.contactLine?.trim() ?? "";
  if (contact && contact.includes("@")) {
    return base.replace('reply with "unsubscribe".', `reply with "unsubscribe" or email ${contact}.`);
  }
  return base;
}

// ---------------------------------------------------------------------------
// WhatsApp number normalisation
// ---------------------------------------------------------------------------

function extractDigits(input?: string): string {
  return (input ?? "").replace(/[^0-9]/g, "");
}

function normaliseWhatsAppNumber(lead: Lead): string | undefined {
  // Prefer an explicit WhatsApp link from the lead's socials.
  const waUrl = lead.socials?.whatsapp;
  if (waUrl) {
    const digits = extractDigits(waUrl);
    // wa.me links usually include the number as the first significant digit sequence.
    if (digits.length >= 10) return digits;
  }
  // Fall back to the lead's phone number.
  const phone = lead.phone;
  if (!phone) return undefined;
  const digits = extractDigits(phone);
  if (!digits) return undefined;
  // Only prepend the India country code when the number is clearly Indian.
  const country = (lead.country ?? "").trim().toUpperCase();
  const looksIndian = country === "IN" || phone.trim().startsWith("+91") || phone.trim().startsWith("91");
  if (looksIndian && /^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  // E.164 with leading + -> strip the +.
  if (phone.trim().startsWith("+") && digits.length > 3) return digits;
  return digits;
}

export function buildWhatsAppLink(number: string, text: string): string {
  const safeNumber = extractDigits(number);
  const encoded = encodeURIComponent(text);
  return `https://wa.me/${safeNumber}?text=${encoded}`;
}

// ---------------------------------------------------------------------------
// Draft builders
// ---------------------------------------------------------------------------

export type DraftOptions = {
  emailTo?: string;
  phone?: string;
  waNumber?: string;
  templates?: Templates;
};

export function buildDrafts(
  dossier: Dossier,
  lead: Lead,
  branding: Branding,
  options: DraftOptions = {}
): { email: EmailDraft; whatsapp: WhatsAppDraft; call: CallDraft } {
  const templates = options.templates ?? loadTemplates();
  const { sender, workspace } = senderAndWorkspace(branding, lead.workspaceId);
  const business = lead.name;
  const offer = topOffer(dossier);

  // Use only facts present in the dossier. Missing lines become empty strings, never invented copy.
  const sayThis = dossier.sayThis?.value ?? "";
  const pushback = dossier.pushback?.value ?? "";
  const topOfferTitle = offer?.title ?? "";
  const topOfferDescription = offer?.description.value ?? "";
  const topOfferWhy = offer?.whyItMatters.value ?? "";

  const vars: Record<string, string> = {
    business,
    sender,
    workspace,
    sayThis,
    pushback,
    gapHeadline: dossier.gap?.headline.value ?? "",
    topOfferTitle,
    topOfferDescription,
    topOfferWhy,
    optOutLine: optOutLine(templates, branding),
  };

  const emailTo = options.emailTo ?? lead.email ?? "";
  const emailBody = renderTemplate(templates.email.body, vars);

  const email: EmailDraft = {
    channel: "email",
    workspaceId: dossier.workspaceId,
    leadId: dossier.leadId,
    to: emailTo,
    domain: domainOf(emailTo),
    bizKey: dossier.bizKey,
    subject: renderTemplate(templates.email.subject, vars),
    body: emailBody,
  };

  const waNumber = options.waNumber ?? normaliseWhatsAppNumber(lead) ?? "";
  const waMessage = renderTemplate(templates.whatsapp.message, vars);
  const whatsapp: WhatsAppDraft = {
    channel: "whatsapp",
    number: waNumber,
    message: waMessage,
    link: waNumber ? buildWhatsAppLink(waNumber, waMessage) : "",
  };

  const call: CallDraft = {
    channel: "call",
    script: renderTemplate(templates.call.script, vars),
  };

  return { email, whatsapp, call };
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// Sequence builder
// ---------------------------------------------------------------------------

const SEQUENCE_DAYS = [0, 3, 7];

export function buildSequence(
  dossier: Dossier,
  lead: Lead,
  branding: Branding,
  options?: DraftOptions
): Sequence {
  const { email } = buildDrafts(dossier, lead, branding, options);
  const steps: SequenceStep[] = SEQUENCE_DAYS.map((day, index) => ({
    day,
    draft: {
      ...email,
      subject:
        index === 0
          ? email.subject
          : `${email.subject}${index === 1 ? " (follow-up)" : " (last follow-up)"}`,
    },
    status: "pending",
  }));
  return {
    workspaceId: dossier.workspaceId,
    leadId: dossier.leadId,
    steps,
    stopped: false,
  };
}

export function sequenceStopped(steps: SequenceStep[]): { stopped: boolean; reason?: string } {
  for (const step of steps) {
    if (step.status === "replied") return { stopped: true, reason: "replied" };
    if (step.status === "opted-out") return { stopped: true, reason: "opted-out" };
    if (step.status === "bounced") return { stopped: true, reason: "bounced" };
  }
  return { stopped: false };
}

// ---------------------------------------------------------------------------
// Sending guards and sendEmail
// ---------------------------------------------------------------------------

const SEND_SCHEMA = `
CREATE TABLE IF NOT EXISTS outreach_sends (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  leadId TEXT NOT NULL,
  channel TEXT NOT NULL,
  toAddress TEXT NOT NULL,
  domain TEXT NOT NULL,
  bizKey TEXT NOT NULL,
  status TEXT NOT NULL,
  sentAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outreach_sends_ws_day ON outreach_sends(workspaceId, sentAt);
CREATE INDEX IF NOT EXISTS idx_outreach_sends_domain ON outreach_sends(domain, sentAt);
`;

let sendTableEnsured = false;

function ensureSendTable(): void {
  if (!sendTableEnsured) {
    getDb().exec(SEND_SCHEMA);
    sendTableEnsured = true;
  }
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function countSendsToday(workspaceId: string, now: Date): number {
  ensureSendTable();
  const today = toISODate(now);
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM outreach_sends WHERE workspaceId = ? AND date(sentAt) = ? AND status = ?"
    )
    .get(workspaceId, today, "sent") as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function lastSendForDomain(domain: string, now: Date): Date | undefined {
  ensureSendTable();
  const row = getDb()
    .prepare(
      "SELECT sentAt FROM outreach_sends WHERE domain = ? AND status = ? ORDER BY sentAt DESC LIMIT 1"
    )
    .get(domain, "sent") as { sentAt: string } | undefined;
  if (!row?.sentAt) return undefined;
  const d = new Date(row.sentAt);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function recordSend(
  draft: EmailDraft,
  status: "sent" | "bounced" | "replied" | "opted-out",
  now: Date
): void {
  ensureSendTable();
  const id = randomUUID();
  getDb()
    .prepare(
      "INSERT INTO outreach_sends (id, workspaceId, leadId, channel, toAddress, domain, bizKey, status, sentAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      draft.workspaceId,
      draft.leadId,
      draft.channel,
      draft.to,
      draft.domain,
      draft.bizKey,
      status,
      now.toISOString()
    );
}

// Global pacing: at most one send per second across all calls in this process.
let globalLastSendAt = 0;

/** Reset the global send pacing counter. Intended for tests only. */
export function resetSendPacing(): void {
  globalLastSendAt = 0;
}

export async function sendEmail(
  draft: EmailDraft,
  deps: SendDeps | TransportFn = {}
): Promise<SendResult> {
  // Accept either a deps object or a bare transport function as the second argument.
  let opts: SendDeps;
  let injectedTransport: TransportFn | undefined;
  if (typeof deps === "function") {
    opts = {};
    injectedTransport = deps;
  } else {
    opts = deps;
    injectedTransport = opts.transport;
  }

  const now = opts.now ? opts.now() : new Date();
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const dailyCap = opts.dailyCap ?? 30;
  const domainGapMs = opts.domainGapMs ?? 24 * 60 * 60 * 1000;
  const pauseMs = opts.pauseMs ?? 1000;
  const suppressFn = opts.isSuppressed ?? isSuppressed;

  // 1. Suppression check.
  const suppression = suppressFn({ emails: [draft.to] }, draft.workspaceId, draft.bizKey);
  if (suppression.suppressed) {
    return { sent: false, dryRun: false, reason: `suppressed: ${suppression.reason}` };
  }

  // 2. Daily cap.
  const sentToday = countSendsToday(draft.workspaceId, now);
  if (sentToday >= dailyCap) {
    return { sent: false, dryRun: false, reason: `daily cap reached (${dailyCap})` };
  }

  // 3. Domain gap.
  if (draft.domain) {
    const last = lastSendForDomain(draft.domain, now);
    if (last) {
      const elapsed = now.getTime() - last.getTime();
      if (elapsed < domainGapMs) {
        return {
          sent: false,
          dryRun: false,
          reason: `domain gap: ${draft.domain} last sent ${Math.round(elapsed / 1000)}s ago`,
        };
      }
    }
  }

  // 4. Process pacing.
  const wait = Math.max(0, globalLastSendAt + pauseMs - now.getTime());
  if (wait > 0) await sleep(wait);

  // 5. Default transport gate.
  const smtpUrl = process.env.LEADSCOUT_SMTP_URL;
  const sendEnabled = process.env.LEADSCOUT_SEND_ENABLED === "1";
  const useDefaultTransport = !injectedTransport && Boolean(smtpUrl) && sendEnabled;

  if (!injectedTransport && !useDefaultTransport) {
    // Dry run: log and record nothing.
    log(`[dry-run] would send email to ${draft.to}: ${draft.subject}`);
    return { sent: false, dryRun: true, reason: "dry run: no transport or sending disabled" };
  }

  const transport = injectedTransport ?? defaultSmtpTransport;

  // 6. Send.
  try {
    const result = await transport(draft);
    globalLastSendAt = now.getTime();
    recordSend(draft, "sent", opts.now ? opts.now() : new Date());
    return { sent: true, dryRun: false, transportResult: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { sent: false, dryRun: false, reason: `transport error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Default SMTP transport (node:net / node:tls)
// ---------------------------------------------------------------------------

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function hasCrlf(value: string): boolean {
  return value.includes("\r") || value.includes("\n");
}

function formatSubject(subject: string): string {
  // RFC 2047 encode non-ASCII subjects so an SMTP server can carry them safely.
  if (/[^\x20-\x7E]/.test(subject)) {
    return `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  }
  return subject;
}

function wrapBase64(data: Buffer): string {
  const base64 = data.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 76) {
    lines.push(base64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

async function readResponse(reader: AsyncGenerator<string>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  while (true) {
    const next = await reader.next();
    if (next.done) break;
    const line = next.value;
    lines.push(line);
    // Last line of a multi-line reply has a space in position 3; continuation lines have '-'.
    if (line.length >= 4 && line[3] === " ") break;
  }
  const code = lines.length > 0 ? Number(lines[0].slice(0, 3)) : 0;
  return { code, lines };
}

async function* lineReader(socket: net.Socket): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of socket) {
    buffer += String(chunk);
    while (true) {
      const crlf = buffer.indexOf("\r\n");
      if (crlf < 0) break;
      const line = buffer.slice(0, crlf);
      buffer = buffer.slice(crlf + 2);
      yield line;
    }
  }
}

async function sendCommand(
  socket: net.Socket,
  reader: AsyncGenerator<string>,
  command: string
): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    socket.write(command + "\r\n", (err) => {
      if (err) return reject(err);
      readResponse(reader).then(resolve).catch(reject);
    });
  });
}

export async function defaultSmtpTransport(draft: EmailDraft): Promise<{ ok: boolean; response: string }> {
  const smtpUrl = process.env.LEADSCOUT_SMTP_URL;
  if (!smtpUrl) throw new Error("LEADSCOUT_SMTP_URL is not set");

  const url = new URL(smtpUrl);
  const host = url.hostname;
  const port = Number(url.port) || (url.protocol === "smtps:" ? 465 : 587);
  const user = url.username ? decodeURIComponent(url.username) : undefined;
  const pass = url.password ? decodeURIComponent(url.password) : undefined;
  const secure = url.protocol === "smtps:" || port === 465;

  const from = process.env.LEADSCOUT_SMTP_FROM || `leadscout@${host}`;

  // Guard against header injection before any network activity.
  if (hasCrlf(from) || hasCrlf(draft.to) || hasCrlf(draft.subject)) {
    throw new Error("SMTP header injection detected");
  }

  // Never send AUTH credentials over an unencrypted connection to a non-loopback host.
  if (user && pass && !secure && !isLoopback(host)) {
    throw new Error("SMTP AUTH requires TLS or a loopback connection");
  }

  const socket: net.Socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.createConnection({ host, port });

  const reader = lineReader(socket);

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once(secure ? "secureConnect" : "connect", () => {
        socket.off("error", reject);
        resolve();
      });
    });

    const greeting = await readResponse(reader);
    if (greeting.code !== 220) {
      throw new Error(`SMTP greeting failed: ${greeting.lines.join(" ")}`);
    }

    const ehlo = await sendCommand(socket, reader, `EHLO ${host}`);
    if (ehlo.code !== 250) {
      throw new Error(`SMTP EHLO failed: ${ehlo.lines.join(" ")}`);
    }
    const capabilities = ehlo.lines.map((l) => l.toUpperCase()).join(" ");

    if (user && pass) {
      if (capabilities.includes("AUTH LOGIN")) {
        const auth = await sendCommand(socket, reader, "AUTH LOGIN");
        if (auth.code !== 334) throw new Error(`AUTH LOGIN failed: ${auth.lines.join(" ")}`);
        const userB64 = Buffer.from(user).toString("base64");
        const passB64 = Buffer.from(pass).toString("base64");
        await sendCommand(socket, reader, userB64);
        const passResp = await sendCommand(socket, reader, passB64);
        if (passResp.code !== 235) {
          throw new Error(`SMTP auth failed: ${passResp.lines.join(" ")}`);
        }
      } else if (capabilities.includes("AUTH PLAIN")) {
        const authPlain = Buffer.from(`\u0000${user}\u0000${pass}`).toString("base64");
        const auth = await sendCommand(socket, reader, `AUTH PLAIN ${authPlain}`);
        if (auth.code !== 235) {
          throw new Error(`SMTP auth failed: ${auth.lines.join(" ")}`);
        }
      }
    }

    const mailFrom = await sendCommand(socket, reader, `MAIL FROM:<${from}>`);
    if (mailFrom.code !== 250) {
      throw new Error(`SMTP MAIL FROM failed: ${mailFrom.lines.join(" ")}`);
    }

    const rcptTo = await sendCommand(socket, reader, `RCPT TO:<${draft.to}>`);
    if (rcptTo.code !== 250) {
      throw new Error(`SMTP RCPT TO failed: ${rcptTo.lines.join(" ")}`);
    }

    const dataCmd = await sendCommand(socket, reader, "DATA");
    if (dataCmd.code !== 354) {
      throw new Error(`SMTP DATA failed: ${dataCmd.lines.join(" ")}`);
    }

    const bodyLines = wrapBase64(Buffer.from(draft.body, "utf-8")).split("\r\n");
    const dottedBody = bodyLines.map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n");
    const message = [
      `From: ${from}`,
      `To: ${draft.to}`,
      `Subject: ${formatSubject(draft.subject)}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      dottedBody,
      ".",
    ].join("\r\n");

    const dataResp = await new Promise<{ code: number; lines: string[] }>((resolve, reject) => {
      socket.write(message + "\r\n", (err) => {
        if (err) return reject(err);
        readResponse(reader).then(resolve).catch(reject);
      });
    });

    if (dataResp.code !== 250) {
      throw new Error(`SMTP message send failed: ${dataResp.lines.join(" ")}`);
    }

    await sendCommand(socket, reader, "QUIT");
    return { ok: true, response: dataResp.lines.join(" ") };
  } finally {
    socket.end();
    socket.destroy();
  }
}
