import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main } from './check-forbidden-strings.mjs';

const ALLOW = { hosts: [{ host: 'ok.ping-devops.com', reason: 'test' }], uuids: [{ value: '11111111-1111-4111-8111-111111111111', reason: 'test' }] };

function repo(files, { list } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-gate-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'forbidden-allowlist.json'), JSON.stringify(ALLOW));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); }
  const env = {};
  if (list !== undefined) { env.FORBIDDEN_STRINGS_FILE = path.join(root, '..', `${path.basename(root)}.list`); fs.writeFileSync(env.FORBIDDEN_STRINGS_FILE, list); }
  const out = []; const err = [];
  const run = (extraEnv = {}) => main({ env: { ...env, ...extraEnv }, root, trackedFiles: Object.keys(files), out: (s) => out.push(s), err: (s) => err.push(s) });
  return { run, out, err };
}

test('passes on clean files and a configured list', () => {
  const t = repo({ 'a.js': 'hello\n' }, { list: '# comment\nsecret-corp\n' });
  assert.equal(t.run(), 0);
});

test('fails on a planted forbidden string (case-insensitive) and reports line and entry, not the value', () => {
  const t = repo({ 'a.js': 'x\nsee Secret-Corp here\n' }, { list: 'secret-corp\n' });
  assert.equal(t.run(), 1);
  assert.match(t.err[0], /a\.js:2 {2}forbidden-string {2}entry #1/);
  assert.ok(!t.err.join('\n').toLowerCase().includes('secret-corp'));
});

test('not configured: notice and exit 0 locally, exit 1 when CI=true', () => {
  const t = repo({ 'a.js': 'hello\n' });
  assert.equal(t.run(), 0);
  assert.match(t.out[0], /not configured/);
  assert.equal(t.run({ CI: 'true' }), 1);
  assert.match(t.err[0], /cannot be skipped/);
});

test('an empty or unreadable list fails', () => {
  assert.equal(repo({ 'a.js': 'x' }, { list: '\n# nothing\n' }).run(), 1);
  const t = repo({ 'a.js': 'x' });
  assert.equal(t.run({ FORBIDDEN_STRINGS_FILE: '/nonexistent/list' }), 1);
});

test('UUIDs in docs fail unless allowlisted; UUIDs in code are ignored', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  assert.equal(repo({ 'docs/g.md': `env ${id}\n` }).run(), 1);
  assert.equal(repo({ 'README.md': `env ${id}\n` }).run(), 1);
  assert.equal(repo({ '.env.example': `X=${id}\n` }).run(), 1);
  assert.equal(repo({ 'web/mock.js': `jti: "${id}"\n` }).run(), 0);
  assert.equal(repo({ 'docs/g.md': 'env 11111111-1111-4111-8111-111111111111\n' }).run(), 0);
});

test('private hostnames fail unless allowlisted', () => {
  const bad = repo({ 'server/config.js': "url: 'https://acme-pf.ping-devops.com'\n" });
  assert.equal(bad.run(), 1);
  assert.match(bad.err[0], /private-host {2}acme-pf\.ping-devops\.com/);
  assert.equal(repo({ 'server/config.js': "url: 'https://ok.ping-devops.com'\n" }).run(), 0);
});

test('binary files are skipped', () => {
  const t = repo({ 'x.bin': 'abc\0 acme-pf.ping-devops.com' });
  assert.equal(t.run(), 0);
});
