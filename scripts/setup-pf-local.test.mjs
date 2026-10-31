import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runSetup, SETUP_MODES } from './setup-lib.mjs';
import { mergeShared, PF_ADMIN_ORIGIN, PF_RUNTIME_URL, readPfAdmin } from './setup-pf-local.mjs';

const EXAMPLE = '# example\nSESSION_SECRET=\nPF_URL=https://pf.example.invalid\n';
const PASSWORD = 'pw-for-tests-only-7f3a';
const here = path.dirname(new URL(import.meta.url).pathname);

function fixture({ installer = 0, configure = {}, doctorCode = 0, provisioning, answers = [], leak = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-pflocal-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.config', 'demo-kit'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env.example'), EXAMPLE);
  const prov = path.join(home, '.config', 'demo-kit', 'provisioning.json');
  if (provisioning !== null) {
    fs.writeFileSync(prov, JSON.stringify(provisioning ?? { other: { keep: 1 }, pingfederate: { adminUrl: PF_ADMIN_ORIGIN, username: 'administrator', password: PASSWORD } }), { mode: 0o600 });
  }
  const shared = path.join(home, 'Development', '.env');
  const log = []; const err = []; const calls = []; const asked = [];
  let n = 0;
  const io = {
    log: (...l) => log.push(...l),
    err: (l) => err.push(l),
    ask: async (q, def) => { asked.push(q); return answers.shift() ?? def; },
    askSecret: async () => '',
  };
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ argv: [cmd, ...args], opts });
    const script = path.basename(args[0] ?? '');
    if (script === 'pingfederate-setup.sh') return { code: installer, stdout: '', stderr: '' };
    if (script === 'doctor.mjs') return { code: doctorCode, stdout: 'Doctor (stub)\n', stderr: '' };
    const code = configure[script] ?? 0;
    return { code, stdout: `  ok   ${script}${leak ? ` echoed ${opts.env?.PF_ADMIN_PASSWORD}` : ''}\n`, stderr: leak ? `boom ${opts.env?.PF_ADMIN_PASSWORD}\n` : '' };
  };
  const rand = () => `generated${++n}`.padEnd(32, 'x');
  const run = (argv, env = {}) => runSetup({ argv, env: { HOME: home, ...env }, root, home, io, fs: { existsSync: fs.existsSync, ...fs.promises }, exec, rand });
  const out = () => [...log, ...err].join('\n');
  return { root, home, shared, prov, log, err, calls, asked, run, out, sharedText: () => fs.readFileSync(shared, 'utf8') };
}

test('pf-local is a setup mode', () => {
  assert.ok(SETUP_MODES.includes('pf-local'));
});

test('pf-local happy path: installer with the terminal, then both configure scripts with the login in their environment only', async () => {
  const t = fixture();
  const r = await t.run(['--yes', '--mode=pf-local', '--users=kit-user@pingone.com']);
  assert.equal(r.code, 0);
  assert.deepEqual(t.calls.map((c) => path.basename(c.argv[1])), ['pingfederate-setup.sh', 'configure-signin.js', 'configure-local-signin.js', 'doctor.mjs']);
  const [installer, signin, local, doctor] = t.calls;
  assert.equal(installer.argv[0], 'bash');
  assert.equal(installer.opts.stdio, 'inherit');
  assert.equal(installer.opts.env.PF_ADMIN_PORT, '4731');
  assert.equal(installer.opts.env.PF_ENGINE_PORT, '4732');
  assert.deepEqual(signin.argv.slice(2), ['--local']);
  assert.deepEqual(local.argv.slice(2), ['--users=kit-user@pingone.com']);
  for (const c of [signin, local]) {
    assert.equal(c.opts.env.PF_ADMIN_URL, PF_ADMIN_ORIGIN);
    assert.equal(c.opts.env.PF_ADMIN_USER, 'administrator');
    assert.equal(c.opts.env.PF_ADMIN_PASSWORD, PASSWORD);
    assert.equal(c.opts.env.PF_ADMIN_INSECURE_TLS, 'true');
    assert.equal(c.opts.env.PF_SETTINGS_FILE, t.shared);
  }
  assert.deepEqual(doctor.argv.slice(2), ['--mode=pf-as']);
  assert.equal(doctor.opts.env, undefined);
  assert.ok(!t.calls.some((c) => c.argv.join(' ').includes(PASSWORD)), 'the password is on no command line');
});

test('pf-local writes the shared file (mode 600) and not the repo .env; no admin key reaches it', async () => {
  const t = fixture();
  await t.run(['--yes', '--mode=pf-local', '--users=kit-user@pingone.com']);
  const text = t.sharedText();
  assert.match(text, new RegExp(`^PF_URL=${PF_RUNTIME_URL}$`, 'm'));
  assert.match(text, /^SESSION_SECRET=generated\d+x+$/m);
  assert.match(text, /^REGISTRATION_KEY=generated/m);
  assert.match(text, /^ID_JAG_REGISTRY_TOKEN=generated/m);
  assert.match(text, /^RESOURCE_AS_CLIENT_SECRET=generated/m);
  assert.match(text, /^MCP_URL=http:\/\/localhost:9090\/mcp$/m);
  assert.ok(!/PF_ADMIN_(USER|PASSWORD)/.test(text));
  assert.ok(!text.includes(PASSWORD));
  assert.equal(fs.statSync(t.shared).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(t.root, '.env')));
});

test('STANDALONE_ENV moves the shared file', async () => {
  const t = fixture();
  const elsewhere = path.join(t.root, 'elsewhere', 'settings.env');
  await t.run(['--yes', '--mode=pf-local', '--users=kit-user@pingone.com'], { STANDALONE_ENV: elsewhere });
  assert.match(fs.readFileSync(elsewhere, 'utf8'), /^PF_URL=/m);
  assert.ok(!fs.existsSync(t.shared));
  assert.equal(t.calls[1].opts.env.PF_SETTINGS_FILE, elsewhere);
});

test('the admin password appears in no log or error line, even when a child echoes it', async () => {
  const t = fixture({ leak: true });
  const r = await t.run(['--yes', '--mode=pf-local', '--users=kit-user@pingone.com']);
  assert.equal(r.code, 0);
  assert.ok(t.out().includes('echoed ***'), 'the child output is shown, scrubbed');
  assert.ok(!t.out().includes(PASSWORD));
  const failed = fixture({ leak: true, configure: { 'configure-signin.js': 1 } });
  await failed.run(['--yes', '--mode=pf-local']);
  assert.ok(!failed.out().includes(PASSWORD));
});

test('second run (existing install): keeps every key it does not own and its own generated values, adds nothing', async () => {
  const t = fixture();
  fs.mkdirSync(path.dirname(t.shared), { recursive: true });
  fs.writeFileSync(t.shared, '# mine\nPINGONE_ENVIRONMENT_ID=env-1\nSESSION_SECRET=keepme\nOTHER_APP_KEY=abc\n', { mode: 0o644 });
  assert.equal((await t.run(['--yes', '--mode=pf-local', '--users=kit-user@pingone.com'])).code, 0);
  const first = t.sharedText();
  assert.match(first, /^# mine$/m);
  assert.match(first, /^PINGONE_ENVIRONMENT_ID=env-1$/m);
  assert.match(first, /^OTHER_APP_KEY=abc$/m);
  assert.match(first, /^SESSION_SECRET=keepme$/m, 'a value already there is not replaced');
  assert.equal(fs.statSync(t.shared).mode & 0o777, 0o600);
  t.log.length = 0;
  assert.equal((await t.run(['--yes', '--mode=pf-local', '--users=kit-user@pingone.com'])).code, 0);
  assert.equal(t.sharedText(), first, 'a rerun leaves the file byte for byte the same');
  assert.match(t.log.join('\n'), /nothing to add/);
});

test('an existing repo .env does not stop pf-local (it writes the shared file instead)', async () => {
  const t = fixture();
  fs.writeFileSync(path.join(t.root, '.env'), 'MINE=1\n');
  assert.equal((await t.run(['--yes', '--mode=pf-local', '--users=kit-user@pingone.com'])).code, 0);
  assert.equal(fs.readFileSync(path.join(t.root, '.env'), 'utf8'), 'MINE=1\n');
});

test('installer failing: stops at once, changes nothing, runs no configure script', async () => {
  const t = fixture({ installer: 1 });
  const r = await t.run(['--yes', '--mode=pf-local', '--users=kit-user@pingone.com']);
  assert.equal(r.code, 1);
  assert.deepEqual(t.calls.map((c) => path.basename(c.argv[1])), ['pingfederate-setup.sh']);
  assert.match(t.err.join('\n'), /did not finish \(exit 1\)/);
  assert.ok(!fs.existsSync(t.shared));
});

test('the real installer script refuses with a clear message when there is no license (no network, no docker)', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-stub-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  // curl answers "000" (nothing listening); docker is "running" and has no containers.
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nprintf 000\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const r = spawnSync('bash', [path.join(here, 'pingfederate-setup.sh')], {
    encoding: 'utf8', input: '',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, PF_LICENSE_FILE: path.join(dir, 'missing.lic') },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No license at /);
  assert.ok(!fs.existsSync(path.join(dir, '.config')), 'nothing saved');
});

test('no saved PingFederate login, or one that is not the local admin: refuse before any configure script runs', async () => {
  const none = fixture({ provisioning: { other: {} } });
  assert.equal((await none.run(['--yes', '--mode=pf-local'])).code, 1);
  assert.match(none.err.join('\n'), /no usable "pingfederate" admin login/);
  const gone = fixture({ provisioning: null });
  assert.equal((await gone.run(['--yes', '--mode=pf-local'])).code, 1);
  // The other PingFederate on this machine (admin 9999) must never be configured, nor any non-loopback host.
  for (const adminUrl of ['https://127.0.0.1:9999', 'https://pf.example.invalid:4731', 'https://localhost:4731']) {
    const t = fixture({ provisioning: { pingfederate: { adminUrl, username: 'administrator', password: PASSWORD } } });
    assert.equal((await t.run(['--yes', '--mode=pf-local'])).code, 1, adminUrl);
    assert.deepEqual(t.calls.map((c) => path.basename(c.argv[1])), ['pingfederate-setup.sh']);
    assert.match(t.err.join('\n'), /only ever configures the local install on 4731/);
    assert.ok(!t.out().includes(PASSWORD));
  }
});

test('a failing configure script stops the run, names the script and its exit code, and says reruns are safe', async () => {
  const t = fixture({ configure: { 'configure-signin.js': 2 } });
  const r = await t.run(['--yes', '--mode=pf-local', '--users=kit-user@pingone.com']);
  assert.equal(r.code, 1);
  assert.deepEqual(t.calls.map((c) => path.basename(c.argv[1])), ['pingfederate-setup.sh', 'configure-signin.js']);
  assert.match(t.err.join('\n'), /configure-signin\.js failed \(exit 2\).*safe to rerun/);
});

test('a failing doctor makes pf-local exit 1', async () => {
  assert.equal((await fixture({ doctorCode: 1 }).run(['--yes', '--mode=pf-local', '--users=kit-user@pingone.com'])).code, 1);
});

test('users: interactive asks once; --yes without --users passes none (a rerun needs none)', async () => {
  const t = fixture({ answers: ['pf-local', 'a@pingone.com,b@pingone.com'] });
  assert.equal((await t.run([])).code, 0);
  assert.equal(t.asked.length, 2);
  assert.deepEqual(t.calls[2].argv.slice(2), ['--users=a@pingone.com,b@pingone.com']);
  const again = fixture();
  await again.run(['--yes', '--mode=pf-local']);
  assert.deepEqual(again.calls[2].argv.slice(2), []);
  assert.deepEqual(again.asked, []);
});

test('mergeShared: adds missing or empty keys, keeps set ones, overwrites only what it is told, never admin keys', () => {
  assert.equal(mergeShared('A=1\nB=\n', { A: '9', B: '2', C: '3' }), 'A=1\nB=2\nC=3\n');
  assert.equal(mergeShared('A=1\n', { A: '9' }, ['A']), 'A=9\n');
  assert.equal(mergeShared('A=1', { C: 'x$&y' }), 'A=1\nC=x$&y\n');
  assert.throws(() => mergeShared('', { PF_ADMIN_PASSWORD: 'x' }), /must not be written/);
  assert.throws(() => mergeShared('', { PF_ADMIN_USER: 'x' }), /must not be written/);
  assert.throws(() => mergeShared('', { A: 'x\ny' }), /line break/);
});

test('readPfAdmin errors never contain the password', async () => {
  const t = fixture({ provisioning: { pingfederate: { adminUrl: 'https://127.0.0.1:9999', username: 'u', password: PASSWORD } } });
  await assert.rejects(readPfAdmin({ fs: fs.promises, home: t.home }), (e) => !e.message.includes(PASSWORD));
});

test('the installer and the .env docs agree: admin keys are documented as env/provisioning only', () => {
  const example = fs.readFileSync(path.join(here, '..', '.env.example'), 'utf8');
  assert.match(example, /provisioning\.json/);
});

// pf-admin.js direct mode, in a child process because it reads process.env and argv when loaded.
const pfAdmin = path.join(here, '..', 'pingfederate', 'pf-admin.js');
const inChild = (code, env) => spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('pf-admin direct mode: no --ns needed, writeEnv goes to PF_SETTINGS_FILE (new file, mode 600), other keys kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-pfadmin-'));
  const file = path.join(dir, 'new.env');
  const r = inChild(`const pf = require(${JSON.stringify(pfAdmin)}); console.log(pf.setting('ns', null, 'ns')); pf.writeEnv({ A: '1' }); pf.writeEnv({ B: '2', A: '3' });`,
    { PF_ADMIN_URL: PF_ADMIN_ORIGIN, PF_SETTINGS_FILE: file });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'direct');
  assert.equal(fs.readFileSync(file, 'utf8'), 'B=2\nA=3\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('pf-admin direct mode talks to PF_ADMIN_URL, never kubectl, and refuses to run without a password', () => {
  const noPw = inChild(`require(${JSON.stringify(pfAdmin)}).adminApi('direct', '1')`, { PF_ADMIN_URL: PF_ADMIN_ORIGIN });
  assert.equal(noPw.status, 2);
  assert.match(noPw.stderr, /PF_ADMIN_PASSWORD is not/);
  assert.ok(!noPw.stderr.includes('kubectl'));
  // Port 1 refuses the connection; the point is the error is a connection error, not a missing kubectl.
  const r = inChild(`require(${JSON.stringify(pfAdmin)}).adminApi('direct', '1')('GET', '/version').then(() => process.exit(3), (e) => { console.log(e.code); })`,
    { PF_ADMIN_URL: 'https://127.0.0.1:1', PF_ADMIN_PASSWORD: PASSWORD, PF_ADMIN_INSECURE_TLS: 'true' });
  assert.equal(r.stdout.trim(), 'ECONNREFUSED');
});
