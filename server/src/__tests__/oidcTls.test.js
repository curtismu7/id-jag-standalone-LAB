// Header sign-in against a PingFederate that has a self-signed certificate (the local PF): the ID token's keys must be
// fetched through the netguard, so PF_CA_FILE applies to them as it does to discovery and the token endpoint.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import auth, { authorizeRequest, discover, oidcConfig } from '../auth/oidc.js';
import { startProvider } from './oidcProvider.js';

let dir; let provider; let ca;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-oidctls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  ca = path.join(dir, 'c.pem');
  provider = await startProvider({ tls: { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(ca) } });
});
afterAll(async () => { await provider.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  provider.tokenRequests = [];
  vi.stubEnv('APP_ORIGIN', 'http://localhost:4720');
  vi.stubEnv('OIDC_ISSUER', provider.issuer);
  vi.stubEnv('PF_URL', provider.issuer);
  vi.stubEnv('OIDC_CLIENT_ID', 'id-jag-app');
  vi.stubEnv('OIDC_CLIENT_SECRET', 'secret');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function signIn() {
  const app = express();
  app.use(session({ name: 'demo.sid', secret: 'test-session-secret', resave: false, saveUninitialized: false }));
  app.use(auth);
  app.get('/test/login', async (req, res) => {
    const c = oidcConfig();
    const { login, url } = authorizeRequest(c, await discover(c.issuer), '/');
    req.session.oidcLogin = login;
    req.session.save(() => res.redirect(url.toString()));
  });
  const agent = request.agent(app);
  const login = await agent.get('/test/login');
  const { code, state } = provider.authorize(login.headers.location);
  return agent.get(`/auth/callback?${new URLSearchParams({ code, state })}`);
}

describe('/auth/callback with a self-signed https issuer', () => {
  it('signs in when PF_CA_FILE vouches for the certificate (the ID token keys come through the CA-aware door)', async () => {
    vi.stubEnv('PF_CA_FILE', ca);
    const cb = await signIn();
    expect(cb.status).toBe(302);
  });
  it('fails closed without PF_CA_FILE: the certificate is not trusted anywhere else', async () => {
    vi.stubEnv('PF_CA_FILE', '');
    const cb = await signIn().catch((e) => ({ status: 'threw', e }));
    expect(cb.status === 'threw' || cb.status === 400 || cb.status === 500).toBe(true);
  });
});
