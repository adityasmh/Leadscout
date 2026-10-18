// Proof harness for outreach.ts: drafts, sequences, safe sending and SMTP client.
// Uses a temp database via LEADSCOUT_DB set before importing any module that opens the DB.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as net from "node:net";

const tmpDir = mkdtempSync(join(tmpdir(), "leadscout-outreach-check-"));
const dbPath = join(tmpDir, "test.db");
process.env.LEADSCOUT_DB = dbPath;

const {
  buildDrafts,
  buildWhatsAppLink,
  buildSequence,
  sequenceStopped,
  sendEmail,
  countSendsToday,
  recordSend,
  defaultSmtpTransport,
  loadTemplates,
  resetSendPacing,
} = await import("./outreach.js");
const { addOptOut, isSuppressed } = await import("./compliance.js");
const { closeDb } = await import("./store.js");
import type { Dossier, Branding } from "./types-v2.js";
import type { Lead } from "./types.js";

const checks: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string) {
  checks.push({ name, ok: condition, detail });
  const status = condition ? "PASS" : "FAIL";
  console.log(`${status}: ${name}${detail ? ` (${detail})` : ""}`);
  return condition;
}

function fail(name: string, detail: string) {
  return check(name, false, detail);
}

// ---------------------------------------------------------------- fixtures

const FIXTURE_DOSSIER: Dossier = {
  leadId: "lead-fixture-01",
  workspaceId: "ws-fixture",
  bizKey: "fixture-dental.example",
  level: 0,
  facts: {},
  gap: {
    headline: { value: "No working website for Fixture Dental Care.", evidence: ["E1"] },
    tag: "GOING UNSEEN",
  },
  sayThis: {
    value:
      "Hi, this is Priya from Leadscout. I noticed Fixture Dental Care doesn't appear to have a working website, so new enquiries may be missing you.",
    evidence: ["E1"],
  },
  pushback: {
    value: "May I send you a quick note on how a simple site could help Fixture Dental Care get found?",
    evidence: ["E1"],
  },
  offers: [
    {
      rank: 1,
      service: "website",
      title: "Website",
      description: {
        value: "A new website built so patients can find and book Fixture Dental Care online.",
        evidence: ["E1"],
      },
      whyItMatters: {
        value: "Most patients search online before choosing a clinic; without a site those enquiries go elsewhere.",
        evidence: ["E1"],
      },
      buildDays: null,
      quote: null,
      assumption: "Price not set yet; final quote after a short call.",
      doorOpener: false,
    },
    {
      rank: 2,
      service: "free-audit",
      title: "Free website and enquiry check",
      description: {
        value: "A free review of the website and enquiry flow.",
        evidence: ["E1"],
      },
      whyItMatters: {
        value: "It shows exactly what to fix first with no upfront commitment.",
        evidence: ["E1"],
      },
      buildDays: null,
      quote: { currency: "INR", min: 0, max: 0 },
      assumption: "Price not set yet; final quote after a short call.",
      doorOpener: true,
    },
  ],
  evidence: [
    {
      id: "E1",
      kind: "listing",
      url: "https://www.openstreetmap.org/node/123",
      quote: "Fixture Dental Care, Mumbai — phone +91 98765 43210, no website listed.",
      field: "signal:no-website",
      fetchedAt: "2026-10-07T00:00:00.000Z",
    },
  ],
  callStatus: "not-called",
  dropped: [],
  inputHash: "fixture-hash",
  promptVersion: "v0",
  tokensIn: 0,
  tokensOut: 0,
  createdAt: "2026-10-07T00:00:00.000Z",
};

const FIXTURE_LEAD: Lead = {
  id: "lead-fixture-01",
  workspaceId: "ws-fixture",
  name: "Fixture Dental Care",
  category: "dental",
  city: "Mumbai",
  country: "IN",
  phone: "+91 98765 43210",
  email: "info@fixture-dental.example",
  website: "https://fixture-dental.example",
  source: "osm",
  sourceUrl: "https://www.openstreetmap.org/node/123",
  summary: "Fixture Dental Care in Mumbai.",
  emails: ["info@fixture-dental.example"],
  phones: ["+91 98765 43210"],
  socials: {},
  signals: ["no-website"],
  score: 72,
  fit: [{ service: "website", score: 90, reason: "no website signal" }],
  angle: "Build a website so patients can find the clinic.",
  status: "new",
  notes: "",
  createdAt: "2026-10-07T00:00:00.000Z",
};

const FIXTURE_BRANDING: Branding = {
  displayName: "Leadscout",
  senderName: "Priya",
  contactLine: "optout@leadscout.example",
  hidePoweredBy: false,
};

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return { ...FIXTURE_LEAD, ...overrides };
}

function makeDossier(overrides: Partial<Dossier> = {}): Dossier {
  return { ...FIXTURE_DOSSIER, ...overrides };
}

// ---------------------------------------------------------------- template traceability helper

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

function expectedForKey(
  key: string,
  dossier: Dossier,
  lead: Lead,
  branding: Branding,
  templates: ReturnType<typeof loadTemplates>
): string {
  const offer = dossier.offers.slice().sort((a, b) => a.rank - b.rank)[0];
  const { sender, workspace } =
    branding.senderName && branding.displayName
      ? { sender: branding.senderName, workspace: branding.displayName }
      : branding.senderName
        ? { sender: branding.senderName, workspace: branding.displayName || lead.workspaceId || "Leadscout" }
        : { sender: branding.displayName || lead.workspaceId || "Leadscout", workspace: branding.displayName || lead.workspaceId || "Leadscout" };

  switch (key) {
    case "business":
      return lead.name;
    case "sender":
      return sender;
    case "workspace":
      return workspace;
    case "sayThis":
      return dossier.sayThis?.value ?? "";
    case "pushback":
      return dossier.pushback?.value ?? "";
    case "gapHeadline":
      return dossier.gap?.headline.value ?? "";
    case "topOfferTitle":
      return offer?.title ?? "";
    case "topOfferDescription":
      return offer?.description.value ?? "";
    case "topOfferWhy":
      return offer?.whyItMatters.value ?? "";
    case "optOutLine": {
      const base = templates.optOutLine;
      const contact = branding.contactLine?.trim() ?? "";
      if (contact && contact.includes("@")) {
        return base.replace('reply with "unsubscribe".', `reply with "unsubscribe" or email ${contact}.`);
      }
      return base;
    }
    default:
      return "";
  }
}

function assertTraceable(
  name: string,
  text: string,
  template: string,
  dossier: Dossier,
  lead: Lead,
  branding: Branding
): boolean {
  const templates = loadTemplates();
  const placeholderNames = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const vars: Record<string, string> = {};
  for (const key of placeholderNames) {
    vars[key] = expectedForKey(key, dossier, lead, branding, templates);
  }
  const rendered = renderTemplate(template, vars);
  if (rendered !== text) {
    return fail(
      name,
      `rendered template does not match draft: rendered=${JSON.stringify(rendered).slice(0, 120)} draft=${JSON.stringify(text).slice(0, 120)}`
    );
  }
  return check(name, true);
}

// ---------------------------------------------------------------- channel drafts

{
  const drafts = buildDrafts(FIXTURE_DOSSIER, FIXTURE_LEAD, FIXTURE_BRANDING);
  const templates = loadTemplates();

  check("email-draft-has-subject", drafts.email.channel === "email" && drafts.email.subject.includes("Fixture Dental Care"));
  check("email-draft-body-has-sayThis", drafts.email.body.includes(FIXTURE_DOSSIER.sayThis!.value));
  check("email-draft-body-has-pushback", drafts.email.body.includes(FIXTURE_DOSSIER.pushback!.value));
  check("email-draft-body-has-top-offer-title", drafts.email.body.includes("Website"));
  check(
    "email-draft-body-has-top-offer-description",
    drafts.email.body.includes(FIXTURE_DOSSIER.offers[0].description.value)
  );
  check(
    "email-draft-body-has-top-offer-why",
    drafts.email.body.includes(FIXTURE_DOSSIER.offers[0].whyItMatters.value)
  );
  check("email-draft-body-has-sender", drafts.email.body.includes("Priya") && drafts.email.body.includes("Leadscout"));

  check("whatsapp-draft-has-message", drafts.whatsapp.channel === "whatsapp" && drafts.whatsapp.message.includes(FIXTURE_DOSSIER.sayThis!.value));
  check("whatsapp-draft-link-format", drafts.whatsapp.link.startsWith("https://wa.me/919876543210?text="));
  check("whatsapp-draft-link-encoded", drafts.whatsapp.link.includes("%20"));

  check("call-draft-has-script", drafts.call.channel === "call" && drafts.call.script.includes(FIXTURE_DOSSIER.sayThis!.value));
  check("call-draft-has-fallback", drafts.call.script.includes(FIXTURE_DOSSIER.pushback!.value));

  assertTraceable("email-subject-traceable", drafts.email.subject, templates.email.subject, FIXTURE_DOSSIER, FIXTURE_LEAD, FIXTURE_BRANDING);
  assertTraceable("email-body-traceable", drafts.email.body, templates.email.body, FIXTURE_DOSSIER, FIXTURE_LEAD, FIXTURE_BRANDING);
  assertTraceable("whatsapp-message-traceable", drafts.whatsapp.message, templates.whatsapp.message, FIXTURE_DOSSIER, FIXTURE_LEAD, FIXTURE_BRANDING);
  assertTraceable("call-script-traceable", drafts.call.script, templates.call.script, FIXTURE_DOSSIER, FIXTURE_LEAD, FIXTURE_BRANDING);
}

// ---------------------------------------------------------------- opt-out line

{
  const { email } = buildDrafts(FIXTURE_DOSSIER, FIXTURE_LEAD, FIXTURE_BRANDING);
  check("email-has-opt-out-line", email.body.includes("unsubscribe"), email.body.slice(-200));
  check("email-opt-out-uses-contact-line", email.body.includes("optout@leadscout.example"));
}

// ---------------------------------------------------------------- wa.me number normalisation

{
  const indian = makeLead({ phone: "98765 43210", socials: {} });
  const d1 = buildDrafts(FIXTURE_DOSSIER, indian, FIXTURE_BRANDING);
  check("wa-normalises-indian-mobile", d1.whatsapp.number === "919876543210", d1.whatsapp.number);

  const uk = makeLead({ phone: "+44 7700 900123", country: "GB", socials: {} });
  const d2 = buildDrafts(FIXTURE_DOSSIER, uk, FIXTURE_BRANDING);
  check("wa-normalises-uk-mobile", d2.whatsapp.number === "447700900123", d2.whatsapp.number);

  const waSocial = makeLead({ phone: "", socials: { whatsapp: "https://wa.me/919999999999" } });
  const d3 = buildDrafts(FIXTURE_DOSSIER, waSocial, FIXTURE_BRANDING);
  check("wa-prefers-socials-link", d3.whatsapp.number === "919999999999", d3.whatsapp.number);

  const us = makeLead({ phone: "555 123 4567", country: "US", socials: {} });
  const d4 = buildDrafts(FIXTURE_DOSSIER, us, FIXTURE_BRANDING);
  check("wa-no-91-prefix-for-non-indian", d4.whatsapp.number === "5551234567", d4.whatsapp.number);

  const noPhone = makeLead({ phone: "", emails: ["hello@example.com"], socials: {} });
  const d5 = buildDrafts(FIXTURE_DOSSIER, noPhone, FIXTURE_BRANDING);
  check("wa-empty-when-no-number", d5.whatsapp.number === "" && d5.whatsapp.link === "", d5.whatsapp.link);

  const encoded = buildWhatsAppLink("919876543210", "Hello world");
  check("wa-link-encodes-text", encoded === "https://wa.me/919876543210?text=Hello%20world", encoded);
}

// ---------------------------------------------------------------- sequence stop rules

{
  const seq = buildSequence(FIXTURE_DOSSIER, FIXTURE_LEAD, FIXTURE_BRANDING);
  check("sequence-has-three-steps", seq.steps.length === 3, `steps=${seq.steps.length}`);
  check("sequence-days-0-3-7", seq.steps.map((s) => s.day).join(",") === "0,3,7");

  const copyReplied: typeof seq = JSON.parse(JSON.stringify(seq));
  copyReplied.steps[0].status = "replied";
  const stopReplied = sequenceStopped(copyReplied.steps);
  check("stop-rule-replied", stopReplied.stopped && stopReplied.reason === "replied", stopReplied.reason);

  const copyOptOut: typeof seq = JSON.parse(JSON.stringify(seq));
  copyOptOut.steps[0].status = "opted-out";
  check("stop-rule-opted-out", sequenceStopped(copyOptOut.steps).stopped);

  const copyBounced: typeof seq = JSON.parse(JSON.stringify(seq));
  copyBounced.steps[1].status = "bounced";
  check("stop-rule-bounced", sequenceStopped(copyBounced.steps).stopped);

  const copyPending: typeof seq = JSON.parse(JSON.stringify(seq));
  check("stop-rule-pending-continues", !sequenceStopped(copyPending.steps).stopped);
}

// ---------------------------------------------------------------- dry run by default

{
  const logs: string[] = [];
  const result = await sendEmail(
    {
      channel: "email",
      workspaceId: "ws-fixture",
      leadId: "lead-fixture-01",
      to: "info@fixture-dental.example",
      domain: "fixture-dental.example",
      bizKey: "fixture-dental.example",
      subject: "Test",
      body: "Body",
    },
    { log: (m) => logs.push(m), pauseMs: 0 }
  );
  check("dry-run-by-default", !result.sent && result.dryRun, JSON.stringify(result));
  check("dry-run-logs", logs.some((l) => l.includes("dry-run") && l.includes("info@fixture-dental.example")));
}

// ---------------------------------------------------------------- suppressed address refused

{
  addOptOut({ value: "blocked.example", kind: "domain", scope: "global", source: "test" });
  const result = await sendEmail(
    {
      channel: "email",
      workspaceId: "ws-fixture",
      leadId: "lead-fixture-01",
      to: "owner@blocked.example",
      domain: "blocked.example",
      bizKey: "fixture-dental.example",
      subject: "Test",
      body: "Body",
    },
    { pauseMs: 0 }
  );
  check("suppressed-address-refused", !result.sent && result.reason?.includes("suppressed"), result.reason);
}

// ---------------------------------------------------------------- daily cap enforced

{
  const capDraft = {
    channel: "email" as const,
    workspaceId: "ws-cap",
    leadId: "lead-cap",
    to: "a@fixture.example",
    domain: "fixture.example",
    bizKey: "fixture.example",
    subject: "Cap test",
    body: "Body",
  };
  const now = new Date();
  recordSend(capDraft, "sent", now);
  const result = await sendEmail(capDraft, { dailyCap: 1, pauseMs: 0, now: () => now });
  check("daily-cap-enforced", !result.sent && result.reason?.includes("daily cap"), result.reason);
  check("daily-cap-count", countSendsToday("ws-cap", now) === 1);
}

// ---------------------------------------------------------------- domain gap enforced

{
  const gapDraft = {
    channel: "email" as const,
    workspaceId: "ws-gap",
    leadId: "lead-gap",
    to: "a@gapped.example",
    domain: "gapped.example",
    bizKey: "gapped.example",
    subject: "Gap test",
    body: "Body",
  };
  const now = new Date();
  recordSend(gapDraft, "sent", now);
  const result = await sendEmail(gapDraft, { domainGapMs: 60_000, pauseMs: 0, now: () => now });
  check("domain-gap-enforced", !result.sent && result.reason?.includes("domain gap"), result.reason);
}

// ---------------------------------------------------------------- transport called exactly once on allowed send

{
  let calls = 0;
  const transport = async () => {
    calls++;
    return { ok: true };
  };
  const result = await sendEmail(
    {
      channel: "email",
      workspaceId: "ws-allowed",
      leadId: "lead-allowed",
      to: "ok@allowed.example",
      domain: "allowed.example",
      bizKey: "allowed.example",
      subject: "Allowed",
      body: "Body",
    },
    { transport, pauseMs: 0 }
  );
  check("allowed-send-succeeds", result.sent && !result.dryRun, JSON.stringify(result));
  check("transport-called-exactly-once", calls === 1, `calls=${calls}`);
}

// ---------------------------------------------------------------- sendEmail accepts a bare transport function

{
  let calls = 0;
  const transport = async () => {
    calls++;
    return { ok: true };
  };
  const result = await sendEmail(
    {
      channel: "email",
      workspaceId: "ws-bare-fn",
      leadId: "lead-bare-fn",
      to: "ok@bare-fn.example",
      domain: "bare-fn.example",
      bizKey: "bare-fn.example",
      subject: "Bare function",
      body: "Body",
    },
    transport
  );
  check("sendEmail-accepts-bare-function", result.sent && !result.dryRun, JSON.stringify(result));
  check("bare-function-called-exactly-once", calls === 1, `calls=${calls}`);
}

// ---------------------------------------------------------------- 1-second pause

{
  resetSendPacing();
  const sleeps: number[] = [];
  let tick = 0;
  const transport = async () => ({ ok: true });
  const draftBase = {
    channel: "email" as const,
    workspaceId: "ws-pause",
    leadId: "lead-pause",
    domain: "pause.example",
    bizKey: "pause.example",
    subject: "Pause",
    body: "Body",
  };
  const first = await sendEmail(
    { ...draftBase, to: "a@pause.example" },
    {
      transport,
      domainGapMs: 0,
      now: () => new Date((tick += 0)),
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }
  );
  const second = await sendEmail(
    { ...draftBase, to: "b@pause.example" },
    {
      transport,
      domainGapMs: 0,
      now: () => new Date((tick += 100)),
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }
  );
  check("pause-first-send-succeeds", first.sent, JSON.stringify(first));
  check("pause-second-send-succeeds", second.sent, JSON.stringify(second));
  check("pause-calls-sleep", sleeps.length >= 2, `sleeps=${sleeps.join(",")}`);
  const secondWait = sleeps[sleeps.length - 1];
  check("pause-second-wait-about-1000ms-or-less", secondWait > 0 && secondWait <= 1000, `wait=${secondWait}`);
}

// ---------------------------------------------------------------- no invented fallback text

{
  const sparse = makeDossier({ sayThis: null, pushback: null });
  const drafts = buildDrafts(sparse, FIXTURE_LEAD, FIXTURE_BRANDING);
  const inventedSayThis = "I wanted to reach out about";
  const inventedPushback = "May I send you a quick note";
  check(
    "no-invented-sayThis-fallback",
    !drafts.email.body.includes(inventedSayThis) && !drafts.whatsapp.message.includes(inventedSayThis),
    drafts.email.body.slice(0, 200)
  );
  check(
    "no-invented-pushback-fallback",
    !drafts.email.body.includes(inventedPushback) && !drafts.whatsapp.message.includes(inventedPushback),
    drafts.whatsapp.message
  );
  check("empty-sayThis-leaves-placeholder-empty", drafts.email.body.includes("\n\n\n\nTop suggestion"));
}

// ---------------------------------------------------------------- SMTP client against fake server

{
  const receivedLines: string[] = [];
  const server = net.createServer((socket) => {
    let stage = 0;
    socket.write("220 fake.server ESMTP\r\n");
    socket.on("data", (data) => {
      const lines = data
        .toString()
        .split("\r\n")
        .filter((l) => l.trim() !== "");
      for (const line of lines) {
        if (stage === 5) {
          receivedLines.push(line);
          if (line === ".") {
            socket.write("250 2.0.0 Ok: queued\r\n");
            stage = 6;
          }
          continue;
        }
        if (stage === 0 && line.toUpperCase().startsWith("EHLO")) {
          socket.write("250-fake.server\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n");
          stage = 1;
        } else if (stage === 1 && line.toUpperCase().startsWith("AUTH LOGIN")) {
          socket.write("334 VXNlcm5hbWU6\r\n");
          stage = 1.5;
        } else if (stage === 1.5) {
          socket.write("334 UGFzc3dvcmQ6\r\n");
          stage = 1.75;
        } else if (stage === 1.75) {
          socket.write("235 2.7.0 Authentication successful\r\n");
          stage = 2;
        } else if (stage === 1 && line.toUpperCase().startsWith("AUTH PLAIN")) {
          socket.write("235 2.7.0 Authentication successful\r\n");
          stage = 2;
        } else if ((stage === 1 || stage === 2) && line.toUpperCase().startsWith("MAIL FROM")) {
          socket.write("250 2.1.0 Ok\r\n");
          stage = 3;
        } else if (stage === 3 && line.toUpperCase().startsWith("RCPT TO")) {
          socket.write("250 2.1.5 Ok\r\n");
          stage = 4;
        } else if (stage === 4 && line.toUpperCase() === "DATA") {
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          stage = 5;
        } else if (stage === 6 && line.toUpperCase().startsWith("QUIT")) {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;

  const prevUrl = process.env.LEADSCOUT_SMTP_URL;
  const prevEnabled = process.env.LEADSCOUT_SEND_ENABLED;
  const prevFrom = process.env.LEADSCOUT_SMTP_FROM;
  process.env.LEADSCOUT_SMTP_URL = `smtp://user:pass@127.0.0.1:${address.port}`;
  process.env.LEADSCOUT_SEND_ENABLED = "1";
  process.env.LEADSCOUT_SMTP_FROM = "sender@fake.example";

  try {
    const result = await sendEmail(
      {
        channel: "email",
        workspaceId: "ws-smtp",
        leadId: "lead-smtp",
        to: "recipient@fake.example",
        domain: "fake.example",
        bizKey: "fake.example",
        subject: "SMTP test",
        body: "Hello from fake SMTP client.",
      },
      { pauseMs: 0 }
    );
    check("smtp-client-sends", result.sent, JSON.stringify(result));
    check("smtp-body-base64-encoded", receivedLines.some((l) => /^[A-Za-z0-9+/=]+$/.test(l) && l.length <= 76));

    const nonAsciiResult = await sendEmail(
      {
        channel: "email",
        workspaceId: "ws-smtp-unicode",
        leadId: "lead-smtp-unicode",
        to: "recipient2@fake.example",
        domain: "fake.example",
        bizKey: "fake.example",
        subject: "Héllo",
        body: "Unicode body.",
      },
      { pauseMs: 0, domainGapMs: 0 }
    );
    check("smtp-unicode-subject-sends", nonAsciiResult.sent, JSON.stringify(nonAsciiResult));
    check("smtp-unicode-subject-encoded", receivedLines.some((l) => l.startsWith("Subject: =?UTF-8?B?")));
  } finally {
    if (prevUrl !== undefined) process.env.LEADSCOUT_SMTP_URL = prevUrl;
    else delete process.env.LEADSCOUT_SMTP_URL;
    if (prevEnabled !== undefined) process.env.LEADSCOUT_SEND_ENABLED = prevEnabled;
    else delete process.env.LEADSCOUT_SEND_ENABLED;
    if (prevFrom !== undefined) process.env.LEADSCOUT_SMTP_FROM = prevFrom;
    else delete process.env.LEADSCOUT_SMTP_FROM;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------- SMTP header injection rejected

{
  const prevUrl = process.env.LEADSCOUT_SMTP_URL;
  const prevEnabled = process.env.LEADSCOUT_SEND_ENABLED;
  process.env.LEADSCOUT_SMTP_URL = "smtp://127.0.0.1:1";
  process.env.LEADSCOUT_SEND_ENABLED = "1";
  try {
    const toInjection = await sendEmail(
      {
        channel: "email",
        workspaceId: "ws-inject",
        leadId: "lead-inject",
        to: "alice@example.com\r\nBCC: evil@example.com",
        domain: "example.com",
        bizKey: "example.com",
        subject: "Test",
        body: "Body",
      },
      { pauseMs: 0 }
    );
    check("smtp-rejects-crlf-in-to", !toInjection.sent && toInjection.reason?.includes("header injection"), toInjection.reason);

    const subjectInjection = await sendEmail(
      {
        channel: "email",
        workspaceId: "ws-inject2",
        leadId: "lead-inject2",
        to: "alice@example.com",
        domain: "example.com",
        bizKey: "example.com",
        subject: "Hello\r\nInjected-Header: bad",
        body: "Body",
      },
      { pauseMs: 0 }
    );
    check("smtp-rejects-crlf-in-subject", !subjectInjection.sent && subjectInjection.reason?.includes("header injection"), subjectInjection.reason);
  } finally {
    if (prevUrl !== undefined) process.env.LEADSCOUT_SMTP_URL = prevUrl;
    else delete process.env.LEADSCOUT_SMTP_URL;
    if (prevEnabled !== undefined) process.env.LEADSCOUT_SEND_ENABLED = prevEnabled;
    else delete process.env.LEADSCOUT_SEND_ENABLED;
  }
}

// ---------------------------------------------------------------- AUTH over plaintext refused for non-loopback

{
  const prevUrl = process.env.LEADSCOUT_SMTP_URL;
  const prevEnabled = process.env.LEADSCOUT_SEND_ENABLED;
  process.env.LEADSCOUT_SMTP_URL = "smtp://user:pass@relay.example:587";
  process.env.LEADSCOUT_SEND_ENABLED = "1";
  try {
    const result = await sendEmail(
      {
        channel: "email",
        workspaceId: "ws-auth-plain",
        leadId: "lead-auth-plain",
        to: "recipient@example.com",
        domain: "example.com",
        bizKey: "example.com",
        subject: "Test",
        body: "Body",
      },
      { pauseMs: 0 }
    );
    check("auth-plaintext-refused-non-loopback", !result.sent && result.reason?.includes("AUTH requires TLS or a loopback connection"), result.reason);
  } finally {
    if (prevUrl !== undefined) process.env.LEADSCOUT_SMTP_URL = prevUrl;
    else delete process.env.LEADSCOUT_SMTP_URL;
    if (prevEnabled !== undefined) process.env.LEADSCOUT_SEND_ENABLED = prevEnabled;
    else delete process.env.LEADSCOUT_SEND_ENABLED;
  }
}

// ---------------------------------------------------------------- templates load from file

{
  const templates = loadTemplates();
  check("templates-load-email", typeof templates.email.subject === "string" && typeof templates.email.body === "string");
  check("templates-load-whatsapp", typeof templates.whatsapp.message === "string");
  check("templates-load-call", typeof templates.call.script === "string");
}

// ---------------------------------------------------------------- summary

closeDb();
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore cleanup failures */ }

const failures = checks.filter((c) => !c.ok);
const overall = failures.length === 0 ? "PASS" : "FAIL";
console.log(`\n${overall}: ${checks.length - failures.length}/${checks.length} checks passed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail ?? ""}`);
  process.exit(1);
}
