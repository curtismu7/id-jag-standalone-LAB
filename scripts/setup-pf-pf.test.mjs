// npm run setup -- --mode=pf-pf [--acme-settings=<file>]: the owner's three-key block, the shared settings file, the redeemer chain.
// Prompting, the filesystem and process spawning are real temp files and stubs; nothing reaches PingFederate or Docker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runSetup } from './setup-lib.mjs';
import { ACME_KEYS, missingMessage, parseAcmeSettings } from './setup-pf-pf.mjs';
import { PF_ADMIN_ORIGIN, PF_RUNTIME_URL } from './setup-pf-local.mjs';

const ACME_URL = 'https://pf-acme.example.invalid';
const ACME_SECRET = 'acme-client-secret-for-tests-9c1e';
const PASSWORD = 'pw-for-tests-only-7f3a';
const BLOCK = `ACME_PF_URL=${ACME_URL}\nACME_EXCHANGE_CLIENT_ID=id-jag-kit-acme\nACME_EXCHANGE_CLIENT_SECRET=${ACME_SECRET}\n`;

function fixture({ shared = `# shared\nOTHER_APP=keep\nPF_URL=${PF_RUNTIME_URL}\n`, redeemerCode = 0, doctorCode = 0, leak = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-pfpf-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.config', 'demo-kit'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'demo-kit', 'provisioning.json'),
    JSON.stringify({ pingfederate: { adminUrl: PF_ADMIN_ORIGIN, username: 'administrator', password: PASSWORD } }), { mode: 0o600 });
  const sharedFile = path.join(home, 'Development', '.env');
  fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
  if (shared !== null) fs.writeFileSync(sharedFile, shared, { mode: 0o600 });
  const block = path.join(root, 'acme-block.env');
  const writeBlock = (text = BLOCK, mode = 0o600) => { fs.writeFileSync(block, text); fs.chmodSync(block, mode); };
  const log = []; const err = []; const calls = [];
  const io = { log: (...l) => log.push(...l), err: (l) => err.push(l), ask: async (q, d) => d, askSecret: async () => '' };
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ argv: [cmd, ...args], opts });
    const script = path.basename(args[0] ?? '');
    if (script === 'doctor.mjs') return { code: doctorCode, stdout: 'Doctor (stub)\n', stderr: '' };
    return { code: redeemerCode, stdout: leak ? `echo ${opts.env?.PF_ADMIN_PASSWORD} ${ACME_SECRET}\n` : 'ok\n', stderr: '' };
  };
  const run = (argv, env = {}) => runSetup({ argv, env: { HOME: home, ...env }, root, home, io, fs: { existsSync: fs.existsSync, ...fs.promises }, exec });
  return { root, home, sharedFile, block, writeBlock, log, err, calls, run, out: () => [...log, ...err].join('\n'), sharedText: () => fs.readFileSync(sharedFile, 'utf8') };
}

test('pf-pf is a setup mode with its own flow', async () => {
  const t = fixture();
  t.writeBlock();
  const r = await t.run(['--mode=pf-pf', `--acme-settings=${t.block}`]);
  assert.equal(r.code, 0, t.out());
  assert.deepEqual(t.calls.map((c) => path.basename(c.argv[1])), ['configure-pf-redeemer.js', 'doctor.mjs']);
  assert.ok(!t.calls.some((c) => c.argv.some((a) => a.includes('.env.example'))));
});

test('the three keys are merged into the shared file (mode 600), other lines are kept, the file is deleted, no value is printed', async () => {
  const t = fixture();
  t.writeBlock();
  const r = await t.run(['--mode=pf-pf', `--acme-settings=${t.block}`]);
  assert.equal(r.code, 0);
  const text = t.sharedText();
  assert.match(text, /^OTHER_APP=keep$/m);
  assert.match(text, new RegExp(`^PF_URL=${PF_RUNTIME_URL}$`, 'm'));
  assert.match(text, new RegExp(`^ACME_PF_URL=${ACME_URL}$`, 'm'));
  assert.match(text, /^ACME_EXCHANGE_CLIENT_ID=id-jag-kit-acme$/m);
  assert.match(text, new RegExp(`^ACME_EXCHANGE_CLIENT_SECRET=${ACME_SECRET}$`, 'm'));
  assert.equal(fs.statSync(t.sharedFile).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(t.block), false, 'the block file is deleted after the merge');
  assert.ok(!t.out().includes(ACME_SECRET) && !t.out().includes(ACME_URL), 'no value is printed');
  assert.match(t.out(), /values not shown/);
});

test('a re-issued block replaces the old values (rotation)', async () => {
  const t = fixture({ shared: `PF_URL=${PF_RUNTIME_URL}\nACME_PF_URL=https://old.example.invalid\nACME_EXCHANGE_CLIENT_ID=old\nACME_EXCHANGE_CLIENT_SECRET=old-secret\n` });
  t.writeBlock();
  await t.run(['--mode=pf-pf', `--acme-settings=${t.block}`]);
  const text = t.sharedText();
  assert.match(text, new RegExp(`^ACME_EXCHANGE_CLIENT_SECRET=${ACME_SECRET}$`, 'm'));
  assert.ok(!text.includes('old-secret'));
  assert.equal(text.match(/^ACME_PF_URL=/gm).length, 1);
});

test('the redeemer runs with the admin login and the shared file in its environment only', async () => {
  const t = fixture();
  t.writeBlock();
  await t.run(['--mode=pf-pf', `--acme-settings=${t.block}`]);
  const [redeemer, doctor] = t.calls;
  assert.equal(redeemer.opts.env.PF_ADMIN_URL, PF_ADMIN_ORIGIN);
  assert.equal(redeemer.opts.env.PF_ADMIN_PASSWORD, PASSWORD);
  assert.equal(redeemer.opts.env.PF_ADMIN_INSECURE_TLS, 'true');
  assert.equal(redeemer.opts.env.PF_SETTINGS_FILE, t.sharedFile);
  assert.ok(!t.calls.some((c) => c.argv.join(' ').includes(PASSWORD) || c.argv.join(' ').includes(ACME_SECRET)), 'no secret on a command line');
  assert.deepEqual(doctor.argv.slice(2), ['--mode=pf-pf']);
  assert.ok(!/PF_ADMIN_(USER|PASSWORD)/.test(t.sharedText()), 'no admin key reaches the shared file');
});

test('a block with any other key is refused, naming the key but never a value, and nothing changes', async () => {
  const t = fixture();
  const before = t.sharedText();
  t.writeBlock(`${BLOCK}ACME_AGENT_SECRET=the-agent-secret-value\nPF_ADMIN_PASSWORD=admin-pw-value\n`);
  const r = await t.run(['--mode=pf-pf', `--acme-settings=${t.block}`]);
  assert.equal(r.code, 2);
  assert.match(t.err.join('\n'), /ACME_AGENT_SECRET is not one of the three accepted keys/);
  assert.match(t.err.join('\n'), /PF_ADMIN_PASSWORD is not one of the three accepted keys/);
  assert.ok(!t.out().includes('the-agent-secret-value') && !t.out().includes('admin-pw-value') && !t.out().includes(ACME_SECRET));
  assert.equal(t.sharedText(), before, 'the shared file is untouched');
  assert.equal(fs.existsSync(t.block), true, 'and the block file is left for the user to fix');
  assert.deepEqual(t.calls, []);
});

test('parseAcmeSettings: problems are listed without values; a key that is not a variable name is not echoed', () => {
  assert.deepEqual(parseAcmeSettings(`# note\n\n${BLOCK}`), { ACME_PF_URL: ACME_URL, ACME_EXCHANGE_CLIENT_ID: 'id-jag-kit-acme', ACME_EXCHANGE_CLIENT_SECRET: ACME_SECRET });
  assert.equal(parseAcmeSettings(`ACME_PF_URL="${ACME_URL}/"\nACME_EXCHANGE_CLIENT_ID=a\nACME_EXCHANGE_CLIENT_SECRET=b\n`).ACME_PF_URL, ACME_URL, 'quotes and a trailing slash are tolerated');
  const bad = (text) => { try { parseAcmeSettings(text); } catch (e) { return e.message; } return ''; };
  assert.match(bad('just-a-secret-pasted-alone\n'), /line 1 is not KEY=value/);
  assert.ok(!bad('just-a-secret-pasted-alone\n').includes('just-a-secret'));
  assert.match(bad(`${BLOCK}weird key=sekret\n`), /line 4: that key is not one of the three/);
  assert.ok(!bad(`${BLOCK}weird key=sekret\n`).includes('weird') && !bad(`${BLOCK}weird key=sekret\n`).includes('sekret'));
  assert.match(bad(`${BLOCK}ACME_PF_URL=${ACME_URL}\n`), /ACME_PF_URL appears twice/);
  assert.match(bad(`ACME_PF_URL=${ACME_URL}\n`), /ACME_EXCHANGE_CLIENT_ID is missing[\s\S]*ACME_EXCHANGE_CLIENT_SECRET is missing/);
  assert.match(bad(BLOCK.replace('ACME_EXCHANGE_CLIENT_ID=id-jag-kit-acme', 'ACME_EXCHANGE_CLIENT_ID=')), /ACME_EXCHANGE_CLIENT_ID is empty/);
  for (const url of ['http://pf-acme.example.invalid', 'https://user:pw@pf-acme.example.invalid', 'https://pf-acme.example.invalid/path', 'https://pf-acme.example.invalid?x=1']) {
    assert.match(bad(BLOCK.replace(ACME_URL, url)), /ACME_PF_URL must be an https origin/, url);
    assert.ok(!bad(BLOCK.replace(ACME_URL, url)).includes('pw'));
  }
  assert.match(bad(BLOCK.replace(`=${ACME_SECRET}`, '=two words')), /whitespace/);
});

test('the block file must be a regular file in mode 600', async () => {
  const t = fixture();
  t.writeBlock(BLOCK, 0o644);
  assert.equal((await t.run(['--mode=pf-pf', `--acme-settings=${t.block}`])).code, 2);
  assert.match(t.err.join('\n'), /readable by others \(mode 644\): run chmod 600/);
  assert.equal(fs.existsSync(t.block), true);
  assert.deepEqual(t.calls, []);
  const missing = fixture();
  assert.equal((await missing.run(['--mode=pf-pf', `--acme-settings=${missing.block}`])).code, 2);
  assert.match(missing.err.join('\n'), /does not exist/);
  const link = fixture();
  link.writeBlock();
  const target = `${link.block}.real`; fs.renameSync(link.block, target); fs.symlinkSync(target, link.block);
  assert.equal((await link.run(['--mode=pf-pf', `--acme-settings=${link.block}`])).code, 2);
  assert.match(link.err.join('\n'), /not a regular file/);
  const bare = fixture();
  assert.equal((await bare.run(['--mode=pf-pf', '--acme-settings'])).code, 2);
});

test('without the flag it says exactly what is missing and who provides it, and changes nothing', async () => {
  const t = fixture();
  const r = await t.run(['--mode=pf-pf']);
  assert.equal(r.code, 1);
  const out = t.err.join('\n');
  for (const k of ACME_KEYS) assert.ok(out.includes(k), k);
  assert.match(out, /owner of the shared Acme PingFederate/);
  assert.match(out, /three-key|one settings block/);
  assert.match(out, /acme-user\s+password separately/);
  assert.match(out, /chmod 600/);
  assert.match(out, /--acme-settings=/);
  assert.match(out, /outside-agent\.js/);
  assert.deepEqual(t.calls, []);
  assert.ok(!t.sharedText().includes('ACME_'));
});

test('without the flag but with the keys already in the shared file, it reruns the redeemer setup', async () => {
  const t = fixture({ shared: `PF_URL=${PF_RUNTIME_URL}\n${BLOCK}` });
  const r = await t.run(['--mode=pf-pf']);
  assert.equal(r.code, 0, t.out());
  assert.equal(path.basename(t.calls[0].argv[1]), 'configure-pf-redeemer.js');
});

test('the local PingFederate must be set up first, and a block is not consumed before that', async () => {
  const t = fixture({ shared: 'OTHER_APP=keep\n' });
  t.writeBlock();
  const r = await t.run(['--mode=pf-pf', `--acme-settings=${t.block}`]);
  assert.equal(r.code, 1);
  assert.match(t.err.join('\n'), /--mode=pf-local first/);
  assert.equal(fs.existsSync(t.block), true, 'the block file is kept');
  assert.ok(!t.sharedText().includes('ACME_'));
  const none = fixture({ shared: 'OTHER_APP=keep\n' });
  await none.run(['--mode=pf-pf']);
  assert.match(none.err.join('\n'), /--mode=pf-pf --acme-settings/);
  assert.match(none.err.join('\n'), /pf-local first/);
});

test('a failing redeemer setup is reported, with the block already merged and deleted (it is safe to rerun)', async () => {
  const t = fixture({ redeemerCode: 1 });
  t.writeBlock();
  const r = await t.run(['--mode=pf-pf', `--acme-settings=${t.block}`]);
  assert.equal(r.code, 1);
  assert.match(t.err.join('\n'), /configure-pf-redeemer\.js failed \(exit 1\).*safe to rerun/);
  assert.match(t.sharedText(), /^ACME_PF_URL=/m);
  assert.equal(fs.existsSync(t.block), false);
  assert.equal(t.calls.length, 1, 'doctor does not run after a failure');
});

test('child output that echoes a secret is scrubbed', async () => {
  const t = fixture({ leak: true });
  t.writeBlock();
  await t.run(['--mode=pf-pf', `--acme-settings=${t.block}`]);
  assert.ok(!t.out().includes(PASSWORD) && !t.out().includes(ACME_SECRET));
  assert.match(t.out(), /\*\*\*/);
});

test('missingMessage lists only what is missing and never a value', () => {
  const m = missingMessage(['ACME_EXCHANGE_CLIENT_SECRET'], 'block.env').join('\n');
  assert.match(m, /ACME_EXCHANGE_CLIENT_SECRET {3}\(missing\)/);
  assert.ok(!/ACME_PF_URL {3}\(missing\)/.test(m));
});

test('a block that names this machine\'s own PingFederate is refused before anything is merged or deleted', async () => {
  const bad = (url) => { try { parseAcmeSettings(BLOCK.replace(ACME_URL, url)); } catch (e) { return e.message; } return ''; };
  for (const url of ['https://127.0.0.1:4732', 'https://localhost:9031', 'https://127.1.2.3', 'https://0.0.0.0:4732']) assert.match(bad(url), /names this machine/, url);
  assert.equal(bad('https://pf-acme.example.invalid:9031'), '', 'another host on the same port is fine');
  const t = fixture();
  t.writeBlock(BLOCK.replace(ACME_URL, PF_RUNTIME_URL));
  const before = t.sharedText();
  assert.equal((await t.run(['--mode=pf-pf', `--acme-settings=${t.block}`])).code, 2);
  assert.equal(t.sharedText(), before, 'nothing merged');
  assert.equal(fs.existsSync(t.block), true, 'the block file is kept');
  assert.deepEqual(t.calls, []);
});

test('a block file over 4 KiB is refused without being read whole, and many problems are summarised', async () => {
  const t = fixture();
  t.writeBlock('x\n'.repeat(3000));
  assert.equal((await t.run(['--mode=pf-pf', `--acme-settings=${t.block}`])).code, 2);
  assert.match(t.err.join('\n'), /is 6000 bytes: a settings block is three short lines/);
  assert.equal(fs.existsSync(t.block), true);
  try { parseAcmeSettings('x\n'.repeat(500)); assert.fail('should throw'); } catch (e) {
    assert.match(e.message, /\.\.\.and \d+ more/);
    assert.ok(e.message.split('\n').length < 20);
  }
});

test('a client secret with "#" is refused: the settings file loader would cut it at the "#"', () => {
  assert.throws(() => parseAcmeSettings(BLOCK.replace(ACME_SECRET, 'ab#cd')), /contains "#"/);
  try { parseAcmeSettings(BLOCK.replace(ACME_SECRET, 'ab#cd')); } catch (e) { assert.ok(!e.message.includes('ab#cd')); }
});
