import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountInterop, listTargets } from '../interop.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (h, c) => `${b64(h)}.${b64(c)}.c2ln`;
const reply = (status, data) => ({ status, json: async () => data });
let fetchMock;
const pass = (_req, _res, next) => next();

function app(over = {}) {
  const a = express();
  a.use(express.json());
  const r = express.Router();
  mountInterop(r, {
    requireReal: pass, modeOf: () => 'pf-as', basic: (i, s) => `Basic ${i}:${s}`, decodeJwt: (t) => ({ header: JSON.parse(Buffer.from(t.split('.')[0], 'base64url')), claims: JSON.parse(Buffer.from(t.split('.')[1], 'base64url')) }),
    exchangeRequest: (_req, scope) => ({ s: { idp: { tokenEndpoint: 'https://pf.test/as/token.oauth2', exchangeClientId: 'id-jag-kit' } }, auth: { Authorization: 'Basic x' }, body: new URLSearchParams({ scope }) }),
    postForm: async (url, form, headers) => { const r2 = await fetchMock(url, form, headers); return r2; },
    ...over,
  });
  a.use('/pg', r);
  return a;
}

beforeEach(() => { fetchMock = vi.fn(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('interop panel', () => {
  it('lists the three targets with the recorded result and what is missing', () => {
    const t = listTargets();
    expect(t.map((x) => [x.id, x.method, x.recorded.result])).toEqual([
      ['authplane', 'native', 'accepts'], ['xaa-dev', 'native', 'refuses'], ['motd', 'native', 'refuses'],
      ['xaa-dev-kid', 'kid', 'accepts'], ['motd-kid', 'kid', 'accepts']]);
    expect(t.find((x) => x.id === 'xaa-dev').missing).toEqual(['INTEROP_XAA_CLIENT_ID', 'INTEROP_XAA_CLIENT_SECRET']);
    expect(t.find((x) => x.id === 'motd').missing).toEqual([]);
  });

  it('motd: mints with the target audience, redeems unauthenticated with client_id, reports kid absent and the refusal', async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, data: { access_token: jwt({ typ: 'oauth-id-jag+jwt', alg: 'RS256', x5t: 'a' }, { iss: 'https://pf.test', aud: 'https://motd.xaa.rocks/', client_id: 'id-jag-kit' }) } })
      .mockResolvedValueOnce({ status: 400, data: { error: 'invalid_grant', error_description: "The JWT header is missing the 'kid' property" } });
    const res = await request(app()).post('/pg/interop/motd/run');
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][1].get('audience')).toBe('https://motd.xaa.rocks/');
    expect(fetchMock.mock.calls[1][0]).toBe('https://motd.xaa.rocks/token');
    expect(fetchMock.mock.calls[1][1].get('client_id')).toBe('id-jag-kit');
    expect(fetchMock.mock.calls[1][2]).toEqual({});
    expect(res.body.mint.header).toEqual({ typ: 'oauth-id-jag+jwt', alg: 'RS256', kid: false, x5t: true });
    expect(res.body.redeem).toMatchObject({ status: 400, accepted: false, error: 'invalid_grant' });
    expect(JSON.stringify(res.body)).not.toContain('c2ln'); // no token in the response
  });

  it('motd workaround: exchanges as the kid client for an access token (no scope), redeems with that client id, reports kid present', async () => {
    vi.stubEnv('INTEROP_KID_CLIENT_ID', 'kid-client');
    vi.stubEnv('INTEROP_KID_CLIENT_SECRET', 'kid-secret');
    fetchMock
      .mockResolvedValueOnce({ status: 200, data: { access_token: jwt({ typ: 'oauth-id-jag+jwt', alg: 'RS256', kid: 'k1' }, { iss: 'https://pf.test', aud: 'https://motd.xaa.rocks/', client_id: 'kid-client' }) } })
      .mockResolvedValueOnce({ status: 200, data: { access_token: 'at' } });
    const res = await request(app({ exchangeRequest: (_req, scope) => ({ s: { idp: { tokenEndpoint: 'https://pf.test/as/token.oauth2', exchangeClientId: 'id-jag-kit' } }, auth: { Authorization: 'Basic x' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: 'rt', subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token', requested_token_type: 'x-id-jag', scope }) }) }))
      .post('/pg/interop/motd-kid/run');
    const [url, form, headers] = fetchMock.mock.calls[0];
    expect(url).toBe('https://pf.test/as/token.oauth2');
    expect(form.get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token');
    expect(form.get('subject_token')).toBe('rt');
    expect(form.has('scope')).toBe(false);
    expect(headers.Authorization).toBe('Basic kid-client:kid-secret');
    expect(fetchMock.mock.calls[1][1].get('client_id')).toBe('kid-client');
    expect(res.body).toMatchObject({ method: 'kid', mint: { header: { kid: true } }, redeem: { accepted: true } });
  });

  it('refuses a target whose client is not configured, and non-PingFederate modes', async () => {
    expect((await request(app()).post('/pg/interop/xaa-dev/run')).status).toBe(501);
    expect((await request(app()).post('/pg/interop/motd-kid/run')).status).toBe(501); // INTEROP_KID_CLIENT_* unset
    expect((await request(app({ modeOf: () => 'byo' })).post('/pg/interop/motd/run')).status).toBe(409);
    expect((await request(app()).post('/pg/interop/nope/run')).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the PingFederate error when the target connection is missing', async () => {
    fetchMock.mockResolvedValueOnce({ status: 400, data: { error: 'invalid_target', error_description: 'no connection' } });
    const res = await request(app()).post('/pg/interop/motd/run');
    expect(res.body.mint).toMatchObject({ status: 400, error: 'invalid_target' });
    expect(res.body.redeem).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
