import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import { PACK_PATH, buildPack, serialize } from './build-content-pack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('content-pack.json is exactly what the generator produces (run: node scripts/build-content-pack.mjs)', async () => {
  const committed = fs.readFileSync(PACK_PATH, 'utf8');
  assert.equal(committed, serialize(await buildPack()), 'content-pack.json is stale; regenerate it and commit the result');
});

test('the generator is deterministic', async () => {
  assert.equal(serialize(await buildPack()), serialize(await buildPack()));
});

test('content-pack.json validates against docs/content-pack.schema.json', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/content-pack.schema.json'), 'utf8'));
  const validate = new Ajv({ allErrors: true, strict: true, validateFormats: false }).compile(schema);
  const ok = validate(JSON.parse(fs.readFileSync(PACK_PATH, 'utf8')));
  assert.ok(ok, JSON.stringify(validate.errors));
});

test('a commit is recorded only when passed', async () => {
  assert.equal((await buildPack()).source, undefined);
  assert.equal((await buildPack({ commit: 'abc1234' })).source.commit, 'abc1234');
});

test('the gateway redeem pack carries a why-it-matters entry (Challenge, Technical, Business) labelled as Ping claims, unverified', () => {
  const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));
  const card = pack.cards.find((c) => c.id === 'why-it-matters-gateway-redeem');
  assert.ok(card, 'the why-it-matters card is missing');
  assert.equal(card.group, 'concept');
  assert.match(card.description, /Ping claim .*UNVERIFIED on our tenant/);
  for (const part of ['Challenge:', 'Technical:', 'Business:']) assert.ok(card.description.includes(part), `${part} is missing`);
  assert.ok(pack.diagrams.some((d) => d.mode === 'gateway-redeem' && d.href === '/diagram/gateway-redeem'));
  assert.ok(pack.cards.some((c) => c.id === 'gateway-redeem' && /UNVERIFIED on our tenant/.test(c.description)));
});
