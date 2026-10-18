import { readFile, readdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures-v2", "dossier");
const TEMP_DB = join(mkdtempSync(join(tmpdir(), "leadscout-dossier-check-")), "leadscout-dossier-check.db");

process.env.LEADSCOUT_DB = TEMP_DB;

const {
  buildTemplateDossier,
  polishDossier,
  saveDossier,
  getDossier,
  setCallStatus,
} = await import("./dossier.js");
const { buildPrompt } = await import("./dossier-prompts.js");
const { defaultLlm, makeDefaultLlm } = await import("./llm.js");
const { closeDb } = await import("./store.js");

type Fixture = {
  name: string;
  expected?: Record<string, unknown>;
  input: any;
};

async function loadFixtures(): Promise<Record<string, Fixture>> {
  const files = await readdir(FIXTURES_DIR);
  const out: Record<string, Fixture> = {};
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const raw = await readFile(join(FIXTURES_DIR, file), "utf8");
    out[file.replace(/\.json$/, "")] = JSON.parse(raw) as Fixture;
  }
  return out;
}

const fixtures = await loadFixtures();

let failed = false;
const lines: string[] = [];

function arraysEqual<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`PASS ${name}`);
    lines.push(`PASS ${name}`);
  } else {
    failed = true;
    const msg = detail ? `FAIL ${name}: ${detail}` : `FAIL ${name}`;
    console.log(msg);
    lines.push(msg);
  }
}

function makeLlm(answerOrFn: string | ((req: any) => string)): {
  llm: any;
  calls: { system: string; prompt: string; taskHint?: string }[];
} {
  const calls: { system: string; prompt: string; taskHint?: string }[] = [];
  const llm = async (req: { system: string; prompt: string; taskHint?: string }) => {
    calls.push(req);
    const text = typeof answerOrFn === "function" ? answerOrFn(req) : answerOrFn;
    return { text, tokensIn: 100, tokensOut: 50, model: "fake-model" };
  };
  return { llm, calls };
}

function goodAnswer(draft: any): string {
  // Echo the draft's safe level-0 text so every field can become level 1
  // without introducing new capitalised words or numbers.
  return JSON.stringify({
    gap: draft.gap
      ? {
          headline: draft.gap.headline,
          tag: draft.gap.tag,
        }
      : undefined,
    sayThis: draft.sayThis,
    pushback: draft.pushback,
    offers: draft.offers.map((o: any) => ({
      service: o.service,
      description: o.description,
      whyItMatters: o.whyItMatters,
    })),
  });
}

function mutateAnswer(draft: any, mutator: (obj: any) => void): string {
  const parsed = JSON.parse(goodAnswer(draft));
  mutator(parsed);
  return JSON.stringify(parsed);
}

// ------------------------------------------------------------------ tests

// 1. Tag fixtures
for (const key of ["tag-going-unseen", "tag-leaking", "tag-outdated", "tag-not-measuring"]) {
  const f = fixtures[key];
  const d = buildTemplateDossier(f.input);
  check(
    `${f.name} fires`,
    d.gap?.tag === f.expected?.tag && arraysEqual(d.gap?.headline.evidence ?? [], (f.expected?.evidence as string[]) ?? []),
    `got ${d.gap?.tag} evidence=${JSON.stringify(d.gap?.headline.evidence)}`
  );
}

// 2. No gap -> honest, service-led opener
{
  const f = fixtures["no-gap"];
  const base = f.input;
  const d = buildTemplateDossier(base);
  check(
    "no gap -> null gap and pushback, service opener present",
    d.gap === null && d.pushback === null && d.sayThis !== null,
    `gap=${JSON.stringify(d.gap)} pushback=${JSON.stringify(d.pushback)} sayThis=${d.sayThis?.value}`
  );
  check(
    "no gap -> non-null sayThis with null gap and pushback",
    d.sayThis !== null && d.gap === null && d.pushback === null,
    d.sayThis?.value
  );

  // (a) no configured sender, no-gap lead: greet the business, first offer clause, question.
  const dNoSender = buildTemplateDossier({ ...base, senderName: undefined });
  check(
    "service opener contains business name, the top offer label and 'Do you have a minute?'",
    dNoSender.sayThis !== null &&
      dNoSender.sayThis.value.includes(base.lead.name) &&
      dNoSender.sayThis.value.includes("I make e-commerce for retail shops") &&
      dNoSender.sayThis.value.includes("Do you have a minute?"),
    dNoSender.sayThis?.value
  );
  check(
    "no sender -> service opener starts 'Hi, is this <business>?'",
    dNoSender.sayThis !== null &&
      dNoSender.sayThis.value.startsWith(`Hi, is this ${base.lead.name}?`),
    dNoSender.sayThis?.value
  );

  // (b) configured sender -> service opener starts "Hi, this is <sender>".
  check(
    "configured sender -> service opener starts 'Hi, this is <sender>'",
    d.sayThis !== null &&
      d.sayThis.value.startsWith(`Hi, this is ${base.senderName}`),
    d.sayThis?.value
  );

  // (c) empty offer description but services present -> opener from the top-ranked offer only, dashes as spaces.
  const dServices = buildTemplateDossier({
    ...base,
    offer: { services: ["on-site-seo", "ecommerce", "ai-chatbot", "fourth-service"], description: "" },
  });
  check(
    "empty offer description -> opener from the top offer only, dashes as spaces",
    dServices.sayThis !== null &&
      dServices.sayThis.value.includes("I make e-commerce for retail shops") &&
      !dServices.sayThis.value.includes("fourth") &&
      !dServices.sayThis.value.includes("on site seo") &&
      !dServices.sayThis.value.includes("ai chatbot"),
    dServices.sayThis?.value
  );

  // (d) empty offer description and no services -> no opener.
  const dNoOffer = buildTemplateDossier({
    ...base,
    offer: { services: [], description: "" },
  });
  check(
    "empty offer and no services -> null sayThis",
    dNoOffer.sayThis === null && dNoOffer.gap === null && dNoOffer.pushback === null,
    `sayThis=${JSON.stringify(dNoOffer.sayThis)}`
  );

  // (e) category empty -> "local businesses"; "dentist clinic" is pluralised once.
  const dLocal = buildTemplateDossier({ ...base, lead: { ...base.lead, category: "" } });
  const dClinic = buildTemplateDossier({ ...base, lead: { ...base.lead, category: "dentist clinic" } });
  check(
    "category empty -> 'local businesses'; 'dentist clinic' -> 'dentist clinics'",
    dLocal.sayThis !== null &&
      dLocal.sayThis.value.includes("I make e-commerce for local businesses") &&
      dClinic.sayThis !== null &&
      dClinic.sayThis.value.includes("I make e-commerce for dentist clinics"),
    `local=${dLocal.sayThis?.value} clinic=${dClinic.sayThis?.value}`
  );

  // (f) a lead WITH a gap keeps the gap opener unchanged (no service opener).
  const gapLead = buildTemplateDossier(fixtures["tag-going-unseen"].input);
  check(
    "lead with a gap keeps the gap opener (no service opener)",
    gapLead.gap !== null &&
      gapLead.sayThis !== null &&
      gapLead.sayThis.value.includes("I noticed") &&
      !gapLead.sayThis.value.includes("I help"),
    gapLead.sayThis?.value
  );

  // (g) no opener ever contains undefined or a curly-brace placeholder.
  const openers = [d, dNoSender, dServices, dLocal, dClinic, gapLead];
  const badOpener = openers.find(
    (x) =>
      x.sayThis !== null &&
      (/undefined/.test(x.sayThis.value) || /\{[^}]*\}/.test(x.sayThis.value))
  );
  check(
    "service openers never contain undefined or curly braces",
    badOpener === undefined,
    badOpener?.sayThis?.value
  );

  // (h) opener stays under 45 words.
  const tooLong = openers.find(
    (x) => x.sayThis !== null && x.sayThis.value.split(/\s+/).filter(Boolean).length >= 45
  );
  check(
    "service openers stay under 45 words",
    tooLong === undefined,
    tooLong?.sayThis?.value
  );
}

// 3. Tie first-match-wins
{
  const f = fixtures["tie"];
  const d = buildTemplateDossier(f.input);
  check(
    "tie first-match-wins",
    d.gap?.tag === "LEAKING" && arraysEqual(d.gap?.headline.evidence ?? [], ["E2"]),
    `tag=${d.gap?.tag} evidence=${JSON.stringify(d.gap?.headline.evidence)}`
  );
}

// 4. Opener intro chosen at fill time
{
  const base = fixtures["tag-going-unseen"].input;

  // (a) sender + different workspace -> "Hi, this is <sender> from <workspace>."
  const dSender = buildTemplateDossier(base);
  check(
    "opener a: sender + different workspace",
    dSender.sayThis !== null &&
      dSender.sayThis.value.startsWith("Hi, this is Test Sender from Test Workspace."),
    dSender.sayThis?.value
  );

  // (b) sender + no workspace -> no "from" part
  const dNoCompany = buildTemplateDossier({ ...base, workspaceName: "" });
  check(
    "opener b: sender + no workspace has no from part",
    dNoCompany.sayThis !== null &&
      dNoCompany.sayThis.value.startsWith("Hi, this is Test Sender.") &&
      !dNoCompany.sayThis.value.includes(" from "),
    dNoCompany.sayThis?.value
  );

  // (c) no sender -> "Hi, is this <business name>?" and neither workspace name nor "this is"
  const fNoSender = fixtures["missing-senderName"];
  const dNoSender = buildTemplateDossier(fNoSender.input);
  check(
    "opener c: no sender greets the business",
    dNoSender.sayThis !== null &&
      dNoSender.sayThis.value.startsWith(`Hi, is this ${fNoSender.input.lead.name}?`) &&
      !dNoSender.sayThis.value.includes(fNoSender.input.workspaceName) &&
      !dNoSender.sayThis.value.includes("this is"),
    dNoSender.sayThis?.value
  );

  // (d) no opener contains undefined or a curly-brace placeholder
  const tagFixtures = ["tag-going-unseen", "tag-leaking", "tag-outdated", "tag-not-measuring"];
  const templated = tagFixtures.map((k) => buildTemplateDossier(fixtures[k].input));
  const allOpeners = [dSender, dNoCompany, dNoSender, ...templated];
  const badOpener = allOpeners.find(
    (d) =>
      d.sayThis !== null &&
      (/undefined/.test(d.sayThis.value) || /\{[^}]*\}/.test(d.sayThis.value))
  );
  check(
    "opener d: no undefined or curly-brace placeholders",
    badOpener === undefined,
    badOpener?.sayThis?.value
  );

  // (e) each of the four gap templates is covered by the fill-time choice
  const covered = templated.every(
    (d) =>
      d.sayThis !== null &&
      (d.sayThis.value.startsWith("Hi, this is ") || d.sayThis.value.startsWith("Hi, is this "))
  );
  check("opener e: all four gap templates covered", covered);
}

// 5. Offers: service absent from pricebook dropped
{
  const f = fixtures["service-absent-from-pricebook"];
  const d = buildTemplateDossier(f.input);
  check(
    "service in lead.fit but absent from pricebook is dropped",
    !d.offers.some((o) => o.service === "seo"),
    JSON.stringify(d.offers.map((o) => o.service))
  );
}

// 6. Null price stays null
{
  const f = fixtures["null-price"];
  const d = buildTemplateDossier(f.input);
  const offer = d.offers.find((o) => o.service === "website-redesign");
  check("null price stays null", offer !== undefined && offer.quote === null);
}

// 7. Offers bounds
{
  const f = fixtures["offers-bounds"];
  const d = buildTemplateDossier(f.input);
  const doorOpeners = d.offers.filter((o) => o.doorOpener);
  const ranks = d.offers.map((o) => o.rank);
  const pricesMatch = d.offers.every((o) => {
    const item = f.input.priceBook.items.find((i: any) => i.service === o.service);
    return item && JSON.stringify(o.quote) === JSON.stringify(item.price);
  });
  check(
    "offers max 5, at most one door-opener, prices match price book",
    d.offers.length <= 5 &&
      doorOpeners.length <= 1 &&
      ranks.every((r, i) => r === i + 1) &&
      pricesMatch,
    `offers=${d.offers.length} doorOpeners=${doorOpeners.length} ranks=${JSON.stringify(ranks)}`
  );
}

// 7b. Door-opener not in lead.fit still added from price book
{
  const f = fixtures["door-opener-not-in-fit"];
  const d = buildTemplateDossier(f.input);
  const doorOpeners = d.offers.filter((o) => o.doorOpener);
  const ranks = d.offers.map((o) => o.rank);
  check(
    "door-opener fallback when none in lead.fit",
    d.offers.length <= 5 &&
      doorOpeners.length === 1 &&
      doorOpeners[0].service === f.expected?.doorOpenerService &&
      ranks.every((r, i) => r === i + 1),
    `offers=${d.offers.length} doorOpeners=${doorOpeners.length} service=${doorOpeners[0]?.service} ranks=${JSON.stringify(ranks)}`
  );
}

// 8. Good fake answer -> level 1
{
  const f = fixtures["tag-leaking"];
  const draft = buildTemplateDossier(f.input);
  const { llm } = makeLlm(goodAnswer(draft));
  const polished = await polishDossier(f.input, draft, { llm });
  check(
    "good fake answer -> level 1",
    polished.level === 1,
    `level=${polished.level} headline=${polished.gap?.headline.value}`
  );
}

// 9. Invented year dropped rule 2
{
  const f = fixtures["tag-leaking"];
  const draft = buildTemplateDossier(f.input);
  const { llm } = makeLlm(
    mutateAnswer(draft, (obj) => {
      obj.sayThis.value =
        "Hi, this is Test Sender. I noticed Fixture Leaking Clinic's site was last updated in 2024. Do you plan to refresh it?";
    })
  );
  const polished = await polishDossier(f.input, draft, { llm });
  const rule2 = polished.dropped.some((d) => d.field === "sayThis" && d.reason.includes("rule 2"));
  check("invented year dropped rule 2", rule2, JSON.stringify(polished.dropped));
}

// 10. Invented person name dropped rule 3
{
  const f = fixtures["tag-leaking"];
  const draft = buildTemplateDossier(f.input);
  const { llm } = makeLlm(
    mutateAnswer(draft, (obj) => {
      obj.sayThis.value =
        "Hi, this is Test Sender. Dr. Ramesh Patel asked us to reach out about Fixture Leaking Clinic's bookings.";
    })
  );
  const polished = await polishDossier(f.input, draft, { llm });
  const rule3 = polished.dropped.some((d) => d.field === "sayThis" && d.reason.includes("rule 3"));
  check("invented person name dropped rule 3", rule3, JSON.stringify(polished.dropped));
}

// 11. Rupee amount dropped rule 2
{
  const f = fixtures["tag-leaking"];
  const draft = buildTemplateDossier(f.input);
  const { llm } = makeLlm(
    mutateAnswer(draft, (obj) => {
      obj.sayThis.value =
        "Hi, this is Test Sender. We can fix Fixture Leaking Clinic's booking gap for just ₹5,000.";
    })
  );
  const polished = await polishDossier(f.input, draft, { llm });
  const rule2 = polished.dropped.some((d) => d.field === "sayThis" && d.reason.includes("rule 2"));
  check("rupee amount dropped rule 2", rule2, JSON.stringify(polished.dropped));
}

// 12. Review claim dropped rule 4
{
  const f = fixtures["tag-leaking"];
  const draft = buildTemplateDossier(f.input);
  const { llm } = makeLlm(
    mutateAnswer(draft, (obj) => {
      obj.sayThis.value =
        "Hi, this is Test Sender. This clinic is rated and has stars on its listing.";
    })
  );
  const polished = await polishDossier(f.input, draft, { llm });
  const rule4 = polished.dropped.some((d) => d.field === "sayThis" && d.reason.includes("rule 4"));
  check("review claim dropped rule 4", rule4, JSON.stringify(polished.dropped));
}

// 13. Missing evidence id dropped rule 1
{
  const f = fixtures["tag-leaking"];
  const draft = buildTemplateDossier(f.input);
  const { llm } = makeLlm(
    mutateAnswer(draft, (obj) => {
      obj.offers[0].description.evidence = [];
    })
  );
  const polished = await polishDossier(f.input, draft, { llm });
  const rule1 = polished.dropped.some((d) => d.field.startsWith("offers[0].description") && d.reason.includes("rule 1"));
  check("missing evidence id dropped rule 1", rule1, JSON.stringify(polished.dropped));
}

// 14. Unknown evidence id dropped rule 1
{
  const f = fixtures["tag-leaking"];
  const draft = buildTemplateDossier(f.input);
  const { llm } = makeLlm(
    mutateAnswer(draft, (obj) => {
      obj.offers[0].description.evidence = ["E99"];
    })
  );
  const polished = await polishDossier(f.input, draft, { llm });
  const rule1 = polished.dropped.some((d) => d.field.startsWith("offers[0].description") && d.reason.includes("rule 1"));
  check("unknown evidence id dropped rule 1", rule1, JSON.stringify(polished.dropped));
}

// 15. Over-long say-this dropped rule 6
{
  const f = fixtures["tag-leaking"];
  const draft = buildTemplateDossier(f.input);
  // Lowercase and no unallowed capitalised words, so only rule 6 (word cap) fires.
  const longSay =
    "hi this is test workspace from test workspace and we are reaching out today because we were looking at the website and we could not find a way to book an appointment online which seems like it might be losing some enquiries and we should discuss this soon before any more leads are lost";
  const { llm } = makeLlm(
    mutateAnswer(draft, (obj) => {
      obj.sayThis.value = longSay;
    })
  );
  const polished = await polishDossier(f.input, draft, { llm });
  const rule6 = polished.dropped.some((d) => d.field === "sayThis" && d.reason.includes("rule 6"));
  check("over-long say-this dropped rule 6", rule6, JSON.stringify(polished.dropped));
}

// 16. Gap headline fail -> level 0 unchanged
{
  const f = fixtures["tag-leaking"];
  const draft = buildTemplateDossier(f.input);
  const originalHeadline = draft.gap?.headline.value;
  const { llm } = makeLlm(
    mutateAnswer(draft, (obj) => {
      obj.gap.headline.value =
        "No online booking on Fixture Leaking Clinic's website since 2024.";
    })
  );
  const polished = await polishDossier(f.input, draft, { llm });
  check(
    "gap headline fail -> level 0 draft unchanged",
    polished.level === 0 && polished.gap?.headline.value === originalHeadline,
    `level=${polished.level} headline=${polished.gap?.headline.value}`
  );
}

// 17. Invalid JSON -> exactly one repair call
{
  const f = fixtures["tag-leaking"];
  const draft = buildTemplateDossier(f.input);
  let callCount = 0;
  const llm = async () => {
    callCount++;
    return { text: callCount === 1 ? "not json" : '{invalid', tokensIn: 10, tokensOut: 5, model: "fake" };
  };
  await polishDossier(f.input, draft, { llm });
  check("invalid JSON -> exactly one repair call", callCount === 2, `calls=${callCount}`);
}

// 18. Injected instruction never appears in output
{
  const f = fixtures["injected-instruction"];
  const draft = buildTemplateDossier(f.input);
  const { llm } = makeLlm(goodAnswer(draft));
  const polished = await polishDossier(f.input, draft, { llm });
  // The evidence list legitimately contains the injected text as input data;
  // we only assert it never surfaces in model-rewritten fields.
  const output = JSON.stringify({
    gap: polished.gap,
    sayThis: polished.sayThis,
    pushback: polished.pushback,
    offers: polished.offers,
  }).toUpperCase();
  check(
    "injected instruction never appears in output",
    !output.includes("HACKED") && !output.includes("IGNORE_PREVIOUS_INSTRUCTIONS"),
    output
  );
}

// 19. Prompt under 14000 chars
{
  const f = fixtures["large-evidence"];
  // Expand evidence list to stress the prompt budget.
  const base = f.input.evidence[0];
  const expanded: any[] = [];
  for (let i = 0; i < 80; i++) {
    expanded.push({
      ...base,
      id: `E${i + 1}`,
      quote: `${base.quote} This is padded sentence number ${i + 1} to increase the prompt size for the length check.`,
    });
  }
  f.input.evidence = expanded;
  const draft = buildTemplateDossier(f.input);
  const { prompt } = buildPrompt(f.input, draft);
  check("prompt < 14000 chars with large fixture", prompt.length < 14000, `length=${prompt.length}`);
}

// 20. defaultLlm parses usage shapes
{
  const cases = [
    {
      name: "input/output_tokens",
      usage: { input_tokens: 123, output_tokens: 45 },
      expected: { in: 123, out: 45, estimated: false },
    },
    {
      name: "prompt/completion_tokens",
      usage: { prompt_tokens: 99, completion_tokens: 7 },
      expected: { in: 99, out: 7, estimated: false },
    },
    {
      name: "no usage",
      usage: undefined,
      expected: { in: 3, out: 3, estimated: true }, // ("system" + "test") / 4 = 3; "hello world!" / 4 = 3
    },
  ];
  for (const c of cases) {
    const answer = c.name === "no usage" ? "hello world!" : "ok";
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({ answer, usage: c.usage, model: "fake" }),
    });
    const llm = makeDefaultLlm(fetchFn as any);
    const res = await llm({ system: "system", prompt: "test" });
    check(
      `defaultLlm parses ${c.name}`,
      res.tokensIn === c.expected.in &&
        res.tokensOut === c.expected.out &&
        !!res.estimated === !!c.expected.estimated,
      JSON.stringify(res)
    );
  }
}

// 21. Save/load round trip incl setCallStatus
{
  const f = fixtures["tag-going-unseen"];
  const draft = buildTemplateDossier(f.input);
  saveDossier(draft);
  const loaded = getDossier(draft.workspaceId, draft.leadId);
  setCallStatus(draft.workspaceId, draft.leadId, "call-back");
  const afterStatus = getDossier(draft.workspaceId, draft.leadId);
  check(
    "save/load round trip incl setCallStatus",
    loaded !== undefined &&
      loaded.leadId === draft.leadId &&
      afterStatus?.callStatus === "call-back",
    `callStatus=${afterStatus?.callStatus}`
  );
}

// ------------------------------------------------------------------ cleanup
closeDb();
try { await unlink(TEMP_DB); } catch { /* ignore */ }

console.log(failed ? "\nDONE with failures" : "\nALL PASS");
lines.push(failed ? "DONE with failures" : "ALL PASS");

if (failed) {
  process.exitCode = 1;
}

export { lines, failed };
