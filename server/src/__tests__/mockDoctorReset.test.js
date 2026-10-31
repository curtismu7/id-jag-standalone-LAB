// Doctor and reset in mock mode (the live paths are covered by doctor.test.js and reset.test.js).
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { runDoctor } from '../doctor.js';
import { ORIGINS } from '../mock/env.js';
import { netguard, outboundFetch } from '../outbound.js';
import { API, ORIGIN, expectNoRealCalls, post, signInApp, signInIssuer, useMockMode } from './mockHelpers.js';

const mock = useMockMode();
const noRealCalls = () => expectNoRealCalls(mock);

describe('doctor in mock mode', () => {
  it('passes with no live settings at all, proving the netguard and the mock servers', async () => {
    for (const mode of ['mock', 'pf-as', 'pf-pf']) {
      const rep = await runDoctor({ mode, skip: ['port'] });
      const bad = rep.checks.filter((c) => c.status === 'fail');
      expect({ mode, bad }).toEqual({ mode, bad: [] });
      expect(rep).toMatchObject({ ok: true, appMode: 'mock' });
      const ids = rep.checks.map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining(['netguard', 'mock-signin', 'mock-pf']));
    }
    const full = await runDoctor({ mode: 'pf-as', skip: ['port'] });
    expect(full.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['pf-admin', 'pf-validator', 'pf-anchor-user', 'pi-flow-client', 'resource-as', 'mcp']));
    noRealCalls();
  });

  it('fails when the netguard self-test says the guard leaks, and warns when mock sign-in is off', async () => {
    const spy = vi.spyOn(netguard, 'selfTest').mockResolvedValue({ ok: false, checks: [{ name: 'mock mode refuses a real host (fetch)', ok: false }] });
    vi.stubEnv('ALLOW_MOCK_SIGNIN', '');
    const rep = await runDoctor({ mode: 'mock', skip: ['port'] });
    spy.mockRestore();
    expect(rep.ok).toBe(false);
    expect(rep.checks.find((c) => c.id === 'netguard')).toMatchObject({ status: 'fail', message: expect.stringContaining('leaking') });
    expect(rep.checks.find((c) => c.id === 'mock-signin').status).toBe('warn');
  });
});

describe('reset in mock mode', () => {
  it('clears the mock data, registered users, sessions and the mock servers\' memory, and keeps the saved mode', async () => {
    const app = createApp();
    const admin = request.agent(app);
    await signInApp(admin);
    const reg = await request(app).post('/api/register').set('Origin', ORIGIN).send({ email: 'dave@mock.example', password: 'a-long-enough-password' }).expect(201);
    await post(admin, `/api/registrations/${reg.body.id}/approve`).expect(200);
    await post(admin, `${API}/mode`, { mode: 'pf-as' });
    await signInIssuer(admin);
    await post(admin, `${API}/issue`).expect(200);
    await post(admin, `${API}/redeem`).expect(200);
    const events = async () => (await (await outboundFetch(`${ORIGINS.as}/events`)).json()).events;
    expect(await events()).toHaveLength(1);
    fs.writeFileSync(path.join(mock.tmp, 'mode.json'), '{"mode":"mock"}');

    const res = await post(admin, '/api/admin/reset', { confirm: 'reset' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, mode: 'mock', registrations: 1, users: ['dave@mock.example'] });
    expect(fs.existsSync(path.join(mock.tmp, 'mock', 'registrations.json'))).toBe(false);
    expect(fs.existsSync(path.join(mock.tmp, 'mode.json'))).toBe(true); // reset keeps saved settings
    expect(await events()).toHaveLength(0); // the mock resource AS forgot its record
    await admin.get('/api/me').expect(401); // sessions are gone
    const dave = await signInApp(request.agent(app), { username: 'dave@mock.example', password: 'a-long-enough-password' });
    expect(dave.status).toBe(401); // removed from the mock PingFederate through its admin API
    await signInApp(request.agent(app)); // the anchor user stays
  });
});
