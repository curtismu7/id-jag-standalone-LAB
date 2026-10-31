#!/usr/bin/env node
'use strict';
/**
 * Interop lab: let the kit's PingFederate mint ID-JAGs addressed to OTHER people's resource authorization servers, to
 * check that a PingFederate ID-JAG is accepted by them. One SP connection (OAuth Token Exchange, ID-JAG enabled) per
 * target, separate from the kit's own idJagKitResourceAsSp so nothing existing changes:
 *
 *   idJagKitMotd       audience https://motd.xaa.rocks/  resource https://motd.xaa.rocks/mcp  scope mcp
 *                      (the public xaa.rocks demo resource; it accepts ID-JAGs from any issuer with a public JWKS)
 *   idJagKitAuthplane  audience http://localhost:9100    resource https://rs.example.com/mcp  scope read
 *                      (an Authplane container, AGPL, run separately; its client id must equal the ID-JAG's client_id)
 *   idJagKitXaaDev     audience https://auth.resource.xaa.dev  resource https://api.resource.xaa.dev  scope todos.read
 *                      (xaa.dev's hosted resource AS; --xaa-client-id is the client registered there. The ID-JAG's sub is
 *                      pinned to --xaa-subject, a made-up id, so no real user's identity goes to a public sandbox.)
 *
 *   kubectl -n <ns> port-forward svc/pingfederate-admin 19999:9999 &
 *   node pingfederate/configure-interop-targets.js --ns=<ns> [--authplane-client-id=<id>]
 *   node pingfederate/configure-interop-targets.js --ns=<ns> --remove
 *
 * The subject token is the kit's usual one (a refresh token via PingFederate's default exchange policy, or an ID
 * token via idJagKitIdTokenPolicy); the exchange client is any client allowed the token-exchange grant (id-jag-kit).
 */
const pf = require('./pf-admin');
const { args, setting, report, acceptAll, from } = pf;

const NS = setting('ns', null, 'the namespace holding the pingfederate-admin secret');
const PORT = args.port || '19999';
const REMOVE = Boolean(args.remove);
const val = (k) => (args[k] && args[k] !== true ? String(args[k]) : '');
const AUTHPLANE_CLIENT_ID = val('authplane-client-id');
const XAA_CLIENT_ID = val('xaa-client-id');
const XAA_SUBJECT = val('xaa-subject');
const POLICY = 'idJagKitIdTokenPolicy';

const TARGETS = [
  { sp: 'idJagKitMotd', name: 'ID-JAG interop: motd.xaa.rocks', audience: 'https://motd.xaa.rocks/', resource: 'https://motd.xaa.rocks/mcp', scope: 'mcp', clientIdFromPolicy: true },
  { sp: 'idJagKitAuthplane', name: 'ID-JAG interop: Authplane (local container)', audience: 'http://localhost:9100', resource: 'https://rs.example.com/mcp', scope: 'read', clientId: AUTHPLANE_CLIENT_ID },
  { sp: 'idJagKitXaaDev', name: 'ID-JAG interop: xaa.dev hosted resource AS', audience: 'https://auth.resource.xaa.dev', resource: 'https://api.resource.xaa.dev', scope: 'todos.read', clientId: XAA_CLIENT_ID, subject: XAA_SUBJECT },
];

(async () => {
  const api = pf.adminApi(NS, PORT);
  if (REMOVE) {
    for (const t of TARGETS) {
      const have = await api('GET', `/idp/spConnections/${t.sp}`);
      if (have.status === 404) console.log(`  keep (absent) ${t.sp}`);
      else report(`delete SP connection ${t.sp}`, await api('DELETE', `/idp/spConnections/${t.sp}`));
    }
    return pf.done('interop', '[interop] removed.');
  }

  const keys = (await api('GET', '/keyPairs/oauthOpenIdConnect')).body || {};
  const signingKey = args['signing-key'] || (keys.staticJwksEnabled && keys.rsaActiveCertRef?.id);
  if (!signingKey) { console.error('PingFederate has no static JWKS: pass --signing-key=<signing key pair id> that its JWKS publishes'); process.exit(2); }
  const defaultPolicy = (await api('GET', '/oauth/tokenExchange/processor/settings')).body?.defaultProcessorPolicyRef?.id;
  const policies = [POLICY, ...(defaultPolicy && defaultPolicy !== POLICY ? [defaultPolicy] : [])];

  for (const t of TARGETS) {
    if (t.sp === 'idJagKitAuthplane' && !t.clientId) { console.log(`  skip ${t.sp}: pass --authplane-client-id (the client id Authplane generated)`); continue; }
    if (t.sp === 'idJagKitXaaDev' && (!t.clientId || !t.subject)) { console.log(`  skip ${t.sp}: pass --xaa-client-id and --xaa-subject`); continue; }
    const mapping = (policyId) => acceptAll({
      processorPolicyRef: { id: policyId },
      attributeContractFulfillment: {
        TOKEN_SUBJECT: t.subject ? { source: { type: 'TEXT' }, value: t.subject } : from('TOKEN_EXCHANGE_PROCESSOR_POLICY', [['TOKEN_SUBJECT', 'TOKEN_SUBJECT']]).TOKEN_SUBJECT,
        client_id: t.clientIdFromPolicy ? from('TOKEN_EXCHANGE_PROCESSOR_POLICY', [['client_id', 'client_id']]).client_id : { source: { type: 'TEXT' }, value: t.clientId },
        scope: { source: { type: 'TEXT' }, value: t.scope },
      },
    });
    const body = {
      type: 'SP', id: t.sp, name: t.name, entityId: t.audience, active: true, loggingMode: 'STANDARD', connectionTargetType: 'STANDARD',
      credentials: { certs: [], signingSettings: { signingKeyPairRef: { id: signingKey }, algorithm: 'SHA256withRSA', includeCertInSignature: false, includeRawKeyInSignature: false } },
      oauthTokenExchangeSettings: {
        resourceUris: [t.resource], minutesBefore: 1, minutesAfter: 5, idJagEnabled: true,
        attributeContract: { coreAttributes: [{ name: 'TOKEN_SUBJECT' }], extendedAttributes: [{ name: 'client_id' }, { name: 'scope' }] },
        processorPolicyMappings: policies.map(mapping),
      },
    };
    const have = await api('GET', `/idp/spConnections/${t.sp}`);
    if (have.status === 200) {
      // Same connection, possibly a new client id (Authplane regenerates it per client): update in place.
      report(`update SP connection ${t.sp}`, await api('PUT', `/idp/spConnections/${t.sp}`, { ...have.body, oauthTokenExchangeSettings: body.oauthTokenExchangeSettings }));
    } else report(`create SP connection ${t.sp} (ID-JAG for ${t.audience})`, await api('POST', '/idp/spConnections', body));
  }
  pf.done('interop', '[interop] done.');
})().catch(pf.fail('interop', PORT));
