#!/usr/bin/env node
'use strict';
/**
 * Configure this app's sign-in at our PingFederate: PingFederate federates to the kit's own PingOne environment
 * (tools/provision-pingone-signin.js) for this app's OAuth client only. Idempotent: existing objects are kept.
 *
 *   kubectl -n <ns> port-forward svc/pingfederate-admin 19999:9999 &
 *   node pingfederate/configure-signin.js --ns=<ns> [--port=19999] [--app-origin=https://…]
 *   node pingfederate/configure-signin.js --local [--app-origin=https://…]    # no PingOne: see below
 *
 * Creates (ids prefixed idJagKit, client PF_EXCHANGE_CLIENT_ID else id-jag-kit):
 *   - an OIDC IdP connection to STANDALONE_P1_ISSUER with the PingOne app STANDALONE_P1_PF_APP_CLIENT_ID / _SECRET
 *   - a policy contract (subject, email, email_verified, name, groups) and its persistent-grant mapping
 *   - an access token manager and OIDC policy only this client may use, so the ID token carries those claims
 *   - the client: authorization code + refresh + token exchange, PKCE, redirect URIs ${APP_ORIGIN}/auth/callback and
 *     ${APP_ORIGIN}/api/id-jag-playground/issuer/callback (a rerun with another --app-origin adds that origin's pair; a local
 *     origin also registers its localhost / 127.0.0.1 twin and port 4720; existing URIs are kept)
 *   - a new FIRST authentication policy: "is it this client?" yes → PingOne, no → CONTINUE to the policies that were
 *     already there, which are not changed.
 * With --local (used by `npm run setup`, mode pf-local) there is no PingOne: everything above is created except the IdP
 * connection and the authentication policy, plus the OAuth scopes a new PingFederate lacks. configure-local-signin.js then adds the policy, signing the kit's users in
 * at PingFederate itself. The admin API is reached by PF_ADMIN_URL (see pf-admin.js), so --ns and --port are not needed.
 * Writes PF_EXCHANGE_CLIENT_ID / PF_EXCHANGE_CLIENT_SECRET to the shared settings file (PF_SETTINGS_FILE, else STANDALONE_ENV, else ~/Development/.env) when it creates the client
 * (the secret is generated here and never printed).
 */
const crypto = require('crypto');
const pf = require('./pf-admin');
const { args, setting, secret, report, writeEnv, acceptAll, from, same } = pf;

const NS = setting('ns', null, 'the namespace holding the pingfederate-admin secret');
const PORT = args.port || '19999';
const LOCAL = Boolean(args.local);
const P1_ISSUER = LOCAL ? '' : setting('p1-issuer', 'STANDALONE_P1_ISSUER', 'the PingOne issuer (run tools/provision-pingone-signin.js)');
const P1_CLIENT = LOCAL ? '' : setting('p1-client', 'STANDALONE_P1_PF_APP_CLIENT_ID', 'the PingOne app for PingFederate');
const P1_SECRET = LOCAL ? '' : secret('STANDALONE_P1_PF_APP_CLIENT_SECRET');
const APP_ORIGIN = String(args['app-origin'] || process.env.APP_ORIGIN || 'http://localhost:4720').replace(/\/$/, '');
const CLIENT = process.env.PF_EXCHANGE_CLIENT_ID || 'id-jag-kit';
const ID = { conn: 'idJagKitP1', apc: 'idJagKitApc', atm: 'idJagKitAtm', oidc: 'idJagKitOidc', selector: 'idJagKitClientSelector' };
const CLAIMS = ['email', 'email_verified', 'name', 'groups'];

const api = pf.adminApi(NS, PORT);
const ensure = (...a) => pf.ensure(api, ...a);

(async () => {
  console.log(LOCAL ? `[pf] sign-in objects for ${CLIENT} (local users, no PingOne)` : `[pf] sign-in for ${CLIENT} at PingOne ${P1_ISSUER} (admin via localhost:${PORT}, ns ${NS})`);

  const meta = LOCAL ? null : await fetch(`${P1_ISSUER}/.well-known/openid-configuration`).then((r) => r.json());
  if (meta && meta.issuer !== P1_ISSUER) { console.error(`PingOne discovery names issuer ${meta.issuer}`); process.exit(1); }

  await ensure(`policy contract ${ID.apc}`, `/authenticationPolicyContracts/${ID.apc}`, '/authenticationPolicyContracts', {
    id: ID.apc, name: 'ID-JAG Kit sign-in', coreAttributes: [{ name: 'subject' }], extendedAttributes: CLAIMS.map((name) => ({ name })),
  });

  if (!LOCAL) await ensure(`IdP connection ${ID.conn} (PingOne)`, `/sp/idpConnections/${ID.conn}`, '/sp/idpConnections', {
    type: 'IDP', id: ID.conn, name: 'ID-JAG Kit: PingOne sign-in', entityId: P1_ISSUER, active: true, loggingMode: 'STANDARD',
    oidcClientCredentials: { clientId: P1_CLIENT, clientSecret: P1_SECRET },
    idpBrowserSso: {
      protocol: 'OIDC', idpIdentityMapping: 'ACCOUNT_MAPPING',
      attributeContract: { coreAttributes: [{ name: 'sub' }], extendedAttributes: CLAIMS.map((name) => ({ name })) },
      oidcProviderSettings: {
        scopes: 'openid profile email', loginType: 'CODE', authenticationScheme: 'BASIC', enablePKCE: true,
        authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint,
        userInfoEndpoint: meta.userinfo_endpoint, jwksURL: meta.jwks_uri, requestParameters: [],
      },
      authenticationPolicyContractMappings: [acceptAll({
        authenticationPolicyContractRef: { id: ID.apc },
        attributeContractFulfillment: from('CLAIMS', [['subject', 'sub'], ...same(CLAIMS)]), // CLAIMS = from the OIDC provider
      })],
      adapterMappings: [],
    },
  });

  await ensure('persistent-grant mapping', `/oauth/authenticationPolicyContractMappings/${ID.apc}`, '/oauth/authenticationPolicyContractMappings', acceptAll({
    id: ID.apc, authenticationPolicyContractRef: { id: ID.apc },
    attributeContractFulfillment: from('AUTHENTICATION_POLICY_CONTRACT', [['USER_KEY', 'subject'], ['USER_NAME', 'email']]),
  }));

  await ensure(`access token manager ${ID.atm}`, `/oauth/accessTokenManagers/${ID.atm}`, '/oauth/accessTokenManagers', {
    id: ID.atm, name: 'ID-JAG Kit sign-in tokens',
    pluginDescriptorRef: { id: 'org.sourceid.oauth20.token.plugin.impl.ReferenceBearerAccessTokenManagementPlugin' },
    configuration: { fields: [], tables: [] },
    attributeContract: { extendedAttributes: [{ name: 'sub' }, ...CLAIMS.map((name) => ({ name, multiValued: name === 'groups' }))] },
  });

  const maps = (await api('GET', '/oauth/accessTokenMappings')).body || [];
  if (maps.some((m) => m.accessTokenManagerRef.id === ID.atm && m.context.contextRef?.id === ID.apc)) console.log('  keep access token mapping');
  else report('create access token mapping', await api('POST', '/oauth/accessTokenMappings', acceptAll({
    context: { type: 'AUTHENTICATION_POLICY_CONTRACT', contextRef: { id: ID.apc } }, accessTokenManagerRef: { id: ID.atm },
    attributeContractFulfillment: from('AUTHENTICATION_POLICY_CONTRACT', [['sub', 'subject'], ...same(CLAIMS)]),
  })));
  // A refresh grant has no sign-in to map from, only the persistent grant (DEFAULT context), which keeps USER_KEY.
  if (maps.some((m) => m.accessTokenManagerRef.id === ID.atm && m.context.type === 'DEFAULT')) console.log('  keep refresh-time token mapping');
  else report('create refresh-time token mapping', await api('POST', '/oauth/accessTokenMappings', acceptAll({
    context: { type: 'DEFAULT' }, accessTokenManagerRef: { id: ID.atm },
    attributeContractFulfillment: {
      ...from('OAUTH_PERSISTENT_GRANT', [['sub', 'USER_KEY']]),
      ...Object.fromEntries(CLAIMS.map((n) => [n, { source: { type: 'NO_MAPPING' } }])),
    },
  })));

  // Desktop ID-JAG clients (configure-desktop-clients.js) renew their short-lived ID token with the refresh token.
  await ensure(`OIDC policy ${ID.oidc}`, `/oauth/openIdConnect/policies/${ID.oidc}`, '/oauth/openIdConnect/policies', {
    id: ID.oidc, name: 'ID-JAG Kit sign-in', accessTokenManagerRef: { id: ID.atm }, idTokenLifetime: 5,
    includeUserInfoInIdToken: false, returnIdTokenOnRefreshGrant: true,
    attributeContract: {
      coreAttributes: [{ name: 'sub' }],
      extendedAttributes: CLAIMS.map((name) => ({ name, includeInIdToken: true, includeInUserInfo: true, multiValued: name === 'groups' })),
    },
    attributeMapping: acceptAll({ attributeContractFulfillment: from('TOKEN', same(['sub', ...CLAIMS])) }),
  });
  const oidc = await api('GET', `/oauth/openIdConnect/policies/${ID.oidc}`);
  if (oidc.status === 200 && !oidc.body.returnIdTokenOnRefreshGrant) {
    report(`${ID.oidc}: return an ID token on refresh`, await api('PUT', `/oauth/openIdConnect/policies/${ID.oidc}`, { ...oidc.body, returnIdTokenOnRefreshGrant: true }));
  }

  if (LOCAL) { // a new PingFederate defines none of the scopes the kit's client is restricted to (the client create answers 422)
    const settings = (await api('GET', '/oauth/authServerSettings')).body || {}; // scopes = the common scopes
    const have = new Set([...(settings.scopes || []), ...(settings.exclusiveScopes || [])].map((x) => x.name));
    for (const name of ['openid', 'profile', 'email', 'offline_access']) {
      if (have.has(name)) console.log(`  keep scope ${name}`);
      else report(`create scope ${name}`, await api('POST', '/oauth/authServerSettings/scopes/commonScopes', { name, description: `${name} (ID-JAG Kit)` }));
    }
  }

  const redirects = pf.signinRedirects(APP_ORIGIN);
  const client = await api('GET', `/oauth/clients/${encodeURIComponent(CLIENT)}`);
  if (client.status === 200) {
    const missing = redirects.filter((u) => !client.body.redirectUris.includes(u));
    if (missing.length) {
      client.body.redirectUris.push(...missing);
      report(`client ${CLIENT}: add ${missing.join(' ')}`, await api('PUT', `/oauth/clients/${encodeURIComponent(CLIENT)}`, client.body));
    } else console.log(`  keep client ${CLIENT}`);
    if (!process.env.PF_EXCHANGE_CLIENT_SECRET) console.log(`  note: PF_EXCHANGE_CLIENT_SECRET is not set; reset ${CLIENT}'s secret in PingFederate and set it`);
  } else {
    const secret = crypto.randomBytes(32).toString('base64url');
    const ok = report(`create client ${CLIENT}`, await api('POST', '/oauth/clients', {
      clientId: CLIENT, name: 'ID-JAG Kit (standalone app)', enabled: true,
      grantTypes: ['AUTHORIZATION_CODE', 'REFRESH_TOKEN', 'TOKEN_EXCHANGE'], redirectUris: redirects,
      clientAuth: { type: 'SECRET', secret }, requireProofKeyForCodeExchange: true, bypassApprovalPage: true,
      restrictScopes: true, restrictedScopes: ['openid', 'profile', 'email', 'offline_access'],
      defaultAccessTokenManagerRef: { id: ID.atm }, restrictToDefaultAccessTokenManager: true,
      oidcPolicy: { policyGroup: { id: ID.oidc } }, requireOfflineAccessScopeToIssueRefreshTokens: 'YES',
    }));
    if (ok) { writeEnv({ PF_EXCHANGE_CLIENT_ID: CLIENT, PF_EXCHANGE_CLIENT_SECRET: secret }); console.log('  wrote PF_EXCHANGE_CLIENT_ID / _SECRET to .env'); }
  }

  // Only this client may get tokens from the kit's token manager.
  const atm = await api('GET', `/oauth/accessTokenManagers/${ID.atm}`);
  if (atm.status === 200 && !atm.body.accessControlSettings?.restrictClients) {
    atm.body.accessControlSettings = { inherited: false, restrictClients: true, allowedClients: [{ id: CLIENT }] };
    report(`restrict ${ID.atm} to ${CLIENT}`, await api('PUT', `/oauth/accessTokenManagers/${ID.atm}`, atm.body));
  }

  await ensure(`selector ${ID.selector}`, `/authenticationSelectors/${ID.selector}`, '/authenticationSelectors', {
    id: ID.selector, name: 'ID-JAG Kit client?',
    pluginDescriptorRef: { id: 'com.pingidentity.pf.selectors.oauthclient.OAuthClientAdapterSelector' },
    configuration: { fields: [], tables: [{ name: 'Clients', rows: [{ defaultRow: false, fields: [{ name: 'Client ID', value: CLIENT }] }] }] },
  });

  if (LOCAL) { pf.done('pf', '[pf] done. Next: configure-local-signin.js adds the sign-in policy and the kit users.'); return; }
  const policy = await api('GET', '/authenticationPolicies/default');
  if (policy.body.authnSelectionTrees.some((t) => t.rootNode.action.authenticationSelectorRef?.id === ID.selector)) console.log('  keep authentication policy');
  else {
    policy.body.authnSelectionTrees.unshift({
      name: 'ID-JAG Kit: its client signs in at PingOne', enabled: true, handleFailuresLocally: false,
      rootNode: {
        action: { type: 'AUTHN_SELECTOR', authenticationSelectorRef: { id: ID.selector } },
        children: [
          {
            action: { type: 'AUTHN_SOURCE', context: 'Yes', authenticationSource: { type: 'IDP_CONNECTION', sourceRef: { id: ID.conn } } },
            children: [
              { action: { type: 'DONE', context: 'Fail' } },
              { action: { type: 'APC_MAPPING', context: 'Success', authenticationPolicyContractRef: { id: ID.apc },
                attributeMapping: acceptAll({ attributeContractFulfillment: from('IDP_CONNECTION', [['subject', 'sub'], ...same(CLAIMS)], { id: ID.conn }) }) } },
            ],
          },
          { action: { type: 'CONTINUE', context: 'No' } },
        ],
      },
    });
    report('authentication policy: new first policy for the kit client', await api('PUT', '/authenticationPolicies/default', policy.body));
  }

  pf.done('pf', `[pf] done. Redirect URI at PingOne: ${(await api('GET', `/sp/idpConnections/${ID.conn}`)).body?.idpBrowserSso?.oidcProviderSettings?.redirectUri}`);
})().catch(pf.fail('pf', PORT));
