#!/usr/bin/env node
'use strict';
/**
 * OWNER-RUN. Lets the shared Acme PingFederate issue ID-JAGs to the kit's own local PingFederate (pf-pf mode), without
 * touching anything the AI-DEMO2 demo uses on Acme. It is ADDITIVE: it creates, changes and deletes only these three
 * objects, and every write is checked against that list before it is sent:
 *   - SP connection idJagKitAcmeToLocalPf: ID-JAG on (5 minutes), signed with Acme's existing ID-JAG signing key
 *     (acme-idjag-signing, referenced only), entity id = the local PingFederate issuer (it becomes the ID-JAG aud),
 *     resourceUris = the kit's PF_RESOURCE, client_id = the redeemer client at the local PingFederate, scope "read mcp:invoke"
 *   - token exchange policy idJagKitPolicy, mapped ONLY by that connection
 *   - refresh token processor idJagKitRefreshToken, the policy's subject processor
 * configure-acme-signin.js then points the kit's sign-in client (id-jag-kit-acme) at idJagKitPolicy, so that client cannot
 * ask Acme for an ID-JAG addressed to anything the demo uses (acmeToPingFed, acmeToResourceAs).
 * Never touched: acmeToPingFed, acmeToResourceAs, acmeIdJagPolicy, acmeAtm, acme-agent, acmeRefreshToken, the signing key,
 * the static JWKS, the default exchange policy, or any other object. It refuses to run when PF_RESOURCE or the local issuer
 * is already used by a connection that is not the kit's.
 *
 *   kubectl --context <ctx> -n <ns> port-forward svc/pingfederate-admin 29999:9999 &
 *   unset PF_ADMIN_URL
 *   node pingfederate/configure-acme-kit-connection.js --acme --expect-issuer=https://<acme-host> --ns=<ns> --context=<ctx> --inventory
 *   ... --dry-run     the plan: GET requests only, no write
 *   ...               do it
 *   ... --remove      undo (the connection, then the policy, then the processor)
 *
 * Options: --pf=… else PF_URL (the local issuer, https://127.0.0.1:4732), --pf-resource=… else PF_RESOURCE,
 * --pf-client=… else PF_REDEEMER_CLIENT_ID (default id-jag-redeemer), --port=29999.
 * Guards (acme-guard.js): --acme, PF_ADMIN_URL unset, and the admin API's base URL must equal --expect-issuer.
 */
const pf = require('./pf-admin');
const { acmePreflight, acmeVerify } = require('./acme-guard');
const { acceptAll } = pf;

const ID = { connection: 'idJagKitAcmeToLocalPf', policy: 'idJagKitPolicy', processor: 'idJagKitRefreshToken' };
const SIGNING_KEY = 'acme-idjag-signing'; // Acme's existing ID-JAG signing key: referenced, never changed
const KIT_CLIENT = 'id-jag-kit-acme';
const SCOPE = 'read mcp:invoke'; // what mcp-sample's tools need

// The only writes this script may send: [collection, id of the one object it owns there].
const OWN = [['/idp/spConnections', ID.connection], ['/oauth/tokenExchange/processor/policies', ID.policy], ['/idp/tokenProcessors', ID.processor]];

/** Why a request must not be sent, or null. Reads are always fine; a write must be to one of OWN. */
function writeProblem(method, p, body) {
  if (method === 'GET') return null;
  for (const [collection, id] of OWN) {
    if (method === 'POST' && p === collection && body?.id === id) return null;
    if (method === 'PUT' && p === `${collection}/${id}` && body?.id === id) return null;
    if (method === 'DELETE' && p === `${collection}/${id}`) return null;
  }
  return `refusing ${method} ${p}: not one of this script's own objects (${OWN.map(([, id]) => id).join(', ')})`;
}

/** The admin API with the write list enforced, and (dry run) every write turned into a printed plan line. */
function guarded(api, { dry = false, log = console.log } = {}) {
  return async (method, p, body) => {
    const bad = writeProblem(method, p, body);
    if (bad) throw new Error(bad);
    if (dry && method !== 'GET') { log(`  plan ${method} ${p}`); return { status: 200, body }; }
    return api(method, p, body);
  };
}

const isKit = (id) => typeof id === 'string' && id.startsWith('idJagKit');
const items = (r) => (Array.isArray(r.body?.items) ? r.body.items : []);

/** Throws when the local issuer or the resource is something other than the kit's connection already uses. */
function validate(o, acmeIssuer) {
  if (!/^https:\/\/[^/\s]+$/.test(o.pf)) throw new Error('--pf (the local issuer) must be an https origin with no path, like https://127.0.0.1:4732');
  if (acmeIssuer && o.pf === String(acmeIssuer).replace(/\/+$/, '')) throw new Error('--pf is the Acme issuer itself: an IdP must not redeem its own ID-JAG (draft section 9.3)');
  if (!/^https?:\/\/[^\s]+$/.test(o.resource)) throw new Error('--pf-resource must be a URL, like http://localhost:9090/mcp');
  if (!o.client) throw new Error('--pf-client is empty');
}

const refreshProcessor = () => ({
  id: ID.processor, name: 'ID-JAG Kit refresh token processor',
  pluginDescriptorRef: { id: 'org.sourceid.wstrust.processor.oauth.RefreshTokenTokenProcessor' },
  configuration: { fields: [], tables: [] },
  attributeContract: { coreAttributes: ['expires_at', 'scope', 'TOKEN_SUBJECT', 'client_id'].map((name) => ({ name, masked: true })), extendedAttributes: [] },
});

const fromSubject = (v) => ({ source: { type: 'SUBJECT_TOKEN' }, value: v });
const exchangePolicy = () => ({
  id: ID.policy, name: 'ID-JAG Kit refresh exchange', actorTokenRequired: false,
  attributeContract: { coreAttributes: [{ name: 'subject' }], extendedAttributes: ['expires_at', 'scope', 'TOKEN_SUBJECT', 'client_id'].map((name) => ({ name })) },
  processorMappings: [acceptAll({
    subjectTokenType: 'urn:ietf:params:oauth:token-type:refresh_token', subjectTokenProcessor: { id: ID.processor },
    actorTokenType: '', actorTokenProcessor: {},
    attributeContractFulfillment: { subject: fromSubject('TOKEN_SUBJECT'), TOKEN_SUBJECT: fromSubject('TOKEN_SUBJECT'),
      expires_at: fromSubject('expires_at'), scope: fromSubject('scope'), client_id: fromSubject('client_id') },
  })],
});

const policyMapping = (clientId) => acceptAll({
  processorPolicyRef: { id: ID.policy },
  attributeContractFulfillment: {
    TOKEN_SUBJECT: { source: { type: 'TOKEN_EXCHANGE_PROCESSOR_POLICY' }, value: 'TOKEN_SUBJECT' },
    client_id: { source: { type: 'TEXT' }, value: clientId },
    scope: { source: { type: 'TEXT' }, value: SCOPE },
  },
});

const connectionBody = (o) => ({
  type: 'SP', id: ID.connection, name: 'ID-JAG Kit: Acme to the kit PingFederate', entityId: o.pf, active: true, loggingMode: 'STANDARD',
  virtualEntityIds: [], connectionTargetType: 'STANDARD',
  credentials: { certs: [], signingSettings: { signingKeyPairRef: { id: SIGNING_KEY }, algorithm: 'SHA256withRSA', includeCertInSignature: false, includeRawKeyInSignature: false } },
  oauthTokenExchangeSettings: {
    resourceUris: [o.resource], minutesBefore: 5, minutesAfter: 5, idJagEnabled: true, // ID-JAGs live about 5 minutes (spec, Okta)
    attributeContract: { coreAttributes: [{ name: 'TOKEN_SUBJECT' }], extendedAttributes: [{ name: 'client_id' }, { name: 'scope' }] },
    processorPolicyMappings: [policyMapping(o.client)],
  },
});

/** Does the stored connection already say what connectionBody says? PingFederate adds defaults, so compare the values we set. */
function connectionMatches(stored, o) {
  const ts = stored.oauthTokenExchangeSettings || {};
  const mine = (ts.processorPolicyMappings || []).filter((m) => m.processorPolicyRef?.id === ID.policy);
  const f = mine[0]?.attributeContractFulfillment || {};
  return stored.entityId === o.pf && stored.credentials?.signingSettings?.signingKeyPairRef?.id === SIGNING_KEY && ts.idJagEnabled === true
    && (ts.resourceUris || []).length === 1 && ts.resourceUris[0] === o.resource && (ts.processorPolicyMappings || []).length === 1 && mine.length === 1
    && f.client_id?.source?.type === 'TEXT' && f.client_id.value === o.client && f.scope?.value === SCOPE && f.TOKEN_SUBJECT?.source?.type === 'TOKEN_EXCHANGE_PROCESSOR_POLICY';
}

/** The connections, with their token exchange settings (the list normally carries them; a missing one is read singly). */
async function connections(api) {
  const out = [];
  for (const c of items(await api('GET', '/idp/spConnections'))) {
    if (c.oauthTokenExchangeSettings === undefined && !isKit(c.id)) {
      const one = await api('GET', `/idp/spConnections/${encodeURIComponent(c.id)}`); // a read, never a write
      out.push(one.status === 200 ? one.body : c);
    } else out.push(c);
  }
  return out;
}

/** Read-only: ids, entity ids and resource URIs, sorted so a before and an after can be diffed. */
async function inventory(rawApi, log = console.log) {
  const api = guarded(rawApi);
  const lines = [];
  for (const c of await connections(api)) {
    const ts = c.oauthTokenExchangeSettings || {};
    lines.push(`connection ${c.id}  entityId=${c.entityId}  resources=[${(ts.resourceUris || []).join(', ')}]  idJag=${Boolean(ts.idJagEnabled)}${isKit(c.id) ? '  (kit)' : ''}`);
  }
  for (const [what, path] of [['exchange policy', '/oauth/tokenExchange/processor/policies'], ['token processor', '/idp/tokenProcessors'], ['signing key', '/keyPairs/signing']]) {
    for (const x of items(await api('GET', path))) lines.push(`${what} ${x.id}${isKit(x.id) ? '  (kit)' : ''}`);
  }
  const client = await api('GET', `/oauth/clients/${KIT_CLIENT}`);
  lines.push(`kit sign-in client ${KIT_CLIENT}: ${client.status === 200 ? `present, exchange policy ${client.body.tokenExchangeProcessorPolicyRef?.id ?? '(none)'}` : 'absent'}`);
  lines.sort();
  lines.forEach((l) => log(l));
  return lines;
}

/** @param o { pf, resource, client }  @param opts { dry, remove, log, acmeIssuer } */
async function run(rawApi, o, { dry = false, remove = false, acmeIssuer } = {}) {
  const api = guarded(rawApi, { dry });
  const ensure = (...a) => pf.ensure(api, ...a);

  if (remove) {
    const client = await api('GET', `/oauth/clients/${KIT_CLIENT}`);
    if (client.status === 200 && client.body.tokenExchangeProcessorPolicyRef?.id === ID.policy) {
      throw new Error(`client ${KIT_CLIENT} still uses ${ID.policy}: run configure-acme-signin.js --remove first`);
    }
    for (const [what, path] of [['SP connection', `/idp/spConnections/${ID.connection}`], ['exchange policy', `/oauth/tokenExchange/processor/policies/${ID.policy}`], ['token processor', `/idp/tokenProcessors/${ID.processor}`]]) {
      if ((await api('GET', path)).status === 200) pf.report(`delete ${what} ${path.split('/').pop()}`, await api('DELETE', path));
      else console.log(`  keep (absent) ${what} ${path.split('/').pop()}`);
    }
    return !pf.hasFailed();
  }

  validate(o, acmeIssuer);
  const keys = await api('GET', '/keyPairs/signing');
  if (!items(keys).some((k) => k.id === SIGNING_KEY)) throw new Error(`Acme has no signing key ${SIGNING_KEY}: nothing to sign the ID-JAG with. Run configure-acme-idp.js's key step first (the demo normally already has it)`);
  for (const c of await connections(api)) {
    if (isKit(c.id)) continue;
    if (c.entityId === o.pf) throw new Error(`the local issuer is already the entity id of connection ${c.id}, which is not the kit's: refusing to add a second connection with it`);
    if ((c.oauthTokenExchangeSettings?.resourceUris || []).includes(o.resource)) throw new Error(`the resource ${o.resource} is already used by connection ${c.id}, which is not the kit's: pick another --pf-resource`);
  }

  await ensure(`refresh token processor ${ID.processor}`, `/idp/tokenProcessors/${ID.processor}`, '/idp/tokenProcessors', refreshProcessor());
  await ensure(`exchange policy ${ID.policy}`, `/oauth/tokenExchange/processor/policies/${ID.policy}`, '/oauth/tokenExchange/processor/policies', exchangePolicy());
  const have = await api('GET', `/idp/spConnections/${ID.connection}`);
  if (have.status !== 200) pf.report(`create SP connection ${ID.connection}`, await api('POST', '/idp/spConnections', connectionBody(o)));
  else if (connectionMatches(have.body, o)) console.log(`  keep SP connection ${ID.connection}`);
  else {
    const want = connectionBody(o);
    pf.report(`update SP connection ${ID.connection}`, await api('PUT', `/idp/spConnections/${ID.connection}`,
      { ...have.body, entityId: want.entityId, credentials: want.credentials, oauthTokenExchangeSettings: want.oauthTokenExchangeSettings }));
  }
  return !pf.hasFailed();
}

module.exports = { run, inventory, validate, writeProblem, guarded, connectionBody, exchangePolicy, refreshProcessor, ID, SIGNING_KEY, KIT_CLIENT };

if (require.main === module) {
  (async () => {
    const { args } = pf;
    const bad = acmePreflight(args, process.env);
    if (bad) { console.error(`[acme-kit] ${bad}`); process.exit(2); }
    const PORT = args.port || '29999';
    const api = pf.adminApi(pf.setting('ns', null, "the namespace holding Acme's pingfederate-admin secret"), PORT);
    const wrong = await acmeVerify(api, args);
    if (wrong) { console.error(`[acme-kit] ${wrong}`); process.exit(2); }
    console.log('[acme-kit] the admin API is the expected Acme PingFederate.');
    if (args.inventory) { await inventory(api); return; }
    const o = {
      pf: pf.setting('pf', 'PF_URL', 'the local PingFederate issuer (the ID-JAG aud)'),
      resource: pf.setting('pf-resource', 'PF_RESOURCE', 'the resource the local PingFederate redeems for'),
      client: String(args['pf-client'] || process.env.PF_REDEEMER_CLIENT_ID || 'id-jag-redeemer'),
    };
    const dry = Boolean(args['dry-run']);
    await run(api, o, { dry, remove: Boolean(args.remove), acmeIssuer: args['expect-issuer'] });
    pf.done('acme-kit', `[acme-kit] ${dry ? 'dry run only, nothing was changed' : args.remove ? 'removed' : 'done'}.`);
  })().catch((e) => { console.error(`[acme-kit] ${e.message}`); process.exit(1); });
}
