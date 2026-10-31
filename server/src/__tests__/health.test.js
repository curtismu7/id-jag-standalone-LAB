import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import router, { _resetHealth, refresh, startHealth } from '../health.js';
import { createFakePf } from '../idp/__tests__/fakePf.js';
import { _usePfAdmin, createPfAdmin } from '../idp/pfAdmin.js';
import { currentWorkspace } from '../workspace.js';

// Default doctor for refresh()/startHealth() is this mock, so a route that ran the doctor itself would be counted.
const doctor = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../doctor.js', async (orig) => ({ ...(await orig()), runDoctor: (...a) => doctor.run(...a) }));

const SENTINELS = { PF_ADMIN_PASSWORD: 'sentinel-admin-password', SESSION_SECRET: 'sentinel-session-secret-value', PF_EXCHANGE_CLIENT_SECRET: 'sentinel-exchange-secret' };
const KEYS = ['PF_ADMIN_URL', 'PF_EXCHANGE_CLIENT_ID', 'HEALTH_MODE', ...Object.keys(SENTINELS)];
const saved = {};
const app = () => express().use('/api/health', router);
const rep = (...statuses) => ({ mode: 'mock', ok: !statuses.includes('fail'), checks: statuses.map((status, i) => ({ id: `c${i}`, status, message: 'sentinel-message-text', fix: 'sentinel-fix-text' })) });

beforeEach(() => { doctor.run.mockReset(); doctor.run.mockResolvedValue({ checks: [{ status: 'pass' }] }); for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } _resetHealth(); });
afterEach(() => { vi.useRealTimers(); for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('GET /api/health', () => {
  it('cold start answers unknown, with the full contract shape', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['at', 'demo', 'runtime', 'schema', 'state']);
    expect(res.body).toMatchObject({ schema: 'demo-health/1', state: 'unknown', runtime: 'offline', demo: { id: 'id-jag', name: 'ID-JAG Standalone', version: '0.1.0' } });
    expect(Object.keys(res.body.demo).sort()).toEqual(['id', 'name', 'version']);
    expect(new Date(res.body.at).toISOString()).toBe(res.body.at);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['all pass', ['pass', 'pass'], 'ready'],
    ['warnings only', ['pass', 'warn'], 'ready'],
    ['any fail', ['pass', 'warn', 'fail'], 'needs-setup'],
  ])('%s -> %s', async (_n, statuses, state) => {
    await refresh({ run: async () => rep(...statuses) });
    const res = await request(app()).get('/api/health');
    expect(res.body.state).toBe(state);
  });

  it('doctor throwing -> unknown; doctor timing out -> unknown', async () => {
    await refresh({ run: async () => { throw new Error('boom'); } });
    expect((await request(app()).get('/api/health')).body.state).toBe('unknown');
    _resetHealth();
    await refresh({ run: () => new Promise(() => {}), timeoutMs: 20 });
    const res = await request(app()).get('/api/health');
    expect(res.body.state).toBe('unknown');
    expect(res.body.at).toBeTruthy();
  });

  it('is never broken today (reserved)', async () => {
    await refresh({ run: async () => rep('fail', 'fail') });
    expect((await request(app()).get('/api/health')).body.state).not.toBe('broken');
  });

  it('runtime: offline in mock without PF admin env, live otherwise', async () => {
    expect((await request(app()).get('/api/health')).body.runtime).toBe('offline');
    process.env.PF_ADMIN_URL = 'https://pf.test:9999';
    expect((await request(app()).get('/api/health')).body.runtime).toBe('live');
    delete process.env.PF_ADMIN_URL;
    process.env.PF_EXCHANGE_CLIENT_ID = 'kit';
    expect((await request(app()).get('/api/health')).body.runtime).toBe('live');
  });

  it('leaks no secret, message or fix text, and no query parameter changes the answer', async () => {
    Object.assign(process.env, SENTINELS);
    await refresh({ run: async () => rep('fail') });
    const a = await request(app()).get('/api/health');
    const b = await request(app()).get('/api/health?mode=pf-as&detail=1');
    const text = JSON.stringify(a.body) + JSON.stringify(b.body);
    for (const s of [...Object.values(SENTINELS), 'sentinel-message-text', 'sentinel-fix-text']) expect(text).not.toContain(s);
    expect(b.body).toEqual(a.body);
  });

  it('runs the doctor once across many requests (the route never runs it)', async () => {
    await refresh();
    expect(doctor.run).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i += 1) await request(app()).get('/api/health');
    expect(doctor.run).toHaveBeenCalledTimes(1);
  });

  it('startHealth runs the doctor at boot, then no more than once per 60 s', async () => {
    vi.useFakeTimers();
    startHealth();
    await vi.advanceTimersByTimeAsync(0);
    expect(doctor.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(doctor.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(doctor.run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(doctor.run).toHaveBeenCalledTimes(3);
  });

  it('a doctor run that outlives the timeout is not stacked on: one stuck attempt at most', async () => {
    let release;
    doctor.run.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    await refresh({ timeoutMs: 10 });
    expect((await request(app()).get('/api/health')).body.state).toBe('unknown');
    await refresh({ timeoutMs: 10 });
    await refresh({ timeoutMs: 10 });
    expect(doctor.run).toHaveBeenCalledTimes(1); // still the hung one
    release({ checks: [{ status: 'pass' }] });
    await new Promise((r) => setTimeout(r, 0));
    await refresh();
    expect(doctor.run).toHaveBeenCalledTimes(2);
    expect((await request(app()).get('/api/health')).body.state).toBe('ready');
  });

  it('concurrent refreshes share one doctor run', async () => {
    const run = vi.fn(async () => rep('pass'));
    await Promise.all([refresh({ run }), refresh({ run }), refresh({ run })]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reuses the doctor: the PF admin API is called only as the doctor calls it, never per request', async () => {
    Object.assign(process.env, { PF_ADMIN_URL: 'https://pf.test:9999', PF_ADMIN_PASSWORD: 'x', PF_EXCHANGE_CLIENT_ID: 'kit', HEALTH_MODE: 'pf-as' });
    const adminCall = vi.fn(async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); });
    const { runDoctor } = await vi.importActual('../doctor.js');
    await refresh({ run: (o) => runDoctor({ ...o, adminCall, fetchImpl: async () => ({ status: 500, json: async () => ({}) }) }) });
    expect(adminCall).toHaveBeenCalledTimes(1); // the doctor's one attempt (the validator lookup)
    for (let i = 0; i < 5; i += 1) await request(app()).get('/api/health');
    expect(adminCall).toHaveBeenCalledTimes(1);
    expect((await request(app()).get('/api/health')).body.state).toBe('needs-setup');
  });

  it.each(['head', 'post', 'put', 'delete', 'patch'])('%s answers 405 with Allow: GET', async (m) => {
    const res = await request(app())[m]('/api/health');
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rate-limits one address to 60 a minute', async () => {
    const a = app();
    let last;
    for (let i = 0; i < 61; i += 1) last = await request(a).get('/api/health');
    expect(last.status).toBe(429);
  });

  it('a latched PF admin: health answers without any new PF admin attempt', async () => {
    Object.assign(process.env, { PF_ADMIN_URL: 'https://pf.test:9999', PF_ADMIN_PASSWORD: 'x', PF_EXCHANGE_CLIENT_ID: 'kit', HEALTH_MODE: 'pf-as' });
    const fake = createFakePf();
    const pf = createPfAdmin({ send: fake.send });
    const attempts = vi.fn((...a) => pf.call(...a)); // counts attempts even when the client itself would refuse one
    _usePfAdmin({ ...pf, call: attempts });
    try {
      fake.status = 401;
      const V = '/passwordCredentialValidators/idJagKitPcv';
      await pf.call('GET', V);
      await pf.call('GET', V);
      expect(pf.latch().locked).toBe(true);
      attempts.mockClear();
      fake.calls.length = 0;
      const { runDoctor } = await vi.importActual('../doctor.js');
      const run = (o) => runDoctor({ ...o, fetchImpl: async () => ({ status: 500, json: async () => ({}) }) }); // no adminCall: the adapter's latch decides
      for (let i = 0; i < 3; i += 1) await refresh({ run });
      for (let i = 0; i < 5; i += 1) await request(app()).get('/api/health');
      expect(attempts).not.toHaveBeenCalled();
      expect(fake.calls).toEqual([]);
      expect((await request(app()).get('/api/health')).body.state).toBe('needs-setup');
    } finally { _usePfAdmin(null); }
  });

  it('refresh runs the doctor in the default workspace', async () => {
    let seen;
    await refresh({ run: async () => { seen = currentWorkspace(); return rep('pass'); } });
    expect(seen).toBe('default');
  });

  it('many requests cause at most one doctor run per 60 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    startHealth();
    await vi.advanceTimersByTimeAsync(0);
    const a = app();
    for (let i = 0; i < 50; i += 1) await request(a).get('/api/health');
    await vi.advanceTimersByTimeAsync(59_000);
    for (let i = 0; i < 10; i += 1) await request(a).get('/api/health');
    expect(doctor.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(doctor.run).toHaveBeenCalledTimes(2);
  });

  // Last in the file: resetModules gives later dynamic imports a different module graph than the static imports above.
  it('a freshly imported module (no reset) starts unknown, never ready', async () => {
    vi.resetModules();
    const fresh = await import('../health.js');
    const res = await request(express().use('/api/health', fresh.default)).get('/api/health');
    expect(res.body.state).toBe('unknown');
    expect(doctor.run).not.toHaveBeenCalled();
  });
});
