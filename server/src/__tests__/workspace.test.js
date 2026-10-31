// Workspace seam (design 6): defaults unchanged, two workspaces isolated, single-tenant routes fail closed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import cookieSignature from 'cookie-signature';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import * as audit from '../registry/audit.js';
import * as regs from '../registrations.js';
import { sessionStore } from '../sessionStore.js';
import * as idps from '../trustedIdps.js';
import { traceSinkFor } from '../trace/shared.js';
import { currentWorkspace, dataDir, runInWorkspace, validWorkspaceId, workspaceDir } from '../workspace.js';

// True when source reads config().dataDir by any route: direct member or bracket access, a name assigned from config()
// then used with .dataDir / ['dataDir'], or destructuring (with or without a rename) from config() or such a name.
const MEMBER = String.raw`(?:\.dataDir\b|\[\s*['"`+"`"+String.raw`]dataDir['"`+"`"+String.raw`]\s*\])`;
function readsDataDir(src) {
  const aliases = new Set(['config', 'c', 'cfg']);
  for (const m of src.matchAll(/\b(\w+)\s*=\s*config\(\)\s*[;,\n]/g)) aliases.add(m[1]);
  const names = [...aliases].join('|');
  return new RegExp(String.raw`\bconfig\(\)\s*` + MEMBER).test(src)
    || new RegExp(String.raw`\b(?:${names})\s*` + MEMBER).test(src)
    || new RegExp(String.raw`\{[^}]*\bdataDir\b[^}]*\}\s*=\s*(?:config\(\)|(?:${names})\b)`).test(src);
}

const ORIGIN = 'https://app.test';
const SECRET = 'test-session-secret';
let root;
let n = 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-ws-'));
  vi.stubEnv('DATA_DIR', root);
  vi.stubEnv('APP_ORIGIN', ORIGIN);
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('REGISTRATION_KEY', 'registration-key-0123456789');
  vi.stubEnv('PF_ADMIN_URL', '');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

const byHeader = (req) => req.get('x-test-ws') || 'default';
const appFor = () => createApp({ workspaceResolver: byHeader });
const seedSession = (ws, user = { email: `${ws}@x.test`, isAdmin: true }) => new Promise((resolve) => {
  const sid = `sid-${++n}`;
  runInWorkspace(ws, () => sessionStore.set(sid, { cookie: { originalMaxAge: null }, user }, () => resolve(`idjag.sid=${encodeURIComponent(`s:${cookieSignature.sign(sid, SECRET)}`)}`)));
});
const inWs = (ws, fn) => runInWorkspace(ws, fn);
const register = (email) => regs.create({ email, password: 'a-long-enough-password' });
const file = (...p) => path.join(root, ...p);

describe('defaults are unchanged', () => {
  it('1. with no resolver, registrations.json and audit.jsonl land exactly at DATA_DIR', () => {
    expect(dataDir()).toBe(root);
    expect(currentWorkspace()).toBe('default');
    register('d@pingidentity.com');
    audit.append({ action: 'x' });
    expect(fs.existsSync(file('registrations.json'))).toBe(true);
    expect(fs.existsSync(file('audit.jsonl'))).toBe(true);
    expect(fs.existsSync(file('ws'))).toBe(false);
  });

  it('2. the session cookie name is still <slug>.sid', async () => {
    const res = await request(createApp()).get('/auth/pi-flow/start').set('Origin', ORIGIN);
    const names = (res.headers['set-cookie'] || []).map((c) => c.split('=')[0]);
    expect(names.every((c) => c === 'idjag.sid')).toBe(true);
  });

  it('4. the CLI reset acts on the DATA_DIR root', () => {
    fs.writeFileSync(file('registrations.json'), '[]');
    const cli = path.resolve(import.meta.dirname, '../../../scripts/reset.mjs');
    const r = spawnSync(process.execPath, [cli, '--dry-run'], { env: { ...process.env, DATA_DIR: root, PF_ADMIN_URL: '', PF_ADMIN_PASSWORD: '' }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`in ${root}:`);
  });

  it('5. x-workspace, a workspace cookie and ?workspace= are ignored by the default resolver', async () => {
    register('d@pingidentity.com');
    const cookie = await seedSession('default');
    const res = await request(createApp()).get('/api/registrations?workspace=a').set('Cookie', `${cookie}; workspace=a`).set('x-workspace', 'a');
    expect(res.status).toBe(200);
    expect(res.body.registrations).toHaveLength(1);
    expect(fs.existsSync(file('ws'))).toBe(false);
  });
});

describe('two workspaces are isolated', () => {
  it('6. a registration in A is not listed in B, and its file sits under ws/a/', async () => {
    inWs('a', () => register('a@pingidentity.com'));
    expect(fs.existsSync(file('ws', 'a', 'registrations.json'))).toBe(true);
    expect(fs.existsSync(file('registrations.json'))).toBe(false);
    const app = appFor();
    const a = await request(app).get('/api/registrations').set('x-test-ws', 'a').set('Cookie', await seedSession('a'));
    const b = await request(app).get('/api/registrations').set('x-test-ws', 'b').set('Cookie', await seedSession('b'));
    expect(a.body.registrations).toHaveLength(1);
    expect(b.body.registrations).toEqual([]);
  });

  it('7. a session cookie from A is rejected (401) in B', async () => {
    const cookie = await seedSession('a');
    const app = appFor();
    expect((await request(app).get('/api/registrations').set('x-test-ws', 'a').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/registrations').set('x-test-ws', 'b').set('Cookie', cookie)).status).toBe(401);
  });

  it('8. audit logs are separate', () => {
    inWs('a', () => audit.append({ action: 'in-a' }));
    inWs('b', () => audit.append({ action: 'in-b' }));
    expect(inWs('a', () => audit.page().entries.map((e) => e.action))).toEqual(['in-a']);
    expect(inWs('b', () => audit.page().entries.map((e) => e.action))).toEqual(['in-b']);
    expect(fs.existsSync(file('audit.jsonl'))).toBe(false);
  });

  it('9. a trusted IdP written in A is invisible in B', () => {
    fs.mkdirSync(file('ws', 'a'), { recursive: true });
    fs.writeFileSync(file('ws', 'a', 'trusted-idps.json'), JSON.stringify([{ id: 'acme', status: 'approved', targets: [] }]));
    expect(inWs('a', () => idps.list().map((e) => e.id))).toEqual(['acme']);
    expect(inWs('b', () => idps.list())).toEqual([]);
    expect(idps.list()).toEqual([]);
  });

  it('10. trace events pushed for A are absent from B', () => {
    inWs('a', () => traceSinkFor().push({ trace_id: 't1' }));
    expect(traceSinkFor('a').list()).toHaveLength(1);
    expect(traceSinkFor('b').list()).toEqual([]);
    expect(traceSinkFor('a')).toBe(traceSinkFor('a'));
  });

  it('11. reset in A leaves B\'s files and sessions', async () => {
    inWs('a', () => register('a@pingidentity.com'));
    inWs('b', () => register('b@pingidentity.com'));
    const ca = await seedSession('a');
    const cb = await seedSession('b');
    const app = appFor();
    const res = await request(app).post('/api/admin/reset').set('x-test-ws', 'a').set('Origin', ORIGIN).set('Cookie', ca).send({ confirm: 'reset' });
    expect(res.status).toBe(200);
    expect(res.body.sessionsCleared).toBe(true);
    expect(fs.existsSync(file('ws', 'a', 'registrations.json'))).toBe(false);
    expect(fs.existsSync(file('ws', 'b', 'registrations.json'))).toBe(true);
    expect((await request(app).get('/api/registrations').set('x-test-ws', 'a').set('Cookie', ca)).status).toBe(401);
    expect((await request(app).get('/api/registrations').set('x-test-ws', 'b').set('Cookie', cb)).body.registrations).toHaveLength(1);
  });

  it('12. ids ../x, A, empty and 64 characters answer 400 bad_workspace', async () => {
    for (const bad of ['../x', 'A', '', 'a'.repeat(64)]) {
      const res = await request(createApp({ workspaceResolver: () => bad })).get('/api/customer-config');
      expect([bad, res.status, res.body.error]).toEqual([bad, 400, 'bad_workspace']);
    }
    const throwing = await request(createApp({ workspaceResolver: () => { throw new Error('x'); } })).get('/api/customer-config');
    expect(throwing.status).toBe(400);
    expect(validWorkspaceId('a'.repeat(63))).toBe(true);
    expect(workspaceDir('/r', 'default')).toBe('/r');
    expect(workspaceDir('/r', 'a-1')).toBe(path.join('/r', 'ws', 'a-1'));
  });

  it('13. the single-tenant routes answer 403 workspace_not_supported in a non-default workspace', async () => {
    const app = appFor();
    const cookie = await seedSession('a');
    const hit = (m, p) => request(app)[m](p).set('x-test-ws', 'a').set('Origin', ORIGIN).set('Cookie', cookie).send({});
    for (const [m, p] of [['post', '/api/registrations/x/approve'], ['get', '/api/doctor'], ['get', '/api/id-jag-playground/config'],
      ['post', '/api/id-jag-playground/trusted-idps/acme/approve'], ['get', '/api/id-jag-playground/trusted-idps/registry'], ['post', '/api/inspect/decode']]) {
      const res = await hit(m, p);
      expect([p, res.status, res.body.error]).toEqual([p, 403, 'workspace_not_supported']);
    }
  });

  it('14. the workspace survives an awaited fetch and fs inside one handler', async () => {
    const seen = [];
    await Promise.all(['a', 'b'].map((ws) => runInWorkspace(ws, async () => {
      seen.push(currentWorkspace());
      await fs.promises.readdir(root);
      await new Promise((r) => setTimeout(r, ws === 'a' ? 15 : 1));
      await Promise.resolve();
      seen.push(`${ws}:${currentWorkspace()}`);
    })));
    expect(seen.filter((s) => s.includes(':')).sort()).toEqual(['a:a', 'b:b']);
    // and through express-session: the session read inside a request still sees its workspace
    const cookie = await seedSession('a');
    const res = await request(appFor()).get('/api/registrations').set('x-test-ws', 'a').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(fs.existsSync(file('ws', 'a'))).toBe(false); // reading creates nothing; workspace was 'a' throughout (200 needs a:-prefixed session)
  });

  it('15. 20 interleaved A and B requests never cross', async () => {
    inWs('a', () => register('a@pingidentity.com'));
    inWs('b', () => { register('b1@pingidentity.com'); register('b2@pingidentity.com'); });
    const app = appFor();
    const cookies = { a: await seedSession('a'), b: await seedSession('b') };
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => {
      const ws = i % 2 ? 'b' : 'a';
      return request(app).get('/api/registrations').set('x-test-ws', ws).set('Cookie', cookies[ws]).then((r) => [ws, r.body.registrations.map((x) => x.email)]);
    }));
    for (const [ws, emails] of results) expect(emails.every((e) => e.startsWith(ws))).toBe(true);
    expect(results.filter(([ws]) => ws === 'a').every(([, e]) => e.length === 1)).toBe(true);
    expect(results.filter(([ws]) => ws === 'b').every(([, e]) => e.length === 2)).toBe(true);
  });

  it('16. nothing outside workspace.js and config.js reads the data dir directly', () => {
    const base = path.resolve(import.meta.dirname, '../../..');
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', '__tests__', 'dist'].includes(e.name)) walk(p); } else if (/\.(m?js)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p);
    });
    walk(path.join(base, 'server/src'));
    walk(path.join(base, 'scripts'));
    const allowed = ['server/src/workspace.js', 'server/src/config.js'].map((f) => path.join(base, f));
    const bad = files.filter((f) => !allowed.includes(f)).filter((f) => readsDataDir(fs.readFileSync(f, 'utf8')));
    expect(bad.map((f) => path.relative(base, f))).toEqual([]);
  });

  it('16b. the data-dir lint flags every way of reading it and ignores unrelated code', () => {
    const flagged = [
      "const d = config().dataDir;", "const d = config()['dataDir'];", 'const d = config()["dataDir"];', 'const d = config()[`dataDir`];',
      "const k = config(); const d = k.dataDir;", "const k = config();\nx(k['dataDir']);", "let conf; conf = config();\nuse(conf.dataDir);",
      "const { dataDir } = config();", "const { dataDir: where } = config();", "const { port, dataDir: where } = config();",
      "const k = config(); const { dataDir: where } = k;", "const d = cfg.dataDir;", "const d = c.dataDir;",
    ];
    for (const src of flagged) expect([src, readsDataDir(src)]).toEqual([src, true]);
    const fine = ["const { port } = config();", "const d = dataDir();", "const x = other.dataDir;", "const k = config(); use(k.port);", "const d = workspaceDir('a');"];
    for (const src of fine) expect([src, readsDataDir(src)]).toEqual([src, false]);
  });

  it('17. the routes that reach tries, hits and probes answer 403 in a non-default workspace', async () => {
    const app = appFor();
    const hit = (m, p) => request(app)[m](p).set('x-test-ws', 'a').set('Origin', ORIGIN).send({});
    for (const [m, p] of [['post', '/api/register'], ['post', '/api/registrations/x/reject'], ['get', '/api/id-jag-playground/backends'], ['get', '/api/id-jag-playground/preflight'],
      ['get', '/api/id-jag-playground/issuer/pi-flow/start'], ['post', '/api/inspect/decode'], ['get', '/api/inspect/discovery']]) {
      const res = await hit(m, p);
      expect([p, res.status, res.body.error]).toEqual([p, 403, 'workspace_not_supported']);
    }
    // /auth/pi-flow/* (tries) is the base sign-in: it is reached only with a live PF, absent here
  });
});
