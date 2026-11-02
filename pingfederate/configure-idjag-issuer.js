#!/usr/bin/env node
'use strict';
/**
 * Make the kit's own local PingFederate an ID-JAG issuer for the app's pf-as mode: the sign-in client trades its refresh
 * token for an ID-JAG addressed to the kit's resource AS. This is the issuer half of configure-acme-idp.js, for the local
 * PingFederate (pf-admin.js direct mode, ids prefixed idJagKit). Run configure-signin.js --local first (the client).
 * Idempotent; local only (PF_ADMIN_URL must be a loopback address).
 *
 *   PF_ADMIN_URL=https://127.0.0.1:4731 PF_ADMIN_PASSWORD=… PF_ADMIN_INSECURE_TLS=true node pingfederate/configure-idjag-issuer.js
 *     [--pf=…  else PF_URL] [--resource-as=…  else RESOURCE_AS_ISSUER] [--resource=…  else ID_JAG_RESOURCE]
 *
 * Creates:
 *   - the signing key idjagkit-signing, and a JWT access token manager that publishes it to /pf/JWKS (PingFederate lists a
 *     signing key there only when such a manager carries it with "Publish Keys to the PingFederate JWKS Endpoint")
 *   - a static JWKS holding ONLY that key (x5t, no kid). PingFederate signs ID-JAGs with x5t, and a JWKS with several RSA
 *     keys (its dynamic OAuth keys) makes its own JWT-bearer consumer verify against the wrong one
 *   - a refresh-token processor and an exchange policy that turn the client's refresh token into the ID-JAG subject; the
 *     policy is the default processor policy when none is set, and the sign-in client's own tokenExchangeProcessorPolicyRef
 *   - the ID-JAG SP connection idJagKitResourceAsSp: aud = the resource AS issuer, resource = the MCP server, client_id =
 *     RESOURCE_AS_CLIENT_ID (the client that redeems at the resource AS), scope "read mcp:invoke"
 */
const pf = require('./pf-admin');
const { acceptAll } = pf;

const ID = { key: 'idjagkit-signing', publisher: 'idJagKitKeyPublisher', processor: 'idJagKitRefreshToken', policy: 'idJagKitPolicy', sp: 'idJagKitResourceAsSp' };
const JWT_ATM = 'com.pingidentity.pf.access.token.management.plugins.JwtBearerAccessTokenManagementPlugin';
const SCOPE = 'read mcp:invoke'; // mcp-sample's scopes

const policyMapping = (clientId) => acceptAll({
  processorPolicyRef: { id: ID.policy },
  attributeContractFulfillment: {
    TOKEN_SUBJECT: { source: { type: 'TOKEN_EXCHANGE_PROCESSOR_POLICY' }, value: 'TOKEN_SUBJECT' },
    client_id: { source: { type: 'TEXT' }, value: clientId },
    scope: { source: { type: 'TEXT' }, value: SCOPE },
  },
});

const spBody = ({ resourceAs, resource, clientId }) => ({
  type: 'SP', id: ID.sp, name: 'ID-JAG Kit resource AS', entityId: resourceAs, active: true, loggingMode: 'STANDARD', virtualEntityIds: [],
  connectionTargetType: 'STANDARD',
  credentials: { certs: [], signingSettings: { signingKeyPairRef: { id: ID.key }, algorithm: 'SHA256withRSA', includeCertInSignature: false, includeRawKeyInSignature: false } },
  oauthTokenExchangeSettings: {
    resourceUris: [resource], minutesBefore: 1, minutesAfter: 5, idJagEnabled: true, // ID-JAGs live about 5 minutes; Minutes Before has a minimum of 1
    attributeContract: { coreAttributes: [{ name: 'TOKEN_SUBJECT' }], extendedAttributes: [{ name: 'client_id' }, { name: 'scope' }] },
    processorPolicyMappings: [policyMapping(clientId)],
  },
});

/** @param o { pfUrl, resourceAs, resource, client, resourceAsClient } */
async function run(api, o) {
  const { report } = pf;
  const ensure = (...a) => pf.ensure(api, ...a);

  const as = (await api('GET', '/oauth/authServerSettings')).body || {};
  const haveScope = new Set([...(as.scopes || []), ...(as.exclusiveScopes || [])].map((x) => x.name));
  for (const name of ['read', 'mcp:invoke']) {
    if (haveScope.has(name)) console.log(`  keep scope ${name}`);
    else report(`create scope ${name}`, await api('POST', '/oauth/authServerSettings/scopes/commonScopes', { name, description: `${name} (ID-JAG Kit)` }));
  }

  // The ID-JAG signing key, published in /pf/JWKS through a JWT token manager.
  const keys = await api('GET', '/keyPairs/signing');
  if ((keys.body?.items || []).some((k) => k.id === ID.key)) console.log('  keep signing key');
  else {
    report(`signing key ${ID.key}`, await api('POST', '/keyPairs/signing/generate', {
      id: ID.key, commonName: 'ID-JAG Kit ID-JAG signing', organization: 'ID-JAG Kit (local)', country: 'US',
      validDays: 730, keyAlgorithm: 'RSA', keySize: 2048, signatureAlgorithm: 'SHA256withRSA',
    }));
  }

  const desc = await api('GET', `/oauth/accessTokenManagers/descriptors/${JWT_ATM}`);
  const fields = (desc.body?.configDescriptor?.fields || []).filter((x) => x.defaultValue !== undefined && x.defaultValue !== null)
    .map((x) => ({ name: x.name, value: String(x.defaultValue) }));
  const setField = (name, value) => { const x = fields.find((y) => y.name === name); if (x) x.value = value; else fields.push({ name, value }); };
  setField('Use Centralized Signing Key', 'false');
  setField('JWS Algorithm', 'RS256'); // 13.1 refuses a manager with no integrity protection
  setField('Active Signing Certificate Key ID', ID.key);
  setField('Publish Keys to the PingFederate JWKS Endpoint', 'true');
  setField('Issuer Claim Value', o.pfUrl);
  await ensure(`ID-JAG key publisher ${ID.publisher}`, `/oauth/accessTokenManagers/${ID.publisher}`, '/oauth/accessTokenManagers', {
    id: ID.publisher, name: 'ID-JAG Kit key publisher', pluginDescriptorRef: { id: JWT_ATM },
    configuration: { fields, tables: [
      { name: 'Certificates', rows: [{ defaultRow: false, fields: [{ name: 'Key ID', value: ID.key }, { name: 'Certificate', value: ID.key }] }] },
      { name: 'Symmetric Keys', rows: [] }] },
    attributeContract: { extendedAttributes: [{ name: 'sub' }] },
  });

  const oidcKeys = await api('GET', '/keyPairs/oauthOpenIdConnect');
  if (!oidcKeys.body?.staticJwksEnabled || oidcKeys.body?.rsaActiveCertRef?.id !== ID.key) {
    report('static JWKS = the ID-JAG key only', await api('PUT', '/keyPairs/oauthOpenIdConnect', {
      ...oidcKeys.body, staticJwksEnabled: true, rsaActiveCertRef: { id: ID.key }, rsaActiveKeyId: 'idjag-kit',
      rsaPublishX5cParameter: true, publishDynamicKeyX5cs: false,
    }));
  } else console.log('  keep static JWKS');

  // The client's refresh token is the exchange's subject.
  await ensure(`refresh token processor ${ID.processor}`, `/idp/tokenProcessors/${ID.processor}`, '/idp/tokenProcessors', {
    id: ID.processor, name: 'ID-JAG Kit refresh token processor',
    pluginDescriptorRef: { id: 'org.sourceid.wstrust.processor.oauth.RefreshTokenTokenProcessor' },
    configuration: { fields: [], tables: [] },
    attributeContract: { coreAttributes: ['expires_at', 'scope', 'TOKEN_SUBJECT', 'client_id'].map((name) => ({ name, masked: true })), extendedAttributes: [] },
  });
  const fromSubject = (v) => ({ source: { type: 'SUBJECT_TOKEN' }, value: v });
  await ensure(`exchange policy ${ID.policy}`, `/oauth/tokenExchange/processor/policies/${ID.policy}`, '/oauth/tokenExchange/processor/policies', {
    id: ID.policy, name: 'ID-JAG Kit refresh exchange', actorTokenRequired: false,
    attributeContract: { coreAttributes: [{ name: 'subject' }], extendedAttributes: ['expires_at', 'scope', 'TOKEN_SUBJECT', 'client_id'].map((name) => ({ name })) },
    processorMappings: [acceptAll({
      subjectTokenType: 'urn:ietf:params:oauth:token-type:refresh_token', subjectTokenProcessor: { id: ID.processor },
      actorTokenType: '', actorTokenProcessor: {},
      attributeContractFulfillment: { subject: fromSubject('TOKEN_SUBJECT'), TOKEN_SUBJECT: fromSubject('TOKEN_SUBJECT'),
        expires_at: fromSubject('expires_at'), scope: fromSubject('scope'), client_id: fromSubject('client_id') },
    })],
  });
  const tes = await api('GET', '/oauth/tokenExchange/processor/settings');
  if (tes.body?.defaultProcessorPolicyRef?.id) console.log(`  keep default exchange policy (${tes.body.defaultProcessorPolicyRef.id})`);
  else report(`default exchange policy = ${ID.policy}`, await api('PUT', '/oauth/tokenExchange/processor/settings', { defaultProcessorPolicyRef: { id: ID.policy } }));

  const client = await api('GET', `/oauth/clients/${encodeURIComponent(o.client)}`);
  if (client.status !== 200) report(`client ${o.client} (run configure-signin.js --local first)`, client);
  else if (client.body.tokenExchangeProcessorPolicyRef?.id === ID.policy) console.log(`  keep client ${o.client} exchange policy`);
  else report(`client ${o.client}: exchange policy ${ID.policy}`, await api('PUT', `/oauth/clients/${encodeURIComponent(o.client)}`, { ...client.body, tokenExchangeProcessorPolicyRef: { id: ID.policy } }));

  // The SP connection is ours (idJagKit id), but configure-desktop-clients.js may have added mappings to it: change only ours.
  const sp = await api('GET', `/idp/spConnections/${ID.sp}`);
  if (sp.status !== 200) report(`SP connection ${ID.sp} (aud ${o.resourceAs})`, await api('POST', '/idp/spConnections', spBody({ resourceAs: o.resourceAs, resource: o.resource, clientId: o.resourceAsClient })));
  else {
    const ts = sp.body.oauthTokenExchangeSettings || {};
    const want = policyMapping(o.resourceAsClient);
    const mine = (ts.processorPolicyMappings || []).find((m) => m.processorPolicyRef.id === ID.policy);
    // PingFederate adds defaults to what it stores, so compare the three values this script sets, not the whole object.
    const f = mine?.attributeContractFulfillment || {};
    const same = f.client_id?.source?.type === 'TEXT' && f.client_id.value === o.resourceAsClient && f.scope?.value === SCOPE
      && f.TOKEN_SUBJECT?.source?.type === 'TOKEN_EXCHANGE_PROCESSOR_POLICY';
    const resources = new Set(ts.resourceUris || []);
    if (sp.body.entityId === o.resourceAs && resources.has(o.resource) && ts.idJagEnabled && same) console.log(`  keep SP connection ${ID.sp}`);
    else {
      sp.body.entityId = o.resourceAs;
      ts.resourceUris = [...new Set([o.resource, ...resources])];
      ts.idJagEnabled = true;
      ts.processorPolicyMappings = [...(ts.processorPolicyMappings || []).filter((m) => m.processorPolicyRef.id !== ID.policy), want];
      sp.body.oauthTokenExchangeSettings = ts;
      report(`SP connection ${ID.sp}: aud ${o.resourceAs}, resource ${o.resource}`, await api('PUT', `/idp/spConnections/${ID.sp}`, sp.body));
    }
  }
}

module.exports = { run, spBody, policyMapping, ID };

if (require.main === module) {
  pf.requireLocalAdmin();
  const o = {
    pfUrl: pf.setting('pf', 'PF_URL', 'the PingFederate issuer'),
    resourceAs: pf.setting('resource-as', 'RESOURCE_AS_ISSUER', 'the resource AS issuer (the ID-JAG aud)'),
    resource: pf.setting('resource', 'ID_JAG_RESOURCE', 'the MCP resource'),
    client: process.env.PF_EXCHANGE_CLIENT_ID || 'id-jag-kit',
    resourceAsClient: process.env.RESOURCE_AS_CLIENT_ID || 'id-jag-playground',
  };
  console.log(`[idjag-issuer] ${o.pfUrl} issues ID-JAGs for ${o.resourceAs} (${o.resource})`);
  const api = pf.adminApi('direct', 0);
  pf.requireIssuer(api, o.pfUrl).then(() => run(api, o)).then(() => pf.done('idjag-issuer', '[idjag-issuer] done.')).catch(pf.fail('idjag-issuer', 0));
}
