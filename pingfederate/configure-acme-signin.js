#!/usr/bin/env node
'use strict';
/**
 * Let the playground's "Acme PingFederate -> PingFederate" mode sign the user in at Acme without a redirect: an HTML form
 * adapter on Acme's existing user store (acmeUsers, made by configure-acme-idp.js), Acme's default authentication source,
 * and a client that may start a pi.flow. Additive: nothing the demo uses on Acme (acme-agent, its SP connections, its
 * keys) is touched; every object is prefixed idJagKit. Idempotent.
 *
 *   kubectl -n <acme ns> port-forward svc/pingfederate-admin 29999:9999 &
 *   node pingfederate/configure-acme-signin.js --ns=<acme ns> [--port=29999]
 *   node pingfederate/configure-acme-signin.js --ns=<acme ns> --remove
 *
 * Creates: HTML form adapter idJagKitAcmeForm; client id-jag-kit-acme (authorization code + refresh + token exchange,
 * pi.flow allowed, redirect <APP_ORIGIN>/api/id-jag-playground/issuer/callback, the ID-JAG exchange policy acmeIdJagPolicy).
 * Maps the adapter to a persistent-grant user (USER_KEY, USER_NAME = the username) and turns on IdP authentication policies
 * (enableIdpAuthnSelection) when off. Turns on Acme's Authentication API (apiEnabled; pi.flow only: restrictAccessToRedirectlessMode stays on) when it is off.
 * Sets Acme's default authentication source to the adapter ONLY when none is set (it is left alone otherwise, and the
 * script says so). The client secret goes to .env (ACME_EXCHANGE_CLIENT_ID / _SECRET), is never printed, and is kept on re-runs.
 */
const crypto = require('crypto');
const pf = require('./pf-admin');
const { args, setting, adminApi, report, writeEnv } = pf;

const ID = { adapter: 'idJagKitAcmeForm', client: 'id-jag-kit-acme' } // fixed: never the demo's acme-agent, whatever ACME_EXCHANGE_CLIENT_ID says;
const ADAPTER = 'com.pingidentity.adapters.htmlform.idp.HtmlFormIdpAuthnAdapter';
const REDIRECT = `${String(process.env.APP_ORIGIN || 'http://localhost:4720').replace(/\/$/, '')}/api/id-jag-playground/issuer/callback`;

/** The adapter body: the descriptor's defaults, one credential validator (acmeUsers). */
function adapterBody(descriptor) {
  const fields = (descriptor.configDescriptor?.fields || []).filter((f) => f.defaultValue !== undefined && f.defaultValue !== null)
    .map((f) => ({ name: f.name, value: String(f.defaultValue) }));
  return {
    id: ID.adapter, name: 'ID-JAG Kit: Acme sign-in form', pluginDescriptorRef: { id: ADAPTER },
    configuration: { fields, tables: [{ name: 'Credential Validators', rows: [{ defaultRow: false, fields: [{ name: 'Password Credential Validator Instance', value: 'acmeUsers' }] }] }] },
    attributeContract: { coreAttributes: [{ name: 'policy.action', masked: false, pseudonym: false }, { name: 'username', masked: false, pseudonym: true }], extendedAttributes: [], maskOgnlValues: false },
    attributeMapping: { attributeSources: [], issuanceCriteria: { conditionalCriteria: [] }, attributeContractFulfillment: {
      'policy.action': { source: { type: 'ADAPTER' }, value: 'policy.action' }, username: { source: { type: 'ADAPTER' }, value: 'username' } } },
  };
}

/** The client body; an existing client keeps its secret (`secret` is only for a new one). */
const clientBody = (secret) => ({
  clientId: ID.client, name: 'ID-JAG Kit: Acme sign-in', enabled: true,
  grantTypes: ['AUTHORIZATION_CODE', 'REFRESH_TOKEN', 'TOKEN_EXCHANGE'],
  ...(secret && { clientAuth: { type: 'SECRET', secret } }),
  redirectUris: [REDIRECT], allowAuthenticationApiInit: true,
  defaultAccessTokenManagerRef: { id: 'acmeAtm' }, tokenExchangeProcessorPolicyRef: { id: 'acmeIdJagPolicy' },
  restrictScopes: true, restrictedScopes: ['offline_access'], bypassApprovalPage: true, // the app asks for offline_access only (Acme defines no OIDC scopes)
});

if (require.main === module) {
  (async () => {
    const PORT = args.port || '29999';
    const api = adminApi(setting('ns', null, "the namespace holding Acme's pingfederate-admin secret"), PORT);
    if (args.remove) {
      const pol = await api('GET', '/authenticationPolicies/default');
      if (pol.body?.defaultAuthenticationSources?.some((s) => s.sourceRef?.id === ID.adapter)) {
        report('default authentication source cleared', await api('PUT', '/authenticationPolicies/default', { ...pol.body, defaultAuthenticationSources: [] }));
      }
      report(`delete adapter mapping ${ID.adapter}`, await api('DELETE', `/oauth/idpAdapterMappings/${ID.adapter}`));
      report(`delete client ${ID.client}`, await api('DELETE', `/oauth/clients/${ID.client}`));
      report(`delete adapter ${ID.adapter}`, await api('DELETE', `/idp/adapters/${ID.adapter}`));
      return;
    }
    const users = await api('GET', '/passwordCredentialValidators/acmeUsers');
    if (users.status !== 200) { console.error('  FAIL no acmeUsers store on this PingFederate: run configure-acme-idp.js first'); process.exit(1); }
    const have = await api('GET', `/idp/adapters/${ID.adapter}`);
    if (have.status === 200) console.log(`  keep adapter ${ID.adapter}`);
    else {
      const d = await api('GET', `/idp/adapters/descriptors/${ADAPTER}`);
      report(`create adapter ${ID.adapter}`, await api('POST', '/idp/adapters', adapterBody(d.body)));
    }
    const pol = await api('GET', '/authenticationPolicies/default');
    const sources = pol.body?.defaultAuthenticationSources || [];
    if (sources.some((s) => s.sourceRef?.id === ID.adapter)) console.log('  keep default authentication source');
    else if (sources.length) console.log(`  NOTE default authentication source is already ${sources.map((s) => s.sourceRef?.id).join(', ')}: left as it is, so pi.flow sign-in uses that`);
    else report('default authentication source = the adapter', await api('PUT', '/authenticationPolicies/default', { ...pol.body, defaultAuthenticationSources: [{ type: 'IDP_ADAPTER', sourceRef: { id: ID.adapter } }] }));
    const mapping = await api('GET', `/oauth/idpAdapterMappings/${ID.adapter}`);
    if (mapping.status === 200) console.log(`  keep adapter mapping ${ID.adapter}`);
    else {
      const user = { source: { type: 'ADAPTER' }, value: 'username' };
      report(`create adapter mapping ${ID.adapter}`, await api('POST', '/oauth/idpAdapterMappings', {
        id: ID.adapter, idpAdapterRef: { id: ID.adapter }, attributeSources: [], issuanceCriteria: { conditionalCriteria: [] },
        attributeContractFulfillment: { USER_KEY: user, USER_NAME: user } }));
    }
    const polSettings = await api('GET', '/authenticationPolicies/settings');
    if (polSettings.body?.enableIdpAuthnSelection) console.log('  keep IdP authentication policies enabled');
    else report('enable IdP authentication policies', await api('PUT', '/authenticationPolicies/settings', { ...polSettings.body, enableIdpAuthnSelection: true }));
    const authApi = await api('GET', '/authenticationApi/settings');
    if (authApi.body?.apiEnabled) console.log('  keep Authentication API enabled');
    else report('enable the Authentication API (pi.flow)', await api('PUT', '/authenticationApi/settings', { ...authApi.body, apiEnabled: true, restrictAccessToRedirectlessMode: true }));
    const client = await api('GET', `/oauth/clients/${ID.client}`);
    if (client.status === 200) {
      report(`update client ${ID.client} (redirect, pi.flow)`, await api('PUT', `/oauth/clients/${ID.client}`, { ...client.body, ...clientBody(null), clientAuth: client.body.clientAuth }));
    } else {
      const secret = crypto.randomBytes(24).toString('base64url');
      report(`create client ${ID.client}`, await api('POST', '/oauth/clients', clientBody(secret)));
      writeEnv({ ACME_EXCHANGE_CLIENT_ID: ID.client, ACME_EXCHANGE_CLIENT_SECRET: secret });
      console.log('  wrote ACME_EXCHANGE_CLIENT_ID and _SECRET to .env');
    }
  })().catch((e) => { console.error(`[acme-signin] ${e.message} (is the Acme admin port-forward on ${PORT} up?)`); process.exit(1); });
}

module.exports = { ID, adapterBody, clientBody, REDIRECT };
