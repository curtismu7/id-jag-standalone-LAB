#!/usr/bin/env node
'use strict';
/**
 * Workaround for outside resource servers that look the signing key up by `kid`. PingFederate 13.1.3 puts only `typ`, `alg`
 * and `x5t` in a native ID-JAG header and has no setting to add `kid` (docs/interop-lab.md). A JWT access token manager does
 * have one, so this lets a real token exchange (the signed-in user's refresh token) be answered by such a manager:
 * the result is a JWT with `kid` and the ID-JAG claims. It is NOT a native ID-JAG (the issued token type is an access token).
 *
 *   kubectl -n <ns> port-forward svc/pingfederate-admin 19999:9999 &
 *   node pingfederate/configure-kid-workaround.js --ns=<ns> [--xaa-client-id=<id registered at xaa.dev>] [--subject=<sub>]
 *   node pingfederate/configure-kid-workaround.js --ns=<ns> --remove
 *
 * Creates (ids alphanumeric, prefixed idJagKidWa): one clone of the demo's JWT access token manager per target (Include Key ID
 * Header Parameter on, `typ` oauth-id-jag+jwt, the target's audience, selected by the target's resource URI, 5 minute lifetime,
 * not published to the JWKS because the signing key already is), an access token mapping from the default token exchange
 * processor policy to each, and one token-exchange client (id idjag-kit-kid) that may use any manager. Writes
 * INTEROP_KID_CLIENT_ID / INTEROP_KID_CLIENT_SECRET to the repo-root .env; the secret is never printed.
 * `sub` is pinned (default idjag-kit-lab-subject) so no real user's identity goes to a public sandbox.
 * motd.xaa.rocks is always set up; xaa.dev only with --xaa-client-id (its claim `client_id` must be the registered client).
 */
const pf = require('./pf-admin');
const crypto = require('crypto');
const { args, setting, adminApi, report, writeEnv, done, fail } = pf;

const NS = setting('ns', null, 'the namespace holding the pingfederate-admin secret');
const PORT = args.port || '19999';
const REMOVE = Boolean(args.remove);
const SUBJECT = args.subject && args.subject !== true ? String(args.subject) : 'idjag-kit-lab-subject';
const XAA_CLIENT = args['xaa-client-id'] && args['xaa-client-id'] !== true ? String(args['xaa-client-id']) : '';
const CLIENT = 'idjag-kit-kid';
const SOURCE_ATM = 'aiDemoPfJwtAtm';

const TARGETS = [
  { atm: 'idJagKidWaMotd', name: 'motd.xaa.rocks', aud: 'https://motd.xaa.rocks/', resource: 'https://motd.xaa.rocks/mcp', scope: 'mcp', clientId: CLIENT },
  ...(XAA_CLIENT || REMOVE ? [{ atm: 'idJagKidWaXaaDev', name: 'xaa.dev', aud: 'https://auth.resource.xaa.dev', resource: 'https://api.resource.xaa.dev', scope: 'todos.read', clientId: XAA_CLIENT }] : []),
];
const text = (value) => ({ source: { type: 'TEXT' }, value });
const setField = (cfg, name, value) => {
  const f = cfg.fields.find((x) => x.name === name);
  if (!f) throw new Error(`the source token manager has no field "${name}"`);
  f.value = value;
};

(async () => {
  const api = adminApi(NS, PORT);
  const policy = (await api('GET', '/oauth/tokenExchange/processor/settings')).body?.defaultProcessorPolicyRef?.id;
  const mapPath = (atm) => `/oauth/accessTokenMappings/${encodeURIComponent(`urn:ietf:params:oauth:grant-type:token-exchange|${policy}|${atm}`)}`;

  if (REMOVE) {
    for (const t of TARGETS) {
      if ((await api('GET', mapPath(t.atm))).status === 200) report(`delete mapping ${t.atm}`, await api('DELETE', mapPath(t.atm)));
    }
    if ((await api('GET', `/oauth/clients/${CLIENT}`)).status === 200) report(`delete client ${CLIENT}`, await api('DELETE', `/oauth/clients/${CLIENT}`));
    for (const t of TARGETS) {
      if ((await api('GET', `/oauth/accessTokenManagers/${t.atm}`)).status === 200) report(`delete token manager ${t.atm}`, await api('DELETE', `/oauth/accessTokenManagers/${t.atm}`));
    }
    return done('kid-workaround', '[kid-workaround] removed. INTEROP_KID_CLIENT_* are still in .env: delete them by hand.');
  }

  if (!policy) { console.error('no default token exchange processor policy is set'); process.exit(1); }
  const src = await api('GET', `/oauth/accessTokenManagers/${SOURCE_ATM}`);
  if (src.status !== 200) { console.error(`${SOURCE_ATM} (a JWT access token manager to clone) is missing`); process.exit(1); }

  for (const t of TARGETS) {
    if ((await api('GET', `/oauth/accessTokenManagers/${t.atm}`)).status === 200) { console.log(`  keep token manager ${t.atm}`); }
    else {
      const atm = JSON.parse(JSON.stringify(src.body));
      atm.id = t.atm; atm.name = `ID-JAG kid workaround (${t.name})`; delete atm.lastModified; delete atm.sequenceNumber;
      setField(atm.configuration, 'Include Key ID Header Parameter', 'true');
      setField(atm.configuration, 'Type Header Value', 'oauth-id-jag+jwt');
      setField(atm.configuration, 'Audience Claim Value', t.aud);
      setField(atm.configuration, 'Issuer Claim Value', args.pf && args.pf !== true ? String(args.pf) : process.env.PF_URL || src.body.configuration.fields.find((f) => f.name === 'Issuer Claim Value').value);
      setField(atm.configuration, 'Token Lifetime', '5'); // minutes, like an ID-JAG
      setField(atm.configuration, 'Publish Keys to the PingFederate JWKS Endpoint', 'false'); // the key is already published; twice fails the kid uniqueness check
      atm.attributeContract = { coreAttributes: [], extendedAttributes: ['sub', 'scope', 'client_id', 'resource'].map((name) => ({ name, multiValued: false })) };
      atm.selectionSettings = { resourceUris: [t.resource] };
      report(`create token manager ${t.atm}`, await api('POST', '/oauth/accessTokenManagers', atm));
    }
    if ((await api('GET', mapPath(t.atm))).status === 200) { console.log(`  keep mapping ${policy} -> ${t.atm}`); continue; }
    report(`create mapping ${policy} -> ${t.atm}`, await api('POST', '/oauth/accessTokenMappings', {
      context: { type: 'TOKEN_EXCHANGE_PROCESSOR_POLICY', contextRef: { id: policy } }, accessTokenManagerRef: { id: t.atm },
      attributeContractFulfillment: { sub: text(SUBJECT), scope: text(t.scope), client_id: text(t.clientId), resource: text(t.resource) },
      attributeSources: [], issuanceCriteria: { conditionalCriteria: [] },
    }));
  }

  if ((await api('GET', `/oauth/clients/${CLIENT}`)).status === 200) console.log(`  keep client ${CLIENT} (its secret is not changed)`);
  else {
    const secret = crypto.randomBytes(24).toString('base64url');
    const ok = report(`create client ${CLIENT}`, await api('POST', '/oauth/clients', {
      clientId: CLIENT, name: 'ID-JAG kit kid workaround', enabled: true, grantTypes: ['TOKEN_EXCHANGE'], restrictScopes: false,
      clientAuth: { type: 'SECRET', secret }, defaultAccessTokenManagerRef: { id: TARGETS[0].atm }, restrictToDefaultAccessTokenManager: false,
    }));
    if (ok) { writeEnv({ INTEROP_KID_CLIENT_ID: CLIENT, INTEROP_KID_CLIENT_SECRET: secret }); console.log('  wrote INTEROP_KID_CLIENT_ID / _SECRET to .env'); }
  }
  return done('kid-workaround', `[kid-workaround] done. Targets: ${TARGETS.map((t) => t.name).join(', ')}.`);
})().catch(fail('kid-workaround', PORT));
