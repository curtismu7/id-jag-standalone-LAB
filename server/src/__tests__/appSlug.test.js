// S1: the base derives its cookie, logout cookie and log prefix from whatever slug the demo registers (demo module mocked).
import cookieSignature from 'cookie-signature';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { sessionStore } from '../sessionStore.js';
import { DEFAULT_WORKSPACE, runInWorkspace } from '../workspace.js';

const h = vi.hoisted(() => ({ cfg: {} }));
vi.mock('../demo/index.js', () => ({ config: () => h.cfg, routes: [] }));

const ORIGIN = 'https://app.test';
const SECRET = 'test-session-secret';
let n = 0;

beforeEach(() => {
  vi.stubEnv('APP_ORIGIN', ORIGIN);
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('PF_ADMIN_URL', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const cookieFor = (name) => new Promise((resolve) => {
  const sid = `sid-${++n}`;
  runInWorkspace(DEFAULT_WORKSPACE, () => sessionStore.set(sid, { cookie: { originalMaxAge: null }, user: { email: 'u@x.test' } },
    () => resolve(`${name}=${encodeURIComponent(`s:${cookieSignature.sign(sid, SECRET)}`)}`)));
});
const meStatus = async (app, name) => (await request(app).get('/api/me').set('Cookie', await cookieFor(name))).status;
const logoutCookies = async (app) => ((await request(app).post('/auth/logout').set('Origin', ORIGIN)).headers['set-cookie'] || []).map((c) => c.split('=')[0]);

describe('slug derivation', () => {
  it('a demo slug of zzz gives zzz.sid for the session, the logout and the log prefix', async () => {
    h.cfg = { slug: 'zzz' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('SESSION_SECRET', '');
    createApp();
    expect(warn.mock.calls.map((a) => a.join(' ')).some((m) => m.startsWith('[zzz] SESSION_SECRET is not set'))).toBe(true);
    vi.stubEnv('SESSION_SECRET', SECRET);
    const app = createApp();
    expect(await meStatus(app, 'zzz.sid')).toBe(200);
    expect(await meStatus(app, 'idjag.sid')).toBe(401);
    expect(await logoutCookies(app)).toEqual(['zzz.sid']);
  });

  it('a demo that sets no slug gets the base default demo.sid, in the session and the logout', async () => {
    h.cfg = {};
    const app = createApp();
    expect(await meStatus(app, 'demo.sid')).toBe(200);
    expect(await meStatus(app, 'zzz.sid')).toBe(401);
    expect(await logoutCookies(app)).toEqual(['demo.sid']);
  });
});
