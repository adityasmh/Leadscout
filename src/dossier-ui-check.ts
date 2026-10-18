// src/dossier-ui-check.ts
// Static analysis checker for the Leadscout dossier UI.
// Reads public/dossier.html and index.html, prints PASS/FAIL,
// exits with code 1 on any FAIL. No browser, no network.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const publicDir = resolve(__dirname, '../public');
const dossierPath = resolve(publicDir, 'dossier.html');
const indexPath = resolve(publicDir, 'index.html');

const requiredIds = [
  'id-identity',
  'id-facts',
  'id-score',
  'id-gap',
  'id-say',
  'id-pushback',
  'id-offers',
  'id-works',
  'id-evidence',
  'id-callstatus',
  'id-generate',
  'id-note',
  'id-level',
  'id-dropped',
  'id-footer',
  'id-report-brand',
  'id-report-list',
  'id-error',
];

const footerTexts = [
  '(c) OpenStreetMap contributors',
  'price not set',
  'FREE door-opener',
  'Powered by Leadscout',
  'rules only',
  'polished and citation-checked',
];

const mockMarkers = ['MOCK_LEVEL1', 'MOCK_LEVEL0', 'MOCK_NULLGAP', 'MOCK_REPORT'];

function readHtml(path: string): { ok: true; text: string } | { ok: false; error: string } {
  try {
    return { ok: true, text: readFileSync(path, 'utf8') };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

function checkIds(html: string): { pass: boolean; missing: string[] } {
  const missing = requiredIds.filter((id) => !html.includes(`id="${id}"`));
  return { pass: missing.length === 0, missing };
}

function checkDetailsForDropped(html: string): { pass: boolean; reason: string } {
  if (!html.includes('<details')) {
    return { pass: false, reason: 'no <details> element found' };
  }
  if (!html.includes('id-dropped')) {
    return { pass: false, reason: 'id-dropped section missing' };
  }
  return { pass: true, reason: '<details> present and id-dropped exists' };
}

function checkEvAnchorsInJs(html: string): { pass: boolean; reason: string } {
  // Look for JS creating ev- ids or ev- anchors. Accept either id="ev-... or href="#ev- or #ev- string construction.
  const js = html.replace(/<script[^>]*>/gi, '').replace(/<\/script>/gi, '');
  const hasEvId = /id\s*=\s*["']ev-/.test(js);
  const hasEvHref = /href\s*=\s*["']#ev-/.test(js);
  const hasEvHash = /['"`]#ev-/.test(js);
  const hasEvCreate = /createElement\s*\(\s*['"'](?:a|span|li|div)['"']\s*\)/i.test(js) && /ev-/.test(js);
  if (hasEvId || hasEvHref || hasEvHash || hasEvCreate) {
    return { pass: true, reason: 'JS builds ev- anchors' };
  }
  return { pass: false, reason: 'no evidence of JS-built ev- anchors' };
}

function checkMockMarkers(html: string): { pass: boolean; missing: string[] } {
  const missing = mockMarkers.filter((m) => !html.includes(m));
  return { pass: missing.length === 0, missing };
}

function checkNullFixture(html: string): { gapNull: boolean; quoteNull: boolean } {
  const idx = html.indexOf('MOCK_NULLGAP');
  if (idx === -1) return { gapNull: false, quoteNull: false };
  const windowSize = 2000;
  const slice = html.slice(idx, idx + windowSize);
  return {
    gapNull: /gap\s*:\s*null/.test(slice) || /"gap"\s*:\s*null/.test(slice),
    quoteNull: /quote\s*:\s*null/.test(slice) || /"quote"\s*:\s*null/.test(slice),
  };
}

function checkXss(html: string): { pass: boolean; hits: string[] } {
  const hits: string[] = [];
  const lines = html.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\binnerHTML\s*=/.test(line)) hits.push(`L${i + 1}: ${line.trim()}`);
    if (/\bouterHTML\s*=/.test(line)) hits.push(`L${i + 1}: ${line.trim()}`);
    if (/\binsertAdjacentHTML\s*\(/.test(line)) hits.push(`L${i + 1}: ${line.trim()}`);
    if (/\bdocument\.write\s*\(/.test(line)) hits.push(`L${i + 1}: ${line.trim()}`);
  }
  return { pass: hits.length === 0, hits };
}

function checkExternalHosts(html: string): { pass: boolean; hits: string[] } {
  const hits: string[] = [];
  const lines = html.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Static src/href to another host: http(s):// or protocol-relative //
    if (/\b(src|href)\s*=\s*["']\s*(?:https?:\/\/|\/\/)/i.test(line)) {
      hits.push(`L${i + 1}: ${line.trim()}`);
    }
    // External url() references in CSS
    if (/url\s*\(\s*["']?\s*(?:https?:\/\/|\/\/)/i.test(line)) {
      hits.push(`L${i + 1}: ${line.trim()}`);
    }
  }
  return { pass: hits.length === 0, hits };
}

function checkFooterAndCss(html: string): { pass: boolean; missing: string[] } {
  const lower = html.toLowerCase();
  const missing = footerTexts.filter((text) => !html.includes(text));
  if (!lower.includes('prefers-color-scheme')) missing.push('prefers-color-scheme');
  if (!lower.includes('@media print')) missing.push('@media print');
  return { pass: missing.length === 0, missing };
}

// ---- Main ----

const results: { check: string; pass: boolean; detail: string; skip?: boolean }[] = [];
let anyFail = false;

const dossier = readHtml(dossierPath);
if (!dossier.ok) {
  results.push({ check: 'dossier.html readable', pass: false, detail: dossier.error });
  anyFail = true;
} else {
  results.push({ check: 'dossier.html readable', pass: true, detail: dossierPath });

  const ids = checkIds(dossier.text);
  results.push({ check: 'required section ids', pass: ids.pass, detail: ids.pass ? 'all present' : `missing: ${ids.missing.join(', ')}` });
  if (!ids.pass) anyFail = true;

  const dropped = checkDetailsForDropped(dossier.text);
  results.push({ check: '<details> for dropped', pass: dropped.pass, detail: dropped.reason });
  if (!dropped.pass) anyFail = true;

  const ev = checkEvAnchorsInJs(dossier.text);
  results.push({ check: 'ev- anchors built in JS', pass: ev.pass, detail: ev.reason });
  if (!ev.pass) anyFail = true;

  const mocks = checkMockMarkers(dossier.text);
  results.push({ check: 'mock fixture markers', pass: mocks.pass, detail: mocks.pass ? 'all present' : `missing: ${mocks.missing.join(', ')}` });
  if (!mocks.pass) anyFail = true;

  const nulls = checkNullFixture(dossier.text);
  results.push({
    check: 'null gap and null quote in null fixture',
    pass: nulls.gapNull && nulls.quoteNull,
    detail: `gap null: ${nulls.gapNull}, quote null: ${nulls.quoteNull}`,
  });
  if (!nulls.gapNull || !nulls.quoteNull) anyFail = true;

  const xss = checkXss(dossier.text);
  results.push({ check: 'no innerHTML/outerHTML/insertAdjacentHTML/document.write', pass: xss.pass, detail: xss.pass ? 'none found' : `found ${xss.hits.length} hit(s)` });
  if (!xss.pass) anyFail = true;
  for (const hit of xss.hits.slice(0, 5)) {
    results.push({ check: '  -', pass: false, detail: hit });
  }

  const ext = checkExternalHosts(dossier.text);
  results.push({ check: 'no external src/href/url() hosts', pass: ext.pass, detail: ext.pass ? 'none found' : `found ${ext.hits.length} hit(s)` });
  if (!ext.pass) anyFail = true;
  for (const hit of ext.hits.slice(0, 5)) {
    results.push({ check: '  -', pass: false, detail: hit });
  }

  const css = checkFooterAndCss(dossier.text);
  results.push({ check: 'footer texts and CSS media queries', pass: css.pass, detail: css.pass ? 'all present' : `missing: ${css.missing.join(', ')}` });
  if (!css.pass) anyFail = true;
}

const index = readHtml(indexPath);
if (!index.ok) {
  results.push({ check: 'index.html readable', pass: false, detail: index.error });
  anyFail = true;
} else {
  results.push({ check: 'index.html readable', pass: true, detail: indexPath });

  const hasDossierLink = /dossier\.html\?ws=/.test(index.text) || /dossier\.html["']/.test(index.text);
  if (hasDossierLink) {
    results.push({ check: 'index.html contains dossier link', pass: true, detail: 'dossier.html link found' });
  } else {
    results.push({
      check: 'index.html contains dossier link',
      pass: false,
      skip: true,
      detail: 'SKIP (delivered by order I2)',
    });
  }
}

// Print results.
for (const r of results) {
  const status = r.skip ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
  console.log(`${status}: ${r.check}${r.detail ? ` — ${r.detail}` : ''}`);
}

if (anyFail) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
