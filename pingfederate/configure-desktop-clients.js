#!/usr/bin/env node
'use strict';
/**
 * Let real ID-JAG clients — mcpc and VS Code (enterprise-managed MCP auth) — reach this kit's resource AS and
 * mcp-sample, with our PingFederate as the IdP. Run configure-signin.js first: the clients sign in there.
 * Idempotent: existing objects are kept.
 *
 *   kubectl -n <ns> port-forward svc/pingfederate-admin 19999:9999 &
 *   node pingfederate/configure-desktop-clients.js --ns=<ns> [--port=19999] [--resource-as=…] [--resource=…]
 *   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.desktop-clients.yml up --build -d
 *
 * Both clients send the user's ID token as the token-exchange subject (PingFederate 13.1's default policy here
 * takes a refresh token), so at PingFederate this adds, ids prefixed idJagKit:
 *   - a JWT token processor that accepts PingFederate's own ID tokens issued to these two clients
 *   - a token exchange processor policy for subject_token_type id_token
 *   - an SP connection (OAuth token exchange, ID-JAG) whose audience is the resource AS issuer and whose
 *     resource is mcp-sample; it signs with the key PingFederate's static JWKS publishes
 *   - the OAuth clients id-jag-mcpc and id-jag-vscode, signing in through the kit's PingOne (added to the
 *     kit's client selector and token manager)
 * and for the resource AS, under deploy/local/ (gitignored): a trusted-IdP file naming PingFederate with both
 * client ids bound to one resource-AS client, id-jag-desktop, and a clients file with that client's secret hash.
 * Secrets are generated here, written to .env only (MCPC_IDP_CLIENT_SECRET, VSCODE_IDP_CLIENT_SECRET,
 * DESKTOP_RESOURCE_CLIENT_SECRET) and never printed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pf = require('./pf-admin');
const { args, setting, report, writeEnv, acceptAll, from } = pf;

const NS = setting('ns', null, 'the namespace holding the pingfederate-admin secret');
const PORT = args.port || '19999';
const PF_URL = setting('pf', 'PF_URL', 'our PingFederate issuer');
// Defaults are deploy/docker-compose.yml's addresses.
const RESOURCE_AS = String(args['resource-as'] || 'http://localhost:4721').replace(/\/$/, '');
const RESOURCE = String(args.resource || 'http://localhost:4722/mcp');
const SCOPE = 'read mcp:invoke'; // mcp-sample's scopes
const RAS_CLIENT = 'id-jag-desktop';
const ID = { processor: args.processor || 'idJagKitIdToken', policy: args.policy || 'idJagKitIdTokenPolicy', sp: args.sp || 'idJagKitResourceAsSp', selector: args.selector || 'idJagKitClientSelector', atm: args.atm || 'idJagKitAtm', oidc: args.oidc || 'idJagKitOidc' };
// Both stay confidential: PingFederate refuses ID-JAGs to public clients ("Public clients are not permitted to
// request an id-jag token"), so VS Code's IdP setting carries a client secret.
const CLIENTS = [
  { id: 'id-jag-mcpc', name: 'mcpc (ID-JAG desktop client)', env: 'MCPC_IDP_CLIENT_SECRET',
    redirects: [13316, 31613, 16133].map((p) => `http://127.0.0.1:${p}/callback`) }, // mcpc's fixed callback ports
  { id: 'id-jag-vscode', name: 'VS Code (ID-JAG desktop client)', env: 'VSCODE_IDP_CLIENT_SECRET',
    redirects: ['http://127.0.0.1:33418', 'http://127.0.0.1:33418/', 'https://vscode.dev/redirect'] },
];
const LOCAL = path.join(__dirname, '../deploy/local');

const api = pf.adminApi(NS, PORT);
const ensure = (...a) => pf.ensure(api, ...a);
const newSecret = () => crypto.randomBytes(32).toString('base64url');

(async () => {
  console.log(`[desktop] mcpc + VS Code → ${RESOURCE_AS} (${RESOURCE}) via ${PF_URL} (admin via localhost:${PORT}, ns ${NS})`);

  // The ID-JAG must verify against PingFederate's JWKS; with a static JWKS only the published key does (x5t, no kid).
  const keys = (await api('GET', '/keyPairs/oauthOpenIdConnect')).body || {};
  const signingKey = args['signing-key'] || (keys.staticJwksEnabled && keys.rsaActiveCertRef?.id);
  if (!signingKey) { console.error('PingFederate has no static JWKS: pass --signing-key=<signing key pair id> that its JWKS publishes'); process.exit(2); }

  await ensure(`ID token processor ${ID.processor}`, `/idp/tokenProcessors/${ID.processor}`, '/idp/tokenProcessors', {
    id: ID.processor, name: 'ID-JAG Kit: our own ID tokens',
    pluginDescriptorRef: { id: 'com.pingidentity.pf.tokenprocessors.jwt.JwtTokenProcessor' },
    configuration: {
      fields: [
        { name: 'Require Audience', value: 'true' }, { name: 'Require Expiration Time', value: 'true' },
        { name: 'Require Issued At Time', value: 'false' }, { name: 'Require Not Before Time', value: 'false' },
        { name: 'Default Cache Duration', value: '5' }, { name: 'Allowed Clock Skew', value: '60' }, { name: 'Max Future Validity', value: '4320' },
      ],
      tables: [
        { name: 'Allowed Issuers', rows: [{ defaultRow: false, fields: [{ name: 'Issuer', value: PF_URL }, { name: 'JWKS URL', value: `${PF_URL}/pf/JWKS` }, { name: 'JWKS', value: '' }] }] },
        { name: 'Allowed Audiences', rows: CLIENTS.map((c) => ({ defaultRow: false, fields: [{ name: 'Audience', value: c.id }] })) },
      ],
    },
    attributeContract: { coreAttributes: [{ name: 'sub' }], extendedAttributes: [{ name: 'aud' }, { name: 'iss' }] },
  });

  await ensure(`exchange policy ${ID.policy} (ID token subject)`, `/oauth/tokenExchange/processor/policies/${ID.policy}`, '/oauth/tokenExchange/processor/policies', {
    id: ID.policy, name: 'ID-JAG Kit: ID token → ID-JAG', actorTokenRequired: false,
    attributeContract: { coreAttributes: [{ name: 'subject' }], extendedAttributes: [{ name: 'TOKEN_SUBJECT' }, { name: 'client_id' }] },
    processorMappings: [acceptAll({
      subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token', subjectTokenProcessor: { id: ID.processor },
      // client_id = the client the ID token was issued to; the processor admits only our two clients.
      attributeContractFulfillment: from('SUBJECT_TOKEN', [['subject', 'sub'], ['TOKEN_SUBJECT', 'sub'], ['client_id', 'aud']]),
    })],
  });

  // Two ways in: the desktop clients' ID tokens (our policy) and the playground's pf-as mode, whose refresh token
  // PingFederate's default exchange policy takes. Both write sub from the policy. client_id must name the client that
  // authenticates at the resource AS (draft 4.4.1): the desktop policy already yields it (via the resource AS's alias for
  // the ID token's aud); the playground's refresh-token policy would yield the PF client (id-jag-kit), so it is pinned.
  const PLAYGROUND_CLIENT = process.env.RESOURCE_AS_CLIENT_ID || 'id-jag-playground';
  const clientIdFor = (id) => (id === ID.policy
    ? { source: { type: 'TOKEN_EXCHANGE_PROCESSOR_POLICY' }, value: 'client_id' }
    : { source: { type: 'TEXT' }, value: PLAYGROUND_CLIENT });
  const policyMapping = (id) => acceptAll({
    processorPolicyRef: { id },
    attributeContractFulfillment: {
      ...from('TOKEN_EXCHANGE_PROCESSOR_POLICY', [['TOKEN_SUBJECT', 'TOKEN_SUBJECT']]),
      client_id: clientIdFor(id),
      scope: { source: { type: 'TEXT' }, value: SCOPE },
    },
  });
  const defaultPolicy = (await api('GET', '/oauth/tokenExchange/processor/settings')).body?.defaultProcessorPolicyRef?.id;
  const policies = [ID.policy, ...(defaultPolicy && defaultPolicy !== ID.policy ? [defaultPolicy] : [])];
  await ensure(`SP connection ${ID.sp} (ID-JAG for ${RESOURCE_AS})`, `/idp/spConnections/${ID.sp}`, '/idp/spConnections', {
    type: 'SP', id: ID.sp, name: 'ID-JAG Kit resource AS', entityId: RESOURCE_AS, active: true, loggingMode: 'STANDARD',
    connectionTargetType: 'STANDARD',
    credentials: { certs: [], signingSettings: { signingKeyPairRef: { id: signingKey }, algorithm: 'SHA256withRSA', includeCertInSignature: false, includeRawKeyInSignature: false } },
    oauthTokenExchangeSettings: {
      resourceUris: [RESOURCE], minutesBefore: 1, minutesAfter: 5, idJagEnabled: true, // PingFederate's minimum Minutes Before is 1
      attributeContract: { coreAttributes: [{ name: 'TOKEN_SUBJECT' }], extendedAttributes: [{ name: 'client_id' }, { name: 'scope' }] },
      processorPolicyMappings: policies.map(policyMapping),
    },
  });
  const sp = await api('GET', `/idp/spConnections/${ID.sp}`);
  const mapped = new Set((sp.body?.oauthTokenExchangeSettings?.processorPolicyMappings || []).map((m) => m.processorPolicyRef.id));
  const unmapped = policies.filter((id) => !mapped.has(id));
  // Bring an existing connection's mappings in line (client_id above), not only add missing policies.
  const stale = (sp.body?.oauthTokenExchangeSettings?.processorPolicyMappings || []).filter((m) => {
    const want = clientIdFor(m.processorPolicyRef.id);
    const have = m.attributeContractFulfillment?.client_id;
    return policies.includes(m.processorPolicyRef.id) && (have?.source?.type !== want.source.type || have?.value !== want.value);
  });
  if (sp.status === 200 && (unmapped.length || stale.length)) {
    for (const m of stale) m.attributeContractFulfillment.client_id = clientIdFor(m.processorPolicyRef.id);
    sp.body.oauthTokenExchangeSettings.processorPolicyMappings.push(...unmapped.map(policyMapping));
    report(`${ID.sp}: map ${unmapped.join(', ') || 'no new policies'}${stale.length ? `, client_id on ${stale.length} existing` : ''}`, await api('PUT', `/idp/spConnections/${ID.sp}`, sp.body));
  }

  const wrote = {};
  for (const c of CLIENTS) {
    const have = await api('GET', `/oauth/clients/${c.id}`);
    if (have.status === 200) {
      console.log(`  keep client ${c.id}`);
      if (!process.env[c.env]) console.log(`  note: ${c.env} is not set; reset ${c.id}'s secret in PingFederate and set it`);
      continue;
    }
    const secret = newSecret();
    if (report(`create client ${c.id}`, await api('POST', '/oauth/clients', {
      clientId: c.id, name: c.name, enabled: true, redirectUris: c.redirects,
      grantTypes: ['AUTHORIZATION_CODE', 'REFRESH_TOKEN', 'TOKEN_EXCHANGE'], clientAuth: { type: 'SECRET', secret },
      requireProofKeyForCodeExchange: true, bypassApprovalPage: true,
      restrictScopes: true, restrictedScopes: ['openid', 'profile', 'email', 'offline_access', ...SCOPE.split(' ')],
      requireOfflineAccessScopeToIssueRefreshTokens: 'YES',
      defaultAccessTokenManagerRef: { id: ID.atm }, restrictToDefaultAccessTokenManager: true,
      oidcPolicy: { policyGroup: { id: ID.oidc } },
      tokenExchangeProcessorPolicyRef: { id: ID.policy },
    }))) wrote[c.env] = secret;
  }
  if (Object.keys(wrote).length) { writeEnv(wrote); console.log(`  wrote ${Object.keys(wrote).join(' / ')} to .env`); }

  // Sign in through the kit's PingOne: the kit's client selector and token manager must admit them.
  const sel = await api('GET', `/authenticationSelectors/${ID.selector}`);
  if (sel.status !== 200) {
    if (args['skip-selector']) console.log(`  skip ${ID.selector} (not found; sign-in uses this PingFederate's default selector)`);
    else { console.error(`  ${ID.selector} not found: run configure-signin.js first (or pass --skip-selector)`); process.exit(1); }
  } else {
  const rows = sel.body.configuration.tables.find((t) => t.name === 'Clients').rows;
  const listed = new Set(rows.map((r) => r.fields.find((f) => f.name === 'Client ID')?.value));
  const addRows = CLIENTS.filter((c) => !listed.has(c.id));
  if (addRows.length) {
    rows.push(...addRows.map((c) => ({ defaultRow: false, fields: [{ name: 'Client ID', value: c.id }] })));
    report(`${ID.selector}: sign in ${addRows.map((c) => c.id).join(', ')} at PingOne`, await api('PUT', `/authenticationSelectors/${ID.selector}`, sel.body));
  } else console.log(`  keep ${ID.selector}`);
  }
  const atm = await api('GET', `/oauth/accessTokenManagers/${ID.atm}`);
  const allowed = atm.body.accessControlSettings?.allowedClients || [];
  const addAtm = CLIENTS.filter((c) => !allowed.some((a) => a.id === c.id));
  if (addAtm.length) {
    atm.body.accessControlSettings = { inherited: false, restrictClients: true, allowedClients: [...allowed, ...addAtm.map((c) => ({ id: c.id }))] };
    report(`${ID.atm}: admit ${addAtm.map((c) => c.id).join(', ')}`, await api('PUT', `/oauth/accessTokenManagers/${ID.atm}`, atm.body));
  } else console.log(`  keep ${ID.atm} access`);

  // The resource AS side (read by deploy/docker-compose.desktop-clients.yml).
  fs.mkdirSync(LOCAL, { recursive: true });
  let rasSecret = process.env.DESKTOP_RESOURCE_CLIENT_SECRET;
  if (!rasSecret) { rasSecret = newSecret(); writeEnv({ DESKTOP_RESOURCE_CLIENT_SECRET: rasSecret }); console.log('  wrote DESKTOP_RESOURCE_CLIENT_SECRET to .env'); }
  fs.writeFileSync(path.join(LOCAL, 'desktop-trusted-idps.json'), JSON.stringify([{
    id: 'pingfederate', issuer: PF_URL, jwksUrl: `${PF_URL}/pf/JWKS`, scopes: SCOPE,
    // This entry shadows the playground registry's entry for the same issuer, so it also names the pf-as client.
    clientAliases: {
      ...Object.fromEntries(CLIENTS.map((c) => [c.id, RAS_CLIENT])),
      ...(process.env.PF_EXCHANGE_CLIENT_ID ? { [process.env.PF_EXCHANGE_CLIENT_ID]: process.env.RESOURCE_AS_CLIENT_ID || 'id-jag-playground' } : {}),
      // The pf-as and SAML mappings pin client_id to the playground's own client, so that id is a key too.
      [process.env.RESOURCE_AS_CLIENT_ID || 'id-jag-playground']: process.env.RESOURCE_AS_CLIENT_ID || 'id-jag-playground',
    },
  }], null, 2) + '\n');
  fs.writeFileSync(path.join(LOCAL, 'desktop-clients.json'), JSON.stringify([{
    client_id: RAS_CLIENT, client_secret_hash: crypto.createHash('sha256').update(rasSecret).digest('hex'), scope: SCOPE,
  }], null, 2) + '\n');
  console.log('  wrote deploy/local/desktop-trusted-idps.json and desktop-clients.json');

  pf.done('desktop', `[desktop] done. Resource AS client: ${RAS_CLIENT}. MCP server: ${RESOURCE}`);
})().catch(pf.fail('desktop', PORT));
