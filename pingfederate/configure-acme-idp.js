#!/usr/bin/env node
'use strict';
/**
 * Configure a fresh PingFederate as "Acme Corp", an OUTSIDE company's IdP that issues
 * ID-JAGs to our resource authorization servers. Used to test the bring-your-own-IdP
 * path with an IdP that shares nothing with ours. Idempotent: existing objects are kept.
 *
 *   kubectl -n <ns> port-forward svc/pingfederate-admin 29999:9999 &
 *   node pingfederate/configure-acme-idp.js --ns=<ns>
 *
 * Every target comes from an option or this repo's settings (env, else the shared settings file, else the repo-root .env); there are no built-in hosts:
 *   --host=…         Acme's public host (its issuer is https://<host>)     else the host of ACME_PF_URL
 *   --resource-as=…  our resource AS issuer = ID-JAG aud                   else RESOURCE_AS_ISSUER
 *   --resource=…     the MCP resource that selects that connection         else ID_JAG_RESOURCE
 *   --pf=…           our PingFederate issuer = ID-JAG aud (pf-pf)          else PF_URL
 *   --pf-resource=…  the resource that selects the PingFederate connection else PF_RESOURCE
 *   --pf-client=…    the client_id written for PingFederate                else PF_REDEEMER_CLIENT_ID
 *   --ns=…  (required: the namespace holding the pingfederate-admin secret)   --port=29999
 * For our resource AS, client_id is acme-agent: register that as "client_id your IdP writes in the ID-JAG" on Trusted IdPs.
 * The PingFederate connection (acmeToPingFed) is updated in place: on an Acme PingFederate another deployment also
 * uses, its resource and client become the ones given here.
 * Secrets (env, else the shared settings file, else the repo-root .env; never printed):
 *   OUTSIDE_IDP_USER_PASSWORD  password of the test user acme-user
 *   OUTSIDE_IDP_CLIENT_SECRET  secret of the acme-agent client
 * The admin password comes from the pingfederate-admin secret in --ns.
 */
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

try { process.loadEnvFile(path.join(__dirname, '../.env')); } catch { /* no .env: env and args only */ }

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
/** An option, else the named env var, else a clear exit. */
function setting(option, envName, what) {
  const v = args[option] || (envName && process.env[envName]);
  if (!v) { console.error(`${what}: pass --${option}=…${envName ? ` or set ${envName}` : ''}`); process.exit(2); }
  return String(v).replace(/\/$/, '');
}
const NS = setting('ns', null, 'the namespace holding the pingfederate-admin secret');
const PORT = args.port || '29999';
const HOST = args.host || (process.env.ACME_PF_URL ? new URL(process.env.ACME_PF_URL).host : setting('host', 'ACME_PF_URL', "Acme's public host"));
const RESOURCE_AS = setting('resource-as', 'RESOURCE_AS_ISSUER', 'our resource AS issuer (the ID-JAG aud)');
const RESOURCE = setting('resource', 'ID_JAG_RESOURCE', 'the MCP resource for our resource AS');
const OUR_PF = setting('pf', 'PF_URL', 'our PingFederate issuer (the ID-JAG aud for pf-pf)');
const PF_RESOURCE = setting('pf-resource', 'PF_RESOURCE', 'the resource the PingFederate redeemer expects');
const PF_CLIENT = setting('pf-client', 'PF_REDEEMER_CLIENT_ID', 'our redeeming client at PingFederate');
const SCOPE = 'read mcp:invoke'; // what mcp-sample's tools need

function secret(name) {
  if (process.env[name]) return process.env[name];
  console.error(`set ${name} (env, the shared settings file or the repo-root .env)`);
  process.exit(2);
}

const adminPw = process.env.PF_ADMIN_PASSWORD || Buffer.from(execFileSync('kubectl', ['-n', NS, 'get', 'secret', args['admin-secret'] || 'pingfederate-admin', '-o', 'jsonpath={.data.password}']).toString(), 'base64').toString();
const agent = new https.Agent({ rejectUnauthorized: false }); // port-forwarded admin API, self-signed

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(`https://localhost:${PORT}/pf-admin-api/v1${p}`, {
      method, agent,
      headers: { Authorization: `Basic ${Buffer.from(`administrator:${adminPw}`).toString('base64')}`, 'X-XSRF-Header': 'PingFederate', 'Content-Type': 'application/json' },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let j = null; try { j = out ? JSON.parse(out) : null; } catch { j = out; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let failed = false;
function report(what, r) {
  const ok = r.status >= 200 && r.status < 300;
  if (!ok) failed = true;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: HTTP ${r.status} ${JSON.stringify(r.body?.validationErrors || r.body?.message || r.body)}`}`);
}
/** Create, or bring an existing one in line with what this script wants. */
async function upsert(what, p, collection, body) {
  const have = await api('GET', p);
  report(`${have.status === 200 ? 'update' : 'create'} ${what}`, have.status === 200 ? await api('PUT', p, body) : await api('POST', collection, body));
}
/** Create unless GET finds it. */
async function ensure(what, getPath, postPath, body) {
  const have = await api('GET', getPath);
  if (have.status === 200) { console.log(`  keep ${what}`); return; }
  report(`create ${what}`, await api('POST', postPath, body));
}

const acceptAll = (m) => ({ attributeSources: [], issuanceCriteria: { conditionalCriteria: [] }, ...m });

(async () => {
  console.log(`[acme] configuring https://${HOST} (admin via localhost:${PORT}, ns ${NS})`);

  const lic = await api('GET', '/license/agreement');
  if (lic.body?.accepted === false) report('accept license agreement', await api('PUT', '/license/agreement', { accepted: true }));

  const ss = await api('GET', '/serverSettings');
  if (ss.body?.federationInfo?.baseUrl !== `https://${HOST}`) {
    ss.body.federationInfo.baseUrl = `https://${HOST}`;
    ss.body.federationInfo.saml2EntityId = ss.body.federationInfo.saml2EntityId || 'acme-pf';
    report('base URL (issuer)', await api('PUT', '/serverSettings', ss.body));
  } else console.log('  keep base URL');

  const as = await api('GET', '/oauth/authServerSettings');
  const have = new Set((as.body.scopes || []).map((s) => s.name));
  const want = ['offline_access', 'read', 'mcp:invoke'].filter((s) => !have.has(s));
  if (want.length) {
    as.body.scopes = [...(as.body.scopes || []), ...want.map((name) => ({ name, description: name, dynamic: false }))];
    report(`scopes ${want.join(' ')}`, await api('PUT', '/oauth/authServerSettings', as.body));
  } else console.log('  keep scopes');

  const pw = secret('OUTSIDE_IDP_USER_PASSWORD');
  await ensure('user store acmeUsers (acme-user)', '/passwordCredentialValidators/acmeUsers', '/passwordCredentialValidators', {
    id: 'acmeUsers', name: 'Acme users', pluginDescriptorRef: { id: 'org.sourceid.saml20.domain.SimpleUsernamePasswordCredentialValidator' },
    configuration: { fields: [], tables: [{ name: 'Users', rows: [{ defaultRow: false, fields: [
      { name: 'Username', value: 'acme-user' }, { name: 'Password', value: pw }, { name: 'Confirm Password', value: pw },
      { name: 'Relax Password Requirements', value: 'false' }] }] }] },
  });

  await ensure('access token manager acmeAtm', '/oauth/accessTokenManagers/acmeAtm', '/oauth/accessTokenManagers', {
    id: 'acmeAtm', name: 'Acme access tokens',
    pluginDescriptorRef: { id: 'org.sourceid.oauth20.token.plugin.impl.ReferenceBearerAccessTokenManagementPlugin' },
    configuration: { fields: [], tables: [] }, attributeContract: { extendedAttributes: [{ name: 'username' }] },
  });

  await ensure('password-grant mapping', '/oauth/resourceOwnerCredentialsMappings/acmeUsers', '/oauth/resourceOwnerCredentialsMappings', acceptAll({
    id: 'acmeUsers', passwordValidatorRef: { id: 'acmeUsers' },
    attributeContractFulfillment: { USER_KEY: { source: { type: 'PASSWORD_CREDENTIAL_VALIDATOR' }, value: 'username' } },
  }));

  await ensure('default access token mapping', '/oauth/accessTokenMappings/default%7CacmeAtm', '/oauth/accessTokenMappings', acceptAll({
    context: { type: 'DEFAULT' }, accessTokenManagerRef: { id: 'acmeAtm' },
    attributeContractFulfillment: { username: { source: { type: 'OAUTH_PERSISTENT_GRANT' }, value: 'USER_KEY' } },
  }));

  await ensure('refresh token processor acmeRefreshToken', '/idp/tokenProcessors/acmeRefreshToken', '/idp/tokenProcessors', {
    id: 'acmeRefreshToken', name: 'Acme refresh token processor',
    pluginDescriptorRef: { id: 'org.sourceid.wstrust.processor.oauth.RefreshTokenTokenProcessor' },
    configuration: { fields: [], tables: [] },
    attributeContract: { coreAttributes: ['expires_at', 'scope', 'TOKEN_SUBJECT', 'client_id'].map((name) => ({ name, masked: true })), extendedAttributes: [] },
  });

  const fromSubject = (v) => ({ source: { type: 'SUBJECT_TOKEN' }, value: v });
  await ensure('ID-JAG exchange policy acmeIdJagPolicy', '/oauth/tokenExchange/processor/policies/acmeIdJagPolicy', '/oauth/tokenExchange/processor/policies', {
    id: 'acmeIdJagPolicy', name: 'Acme ID-JAG refresh exchange', actorTokenRequired: false,
    attributeContract: { coreAttributes: [{ name: 'subject' }], extendedAttributes: ['expires_at', 'scope', 'TOKEN_SUBJECT', 'client_id'].map((name) => ({ name })) },
    processorMappings: [acceptAll({
      subjectTokenType: 'urn:ietf:params:oauth:token-type:refresh_token', subjectTokenProcessor: { id: 'acmeRefreshToken' },
      actorTokenType: '', actorTokenProcessor: {},
      attributeContractFulfillment: { subject: fromSubject('TOKEN_SUBJECT'), TOKEN_SUBJECT: fromSubject('TOKEN_SUBJECT'),
        expires_at: fromSubject('expires_at'), scope: fromSubject('scope'), client_id: fromSubject('client_id') },
    })],
  });
  const tes = await api('GET', '/oauth/tokenExchange/processor/settings');
  if (tes.body?.defaultProcessorPolicyRef?.id !== 'acmeIdJagPolicy') {
    report('default exchange policy', await api('PUT', '/oauth/tokenExchange/processor/settings', { defaultProcessorPolicyRef: { id: 'acmeIdJagPolicy' } }));
  }

  await ensure('client acme-agent', '/oauth/clients/acme-agent', '/oauth/clients', {
    clientId: 'acme-agent', name: 'Acme agent (outside company)', enabled: true,
    grantTypes: ['RESOURCE_OWNER_CREDENTIALS', 'REFRESH_TOKEN', 'TOKEN_EXCHANGE'],
    clientAuth: { type: 'SECRET', secret: secret('OUTSIDE_IDP_CLIENT_SECRET') },
    defaultAccessTokenManagerRef: { id: 'acmeAtm' }, tokenExchangeProcessorPolicyRef: { id: 'acmeIdJagPolicy' },
    restrictScopes: false, bypassApprovalPage: true,
  });

  // Acme's own ID-JAG signing key (published in its /pf/JWKS).
  const keys = await api('GET', '/keyPairs/signing');
  if (!(keys.body?.items || []).some((k) => k.id === 'acme-idjag-signing')) {
    report('signing key acme-idjag-signing', await api('POST', '/keyPairs/signing/generate', {
      id: 'acme-idjag-signing', commonName: 'Acme ID-JAG signing', organization: 'Acme Corp (demo)', country: 'US',
      validDays: 730, keyAlgorithm: 'RSA', keySize: 2048, signatureAlgorithm: 'SHA256withRSA',
    }));
  } else console.log('  keep signing key');

  // PingFederate does NOT publish an ID-JAG signing key by itself: /pf/JWKS lists it only
  // when a JWT token manager carries it with "Publish Keys to the PingFederate JWKS Endpoint".
  // Without this, every resource AS fails with "no JWKS key for x5t …".
  const jwtAtm = 'com.pingidentity.pf.access.token.management.plugins.JwtBearerAccessTokenManagementPlugin';
  const desc = await api('GET', `/oauth/accessTokenManagers/descriptors/${jwtAtm}`);
  const fields = (desc.body?.configDescriptor?.fields || []).filter((x) => x.defaultValue !== undefined && x.defaultValue !== null)
    .map((x) => ({ name: x.name, value: String(x.defaultValue) }));
  const setField = (name, value) => { const x = fields.find((y) => y.name === name); if (x) x.value = value; else fields.push({ name, value }); };
  setField('Use Centralized Signing Key', 'false');
  setField('Active Signing Certificate Key ID', 'acme-idjag-signing');
  setField('Publish Keys to the PingFederate JWKS Endpoint', 'true');
  setField('Issuer Claim Value', `https://${HOST}`);
  await ensure('ID-JAG key publisher acmeKeyPublisher', '/oauth/accessTokenManagers/acmeKeyPublisher', '/oauth/accessTokenManagers', {
    id: 'acmeKeyPublisher', name: 'Acme ID-JAG key publisher', pluginDescriptorRef: { id: jwtAtm },
    configuration: { fields, tables: [
      { name: 'Certificates', rows: [{ defaultRow: false, fields: [{ name: 'Key ID', value: 'acme-idjag-signing' }, { name: 'Certificate', value: 'acme-idjag-signing' }] }] },
      { name: 'Symmetric Keys', rows: [] }] },
    attributeContract: { extendedAttributes: [{ name: 'sub' }] },
  });

  // Publish ONLY the ID-JAG key. PingFederate signs ID-JAGs with an x5t header and no kid,
  // and PingFederate's own JWT-bearer consumer does not pick the key by x5t: with several RSA
  // keys in /pf/JWKS (the dynamic OAuth keys) it verifies against the wrong one and answers
  // "Invalid JWT token". A static key set holding just this key fixes that for any consumer.
  const ok = await api('GET', '/keyPairs/oauthOpenIdConnect');
  if (!ok.body?.staticJwksEnabled || ok.body?.rsaActiveCertRef?.id !== 'acme-idjag-signing') {
    report('static JWKS = the ID-JAG key only', await api('PUT', '/keyPairs/oauthOpenIdConnect', {
      staticJwksEnabled: true, rsaActiveCertRef: { id: 'acme-idjag-signing' }, rsaActiveKeyId: 'acme-idjag',
      rsaPublishX5cParameter: true, publishDynamicKeyX5cs: false,
    }));
  } else console.log('  keep static JWKS');

  // One ID-JAG SP connection per resource AS we trust Acme towards. resource selects the
  // connection; the entity id becomes the ID-JAG aud; client_id is the client at THAT AS.
  const spConnection = (id, name, entityId, resource, clientId) => ({
    type: 'SP', id, name, entityId, active: true, loggingMode: 'STANDARD', virtualEntityIds: [], connectionTargetType: 'STANDARD',
    credentials: { certs: [], signingSettings: { signingKeyPairRef: { id: 'acme-idjag-signing' }, algorithm: 'SHA256withRSA', includeCertInSignature: false, includeRawKeyInSignature: false } },
    oauthTokenExchangeSettings: {
      resourceUris: [resource], minutesBefore: 5, minutesAfter: 5, idJagEnabled: true, // ID-JAGs live about 5 minutes (spec, Okta)
      attributeContract: { coreAttributes: [{ name: 'TOKEN_SUBJECT' }], extendedAttributes: [{ name: 'client_id' }, { name: 'scope' }] },
      processorPolicyMappings: [acceptAll({
        processorPolicyRef: { id: 'acmeIdJagPolicy' },
        attributeContractFulfillment: {
          TOKEN_SUBJECT: { source: { type: 'TOKEN_EXCHANGE_PROCESSOR_POLICY' }, value: 'TOKEN_SUBJECT' },
          client_id: { source: { type: 'TEXT' }, value: clientId },
          scope: { source: { type: 'TEXT' }, value: SCOPE },
        },
      })],
    },
  });
  await upsert(`SP connection to our resource AS (aud ${RESOURCE_AS})`, '/idp/spConnections/acmeToResourceAs', '/idp/spConnections',
    spConnection('acmeToResourceAs', 'ID-JAG to the ID-JAG kit resource AS', RESOURCE_AS, RESOURCE, 'acme-agent'));
  await upsert(`SP connection to our PingFederate (aud ${OUR_PF})`, '/idp/spConnections/acmeToPingFed', '/idp/spConnections',
    spConnection('acmeToPingFed', 'ID-JAG to our PingFederate', OUR_PF, PF_RESOURCE, PF_CLIENT));

  console.log(failed ? '[acme] finished with failures' : `[acme] done. Issuer https://${HOST}, JWKS https://${HOST}/pf/JWKS`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(`[acme] ${err.message}`); process.exit(1); });
