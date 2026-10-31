import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { checkDockerContext, IDPS, runSetup, setEnv } from './setup-lib.mjs';

const EXAMPLE = '# example\nSESSION_SECRET=\nID_JAG_REGISTRY_TOKEN=\nPF_URL=https://pf.example.com\nPF_EXCHANGE_CLIENT_ID=\nPF_EXCHANGE_CLIENT_SECRET=\nRESOURCE_AS_ISSUER=\nRESOURCE_AS_CLIENT_SECRET=\nMCP_URL=\nID_JAG_RESOURCE=\n';

function fixture({ docker = 'orbstack', doctorCode = 0, answers = [], secrets = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-setup-'));
  fs.writeFileSync(path.join(root, '.env.example'), EXAMPLE);
  const log = []; const err = []; const calls = []; const asked = [];
  let n = 0;
  const io = {
    log: (...l) => log.push(...l),
    err: (l) => err.push(l),
    ask: async (q, def) => { asked.push(q); return answers.shift() ?? def; },
    askSecret: async (q) => { asked.push(q); return secrets.shift() ?? ''; },
  };
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'docker') return { code: docker === null ? 127 : 0, stdout: `${docker}\n`, stderr: '' };
    return { code: doctorCode, stdout: 'Doctor (stub)\n', stderr: '' };
  };
  const rand = () => `generated${++n}`.padEnd(32, 'x');
  const run = (argv, env = {}) => runSetup({ argv, env, root, io, fs: { existsSync: fs.existsSync, ...fs.promises }, exec, rand });
  return { root, log, err, calls, asked, run, env: () => fs.readFileSync(path.join(root, '.env'), 'utf8') };
}

test('mock happy path: --yes writes .env with generated secrets, runs doctor, asks nothing, uses no network or docker', async () => {
  const t = fixture();
  const r = await t.run(['--yes', '--mode=mock']);
  assert.equal(r.code, 0);
  assert.deepEqual(t.asked, []);
  const env = t.env();
  assert.match(env, /^SESSION_SECRET=generated\d+x+$/m);
  assert.match(env, /^REGISTRATION_KEY=generated\d+x+$/m);
  assert.match(env, /^ID_JAG_REGISTRY_TOKEN=generated\d+x+$/m);
  assert.deepEqual(t.calls.map((c) => c[0]), ['node']);
  assert.match(t.calls[0].join(' '), /doctor\.mjs --mode=mock$/);
  assert.match(t.log.join('\n'), /Doctor \(stub\)/);
  assert.match(t.log.join('\n'), /npm run build && npm start/);
  assert.equal(fs.statSync(path.join(t.root, '.env')).mode & 0o777, 0o600);
});

test('interactive with no mode answer defaults to mock and asks only for the mode', async () => {
  const t = fixture();
  assert.equal((await t.run([])).code, 0);
  assert.equal(t.asked.length, 1);
  assert.match(t.env(), /^RESOURCE_AS_ISSUER=$/m);
});

test('refuses to clobber an existing .env', async () => {
  const t = fixture();
  fs.writeFileSync(path.join(t.root, '.env'), 'MINE=1\n');
  const r = await t.run(['--yes']);
  assert.equal(r.code, 1);
  assert.equal(t.env(), 'MINE=1\n');
  assert.match(t.err[0], /--force/);
  assert.deepEqual(t.calls, []);
});

test('--force saves .env.bak.<n> first, using the next free number', async () => {
  const t = fixture();
  fs.writeFileSync(path.join(t.root, '.env'), 'MINE=1\n');
  fs.writeFileSync(path.join(t.root, '.env.bak.1'), 'OLDER\n');
  assert.equal((await t.run(['--yes', '--force'])).code, 0);
  assert.equal(fs.readFileSync(path.join(t.root, '.env.bak.2'), 'utf8'), 'MINE=1\n');
  assert.equal(fs.readFileSync(path.join(t.root, '.env.bak.1'), 'utf8'), 'OLDER\n');
  assert.match(t.env(), /^SESSION_SECRET=generated/m);
});

test('--force leaves .env and its backup readable only by the owner, even if the old .env was world-readable', { skip: process.platform === 'win32' }, async () => {
  const t = fixture();
  fs.writeFileSync(path.join(t.root, '.env'), 'MINE=1\n', { mode: 0o644 });
  fs.chmodSync(path.join(t.root, '.env'), 0o644);
  assert.equal((await t.run(['--yes', '--force'])).code, 0);
  assert.equal(fs.statSync(path.join(t.root, '.env')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(t.root, '.env.bak.1')).mode & 0o777, 0o600);
});

test('.env backups are ignored by git and docker, so --force cannot stage or bake in real secrets', () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  assert.equal(spawnSync('git', ['check-ignore', '-q', '.env.bak.1'], { cwd: repo }).status, 0);
  assert.match(fs.readFileSync(path.join(repo, '.dockerignore'), 'utf8'), /^\.env\.bak\.\*$/m);
});

test('generated and supplied secrets are never printed', async () => {
  const t = fixture();
  await t.run(['--yes', '--mode=pf-as', '--pf-client-id=cid'], { PF_EXCHANGE_CLIENT_SECRET: 'hunter2-secret' });
  const out = [...t.log, ...t.err].join('\n');
  assert.ok(!/generated\d/.test(out));
  assert.ok(!out.includes('hunter2-secret'));
  const env = t.env();
  assert.match(env, /^PF_EXCHANGE_CLIENT_SECRET=hunter2-secret$/m);
  assert.match(env, /^PF_EXCHANGE_CLIENT_ID=cid$/m);
  assert.match(env, /^RESOURCE_AS_CLIENT_SECRET=generated/m);
  assert.match(env, /^MCP_URL=http:\/\/localhost:9090\/mcp$/m);
});

test('pf-as asks for PF settings (secret via askSecret); admin password only when an admin URL is given', async () => {
  const t = fixture({ answers: ['pf-as', 'local', 'https://pf.test', 'cid', 'https://pf.test:9999'], secrets: ['xsecret', 'adminpw'] });
  assert.equal((await t.run([])).code, 0);
  assert.deepEqual(t.asked, ['Mode to configure (mock, pf-as, pf-pf, byo, pf-local)', 'Sign-in', 'PingFederate base URL', 'PingFederate exchange client id', 'PingFederate exchange client secret', 'PingFederate admin URL (blank to skip the admin checks)', 'PingFederate admin password']);
  assert.match(t.env(), /^PF_ADMIN_PASSWORD=adminpw$/m);
  const none = fixture({ answers: ['pf-as', 'local', 'https://pf.test', 'cid', ''], secrets: ['xsecret'] });
  await none.run([]);
  assert.ok(!none.asked.includes('PingFederate admin password'));
});

test('PingOne and AIC are listed as unavailable with a reason, and refused', async () => {
  const t = fixture();
  for (const id of ['pingone', 'aic']) {
    const r = await t.run(['--yes', '--mode=pf-as', `--idp=${id}`]);
    assert.equal(r.code, 2);
    assert.match(t.err.at(-1), new RegExp(IDPS.find((i) => i.id === id).reason.slice(0, 20)));
  }
  assert.match(t.log.join('\n'), /pingone .*\(unavailable: the PingOne hop is a redirect/);
  assert.match(t.log.join('\n'), /aic .*\(unavailable: AIC sign-in waits for pi\.flow/);
  assert.ok(!fs.existsSync(path.join(t.root, '.env')));
});

test('docker: Docker Desktop context is refused with the switch command; orbstack passes', async () => {
  const bad = fixture({ docker: 'desktop-linux' });
  const r = await bad.run(['--yes', '--run=docker']);
  assert.equal(r.code, 1);
  assert.match(bad.err[0], /docker context use orbstack/);
  assert.ok(!bad.calls.some((c) => c[0] === 'open'));
  assert.ok(!fs.existsSync(path.join(bad.root, '.env')));
  const ok = fixture();
  assert.equal((await ok.run(['--yes', '--run=docker'])).code, 0);
  assert.match(ok.log.join('\n'), /docker compose -f deploy\/docker-compose\.yml up/);
  assert.match(await checkDockerContext(async () => ({ code: 127, stdout: '' })), /OrbStack/);
});

test('npm runs never touch docker', async () => {
  const t = fixture({ docker: 'desktop-linux' });
  assert.equal((await t.run(['--yes'])).code, 0);
  assert.ok(!t.calls.some((c) => c[0] === 'docker'));
});

test('a failing doctor makes setup exit 1 after writing .env', async () => {
  const t = fixture({ doctorCode: 1 });
  assert.equal((await t.run(['--yes'])).code, 1);
  assert.ok(fs.existsSync(path.join(t.root, '.env')));
});

test('setEnv replaces or appends, and rejects line breaks', () => {
  assert.equal(setEnv('A=\nB=2\n', 'A', 'x$&y'), 'A=x$&y\nB=2\n');
  assert.equal(setEnv('A=1', 'C', '3'), 'A=1\nC=3\n');
  assert.throws(() => setEnv('A=', 'A', 'x\ny'));
});
