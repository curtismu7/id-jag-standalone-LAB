import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoJson } from '../../demoJson.js';
import { activeAdapter } from '../index.js';
import { _usePfAdmin, checkValidatorWrite, createPfAdmin } from '../pfAdmin.js';
import pfLocal from '../pf-local.js';
import { adapterContract } from './adapterContract.js';
import { createFakePf, row } from './fakePf.js';

const SENTINELS = {
  PF_ADMIN_URL: 'https://sentinel-admin-host.invalid:9999', PF_ADMIN_USER: 'sentinel-admin-user', PF_ADMIN_PASSWORD: 'sentinel-admin-password',
};
const KEYS = [...Object.keys(SENTINELS), 'PF_ADMIN_INSECURE_TLS', 'PF_EXCHANGE_CLIENT_ID', 'ADMIN_EMAILS', 'DATA_DIR', 'IDP', 'APP_ORIGIN', 'NODE_ENV'];
const saved = {};
let dir;
let fake;

beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } _usePfAdmin(null); });
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfl-'));
  process.env.DATA_DIR = dir;
  Object.assign(process.env, SENTINELS, { PF_EXCHANGE_CLIENT_ID: 'kit' });
  fake = createFakePf();
  _usePfAdmin(createPfAdmin({ send: fake.send }));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); _usePfAdmin(null); });

const approve = (...emails) => fs.writeFileSync(path.join(dir, 'registrations.json'), JSON.stringify(emails.map((email) => ({ email, status: 'approved' }))));

// The contract's fakes see the same fake PF the shared client talks to (rebuilt before each test above).
adapterContract(pfLocal, {
  sentinels: SENTINELS,
  setUsers: (e) => fake.setUsers(e),
  breakNetwork: (on) => { if (fake) fake.down = on; },
});

describe('pf-local adapter', () => {
  it('is the active adapter by default and takes its setup script from demo.json', () => {
    expect(activeAdapter({})).toBe(pfLocal);
    expect(pfLocal.setup.script).toBe(demoJson().provider.setupScripts['pf-local']);
    expect(fs.existsSync(path.resolve(import.meta.dirname, '../../../../', pfLocal.setup.script))).toBe(true);
    expect(pfLocal.setup.needsUsers).toBe(true);
  });
  it('the fake answers 422 on an empty Users table, so remove keeps the last user without a write', async () => {
    const empty = await fake.send('http://x/pf-admin-api/v1/passwordCredentialValidators/idJagKitPcv', { method: 'PUT', body: JSON.stringify({ configuration: { tables: [{ name: 'Users', rows: [] }] } }) });
    expect(empty.status).toBe(422);
    fake.calls.length = 0;
    expect(await pfLocal.users.remove('setup@example.test')).toEqual({ removed: false, kept: true });
    expect(fake.calls).toEqual(['GET /passwordCredentialValidators/idJagKitPcv']);
  });
  it('add then remove an app-added user through idp.users', async () => {
    await pfLocal.users.add('new@example.test', 'a-long-enough-password');
    expect(fake.emails()).toEqual(['setup@example.test', 'new@example.test']);
    approve('new@example.test');
    expect(await pfLocal.users.remove('new@example.test')).toEqual({ removed: true, kept: false });
    expect(fake.emails()).toEqual(['setup@example.test']);
  });
  it('refuses to remove a user the app did not add, and the anchor user', async () => {
    fake.setUsers(['setup@example.test', 'other@example.test']);
    await expect(pfLocal.users.remove('other@example.test')).rejects.toMatchObject({ code: 'pf_admin_forbidden' });
    approve('setup@example.test');
    await expect(pfLocal.users.remove('setup@example.test')).rejects.toMatchObject({ code: 'pf_admin_forbidden' });
    expect(fake.emails()).toEqual(['setup@example.test', 'other@example.test']);
  });
});

describe('PF admin method and path allowlist', () => {
  const V = '/passwordCredentialValidators/idJagKitPcv';
  const mk = () => createPfAdmin({ send: fake.send });
  it.each([
    ['GET', V], ['PUT', V], ['POST', V], ['DELETE', V], ['GET', '/passwordCredentialValidators'], ['GET', '/passwordCredentialValidators/other'],
    ['GET', '/oauth/clients/kit'], ['GET', '/oauth/clients/other'], ['PUT', '/oauth/clients/kit'], ['POST', '/oauth/clients/kit'], ['DELETE', '/oauth/clients/kit'],
    ['GET', '/serverSettings'], ['POST', '/oauth/clients'],
  ])('%s %s', async (method, p) => {
    const allowedPair = (method === 'GET' && (p === V || p === '/oauth/clients/kit')) || (method === 'PUT' && p === V);
    const c = mk();
    fake.calls.length = 0;
    if (method === 'PUT') await c.call('GET', V); // so a PUT is judged by the allowlist, not for lacking a fetch
    fake.calls.length = 0;
    const body = method === 'PUT' ? fake.validator : undefined;
    if (allowedPair) await expect(c.call(method, p, body)).resolves.toMatchObject({ status: 200 });
    else {
      await expect(c.call(method, p, body)).rejects.toMatchObject({ code: 'pf_admin_forbidden' });
      expect(fake.calls).toEqual([]); // refused before any network I/O
    }
  });
  it('a PUT without a fetch in the same call is refused', async () => {
    // the dedicated "fetch first" branch, not checkValidatorWrite failing on a missing document
    await expect(mk().call('PUT', V, fake.validator)).rejects.toMatchObject({ code: 'pf_admin_forbidden', message: expect.stringContaining('fetch the validator first') });
    expect(fake.calls).toEqual([]);
  });
});

describe('validator write is add-only', () => {
  const doc = (rows) => ({ id: 'v', configuration: { fields: [{ name: 'a', value: '1' }], tables: [{ name: 'Users', rows }] } });
  const F = [row('anchor@x'), row('app@x'), row('other@x')];
  const opt = { adminEmails: ['boss@x'], appAdded: new Set(['app@x']) };
  const fetched = doc(F);
  it('one appended row passes', () => expect(() => checkValidatorWrite(fetched, doc([...F, row('new@x')]), opt)).not.toThrow());
  it('a changed password is refused', () => expect(() => checkValidatorWrite(fetched, doc([F[0], row('app@x', 'changed'), F[2]]), opt)).toThrow(/existing row changed/));
  it('two added rows are refused', () => expect(() => checkValidatorWrite(fetched, doc([...F, row('a@x'), row('b@x')]), opt)).toThrow(/more than one/));
  it('reordering is refused', () => expect(() => checkValidatorWrite(fetched, doc([F[1], F[0], F[2]]), opt)).toThrow(/forbidden|changed|removed|add/));
  it('a change outside the Users table is refused', () => {
    const b = doc([...F, row('n@x')]);
    b.configuration.fields[0].value = '2';
    expect(() => checkValidatorWrite(fetched, b, opt)).toThrow(/only the Users table/);
  });
  it('removing the anchor row is refused', () => expect(() => checkValidatorWrite(fetched, doc([F[1], F[2]]), { ...opt, appAdded: new Set(['anchor@x']) })).toThrow(/anchor/));
  it('removing a row the app did not add is refused', () => expect(() => checkValidatorWrite(fetched, doc([F[0], F[1]]), opt)).toThrow(/only users this app added/));
  it('removing an ADMIN_EMAILS user is refused', () => expect(() => checkValidatorWrite(fetched, doc([F[0], F[2]]), { adminEmails: ['app@x'], appAdded: new Set(['app@x']) })).toThrow(/admin user/));
  it('removing an app-added row passes', () => expect(() => checkValidatorWrite(fetched, doc([F[0], F[2]]), opt)).not.toThrow());
  it('removing and adding in one call is refused', () => expect(() => checkValidatorWrite(fetched, doc([F[0], F[2], row('new@x')]), opt)).toThrow());
});

describe('2-failure latch', () => {
  it('latches after two 401/403 answers for 15 minutes without touching the network, and a later success clears it', async () => {
    let t = 1_000_000;
    const c = createPfAdmin({ send: fake.send, now: () => t });
    const V = '/passwordCredentialValidators/idJagKitPcv';
    fake.status = 401;
    await c.call('GET', V);
    expect(c.latch().locked).toBe(false);
    fake.status = 403;
    await c.call('GET', V);
    expect(c.latch().locked).toBe(true);
    fake.calls.length = 0;
    await expect(c.call('GET', V)).rejects.toMatchObject({ code: 'pf_admin_locked' });
    expect(fake.calls).toEqual([]);
    t += 900_000 - 1; // literal: the latch is 15 minutes
    await expect(c.call('GET', V)).rejects.toMatchObject({ code: 'pf_admin_locked' });
    t += 2;
    fake.status = null;
    await expect(c.call('GET', V)).resolves.toMatchObject({ status: 200 });
    expect(c.latch().locked).toBe(false);
  });
  it('one failure between successes does not latch', async () => {
    const c = createPfAdmin({ send: fake.send });
    const V = '/passwordCredentialValidators/idJagKitPcv';
    fake.status = 401; await c.call('GET', V);
    fake.status = null; await c.call('GET', V);
    fake.status = 401; await c.call('GET', V);
    expect(c.latch().locked).toBe(false);
  });
  it('doctor reports the latch without calling', async () => {
    let t = 5;
    const c = createPfAdmin({ send: fake.send, now: () => t });
    fake.status = 401;
    const V = '/passwordCredentialValidators/idJagKitPcv';
    await c.call('GET', V); await c.call('GET', V);
    _usePfAdmin(c);
    fake.calls.length = 0;
    const out = await pfLocal.doctor({ env: process.env });
    expect(out[0]).toMatchObject({ id: 'pf-admin', status: 'fail' });
    expect(out[0].message).toMatch(/paused/);
    expect(fake.calls).toEqual([]);
  });
  it('doctor makes one attempt and never retries a refused credential', async () => {
    fake.status = 401;
    await pfLocal.doctor({ env: process.env });
    expect(fake.calls).toEqual(['GET /passwordCredentialValidators/idJagKitPcv']);
  });
});

describe('pf-admin-account and TLS rules', () => {
  const run = async (env) => (await pfLocal.doctor({ env: { ...process.env, PF_ADMIN_USER: '', ...env } })).find((c) => c.id === 'pf-admin-account');
  it('fails for administrator when production-like, warns otherwise', async () => {
    expect((await run({})).status).toBe('warn');
    expect((await run({ NODE_ENV: 'production' })).status).toBe('fail');
    expect((await run({ APP_ORIGIN: 'https://demo.example.com' })).status).toBe('fail');
    expect((await run({ APP_ORIGIN: 'http://127.0.0.1:4720' })).status).toBe('warn');
    expect((await run({ PF_ADMIN_USER: 'kit-admin', NODE_ENV: 'production' })).status).toBe('pass');
  });
  it('PF_ADMIN_INSECURE_TLS in production fails the doctor and blocks the call', async () => {
    const env = { PF_ADMIN_INSECURE_TLS: 'true', NODE_ENV: 'production' };
    expect((await pfLocal.doctor({ env: { ...process.env, ...env } })).find((c) => c.id === 'pf-admin-tls').status).toBe('fail');
    Object.assign(process.env, env);
    await expect(createPfAdmin({ send: fake.send }).call('GET', '/passwordCredentialValidators/idJagKitPcv')).rejects.toMatchObject({ code: 'pf_admin_forbidden' });
  });
  it('a validator with no users fails pf-anchor-user', async () => {
    fake.validator.configuration.tables[0].rows = [];
    expect((await pfLocal.doctor({ env: process.env })).find((c) => c.id === 'pf-anchor-user').status).toBe('fail');
  });
});

describe('redaction', () => {
  it('the admin URL, user and password appear in no console output, error, or doctor message (PF down, 401, 500)', async () => {
    const out = [];
    const spies = ['log', 'warn', 'error', 'info'].map((m) => vi.spyOn(console, m).mockImplementation((...a) => out.push(a.join(' '))));
    for (const mode of ['down', 401, 500]) {
      fake.down = mode === 'down'; fake.status = typeof mode === 'number' ? mode : null;
      _usePfAdmin(createPfAdmin({ send: fake.send }));
      out.push(JSON.stringify(await pfLocal.doctor({ env: process.env })));
      for (const f of [() => pfLocal.users.add('r@example.test', 'a-long-enough-password'), () => pfLocal.users.count()]) {
        try { await f(); } catch (e) { out.push(String(e.message)); }
      }
    }
    spies.forEach((s) => s.mockRestore());
    const all = out.join('\n');
    for (const v of Object.values(SENTINELS)) expect(all).not.toContain(v);
    expect(all).not.toContain('sentinel-admin-host');
  });
});
