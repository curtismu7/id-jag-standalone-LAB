import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import router from '../doctorRoute.js';
import * as doctor from '../doctor.js';
import pfLocal from '../idp/pf-local.js';
import { _clearProbeCache } from '../idJagPlayground.js';

const SECRETS = { PF_EXCHANGE_CLIENT_SECRET: 'sentinel-exchange-secret', RESOURCE_AS_CLIENT_SECRET: 'sentinel-ras-secret', ID_JAG_REGISTRY_TOKEN: 'sentinel-registry-token',
  SESSION_SECRET: 'sentinel-session-secret-value', REGISTRATION_KEY: 'sentinel-registration-key', PF_ADMIN_PASSWORD: 'sentinel-admin-password' };
const GOOD = {
  PF_URL: 'https://pf.test', PF_EXCHANGE_CLIENT_ID: 'kit', RESOURCE_AS_ISSUER: 'http://ras.test', ID_JAG_RESOURCE: 'http://mcp.test/mcp',
  MCP_URL: 'http://mcp.test/mcp', ADMIN_EMAILS: 'boss@pingidentity.com', PORT: '18999', ...SECRETS,
};
const KEYS = [...new Set([...Object.keys(GOOD), 'DATA_DIR', 'PF_ADMIN_URL', 'ACME_PF_URL', 'ACME_EXCHANGE_CLIENT_ID', 'ACME_EXCHANGE_CLIENT_SECRET', 'PF_REDEEMER_CLIENT_SECRET', 'PF_RESOURCE', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'])];
const saved = {};
let dir;

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
  process.env.DATA_DIR = path.join(dir, 'data');
  _clearProbeCache();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(dir, { recursive: true, force: true });
});
const setEnv = (o) => Object.assign(process.env, o);
const ok = (data, status = 200) => ({ status, json: async () => data });
// A fake network: discovery documents by URL, everything else 200.
const net_ = (issuer = 'https://pf.test') => vi.fn(async (url) => {
  if (String(url) === 'https://pf.test/.well-known/openid-configuration') return ok({ issuer });
  if (String(url).endsWith('/pf/JWKS')) return ok({ keys: [{ kty: 'RSA', n: 'a', e: 'AQAB', x5t: 't' }] });
  return ok({});
});
const freePort = { createServer: () => { const h = {}; return { once: (e, f) => { h[e] = f; }, listen: () => setTimeout(() => h.listening?.(), 0), close: (cb) => cb() }; } };
const takenPort = { createServer: () => { const h = {}; return { once: (e, f) => { h[e] = f; }, listen: () => setTimeout(() => h.error?.(new Error('EADDRINUSE')), 0), close: (cb) => cb() }; } };
const get = (rep, id) => rep.checks.find((c) => c.id === id);

// The PF admin slice now lives in the pf-local adapter (idp.doctor).
const checkPfAdmin = (env, adminCall) => pfLocal.doctor({ env, adminCall });

describe('individual checks', () => {
  it('node: passes on 26+, fails below with a fix', () => {
    expect(doctor.checkNode('26.1.0').status).toBe('pass');
    expect(doctor.checkNode('22.19.0').status).toBe('fail');
    const f = doctor.checkNode('20.19.0');
    expect(f.status).toBe('fail');
    expect(f.fix).toMatch(/Node 26/);
  });
  it('env file: mock does not need it, a real mode warns', () => {
    const none = { existsSync: () => false };
    expect(doctor.checkEnvFile('mock', '/x/.env', none).status).toBe('pass');
    expect(doctor.checkEnvFile('pf-as', '/x/.env', none).status).toBe('warn');
    expect(doctor.checkEnvFile('pf-as', '/x/.env', { existsSync: () => true }).status).toBe('pass');
  });
  it('required env: names exactly the unset variables', () => {
    const f = doctor.checkEnvRequired('pf-as', { MCP_URL: 'x' });
    expect(f.status).toBe('fail');
    expect(f.fix).toContain('PF_EXCHANGE_CLIENT_ID');
    expect(f.fix).not.toContain('MCP_URL');
    expect(doctor.checkEnvRequired('pf-as', GOOD).status).toBe('pass');
    expect(doctor.checkEnvRequired('pf-pf', {}).message).toContain('ACME_PF_URL');
    expect(doctor.checkEnvRequired('byo', {}).message).toContain('RESOURCE_AS_ISSUER');
  });
  it('sign-in client: fails without one, passes with the exchange client', () => {
    expect(doctor.checkSignin().status).toBe('fail');
    setEnv({ PF_EXCHANGE_CLIENT_ID: 'kit', PF_EXCHANGE_CLIENT_SECRET: 's' });
    expect(doctor.checkSignin().status).toBe('pass');
  });
  it('session secret, registration key and admins: warn when missing', () => {
    expect(doctor.checkSessionSecret({}).status).toBe('warn');
    expect(doctor.checkSessionSecret({ SESSION_SECRET: 'x'.repeat(20) }).status).toBe('pass');
    expect(doctor.checkRegistrationKey({}).fix).toContain('REGISTRATION_KEY');
    expect(doctor.checkRegistrationKey({ REGISTRATION_KEY: 'short' }).status).toBe('warn');
    expect(doctor.checkRegistrationKey({ REGISTRATION_KEY: 'k'.repeat(16) }).status).toBe('pass');
    expect(doctor.checkAccess({}).status).toBe('warn');
    expect(doctor.checkAccess({ ADMIN_EMAILS: 'a@b.c' }).status).toBe('pass');
  });
  it('data dir: writable passes, unwritable fails naming the directory', () => {
    expect(doctor.checkDataDir(path.join(dir, 'new', 'deep')).status).toBe('pass');
    const denied = { existsSync: () => true, accessSync: () => { throw new Error('EACCES'); }, constants: { W_OK: 2 } };
    const f = doctor.checkDataDir('/ro/data', denied);
    expect(f.status).toBe('fail');
    expect(f.fix).toContain('DATA_DIR');
  });
  it('port: free passes, taken fails with lsof hint (fake net)', async () => {
    expect((await doctor.checkPort(4720, freePort)).status).toBe('pass');
    const f = await doctor.checkPort(4720, takenPort);
    expect(f.status).toBe('fail');
    expect(f.fix).toContain('lsof -i :4720');
  });
  it('port: detects a really listening port', async () => {
    const s = net.createServer();
    await new Promise((res) => s.listen(0, res));
    const port = s.address().port;
    expect((await doctor.checkPort(port)).status).toBe('fail');
    await new Promise((res) => s.close(res));
    expect((await doctor.checkPort(port)).status).toBe('pass');
  });
  it('discovery: matches, mismatches byte for byte, non-2xx, unreachable', async () => {
    expect((await doctor.checkDiscovery('d', 'PF_URL', 'https://pf.test', net_())).status).toBe('pass');
    const bad = await doctor.checkDiscovery('d', 'PF_URL', 'https://pf.test', net_('https://pf.test/'));
    expect(bad.status).toBe('fail');
    expect(bad.message).toContain('https://pf.test/');
    expect(bad.fix).toContain('PF_URL');
    expect((await doctor.checkDiscovery('d', 'PF_URL', 'https://pf.test', async () => ok({}, 503))).message).toContain('HTTP 503');
    const down = await doctor.checkDiscovery('d', 'PF_URL', 'https://pf.test', async () => { throw Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }); });
    expect(down.status).toBe('fail');
    expect(down.message).toContain('ENOTFOUND');
  });
  it('discovery: a local issuer that differs gets advice that points at the PingFederate, not at PF_URL', async () => {
    const bad = await doctor.checkDiscovery('d', 'PF_URL', 'https://127.0.0.1:4732', async () => ok({ issuer: 'https://localhost:9031' }));
    expect(bad.status).toBe('fail');
    expect(bad.message).toContain('https://localhost:9031');
    expect(bad.fix).not.toContain('Set PF_URL to https://localhost:9031');
    expect(bad.fix).toContain('Do not change PF_URL');
    expect(bad.fix).toContain('setup -- --mode=pf-local');
    const remote = await doctor.checkDiscovery('d', 'PF_URL', 'https://pf.test', net_('https://pf.test/'));
    expect(remote.fix).toContain('Set PF_URL to exactly the issuer');
  });
  it('issuer JWKS (pf-as): one RSA key with x5t passes; none with x5t fails; two distinct warns; unreadable fails', async () => {
    const jwks = (keys, status = 200) => async () => ok({ keys }, status);
    const one = { kty: 'RSA', n: 'a', e: 'AQAB', x5t: 't' };
    expect((await doctor.checkIssuerJwks('j', 'https://pf.test', jwks([one, { ...one, kid: 'k2' }]))).status).toBe('pass');
    const none = await doctor.checkIssuerJwks('j', 'https://pf.test', jwks([{ kty: 'RSA', n: 'a', e: 'AQAB' }]));
    expect(none).toMatchObject({ status: 'fail', message: expect.stringContaining('no RSA key with x5t') });
    expect((await doctor.checkIssuerJwks('j', 'https://pf.test', jwks([one, { ...one, n: 'b', x5t: 'u' }]))).status).toBe('warn');
    expect((await doctor.checkIssuerJwks('j', 'https://pf.test', jwks([], 500))).message).toContain('HTTP 500');
    const down = await doctor.checkIssuerJwks('j', 'https://pf.test', async () => { throw Object.assign(new Error('x'), { cause: { code: 'CERT_HAS_EXPIRED' } }); });
    expect(down).toMatchObject({ status: 'fail', message: expect.stringContaining('CERT_HAS_EXPIRED') });
  });
  it('pf admin: skipped when unset; password missing, unreachable, 401, no validator, and good', async () => {
    expect(await checkPfAdmin({})).toEqual([]);
    const env = { PF_ADMIN_URL: 'https://pf:9999', PF_ADMIN_PASSWORD: 'p', PF_EXCHANGE_CLIENT_ID: 'kit' };
    expect((await checkPfAdmin({ PF_ADMIN_URL: 'x' }))[0].fix).toContain('PF_ADMIN_PASSWORD');
    expect((await checkPfAdmin(env, async () => { throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }); }))[0].message).toContain('ECONNREFUSED');
    expect((await checkPfAdmin(env, async () => ({ status: 401 })))[0].fix).toContain('PF_ADMIN_USER');
    const noVal = await checkPfAdmin(env, async (_m, p) => (p.includes('Validators') ? { status: 404 } : { status: 200, body: { allowAuthenticationApiInit: true } }));
    expect(get({ checks: noVal }, 'pf-validator')).toMatchObject({ status: 'fail', fix: expect.stringContaining('configure-local-signin') });
    const good = await checkPfAdmin(env, async (_m, p) => (p.includes('Validators') ? { status: 200 } : { status: 200, body: { allowAuthenticationApiInit: true } }));
    expect(good.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'warn']); // warn: pf-admin-account (default administrator, not production)
    const noPiFlow = await checkPfAdmin(env, async (_m, p) => (p.includes('Validators') ? { status: 200 } : { status: 200, body: { allowAuthenticationApiInit: false } }));
    expect(get({ checks: noPiFlow }, 'pi-flow-client').status).toBe('fail');
  });
  it('backends: up passes, down fails with how to start it', async () => {
    setEnv({ PF_URL: 'https://pf.test', RESOURCE_AS_ISSUER: 'http://ras.test', MCP_URL: 'http://mcp.test/mcp' });
    const up = await doctor.checkBackends('pf-as', async () => ok({}));
    expect(up.map((c) => [c.id, c.status])).toEqual([['resource-as', 'pass'], ['mcp', 'pass']]);
    const down = await doctor.checkBackends('pf-as', async (u) => { if (String(u).includes('mcp.test')) throw new Error('refused'); return ok({}); });
    expect(get({ checks: down }, 'mcp')).toMatchObject({ status: 'fail', fix: expect.stringContaining('mcp-sample') });
  });
});

describe('runDoctor', () => {
  it('mock mode passes offline with no .env', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network used'); });
    const rep = await doctor.runDoctor({ mode: 'mock', fetchImpl, netImpl: freePort });
    expect(rep.ok).toBe(true);
    expect(rep.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('a good pf-as setup has no failures', async () => {
    setEnv(GOOD);
    const rep = await doctor.runDoctor({ mode: 'pf-as', fetchImpl: net_(), netImpl: freePort, envFile: __filename, fsImpl: { ...fs, existsSync: () => true, accessSync: () => {} } });
    expect(rep.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(rep.ok).toBe(true);
  });
  it('pf-as checks the issuer\'s JWKS (live mode only), and pf-pf does not', async () => {
    setEnv(GOOD);
    const noX5t = async (url) => (String(url).endsWith('/pf/JWKS') ? ok({ keys: [{ kty: 'RSA', n: 'a', e: 'AQAB' }] }) : net_()(url));
    const rep = await doctor.runDoctor({ mode: 'pf-as', fetchImpl: noX5t, netImpl: freePort, envFile: __filename, fsImpl: { ...fs, existsSync: () => true, accessSync: () => {} } });
    expect(get(rep, 'pf-jwks').status).toBe('fail');
    expect(rep.ok).toBe(false);
    setEnv({ ...GOOD, ACME_PF_URL: 'https://acme.test' });
    expect(get(await doctor.runDoctor({ mode: 'pf-pf', fetchImpl: noX5t, netImpl: freePort }), 'pf-jwks')).toBeUndefined();
  });
  it('pf-pf also checks the Acme issuer', async () => {
    setEnv({ ...GOOD, ACME_PF_URL: 'https://acme.test' });
    const rep = await doctor.runDoctor({ mode: 'pf-pf', fetchImpl: net_(), netImpl: freePort });
    expect(get(rep, 'acme-discovery').status).toBe('fail');
  });
  it('a deliberately broken setup names a fix for each problem', async () => {
    setEnv({ ...GOOD, PF_URL: 'https://pf.test' });
    delete process.env.REGISTRATION_KEY;
    const denied = { ...fs, existsSync: () => true, accessSync: () => { throw new Error('EACCES'); } };
    const rep = await doctor.runDoctor({ mode: 'pf-as', fetchImpl: net_('https://pf.test/'), netImpl: takenPort, fsImpl: denied });
    expect(rep.ok).toBe(false);
    for (const id of ['pf-discovery', 'data-dir', 'port', 'env-registration']) expect(get(rep, id).fix, id).toBeTruthy();
    expect(get(rep, 'pf-discovery').status).toBe('fail');
    expect(get(rep, 'data-dir').status).toBe('fail');
    expect(get(rep, 'port').status).toBe('fail');
    expect(get(rep, 'env-registration').status).toBe('warn');
  });
  it('never puts a secret value in the report, even when checks fail', async () => {
    setEnv({ ...GOOD, PF_ADMIN_URL: 'https://pf:9999' });
    const adminCall = async () => { throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }); };
    const rep = await doctor.runDoctor({ mode: 'pf-as', fetchImpl: net_('https://wrong'), netImpl: takenPort, adminCall });
    const out = JSON.stringify(rep) + doctor.formatReport(rep);
    for (const v of Object.values(SECRETS)) expect(out).not.toContain(v);
    expect(out).toContain('SESSION_SECRET set (');
  });
  it('a crashing check becomes a fail, not an exception', async () => {
    setEnv(GOOD);
    const rep = await doctor.runDoctor({ mode: 'pf-as', fetchImpl: net_(), netImpl: freePort, adminCall: async () => { throw new Error('x'); } });
    expect(rep.checks).toBeTruthy();
  });
  it('rejects an unknown mode', async () => {
    await expect(doctor.runDoctor({ mode: 'nope' })).rejects.toThrow(/unknown mode/);
  });
  it('formatReport prints each non-pass check with its fix', () => {
    const text = doctor.formatReport({ mode: 'pf-as', ok: false, checks: [{ id: 'port', status: 'fail', message: 'in use', fix: 'free it' }, { id: 'node', status: 'pass', message: 'Node 26', fix: '' }] });
    expect(text).toContain('FAIL  port');
    expect(text).toContain('fix: free it');
    expect(text).toContain('1 passed, 0 warnings, 1 failed');
  });
});

describe('GET /api/doctor', () => {
  const appWith = (user) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user }; next(); });
    app.use('/api/doctor', router);
    return app;
  };
  it('401 signed out, 403 non-admin, 200 admin (without the port check)', async () => {
    expect((await request(appWith(null)).get('/api/doctor?mode=mock')).status).toBe(401);
    expect((await request(appWith({ email: 'a@b.c' })).get('/api/doctor?mode=mock')).status).toBe(403);
    const res = await request(appWith({ email: 'a@b.c', isAdmin: true })).get('/api/doctor?mode=mock');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checks.map((c) => c.id)).not.toContain('port');
  });
  it('400 for an unknown mode', async () => {
    expect((await request(appWith({ email: 'a@b.c', isAdmin: true })).get('/api/doctor?mode=x')).status).toBe(400);
  });
});
