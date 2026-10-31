// docs/talk-track.md (rule 3): the presenter script has numbered steps, says what Mock mode simulates, states the ID-JAG
// facts, and every button or link it tells the presenter to press still exists in the web app (so the script cannot rot).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = fs.readFileSync(path.join(root, 'docs', 'talk-track.md'), 'utf8');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
    return /\.(jsx?|json)$/.test(e.name) ? [fs.readFileSync(p, 'utf8')] : [];
  });
}

test('the talk track has numbered steps, in order, each a ## heading', () => {
  const heads = [...doc.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.ok(heads.length >= 10, `only ${heads.length} steps`);
  heads.forEach((h, i) => assert.ok(h.startsWith(`Step ${i + 1}: `), `step ${i + 1} is "${h}"`));
});

test('it is honest about Mock mode and states the ID-JAG facts', () => {
  assert.match(doc, /simulat/i);
  assert.match(doc, /"mock": true/);
  assert.match(doc, /owner-run/i);
  assert.match(doc, /IETF draft/);
  assert.match(doc, /PingFederate is the one that supports ID-JAG/);
  assert.match(doc, /only one that supports DPoP/);
  assert.match(doc, /PingOne and Advanced Identity Cloud do not/);
  assert.match(doc, /access tokens that were already minted stay valid/i);
  assert.doesNotMatch(doc, /PingOne[^.]*supports ID-JAG/i);
});

test('every bold button, link or label in it exists in the web app', () => {
  const all = sources(path.join(root, 'web', 'src')).join('\n');
  const BUILT = new Set(['View PingFederate → resource AS diagram']); // "View {label} diagram" is assembled at run time
  for (const [, label] of doc.matchAll(/\*\*([^*]+)\*\*/g)) {
    if (BUILT.has(label)) continue;
    assert.ok(all.includes(label), `the talk track names "${label}" but no web source contains it`);
  }
  assert.ok(all.includes('View ') && all.includes(' diagram ↗'));
});

test('it names no real host, tenant or person', () => {
  assert.doesNotMatch(doc, /https?:\/\/(?!127\.0\.0\.1|localhost)/);
  assert.doesNotMatch(doc, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
});
