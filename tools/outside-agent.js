#!/usr/bin/env node
'use strict';
/**
 * An outside company's agent, end to end, with none of our code in its path:
 *   1. sign the user in at ITS IdP (password grant: a test harness, no browser)
 *   2. RFC 8693 token exchange at its IdP for an ID-JAG addressed to OUR authorization server
 *   3. RFC 7523 JWT bearer redemption at OUR public token endpoint
 *   4. optionally, tools/list at our MCP server (mcp-sample) with the token we returned
 * Prints decoded claims and OAuth errors only, never a raw token.
 *
 * Usage (secrets come from env or the repo-root .env, never args):
 *   OUTSIDE_IDP_CLIENT_SECRET=… OUTSIDE_IDP_USER_PASSWORD=… OUR_AS_CLIENT_ID=idp-acme OUR_AS_CLIENT_SECRET=… \
 *   node tools/outside-agent.js --target=resource-as
 *   node tools/outside-agent.js --target=pingfederate
 *
 * Every address and client comes from an option or this repo's settings; there are no built-in hosts:
 *   --idp=…                 the outside IdP (a PingFederate)          else ACME_PF_URL
 *   --idp-client=acme-agent --user=acme-user                           (what pingfederate/configure-acme-idp.js creates)
 *   --target=resource-as    --as-issuer=… else RESOURCE_AS_ISSUER; --as-token-endpoint=… else <issuer>/token;
 *                           --as-client=… else OUR_AS_CLIENT_ID (the idp-<id> client from My IdPs); --resource=… else ID_JAG_RESOURCE
 *   --target=pingfederate   --as-issuer=… else PF_URL; --as-token-endpoint=… else <issuer>/as/token.oauth2;
 *                           --as-client=… else PF_REDEEMER_CLIENT_ID; --resource=… else PF_RESOURCE
 *   --scope="read mcp:invoke"   --mcp=<mcp-sample /mcp URL> (optional step 4)
 *   --insecure  (skip TLS verification, for self-signed dev hosts only)
 */
const path = require('path');

try { process.loadEnvFile(path.join(__dirname, '../.env')); } catch { /* no .env: env and args only */ }

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
if (args.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/** An option, else the named env var, else a clear exit. */
function setting(option, envName, what) {
  const v = args[option] || process.env[envName];
  if (!v) { console.error(`${what}: pass --${option}=… or set ${envName}`); process.exit(2); }
  return String(v).replace(/\/$/, '');
}

const TARGETS = {
  'resource-as': { issuerEnv: 'RESOURCE_AS_ISSUER', tokenPath: '/token', clientEnv: 'OUR_AS_CLIENT_ID', resourceEnv: 'ID_JAG_RESOURCE' },
  pingfederate: { issuerEnv: 'PF_URL', tokenPath: '/as/token.oauth2', clientEnv: 'PF_REDEEMER_CLIENT_ID', resourceEnv: 'PF_RESOURCE' },
};
const target = TARGETS[args.target || 'resource-as'];
if (!target) { console.error(`unknown --target ${args.target} (resource-as or pingfederate)`); process.exit(2); }

const idp = setting('idp', 'ACME_PF_URL', 'the outside IdP');
const idpToken = `${idp}/as/token.oauth2`;
const idpClient = args['idp-client'] || 'acme-agent';
const asIssuer = setting('as-issuer', target.issuerEnv, 'our authorization server issuer (the ID-JAG aud)');
const asTokenEndpoint = args['as-token-endpoint'] || `${asIssuer}${target.tokenPath}`;
const asClient = setting('as-client', target.clientEnv, 'our client at that authorization server');
const resource = args.resource || process.env[target.resourceEnv] || '';
if (!resource) { console.error(`the MCP resource: pass --resource=… or set ${target.resourceEnv}`); process.exit(2); }
const scope = args.scope || 'read mcp:invoke';

const need = (k) => { if (!process.env[k]) { console.error(`set ${k}`); process.exit(2); } return process.env[k]; };
const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const claims = (jwt) => {
  try {
    const [h, p] = String(jwt).split('.');
    return { header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(p, 'base64url')) };
  } catch { return '(not a JWT)'; }
};

async function post(url, form, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form).toString() });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

function step(n, title) { console.log(`\n[${n}] ${title}`); }
function fail(where, r) {
  console.log(`    REFUSED at ${where}: HTTP ${r.status} ${r.body.error || ''} ${r.body.error_description || ''}`);
  process.exit(1);
}

(async () => {
  const idpAuth = { Authorization: basic(idpClient, need('OUTSIDE_IDP_CLIENT_SECRET')) };

  step(1, `Sign in at the outside IdP (${idp}) as ${args.user || 'acme-user'}`);
  const login = await post(idpToken, { grant_type: 'password', username: args.user || 'acme-user',
    password: need('OUTSIDE_IDP_USER_PASSWORD'), scope: 'openid offline_access' }, idpAuth);
  if (login.status !== 200 || !login.body.refresh_token) fail('IdP sign-in', login);
  console.log('    got a refresh token from the outside IdP (kept in memory)');

  step(2, `Exchange it for an ID-JAG addressed to ${asIssuer}`);
  const ex = await post(idpToken, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
    subject_token: login.body.refresh_token,
    subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
    audience: asIssuer, resource, scope,
  }, idpAuth);
  if (ex.status !== 200 || !ex.body.access_token) fail('ID-JAG exchange', ex);
  console.log(`    issued_token_type=${ex.body.issued_token_type} token_type=${ex.body.token_type} expires_in=${ex.body.expires_in}`);
  console.log(JSON.stringify(claims(ex.body.access_token), null, 2).replace(/^/gm, '    '));

  step(3, `Redeem the ID-JAG at OUR token endpoint ${asTokenEndpoint} as client ${asClient}`);
  const asSecret = process.env.OUR_AS_CLIENT_SECRET;
  const redeem = await post(asTokenEndpoint, {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: ex.body.access_token, client_id: asClient, resource,
  }, asSecret ? { Authorization: basic(asClient, asSecret) } : {});
  if (redeem.status !== 200 || !redeem.body.access_token) fail('redemption', redeem);
  console.log(`    token_type=${redeem.body.token_type} expires_in=${redeem.body.expires_in} scope=${redeem.body.scope || ''} refresh_token=${redeem.body.refresh_token ? 'RETURNED (spec says none)' : 'none'}`);
  console.log(JSON.stringify(claims(redeem.body.access_token), null, 2).replace(/^/gm, '    '));

  if (args.mcp) {
    step(4, `tools/list at ${args.mcp} with the token we returned`);
    const r = await fetch(args.mcp, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${redeem.body.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    const text = await r.text();
    const m = text.match(/\{[\s\S]*\}/);
    const body = m ? JSON.parse(m[0]) : {};
    console.log(`    HTTP ${r.status}: ${(body.result?.tools || []).length} tools${body.error ? ` error ${JSON.stringify(body.error)}` : ''}`);
  }
  console.log('\nDone: an outside IdP issued, our authorization server redeemed.');
})().catch((err) => { console.error(err.message); process.exit(1); });
