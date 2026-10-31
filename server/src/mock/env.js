// What the app sees in mock mode instead of the real environment: the settings that point at real systems are dropped
// and replaced with values for the in-process mock (mock/index.js). Everything else (PORT, APP_ORIGIN, SESSION_SECRET,
// DATA_DIR ...) is the real environment, so the app itself is configured as usual.
// No secret in this file is a credential anywhere: the client secrets are random for each run of the process, and the
// demo user exists only inside the mock PingFederate. All hosts are .invalid, which never resolves.

import crypto from 'node:crypto';
import path from 'node:path';

export const ORIGINS = {
  pf: 'https://pf.mock.invalid',
  acme: 'https://acme-pf.mock.invalid',
  as: 'https://resource-as.mock.invalid',
  mcp: 'https://mcp.mock.invalid',
  // Gateway redeem mode (mock/gatewayWorld.js): the exchange issuer, a partner issuer the target does not trust, the target
  // app's own issuer, the target app's API, and the gateway the caller's token is presented to.
  gwIdp: 'https://exchange-idp.mock.invalid',
  gwPartner: 'https://partner-idp.mock.invalid',
  gwTarget: 'https://target-idp.mock.invalid',
  gwApi: 'https://target-api.mock.invalid',
  gwGateway: 'https://gateway.mock.invalid',
};
export const MOCK_ORIGINS = new Set(Object.values(ORIGINS));
export const MCP_RESOURCE = `${ORIGINS.mcp}/mcp`;

// The one demo account of the mock PingFederate. The username is the email, as for the kit's real users.
export const MOCK_USER = { username: 'alice@mock.example', password: 'mock-password', name: 'Alice (mock)' };

const rand = () => crypto.randomBytes(24).toString('base64url');
export const SECRETS = {
  exchange: rand(), redeemer: rand(), acme: rand(), resourceAs: rand(), registry: rand(), pfAdmin: rand(), registration: rand(),
};
export const CLIENT_IDS = { exchange: 'mock-exchange-client', redeemer: 'mock-redeemer-client', acme: 'mock-acme-exchange-client', resourceAs: 'id-jag-playground' };
export const PF_ADMIN_USER = 'mock-admin';

// Every setting whose name starts like this is dropped in mock mode: it names a real server, client or account.
const DROPPED = /^(PF_|ACME_|RESOURCE_AS_|OIDC_|XAA_|SAML_|INTEROP_|MCP_URL$|ID_JAG_|ADMIN_|ALLOWED_EMAIL_DOMAINS$|IDP$|HEALTH_MODE$|ALLOW_PRIVATE_ISSUERS$|REGISTRATION_KEY$)/;

/** The environment of mock mode: `base` without the real-system settings, plus the mock's own. */
export function mockEnv(base = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(base)) if (!DROPPED.test(k)) out[k] = v;
  return {
    ...out,
    DATA_DIR: path.join(String(base.DATA_DIR ?? '').trim() || '.data', 'mock'), // mock data never mixes with live data
    PF_URL: ORIGINS.pf,
    PF_EXCHANGE_CLIENT_ID: CLIENT_IDS.exchange,
    PF_EXCHANGE_CLIENT_SECRET: SECRETS.exchange,
    PF_REDEEMER_CLIENT_ID: CLIENT_IDS.redeemer,
    PF_REDEEMER_CLIENT_SECRET: SECRETS.redeemer,
    PF_RESOURCE: MCP_RESOURCE,
    ACME_PF_URL: ORIGINS.acme,
    ACME_EXCHANGE_CLIENT_ID: CLIENT_IDS.acme,
    ACME_EXCHANGE_CLIENT_SECRET: SECRETS.acme,
    RESOURCE_AS_ISSUER: ORIGINS.as,
    RESOURCE_AS_TOKEN_ENDPOINT: `${ORIGINS.as}/token`,
    RESOURCE_AS_CLIENT_ID: CLIENT_IDS.resourceAs,
    RESOURCE_AS_CLIENT_SECRET: SECRETS.resourceAs,
    MCP_URL: MCP_RESOURCE,
    ID_JAG_RESOURCE: MCP_RESOURCE,
    ID_JAG_REGISTRY_TOKEN: SECRETS.registry,
    ADMIN_EMAILS: MOCK_USER.username,
    ALLOWED_EMAIL_DOMAINS: 'mock.example',
    PF_ADMIN_URL: `${ORIGINS.pf}:9999`,
    PF_ADMIN_USER,
    PF_ADMIN_PASSWORD: SECRETS.pfAdmin,
    REGISTRATION_KEY: SECRETS.registration,
  };
}
