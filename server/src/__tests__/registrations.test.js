import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import router, { resetRateLimit } from '../registrationRoutes.js';
import * as store from '../registrations.js';
import { activeAdapter } from '../idp/index.js';

vi.mock('../pfUsers.js', () => ({ addUser: vi.fn(async () => {}), adminConfigured: () => true }));
const { addUser } = await import('../pfUsers.js');

const ORIGIN = 'https://app.test';
const GOOD = { email: 'new.user@pingidentity.com', password: 'a-long-enough-password' };

let dataDir;
function appWith(user) {
  const app = express();
  app.use((req, _res, next) => { req.session = { user }; next(); });
  app.use('/api', router);
  return app;
}
const admin = { email: 'boss@pingidentity.com', isAdmin: true };
const post = (app, p, body) => request(app).post(p).set('Origin', ORIGIN).send(body);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  process.env.DATA_DIR = dataDir;
  process.env.APP_ORIGIN = ORIGIN;
  process.env.REGISTRATION_KEY = 'k'.repeat(24);
  delete process.env.ALLOWED_EMAIL_DOMAINS;
  resetRateLimit();
  addUser.mockReset().mockResolvedValue();
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('POST /api/register', () => {
  it('records a pending request and never stores the password in the clear', async () => {
    const r = await post(appWith(null), '/api/register', GOOD);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending');
    const raw = fs.readFileSync(path.join(dataDir, 'registrations.json'), 'utf8');
    expect(raw).not.toContain(GOOD.password);
    expect(raw).toContain('new.user@pingidentity.com');
  });

  it.each([
    ['a domain that is not allowed', { email: 'x@gmail.com' }],
    ['a plus address', { email: 'x+tag@pingidentity.com' }],
    ['a subdomain', { email: 'x@evil.pingidentity.com' }],
    ['a short password', { password: 'short' }],
    ['no password', { password: undefined }],
  ])('refuses %s', async (_n, over) => {
    const r = await post(appWith(null), '/api/register', { ...GOOD, ...over });
    expect(r.status).toBe(400);
    expect(store.list()).toEqual([]);
  });

  it('refuses a second request for the same address', async () => {
    await post(appWith(null), '/api/register', GOOD);
    const r = await post(appWith(null), '/api/register', { ...GOOD, email: 'NEW.user@pingidentity.com' });
    expect(r.status).toBe(409);
  });

  it('answers 503 when REGISTRATION_KEY is missing', async () => {
    delete process.env.REGISTRATION_KEY;
    expect((await post(appWith(null), '/api/register', GOOD)).status).toBe(503);
  });

  it('refuses a cross-origin write', async () => {
    const r = await request(appWith(null)).post('/api/register').set('Origin', 'https://evil.test').send(GOOD);
    expect(r.status).toBe(403);
  });

  it('rate-limits one address after 5 requests an hour', async () => {
    const app = appWith(null);
    for (let i = 0; i < 5; i += 1) await post(app, '/api/register', { ...GOOD, email: `u${i}@pingidentity.com` });
    expect((await post(app, '/api/register', { ...GOOD, email: 'u9@pingidentity.com' })).status).toBe(429);
  });
});

describe('admin decisions', () => {
  const seedRequest = async () => (await post(appWith(null), '/api/register', GOOD)).body.id;

  it('lists requests for an admin only, with no password in them', async () => {
    await seedRequest();
    expect((await request(appWith(null)).get('/api/registrations')).status).toBe(401);
    expect((await request(appWith({ email: 'u@pingidentity.com' })).get('/api/registrations')).status).toBe(403);
    const r = await request(appWith(admin)).get('/api/registrations');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(GOOD.password);
    expect(JSON.stringify(r.body)).not.toContain('passwordSealed');
  });

  it('approve creates the PingFederate user with the chosen password, then wipes it', async () => {
    const id = await seedRequest();
    const r = await post(appWith(admin), `/api/registrations/${id}/approve`, {});
    expect(r.status).toBe(200);
    expect(addUser).toHaveBeenCalledWith('new.user@pingidentity.com', GOOD.password);
    expect(r.body).toMatchObject({ status: 'approved', decidedBy: admin.email });
    expect(fs.readFileSync(path.join(dataDir, 'registrations.json'), 'utf8')).toContain('"passwordSealed": null');
    expect((await post(appWith(admin), `/api/registrations/${id}/approve`, {})).status).toBe(409);
  });

  it('approve goes through the active IdP adapter users.add, not pfUsers directly', async () => {
    const add = vi.spyOn(activeAdapter().users, 'add');
    const id = await seedRequest();
    expect((await post(appWith(admin), `/api/registrations/${id}/approve`, {})).status).toBe(200);
    expect(add).toHaveBeenCalledWith('new.user@pingidentity.com', GOOD.password);
    add.mockRestore();
  });

  it('keeps the request pending when PingFederate fails', async () => {
    const id = await seedRequest();
    addUser.mockRejectedValue(Object.assign(new Error('PF down'), { status: 502 }));
    const r = await post(appWith(admin), `/api/registrations/${id}/approve`, {});
    expect(r.status).toBe(502);
    expect(store.list()[0].status).toBe('pending');
    addUser.mockResolvedValue();
    expect((await post(appWith(admin), `/api/registrations/${id}/approve`, {})).status).toBe(200);
  });

  it('reject wipes the password and records the reason', async () => {
    const id = await seedRequest();
    const r = await post(appWith(admin), `/api/registrations/${id}/reject`, { reason: 'not a Ping employee' });
    expect(r.body).toMatchObject({ status: 'rejected', reason: 'not a Ping employee' });
    expect(addUser).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dataDir, 'registrations.json'), 'utf8')).toContain('"passwordSealed": null');
  });

  it('a non-admin cannot approve', async () => {
    const id = await seedRequest();
    expect((await post(appWith({ email: 'u@pingidentity.com' }), `/api/registrations/${id}/approve`, {})).status).toBe(403);
    expect(addUser).not.toHaveBeenCalled();
  });

  it('a pending request expires after 7 days and loses its password', async () => {
    const id = await seedRequest();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + store.TTL_MS + 1000);
    expect(store.list()[0].status).toBe('expired');
    expect((await post(appWith(admin), `/api/registrations/${id}/approve`, {})).status).toBe(409);
    expect(fs.readFileSync(path.join(dataDir, 'registrations.json'), 'utf8')).toContain('"passwordSealed": null');
  });

  it('writes an audit line per decision, with no password in it', async () => {
    const id = await seedRequest();
    await post(appWith(admin), `/api/registrations/${id}/approve`, {});
    const log = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8');
    expect(log).toContain('registration.request');
    expect(log).toContain('registration.approve');
    expect(log).not.toContain(GOOD.password);
  });
});
