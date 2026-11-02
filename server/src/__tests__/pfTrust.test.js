// PF_CA_FILE: the local PingFederate's certificate is trusted for PF_URL's origin only, never globally.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { caFor, fetchWithCa, trustedFetch } from '../pfTrust.js';
import { createNetguard } from '../netguard.js';
import { outboundFetch } from '../outbound.js';

const PF = 'https://127.0.0.1:4732';
const ENV = { PF_URL: PF, PF_CA_FILE: '/ca.pem' };
const read = () => Buffer.from('PEM');

describe('caFor', () => {
  it('returns the CA for PF_URL\'s origin only (string or Request-like), https only', () => {
    expect(caFor(`${PF}/pf/JWKS`, ENV, read)).toEqual(Buffer.from('PEM'));
    expect(caFor({ url: `${PF}/as/token.oauth2` }, ENV, read)).toBeDefined();
    expect(caFor('https://127.0.0.1:4733/', ENV, read)).toBeUndefined();
    expect(caFor('https://localhost:4732/', ENV, read)).toBeUndefined();
    expect(caFor('https://pf.example.invalid/', ENV, read)).toBeUndefined();
    expect(caFor('http://127.0.0.1:4732/', ENV, read)).toBeUndefined();
    expect(caFor('http://127.0.0.1:4732/', { ...ENV, PF_URL: 'http://127.0.0.1:4732' }, read)).toBeUndefined(); // a CA is for TLS: never for plain http, even if PF_URL says http
    expect(caFor('not a url', ENV, read)).toBeUndefined();
  });
  it('is off without PF_CA_FILE or PF_URL, and when the file cannot be read', () => {
    expect(caFor(`${PF}/`, { PF_URL: PF }, read)).toBeUndefined();
    expect(caFor(`${PF}/`, { PF_CA_FILE: '/ca.pem' }, read)).toBeUndefined();
    expect(caFor(`${PF}/`, ENV, () => { throw new Error('ENOENT'); })).toBeUndefined();
  });
});

describe('trustedFetch', () => {
  it('uses the global fetch for any other host, and for PF_URL when no CA is configured', async () => {
    const f = vi.fn(async () => new Response('x'));
    vi.stubGlobal('fetch', f);
    vi.stubEnv('PF_URL', PF);
    vi.stubEnv('PF_CA_FILE', '');
    try {
      await trustedFetch('https://example.invalid/', { method: 'GET' });
      await trustedFetch(`${PF}/pf/JWKS`);
      expect(f).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });
  it('is what the netguard sends real calls through, so mock mode still refuses real hosts', async () => {
    const guard = createNetguard({ mode: () => 'mock', mock: { origins: new Set(), fetch: async () => new Response('m') }, realFetch: trustedFetch });
    await expect(guard.fetch('https://pf.example.invalid/')).rejects.toMatchObject({ code: 'NETGUARD_REFUSED' });
  });
});

describe('fetchWithCa over a real TLS socket', () => {
  let dir; let server; let url; let seen;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-pftrust-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
    server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen = { method: req.method, url: req.url, headers: req.headers, body };
        if (req.url === '/moved') { res.writeHead(302, { location: '/elsewhere' }); return res.end(); }
        if (req.url === '/empty') { res.writeHead(204); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
        return res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `https://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const ca = () => fs.readFileSync(path.join(dir, 'c.pem'));

  it('verifies the certificate against the CA and returns a real Response (json, status, every Set-Cookie)', async () => {
    const r = await fetchWithCa(`${url}/pf/JWKS`, { headers: { Accept: 'application/json' } }, ca());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(seen.headers.accept).toBe('application/json');
  });
  it('sends method, headers and a form body, and does not follow redirects (the pi.flow driver reads them)', async () => {
    const form = new URLSearchParams({ grant_type: 'x', a: 'b c' });
    await fetchWithCa(`${url}/as/token.oauth2`, { method: 'POST', body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, ca());
    expect(seen).toMatchObject({ method: 'POST', body: 'grant_type=x&a=b+c' });
    const moved = await fetchWithCa(`${url}/moved`, { redirect: 'manual' }, ca());
    expect(moved.status).toBe(302);
    expect(moved.headers.get('location')).toBe('/elsewhere');
    expect((await fetchWithCa(`${url}/empty`, {}, ca())).status).toBe(204);
  });
  it('refuses a certificate the CA does not vouch for, and honours the abort signal', async () => {
    await expect(fetchWithCa(`${url}/`, {}, undefined)).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const other = fs.readFileSync(path.join(dir, 'k.pem')); // not a certificate: nothing verifies
    await expect(fetchWithCa(`${url}/`, {}, other)).rejects.toBeDefined();
    await expect(fetchWithCa(`${url}/`, { signal: AbortSignal.abort() }, ca())).rejects.toBeDefined();
  });
  it('the app\'s own door (outboundFetch, the real netguard) reaches PF_URL through the CA', async () => {
    vi.stubEnv('PF_URL', url);
    vi.stubEnv('PF_CA_FILE', path.join(dir, 'c.pem'));
    try { expect((await outboundFetch(`${url}/pf/JWKS`)).status).toBe(200); } finally { vi.unstubAllEnvs(); }
  });
  it('trustedFetch applies the CA to PF_URL\'s origin only: the same server under another origin is not trusted', async () => {
    const port = new URL(url).port;
    vi.stubEnv('PF_URL', url);
    vi.stubEnv('PF_CA_FILE', path.join(dir, 'c.pem'));
    try {
      expect((await trustedFetch(`${url}/x`)).status).toBe(200);
      // Same server, same certificate, but localhost is not PF_URL's origin: no CA, so Node's default trust applies and refuses it.
      await expect(trustedFetch(`https://localhost:${port}/x`)).rejects.toBeDefined();
    } finally { vi.unstubAllEnvs(); }
  });
});
