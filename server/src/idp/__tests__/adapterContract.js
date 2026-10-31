// Shared IdP adapter contract test (design 4.4). Every adapter's test file calls adapterContract(adapter, fakes).
//   fakes.sentinels   env values to plant (PF_ADMIN_URL ...); none may surface in a doctor() result or a thrown message
//   fakes.setUsers(emails)   the adapter's user store now holds exactly these users
//   fakes.breakNetwork(on)   the backing service now fails every call, with a message that carries the sentinels
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routesFor, validateAdapter } from '../contract.js';
import { getAdapter, registerAdapter } from '../index.js';

export function adapterContract(adapter, fakes) {
  describe(`adapter contract: ${adapter.id}`, () => {
    const saved = {};
    beforeEach(() => {
      for (const [k, v] of Object.entries(fakes.sentinels ?? {})) { saved[k] = process.env[k]; process.env[k] = v; }
    });
    afterEach(() => {
      for (const k of Object.keys(fakes.sentinels ?? {})) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      fakes.breakNetwork?.(false);
    });

    it('has the contract shape', () => {
      expect(() => validateAdapter(adapter)).not.toThrow();
      expect(['pi-flow', 'session']).toContain(adapter.signIn.driver);
    });

    it('available:false needs a reason and mounts no route', () => {
      expect(() => validateAdapter({ ...adapter, available: false, reason: '' })).toThrow(/reason/);
      const off = validateAdapter({ ...adapter, available: false, reason: 'not configured' });
      expect(routesFor(off)).toEqual([]);
      expect(routesFor(adapter).length).toBeGreaterThan(0);
    });

    it('rejects a redirect driver', () => {
      expect(() => validateAdapter({ ...adapter, signIn: { driver: 'redirect' } })).toThrow(/driver/);
    });

    it('a sign-in start route never answers with a redirect to an authorize URL', async () => {
      if (adapter.signIn.driver !== 'pi-flow') return;
      const app = express();
      app.use((req, _res, next) => { req.session = { save: (cb) => cb() }; next(); });
      for (const r of routesFor(adapter)) app[r.method](r.path, express.json(), r.handler);
      const res = await request(app).get('/auth/pi-flow/start').redirects(0);
      expect(res.status < 300 || res.status >= 400).toBe(true); // 503 not_configured is fine; a 3xx is not
      expect(res.headers.location).toBeUndefined();
    });

    it('users: null only when self-registration is off; remove of the last user reports kept', async () => {
      if (adapter.users === null) { expect(adapter.capabilities.selfRegistration).toBe(false); return; }
      fakes.setUsers(['only@example.test']);
      expect(await adapter.users.count()).toBe(1);
      expect(await adapter.users.remove('only@example.test')).toEqual({ removed: false, kept: true });
      expect(await adapter.users.count()).toBe(1);
    });

    it('no sentinel env value appears in a doctor() result or a thrown message', async () => {
      const seen = [];
      for (const down of [false, true]) {
        fakes.breakNetwork?.(down);
        try { seen.push(JSON.stringify(await adapter.doctor({ env: process.env }))); } catch (e) { seen.push(String(e?.message)); }
        if (adapter.users) {
          try { await adapter.users.add('x@example.test', 'a-long-enough-password'); } catch (e) { seen.push(String(e?.message)); }
          try { await adapter.users.count(); } catch (e) { seen.push(String(e?.message)); }
        }
      }
      const out = seen.join('\n');
      expect(out.length).toBeGreaterThan(0);
      for (const v of Object.values(fakes.sentinels ?? {})) expect(out).not.toContain(v);
    });

    it('the registry refuses an unknown or reserved id and returns the registered adapter', () => {
      expect(() => getAdapter('nope')).toThrow(/unknown IdP/);
      expect(() => registerAdapter({ ...adapter, id: 'nope' })).toThrow(/unknown id/);
      expect(() => registerAdapter({ ...adapter, id: 'p1' })).toThrow(/reserved/);
      expect(getAdapter(adapter.id)).toBe(adapter);
    });
  });
}
