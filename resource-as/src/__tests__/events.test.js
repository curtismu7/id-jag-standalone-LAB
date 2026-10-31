// The resource AS's own record of /token decisions: /events and the HTML page.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHandler } from '../app.js';
import { maskSub } from '../events.js';
import { listen, mintIdJag, newRsaKey, startTestIdp } from '../../test/helpers.js';

const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const AS_ISSUER = 'https://as.example.test';
const RESOURCE = 'https://mcp.example.test/mcp';
const signingKey = newRsaKey();
let idp;
const open = [];
beforeAll(async () => { idp = await startTestIdp(); });
afterAll(() => idp.close());
afterEach(async () => { await Promise.all(open.splice(0).map((s) => s.close())); });

async function startAs(idps) {
  const srv = await listen(createHandler({
    issuer: AS_ISSUER, acceptedResources: [RESOURCE], allowPublicClients: true, signingKey, log: () => {},
    clients: [{ client_id: 'agent-1', scope: 'read mcp:invoke' }],
    idps: idps ?? [{ id: 'test', issuer: idp.issuer, jwksUrl: idp.jwksUrl, clientAliases: { 'agent-1': 'agent-1' }, scopes: '' }],
  }));
  open.push(srv);
  return srv;
}
const redeem = (as, assertion, clientId = 'agent-1') => fetch(`${as.url}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: JWT_BEARER, assertion, client_id: clientId }),
});
const events = async (as) => (await (await fetch(`${as.url}/events`)).json());
const goodJag = (claims = {}) => mintIdJag(idp, { audience: AS_ISSUER, resource: RESOURCE }, claims);

describe('maskSub', () => {
  it('masks emails and other subjects', () => {
    expect(maskSub('jane@pingone.com')).toBe('j***@pingone.com');
    expect(maskSub('user-123')).toBe('user…');
    expect(maskSub(undefined)).toBeUndefined();
  });
});

describe('GET /events', () => {
  it('records an accepted redemption with masked sub and jti prefix, newest first', async () => {
    const as = await startAs();
    await redeem(as, await goodJag({ sub: 'jane@pingone.com', jti: 'abcdefgh-1234' }));
    await redeem(as, await goodJag({ sub: 'user-123', jti: '12345678-zzzz' }));
    const res = await fetch(`${as.url}/events`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const body = await res.json();
    expect(body.issuer).toBe(AS_ISSUER);
    expect(body.events.map((e) => e.sub)).toEqual(['user…', 'j***@pingone.com']);
    expect(body.events[1]).toMatchObject({
      decision: 'accepted', iss: idp.issuer, client_id: 'agent-1', aud: RESOURCE, scope: 'read mcp:invoke', jti: 'abcdefgh…',
    });
    expect(Date.parse(body.events[1].at)).not.toBeNaN();
  });

  it('records refusals with their reason', async () => {
    const as = await startAs();
    await redeem(as, await goodJag({ aud: 'https://other.example.test' }));
    const [e] = (await events(as)).events;
    expect(e).toMatchObject({ decision: 'refused', error: 'invalid_grant', client_id: 'agent-1', iss: idp.issuer });
    expect(e.reason).toMatch(/verification failed/);
  });

  it('never contains an assertion, token or secret', async () => {
    const as = await startAs();
    const jag = await goodJag();
    const ok = await (await redeem(as, jag)).json();
    await redeem(as, jag); // replay refusal
    await redeem(as, `${jag}x`);
    const text = JSON.stringify(await events(as)) + await (await fetch(`${as.url}/`)).text();
    for (const secret of [jag, jag.split('.')[1], jag.split('.')[2], ok.access_token]) expect(text).not.toContain(secret);
  });

  it('keeps the newest 50', async () => {
    const as = await startAs();
    for (let i = 0; i < 53; i++) await redeem(as, 'not-a-jwt', `c${i}`);
    const { events: list } = await events(as);
    expect(list).toHaveLength(50);
    expect(list[0].client_id).toBe('c52');
    expect(list[49].client_id).toBe('c3');
  });
});

describe('GET /', () => {
  it('serves a script-free page with a CSP, links and the trusted IdPs', async () => {
    const as = await startAs();
    await redeem(as, await goodJag());
    const res = await fetch(`${as.url}/`);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY'); // the page cannot be framed (clickjacking)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('Resource authorization server');
    expect(html).toContain('http-equiv="refresh" content="5"');
    expect(html).toContain('/.well-known/oauth-authorization-server');
    expect(html).toContain('href="/jwks"');
    expect(html).toContain(idp.issuer);
    expect(html).toContain('Accepted');
    expect(html).not.toMatch(/<script/i);
  });

  it('escapes caller-controlled client_id and iss', async () => {
    const evil = '<script>alert(1)</script>"\'';
    const as = await startAs();
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: evil })).toString('base64url')}.x`;
    await redeem(as, unsigned, evil);
    const html = await (await fetch(`${as.url}/`)).text();
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;');
    expect(html).toContain('Refused');
  });
});
