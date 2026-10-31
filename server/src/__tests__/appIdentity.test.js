// S1: the app identity (cookie name, logout cookie, log prefix) comes from the registered demo config's slug.
// Expected values are literals so a hardcoded or tautological implementation cannot pass.
import cookieSignature from 'cookie-signature';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { config, useDemoConfig } from '../config.js';
import { sessionStore } from '../sessionStore.js';
import { DEFAULT_WORKSPACE, runInWorkspace } from '../workspace.js';

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

describe('ID-JAG demo identity', () => {
  it('config() is the base identity until createApp registers the demo config, then the demo identity', () => {
    useDemoConfig(() => ({}));
    expect(config()).toMatchObject({ slug: 'demo', appName: 'Demo Kit' });
    createApp();
    expect(config()).toMatchObject({ slug: 'idjag', appName: 'ID-JAG Kit' });
  });

  it('createApp reads the session cookie named idjag.sid and no other', async () => {
    useDemoConfig(() => ({})); // createApp must register the demo config itself
    const app = createApp();
    expect(await meStatus(app, 'idjag.sid')).toBe(200);
    expect(await meStatus(app, 'demo.sid')).toBe(401);
  });

  it('/auth/logout clears idjag.sid', async () => {
    const res = await request(createApp()).post('/auth/logout').set('Origin', ORIGIN);
    expect(res.status).toBe(303);
    expect((res.headers['set-cookie'] || []).map((c) => c.split('=')[0])).toEqual(['idjag.sid']);
  });

  it('the log prefix is [idjag]', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('SESSION_SECRET', '');
    createApp();
    expect(warn.mock.calls.map((a) => a.join(' ')).some((m) => m.startsWith('[idjag] SESSION_SECRET is not set'))).toBe(true);
  });
});
