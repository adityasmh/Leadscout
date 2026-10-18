// UI1 workspace consistency — offline check. No network, no browser, no database.
// It extracts the shared workspace-selection block from the three real pages and
// runs the dossier identity renderer against a minimal fake DOM.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PUB = resolve(process.cwd(), "public");
const INDEX = resolve(PUB, "index.html");
const SETTINGS = resolve(PUB, "settings.html");
const DOSSIER = resolve(PUB, "dossier.html");

let pass = 0;
let fail = 0;
const out: string[] = [];

function check(name: string, ok: boolean): void {
  if (ok) { pass++; out.push("PASS " + name); }
  else { fail++; out.push("FAIL " + name); }
}

function assertEq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(name + " (got " + JSON.stringify(got) + ")", ok);
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  if (a < 0) return "";
  const b = src.indexOf(end, a);
  if (b < 0) return "";
  return src.slice(a, b + end.length);
}

function extractFunction(src: string, name: string): string {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error("function not found: " + name);
  let depth = 0;
  let i = src.indexOf("{", at);
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(at, i);
}

function makeStorage() {
  const store = new Map<string, string>();
  return {
    getItem(k: string): string | null { return store.has(k) ? (store.get(k) as string) : null; },
    setItem(k: string, v: string): void { store.set(k, String(v)); },
    removeItem(k: string): void { store.delete(k); }
  };
}

// ---------------------------------------------------------------- 1. shared block
const files = [INDEX, SETTINGS, DOSSIER];
const blocks = files.map((f) => between(read(f), "// UI1-shared-start", "// UI1-shared-end"));
check("index.html carries the shared selection block", blocks[0].length > 0);
check("settings.html carries the shared selection block", blocks[1].length > 0);
check("dossier.html carries the shared selection block", blocks[2].length > 0);
check("all three pages use the same selection block", blocks[0] === blocks[1] && blocks[1] === blocks[2]);

const sharedSrc = blocks[0];
const storage = makeStorage();
const sharedFactory = new Function(
  "localStorage",
  sharedSrc + "\nreturn { pickWorkspaceId, wsStored, wsRemember, workspaceChoiceKey };"
);
const shared = sharedFactory(storage) as {
  pickWorkspaceId(paramWs: string, stored: string, list: unknown[]): string;
  wsStored(key?: string): string;
  wsRemember(id: string, key?: string): void;
  workspaceChoiceKey(): string;
};

const list = [
  { id: "ws-demo", name: "demo", createdAt: "2026-01-01T00:00:00.000Z", leadsCount: 0 },
  { id: "ws-dentists", name: "Dentists - Mumbai and Navi Mumbai", createdAt: "2026-02-01T00:00:00.000Z", leadsCount: 318 },
  { id: "ws-lawyer", name: "lawyer", createdAt: "2026-03-01T00:00:00.000Z", leadsCount: 0 }
];

assertEq("?ws= wins over storage", shared.pickWorkspaceId("ws-param", "ws-dentists", list), "ws-param");
assertEq("storage wins over the default", shared.pickWorkspaceId("", "ws-lawyer", list), "ws-lawyer");
assertEq("newest workspace with leads is chosen (dentists)", shared.pickWorkspaceId("", "", list), "ws-dentists");
assertEq("the first workspace is the last resort", shared.pickWorkspaceId("", "", [list[0]]), "ws-demo");

const noCounts = [
  { id: "ws-demo", name: "demo", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "ws-cafe", name: "Cafe", createdAt: "2026-02-01T00:00:00.000Z" },
  { id: "ws-lawyer", name: "lawyer", createdAt: "2026-03-01T00:00:00.000Z" }
];
assertEq("without counts the newest non-demo workspace wins", shared.pickWorkspaceId("", "", noCounts), "ws-lawyer");
assertEq("the shared key is leadscout.workspace", shared.workspaceChoiceKey(), "leadscout.workspace");

shared.wsRemember("ws-chosen");
assertEq("choosing a workspace writes the shared key", storage.getItem("leadscout.workspace"), "ws-chosen");

const throwing = {
  getItem(): string { throw new Error("blocked"); },
  setItem(): void { throw new Error("blocked"); },
  removeItem(): void { throw new Error("blocked"); }
};
const throwingFactory = new Function("localStorage", sharedSrc + "\nreturn { wsStored, wsRemember };");
const throwingApi = throwingFactory(throwing) as { wsStored(): string; wsRemember(id: string): void };
let threw = false;
try { throwingApi.wsStored(); throwingApi.wsRemember("x"); } catch (e) { threw = true; }
check("storage read/write is wrapped in try/catch", !threw);

// ---------------------------------------------------------------- 2. dossier identity
const dossierSrc = read(DOSSIER);
check(
  "dossier.html falls back to the lead route when the dossier has no lead",
  /data\.lead\s*\|\|\s*null/.test(dossierSrc) && dossierSrc.includes("apiGetLead(")
);

const domFns = ["el", "clear", "normalizeUrl", "leadIdentityFields", "renderIdentity"]
  .map((n) => extractFunction(dossierSrc, n))
  .join("\n");

class FakeNode {
  nodeType = 1;
  tagName: string;
  className = "";
  textContent = "";
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  classList = { toggle(): void {} };
  constructor(tag: string) { this.tagName = tag; }
  get firstChild(): FakeNode | null { return this.children.length ? this.children[0] : null; }
  appendChild(n: FakeNode): FakeNode { this.children.push(n); return n; }
  removeChild(n: FakeNode): void { this.children = this.children.filter((c) => c !== n); }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  addEventListener(): void {}
}

function makeDoc() {
  const byId = new Map<string, FakeNode>();
  byId.set("id-identity", new FakeNode("section"));
  return {
    createElement(tag: string): FakeNode { return new FakeNode(tag); },
    createTextNode(t: string): FakeNode { const n = new FakeNode("#text"); n.textContent = t; return n; },
    getElementById(id: string): FakeNode | null { return byId.get(id) || null; },
    _byId: byId
  };
}

function serialize(n: FakeNode): string {
  let s = n.textContent || "";
  for (const k of Object.keys(n.attrs)) s += " " + k + "=" + n.attrs[k];
  for (const c of n.children) s += " " + serialize(c);
  return s;
}

const doc = makeDoc();
const identityFactory = new Function("document", domFns + "\nreturn { renderIdentity };");
const identityApi = identityFactory(doc) as { renderIdentity(lead: unknown): void };

const fixtureLead = {
  name: "Fake Cafe (test fixture)",
  category: "cafe",
  address: "12 Fake Test Road, Mumbai",
  phone: "+91 90000 00000",
  website: "fake-cafe.example.invalid"
};
identityApi.renderIdentity(fixtureLead);
const rendered = serialize(doc._byId.get("id-identity") as FakeNode);
check("identity block shows the lead name", rendered.includes("Fake Cafe (test fixture)"));
check("identity block shows the category", rendered.includes("cafe"));
check("identity block shows the address", rendered.includes("12 Fake Test Road, Mumbai"));
check("identity block shows the phone", rendered.includes("+91 90000 00000"));
check("identity block shows the website", rendered.includes("fake-cafe.example.invalid"));

identityApi.renderIdentity(null);
const renderedNull = serialize(doc._byId.get("id-identity") as FakeNode);
check("a missing lead still shows the plain message", renderedNull.includes("No lead identity available."));

out.push("");
out.push(pass + " passed, " + fail + " failed");
console.log(out.join("\n"));
if (fail > 0) process.exit(1);
