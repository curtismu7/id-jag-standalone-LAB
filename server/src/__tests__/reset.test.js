import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reset } from '../reset.js';
import { sessionStore } from '../sessionStore.js';

vi.mock('../pfUsers.js', () => ({ removeUser: vi.fn(async () => true), addUser: vi.fn(), adminConfigured: () => true }));
const { removeUser } = await import('../pfUsers.js');
const { default: resetRoutes } = await import('../resetRoutes.js');

const ORIGIN = 'https://app.test';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const STAMP = 'audit-2026-10-20T12-00-00-000Z.jsonl';
let dir;
let clientsFile;
const write = (n, v) => fs.writeFileSync(path.join(dir, n), typeof v === 'string' ? v : JSON.stringify(v));
const seed = () => {
  write('registrations.json', [
    { id: '1', email: 'Ok@pingidentity.com', status: 'approved' },
    { id: '2', email: 'wait@pingidentity.com', status: 'pending' },
    { id: '3', email: 'no@pingidentity.com', status: 'rejected' },
  ]);
  write('trusted-idps.json', [{ id: 'acme', status: 'approved', targets: ['resource-as'] }, { id: 'pfonly', targets: ['pingfederate'] }]);
  write('audit.jsonl', '{"action":"old"}\n');
  fs.writeFileSync(clientsFile, JSON.stringify([{ client_id: 'id-jag-playground' }, { client_id: 'idp-acme' }, { client_id: 'idp-pfonly' }]));
};
const deps = (over = {}) => ({ dataDir: dir, now: NOW, actor: 'admin@x', removeUser: vi.fn(async () => true), removeClient: vi.fn(), ...over });
const files = () => fs.readdirSync(dir).sort();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-'));
  clientsFile = path.join(dir, '..', `clients-${path.basename(dir)}.json`);
  process.env.DATA_DIR = dir;
  process.env.APP_ORIGIN = ORIGIN;
  process.env.RESOURCE_AS_CLIENTS_FILE = clientsFile;
  removeUser.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(clientsFile, { force: true });
});

describe('reset()', () => {
  it('clears registrations, trusted IdPs and clients, archives the audit log and restarts it', async () => {
    seed();
    const d = deps();
    const r = await reset(d);
    expect(files()).toEqual([STAMP, 'audit.jsonl']);
    expect(fs.readFileSync(path.join(dir, STAMP), 'utf8')).toBe('{"action":"old"}\n');
    const lines = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ action: 'reset', actor: 'admin@x', at: NOW.toISOString() });
    expect(d.removeClient.mock.calls).toEqual([['idp-acme']]);
    expect(r).toMatchObject({ ok: true, registrations: 3, idps: 2, auditArchive: STAMP });
  });

  it('removes only approved registrants from PingFederate', async () => {
    seed();
    const d = deps();
    await reset(d);
    expect(d.removeUser.mock.calls).toEqual([['ok@pingidentity.com']]);
  });

  it('empties sessions and in-memory state', async () => {
    seed();
    const clearSessions = vi.fn((cb) => cb());
    const mem = vi.fn();
    const r = await reset(deps({ clearSessions, clearMemory: [mem] }));
    expect(clearSessions).toHaveBeenCalled();
    expect(mem).toHaveBeenCalled();
    expect(r.sessionsCleared).toBe(true);
  });

  it('leaves everything else in place', async () => {
    seed();
    write('kit-users.json', '{"keep":1}');
    write('.env', 'SECRET=1');
    await reset(deps());
    expect(fs.readFileSync(path.join(dir, 'kit-users.json'), 'utf8')).toBe('{"keep":1}');
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('SECRET=1');
  });

  it('dry run reports but changes nothing', async () => {
    seed();
    const before = files().map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    const d = deps({ dryRun: true, clearSessions: vi.fn() });
    const r = await reset(d);
    expect(files().map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))).toEqual(before);
    expect(d.removeUser).not.toHaveBeenCalled();
    expect(d.removeClient).not.toHaveBeenCalled();
    expect(d.clearSessions).not.toHaveBeenCalled();
    expect(r).toMatchObject({ dryRun: true, users: ['ok@pingidentity.com'], clients: ['idp-acme'], auditArchive: STAMP });
  });

  it('still resets local state when PingFederate is unreachable, and reports the users left behind', async () => {
    seed();
    const r = await reset(deps({ removeUser: vi.fn(async () => { throw new Error('PingFederate admin API unreachable: ECONNREFUSED'); }) }));
    expect(r.ok).toBe(false);
    expect(r.pfFailed).toEqual([{ email: 'ok@pingidentity.com', error: 'PingFederate admin API unreachable: ECONNREFUSED' }]);
    expect(files()).toEqual([STAMP, 'audit.jsonl']);
  });

  it('reports the last PingFederate user as kept, not as a failure, and still clears local state', async () => {
    seed();
    const r = await reset(deps({ removeUser: vi.fn(async () => { throw Object.assign(new Error('the last one is kept'), { lastUser: true }); }) }));
    expect(r.pfKept).toEqual(['ok@pingidentity.com']);
    expect(r.pfFailed).toEqual([]);
    expect(r.ok).toBe(true);
    expect(files()).toEqual([STAMP, 'audit.jsonl']);
  });

  it('works on a fresh install (nothing to clear)', async () => {
    const r = await reset(deps());
    expect(r).toMatchObject({ ok: true, registrations: 0, auditArchive: null });
    expect(files()).toEqual(['audit.jsonl']);
  });
});

describe('real client removal', () => {
  it('removes the IdP client from the resource-AS clients file and keeps the others', async () => {
    seed();
    const { removeClient } = await import('../registry/clients.js');
    await reset(deps({ removeClient }));
    expect(JSON.parse(fs.readFileSync(clientsFile, 'utf8')).map((c) => c.client_id)).toEqual(['id-jag-playground', 'idp-pfonly']);
  });
});

describe('POST /api/admin/reset', () => {
  const appFor = (user) => {
    const app = express();
    app.use(session({ store: sessionStore, secret: 's', resave: false, saveUninitialized: false }));
    app.use((req, _res, next) => { if (user) req.session.user = user; next(); });
    app.use('/api', resetRoutes);
    return app;
  };
  const post = (app, body, origin = ORIGIN) => request(app).post('/api/admin/reset').set('Origin', origin).send(body);

  it('401 when signed out, 403 for a non-admin, 400 without the confirm word', async () => {
    seed();
    expect((await post(appFor(null), { confirm: 'reset' })).status).toBe(401);
    expect((await post(appFor({ email: 'u@x', isAdmin: false }), { confirm: 'reset' })).status).toBe(403);
    expect((await post(appFor({ email: 'a@x', isAdmin: true }), {})).status).toBe(400);
    expect((await post(appFor({ email: 'a@x', isAdmin: true }), { confirm: 'yes' })).status).toBe(400);
    expect(fs.existsSync(path.join(dir, 'registrations.json'))).toBe(true);
  });

  it('refuses a cross-origin request', async () => {
    seed();
    const r = await post(appFor({ email: 'a@x', isAdmin: true }), { confirm: 'reset' }, 'https://evil.test');
    expect(r.status).toBe(403);
    expect(fs.existsSync(path.join(dir, 'registrations.json'))).toBe(true);
  });

  it('200: resets, and the admin session is gone afterwards', async () => {
    seed();
    const app = express();
    app.use(session({ store: sessionStore, secret: 's', resave: false, saveUninitialized: false }));
    app.post('/login', (req, res) => { req.session.user = { email: 'a@x', isAdmin: true }; res.end(); });
    app.get('/me', (req, res) => res.sendStatus(req.session.user ? 200 : 401));
    app.use('/api', resetRoutes);
    const agent = request.agent(app);
    await agent.post('/login');
    expect((await agent.get('/me')).status).toBe(200);
    const r = await agent.post('/api/admin/reset').set('Origin', ORIGIN).send({ confirm: 'reset' });
    expect(r.status).toBe(200);
    expect(r.body.sessionsCleared).toBe(true);
    expect(files()).toHaveLength(2);
    expect(files()[0]).toMatch(/^audit-.*\.jsonl$/);
    expect(removeUser).toHaveBeenCalledWith('ok@pingidentity.com');
    expect((await agent.get('/me')).status).toBe(401);
  });

  it('502 with the report when PingFederate cannot be reached, local state still reset', async () => {
    seed();
    removeUser.mockRejectedValue(new Error('unreachable'));
    const r = await post(appFor({ email: 'a@x', isAdmin: true }), { confirm: 'reset' });
    expect(r.status).toBe(502);
    expect(r.body.pfFailed).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'registrations.json'))).toBe(false);
  });
});

describe('npm run reset (CLI)', () => {
  const cli = path.resolve(import.meta.dirname, '../../../scripts/reset.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, DATA_DIR: dir, PF_ADMIN_URL: '', PF_ADMIN_PASSWORD: '' }, encoding: 'utf8' });

  it('refuses without --yes and changes nothing', () => {
    seed();
    const r = run();
    expect(r.status).toBe(2);
    expect(fs.existsSync(path.join(dir, 'registrations.json'))).toBe(true);
  });

  it('--dry-run prints the plan and changes nothing', () => {
    seed();
    const r = run('--dry-run');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Would clear');
    expect(fs.existsSync(path.join(dir, 'registrations.json'))).toBe(true);
  });

  it('--yes with PingFederate unconfigured still resets locally and exits non-zero', () => {
    seed();
    const r = run('--yes');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ok@pingidentity.com');
    expect(fs.existsSync(path.join(dir, 'registrations.json'))).toBe(false);
  });
});
