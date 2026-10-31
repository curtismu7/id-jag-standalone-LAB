#!/usr/bin/env node
/**
 * Generates content-pack.json (repo root) from web/src/data/terms.json and sources.json, plus the guide list
 * in GuidesPage.jsx and the diagram files in diagrams/. Format: docs/content-pack.schema.json.
 * Output is deterministic: lists sorted by id, 2-space JSON, no timestamps. The git commit is recorded only when
 * passed (--commit=<sha>), so a plain run is reproducible.
 *
 *   node scripts/build-content-pack.mjs [--commit=<sha>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACK_PATH = path.join(ROOT, 'content-pack.json');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The [id, title] pairs of GUIDES in GuidesPage.jsx (a page component cannot be imported by node). */
function readGuides() {
  const block = read('web/src/pages/GuidesPage.jsx').match(/export const GUIDES = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error('GUIDES not found in GuidesPage.jsx');
  return [...block[1].matchAll(/\[\s*"([^"]+)",\s*"([^"]+)"\s*\]/g)].map(([, id, title]) => [id, title]);
}

// DRAFT value text for the gateway redeem feature. Section 10 of the feature prompt has no On-Behalf-Of or ID-JAG row (the slide 48 row there is
// Intent, Purpose, Behaviour, a different feature), so this is written by this lab's author from the swagger field names (OBO.Redeem) and the
// feature description. It is NOT Ping wording and is UNVERIFIED on our tenant. The owner replaces it with the real row.
const WHY_IT_MATTERS = [
  'DRAFT by the lab author, not Ping wording; the owner replaces it. Ping release claim (2026-11-02), UNVERIFIED on our tenant.',
  "Challenge: An agent that calls a third-party app for a user either shares one standing credential with that app, so the app cannot tell which user acted, or has no way to present the user's identity to the app's own issuer.",
  "Technical: The gateway exchanges the caller's token for an ID-JAG (leg 1) and, when a Redeem spec with a TokenURL is set, redeems it at the target app's own issuer as an assertion grant (leg 2), so the app gets a token for the user and no shared secret sits on the agent side. Without Redeem the exchange result is not redeemed.",
  'Business: A third-party app can be brought under per-user, attributable access without issuing it a standing service credential, which shrinks the standing-secret inventory and lets an audit show which user an agent acted for.',
].join(' ');

export async function buildPack({ commit } = {}) {
  const glossary = JSON.parse(read('web/src/data/terms.json')).sort(byId);
  const sources = JSON.parse(read('web/src/data/sources.json')).sort(byId);
  const cards = [
    ...readGuides().map(([id, label]) => ({ id: `guide-${id}`, label, group: 'setup', action: { type: 'route', href: `/guides#${id}` } })),
    { id: 'playground', label: 'ID-JAG Playground', description: 'The flow one step at a time, with every request, response and the code behind it.', group: 'try-it', action: { type: 'route', href: '/' }, terms: ['id-jag', 'jwt-bearer-grant', 'token-exchange'] },
    { id: 'gateway-redeem', label: 'Gateway redeems the ID-JAG (Ping release claim, mock only)', description: 'The gateway exchanges the caller token (leg 1) and redeems the result at the target app\'s own issuer (leg 2). Ping release claim (2026-11-02), UNVERIFIED on our tenant.', group: 'try-it', action: { type: 'route', href: '/' }, terms: ['id-jag', 'token-exchange', 'jwt-bearer-grant'] },
    { id: 'why-it-matters-gateway-redeem', label: 'Why it matters: the gateway redeems the ID-JAG (DRAFT, Ping claims unverified)', description: WHY_IT_MATTERS, group: 'concept', action: { type: 'route', href: '/' }, terms: ['id-jag'] },
    { id: 'trusted-idps', label: 'Trusted IdPs', description: 'Register your IdP so our resource authorization server accepts its ID-JAGs.', group: 'try-it', action: { type: 'route', href: '/trusted-idps' }, terms: ['resource-authorization-server'] },
    { id: 'inspector', label: 'Inspector', description: 'Check an ID-JAG against the draft and the trust registry.', group: 'try-it', action: { type: 'route', href: '/inspect' }, terms: ['jti-replay', 'strict-client-binding'] },
  ].sort(byId);
  const termIds = new Set(glossary.map((t) => t.id));
  for (const c of cards) for (const t of c.terms || []) if (!termIds.has(t)) throw new Error(`card ${c.id}: unknown term ${t}`);
  // One diagram per file in diagrams/ (diagram-studio/1 data); the title is the label the app shows for the mode.
  const diagrams = fs.readdirSync(path.join(ROOT, 'diagrams')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
    .map((m) => ({ id: `flow-${m}`, label: `${JSON.parse(read(`diagrams/${m}.json`)).title} diagram`, href: `/diagram/${m}`, mode: m }));
  return {
    schema: 'demo-content-pack/1',
    id: 'id-jag',
    title: 'ID-JAG',
    version: '0.1.0',
    ...(commit ? { source: { repo: 'ping-sandbox/id-jag-standalone-LAB', commit } } : {}),
    demo: { id: 'id-jag-standalone', name: 'ID-JAG playground', catalog: 'C1', tags: ['mcp', 'pingfederate', 'tokens'] },
    glossary,
    sources,
    cards,
    diagrams,
  };
}

export const serialize = (pack) => `${JSON.stringify(pack, null, 2)}\n`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const commit = process.argv.find((a) => a.startsWith('--commit='))?.slice('--commit='.length);
  fs.writeFileSync(PACK_PATH, serialize(await buildPack({ commit })));
  console.log(`wrote ${path.relative(process.cwd(), PACK_PATH)}`);
}
