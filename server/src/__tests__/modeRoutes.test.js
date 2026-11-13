import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { _resetHealth } from '../health.js';
import { _resetMode, currentMode } from '../mode.js';
import { MOCK_USER } from '../mock/env.js';

const ORIGIN = 'http://app.test';
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-modeapi-'));
  vi.stubEnv('APP_ORIGIN', ORIGIN);
  vi.stubEnv('DATA_DIR', dir);
  vi.stubEnv('SESSION_SECRET', 'test-session-secret');
  vi.stubEnv('MODE', '');
  vi.stubEnv('ALLOW_MOCK_SIGNIN', '1');
  vi.stubEnv('HOST', '127.0.0.1');
  for (const k of ['PF_URL', 'PF_EXCHANGE_CLIENT_ID', 'PF_EXCHANGE_CLIENT_SECRET', 'ACME_PF_URL', 'ACME_EXCHANGE_CLIENT_ID', 'ACME_EXCHANGE_CLIENT_SECRET', 'PF_REDEEMER_CLIENT_SECRET']) vi.stubEnv(k, '');
  _resetMode();
  _resetHealth();
});
afterEach(() => { _resetMode(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

const post = (agent, body) => agent.post('/api/mode').set('Origin', ORIGIN).send(body);
const configureLive = () => {
  vi.stubEnv('PF_URL', 'https://pf.example.invalid');
  vi.stubEnv('PF_EXCHANGE_CLIENT_ID', 'client');
  vi.stubEnv('PF_EXCHANGE_CLIENT_SECRET', 'secret');
};

describe('GET /api/mode', () => {
  it('in mock mode names the mode, what Live still needs, and the demo account', async () => {
    const res = await request(createApp()).get('/api/mode').expect(200);
    // /api/mode also carries the app version for the TopMenu; the rule 19 fields are the contract.
    expect(res.body).toEqual({
      mode: 'mock', live: { ready: false, missing: ['PF_URL', 'PF_EXCHANGE_CLIENT_ID', 'PF_EXCHANGE_CLIENT_SECRET'] },
      mockUser: { username: MOCK_USER.username, password: MOCK_USER.password }, signin: { allowed: true },
      version: expect.any(String),
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('says why mock sign-in is off, so the page can show it', async () => {
    vi.stubEnv('ALLOW_MOCK_SIGNIN', '');
    const res = await request(createApp()).get('/api/mode').expect(200);
    expect(res.body.signin).toMatchObject({ allowed: false, message: expect.stringContaining('ALLOW_MOCK_SIGNIN=1') });
  });

  it('never returns a value of a live setting', async () => {
    configureLive();
    const res = await request(createApp()).get('/api/mode').expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/pf\.example|client|secret/i);
    expect(res.body.live).toEqual({ ready: true, missing: [] });
  });
});

describe('POST /api/mode', () => {
  it('refuses a request that is not same-origin, and a bad mode', async () => {
    const app = createApp();
    await request(app).post('/api/mode').send({ mode: 'live' }).expect(403);
    await request(app).post('/api/mode').set('Origin', 'http://evil.test').send({ mode: 'live' }).expect(403);
    expect((await post(request(app), { mode: 'both' })).status).toBe(400);
    expect((await post(request(app), {})).status).toBe(400);
    expect(fs.existsSync(path.join(dir, 'mode.json'))).toBe(false);
  });

  it('explains what Live needs instead of failing silently, and stays in mock', async () => {
    const app = createApp();
    const res = await post(request(app), { mode: 'live' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'live_not_configured', missing: ['PF_URL', 'PF_EXCHANGE_CLIENT_ID', 'PF_EXCHANGE_CLIENT_SECRET'] });
    expect(res.body.message).toMatch(/PF_URL/);
    expect((await request(app).get('/api/mode')).body.mode).toBe('mock');
  });

  it('switches to live when configured; /api/health shows it at once, and it survives a restart', async () => {
    configureLive();
    vi.stubEnv('MODE', 'mock'); // live settings present and MODE unset would start live (mode.test.js); this test starts on the mock
    const app = createApp();
    expect((await request(app).get('/api/health')).body.mode).toBe('mock');
    const res = await post(request(app), { mode: 'live' }).expect(200);
    expect(res.body).toMatchObject({ mode: 'live', live: { ready: true } });
    expect(res.body.mockUser).toBeUndefined(); // the demo account is a mock-mode thing
    expect(currentMode()).toBe('live');
    const health = (await request(app).get('/api/health')).body;
    expect(health).toMatchObject({ schema: 'demo-health/1', mode: 'live', runtime: 'live' });
    _resetMode(); // restart
    expect((await request(createApp()).get('/api/mode')).body.mode).toBe('live');
    expect((await request(createApp()).get('/api/health')).body.mode).toBe('live');
    await post(request(app), { mode: 'mock' }).expect(200);
    const back = (await request(app).get('/api/health')).body;
    expect(back).toMatchObject({ mode: 'mock', runtime: 'offline' });
  });

  it('ends the web sessions on a switch: a session holds the tokens of one mode only', async () => {
    configureLive();
    vi.stubEnv('MODE', 'mock'); // start on the mock even though the live settings are present
    const app = createApp();
    const agent = request.agent(app);
    await agent.get('/auth/pi-flow/start').expect(200);
    const creds = await agent.post('/auth/pi-flow/credentials').set('Origin', ORIGIN).send({ username: MOCK_USER.username, password: MOCK_USER.password }).expect(200);
    const to = new URL(creds.body.redirectTo);
    await agent.get(to.pathname + to.search).expect(302);
    await agent.get('/api/me').expect(200);
    await post(agent, { mode: 'live' }).expect(200);
    await agent.get('/api/me').expect(401);
  });

  it('switching to the mode already running changes nothing', async () => {
    const app = createApp();
    const res = await post(request(app), { mode: 'mock' }).expect(200);
    expect(res.body.mode).toBe('mock');
    expect(fs.existsSync(path.join(dir, 'mode.json'))).toBe(false);
  });
});
