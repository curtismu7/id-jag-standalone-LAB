// Shared by the mock-mode suites: the app in mock mode against a temp DATA_DIR, with the real fetch a spy that fails the test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { _clearProbeCache } from '../idJagPlayground.js';
import { _forceMode, _resetMode } from '../mode.js';
import { MOCK_USER } from '../mock/env.js';
import { _dropMockWorld } from '../mock/index.js';
import { netguard } from '../outbound.js';

export const ORIGIN = 'http://app.test';
export const API = '/api/id-jag-playground';

export const post = (agent, p, body = {}) => agent.post(p).set('Origin', ORIGIN).send(body);

/** Call once inside a describe/file: sets the environment up before each test and tears it down after. Returns accessors. */
export function useMockMode() {
  const state = { tmp: '', realFetch: null };
  beforeEach(() => {
    state.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-mock-'));
    vi.stubEnv('APP_ORIGIN', ORIGIN);
    vi.stubEnv('DATA_DIR', state.tmp);
    vi.stubEnv('SESSION_SECRET', 'test-session-secret');
    vi.stubEnv('ALLOW_MOCK_SIGNIN', '1');
    vi.stubEnv('HOST', '127.0.0.1');
    vi.stubEnv('LAB_PUBLISH', '');
    vi.stubEnv('TRUST_PROXY', '');
    state.realFetch = vi.fn(async () => { throw new Error('the real fetch must not be called in mock mode'); });
    vi.stubGlobal('fetch', state.realFetch);
    _forceMode('mock');
    _dropMockWorld();
    _clearProbeCache();
    netguard._reset();
  });
  afterEach(() => {
    _resetMode();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(state.tmp, { recursive: true, force: true });
  });
  return state;
}

/** The pi.flow sign-in at the issuer of the current playground mode, then its callback. */
export async function signInIssuer(agent, creds = { username: MOCK_USER.username, password: MOCK_USER.password }) {
  await agent.get(`${API}/issuer/pi-flow/start`).expect(200);
  const r = await post(agent, `${API}/issuer/pi-flow/credentials`, creds);
  if (r.status !== 200) return r;
  const to = new URL(r.body.redirectTo);
  await agent.get(to.pathname + to.search).expect(302);
  return r;
}

/** The app's own sign-in (pi.flow at the mock PingFederate) and the session it opens. */
export async function signInApp(agent, creds = { username: MOCK_USER.username, password: MOCK_USER.password }) {
  await agent.get('/auth/pi-flow/start').expect(200);
  const r = await post(agent, '/auth/pi-flow/credentials', creds);
  if (r.status !== 200) return r;
  const to = new URL(r.body.redirectTo);
  await agent.get(to.pathname + to.search).expect(302);
  return r;
}

/** The test made no real call: the spy was never reached, nothing was refused or sent on, and the mock did answer. */
export function expectNoRealCalls(state) {
  expect(state.realFetch).not.toHaveBeenCalled();
  const s = netguard.stats();
  expect(s).toMatchObject({ refused: 0, live: 0, loopback: 0 });
  expect(s.mock).toBeGreaterThan(0);
}
