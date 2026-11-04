// The live run of the AWS AgentCore leg, engine level: real leg 1 (exchange) and leg 2 (redemption) against stubbed
// HTTP, the runtime hop refusing, and the custody rule: no real token ever appears in the answer.
import { describe, expect, it, vi } from 'vitest';
import { LIVE_RUNTIME_MISSING, liveRun } from '../agentcoreRedeem.js';
import { netguard } from '../outbound.js';

// Live-mode env for config(). The secrets come from the environment, never from a response.
vi.stubEnv('PF_URL', 'https://pf.example.invalid');
vi.stubEnv('PF_EXCHANGE_CLIENT_ID', 'pf-exchange-client');
vi.stubEnv('PF_EXCHANGE_CLIENT_SECRET', 'exchange-secret-value-1');
vi.stubEnv('RESOURCE_AS_ISSUER', 'https://as.example.invalid');
vi.stubEnv('RESOURCE_AS_CLIENT_ID', 'id-jag-playground');
vi.stubEnv('RESOURCE_AS_CLIENT_SECRET', 'resource-as-secret-value-1');
vi.stubEnv('ID_JAG_RESOURCE', 'https://as.example.invalid/mcp');
vi.stubEnv('ID_JAG_SCOPE', 'tools:invoke');

const REFRESH = 'header.eyJzdWIiOiJhbGljZSIsInR5cCI6InJ0In0.sig-refresh'; // not a JWT the decoder can read
const ID_JAG = ['eyJhbGciOiJSUzI1NiIsInR5cCI6Im9hdXRoLWlkLWphZytqd3QifQ', Buffer.from(JSON.stringify({
  iss: 'https://pf.example.invalid', sub: 'alice', aud: 'https://as.example.invalid', client_id: 'id-jag-playground',
  scope: 'tools:invoke', act: { sub: 'pf-exchange-client' }, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), jti: 'j1',
})).toString('base64url'), 'sig'].join('.');
const ACCESS = ['eyJhbGciOiJSUzI1NiIsInR5cCI6ImF0K2p3dCJ9', Buffer.from(JSON.stringify({
  iss: 'https://as.example.invalid', sub: 'alice', aud: 'https://as.example.invalid/mcp', client_id: 'id-jag-playground',
  scope: 'tools:invoke', act: { sub: 'pf-exchange-client' }, exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64url'), 'sig'].join('.') ;

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('liveRun', () => {
  it('leg 1 exchanges the session refresh token at PingFederate, leg 2 redeems at resource-as, the runtime hop refuses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: ID_JAG, issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag', token_type: 'N_A', expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600, scope: 'tools:invoke' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const out = await liveRun({ subjectToken: REFRESH, scopeOverride: 'tools:invoke' });
      // Leg 1 went to PingFederate with the refresh token as the subject and an ID-JAG requested.
      const [url1, init1] = fetchMock.mock.calls[0];
      expect(url1).toBe('https://pf.example.invalid/as/token.oauth2');
      const form1 = new URLSearchParams(init1.body);
      expect(form1.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
      expect(form1.get('subject_token')).toBe(REFRESH);
      expect(form1.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:refresh_token');
      expect(form1.get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:id-jag');
      expect(form1.get('audience')).toBe('https://as.example.invalid');
      expect(form1.get('resource')).toBe('https://as.example.invalid/mcp'); // ID_JAG_RESOURCE (stubbed below)
      expect(init1.headers.authorization).toMatch(/^Basic /);
      expect(out.leg1.isIdJag).toBe(true);
      // Leg 2 went to the kit's resource-as with the ID-JAG as the assertion.
      const [url2, init2] = fetchMock.mock.calls[1];
      expect(url2).toBe('https://as.example.invalid/token');
      const form2 = new URLSearchParams(init2.body);
      expect(form2.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      expect(form2.get('assertion')).toBe(ID_JAG);
      expect(out.redeemed).toBe(true);
      expect(out.leg2.decoded.claims.sub).toBe('alice');
      expect(out.leg2.decoded.claims.act).toEqual({ sub: 'pf-exchange-client' });
      // The runtime hop refuses: no live runtime is deployed.
      expect(out.refusal).toMatchObject({ stage: 'runtime', kind: 'not_deployed', error: 'runtime_not_deployed', status: 409 });
      expect(out.refusal.description).toBe(LIVE_RUNTIME_MISSING);
      expect(out.runtime).toBeNull();
      // Custody: no raw refresh token, ID-JAG or access token anywhere in the answer.
      const text = JSON.stringify(out);
      expect(text).not.toContain(REFRESH);
      expect(text).not.toContain(ID_JAG);
      expect(text).not.toContain(ACCESS);
      expect(text).not.toContain('exchange-secret-value-1');
      expect(text).not.toContain('resource-as-secret-value-1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('an exchange refusal comes back as an oauth refusal naming the stage', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant', error_description: 'the refresh token is revoked' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const out = await liveRun({ subjectToken: REFRESH });
      expect(out.redeemed).toBe(false);
      expect(out.refusal).toMatchObject({ stage: 'leg1', kind: 'oauth', error: 'invalid_grant', description: 'the refresh token is revoked' });
    } finally { vi.unstubAllGlobals(); }
  });

  it('an unreachable PingFederate is a network refusal, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { cause: { code: 'ECONNREFUSED' } })));
    try {
      const out = await liveRun({ subjectToken: REFRESH });
      expect(out.refusal).toMatchObject({ stage: 'leg1', kind: 'network', error: 'network' });
      expect(out.refusal.description).toMatch(/ECONNREFUSED/);
    } finally { vi.unstubAllGlobals(); }
  });

  it('a missing session refresh token is a sign-in refusal before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const out = await liveRun({ subjectToken: null });
      expect(out.refusal).toMatchObject({ stage: 'leg1', kind: 'session', error: 'sign_in_required' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
