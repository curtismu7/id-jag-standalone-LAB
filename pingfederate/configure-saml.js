#!/usr/bin/env node
'use strict';
/**
 * Let the ID-JAG playground's SAML option reach PingFederate: the app signs a SAML 2.0 assertion for the signed-in
 * user and PingFederate trades it for an ID-JAG in one token exchange. Run configure-desktop-clients.js first: it
 * creates the SP connection this adds a mapping to. Idempotent: existing objects are kept. Modelled on, and
 * verified against, tools/saml-spike/spike.mjs.
 *
 *   kubectl -n <ns> port-forward svc/pingfederate-admin 19999:9999 &
 *   node pingfederate/configure-saml.js --ns=<ns> [--port=19999]
 *   node pingfederate/configure-saml.js --ns=<ns> --remove
 *   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.saml.yml up -d
 *
 * At PingFederate this adds, ids prefixed idJagKit:
 *   - the signer's certificate as a trusted CA (trust comes from the CA store; the id must be lower case)
 *   - a SAML 2.0 token processor that requires the assertion's Audience
 *   - a token exchange processor policy for subject_token_type saml2 (subject from the processor)
 *   - the OAuth client id-jag-kit-saml (token exchange only) that runs that policy
 *   - one processor policy mapping on the SP connection idJagKitResourceAsSp (nothing else of it is touched)
 * and under deploy/local/saml/ (gitignored) the signer key pair. The client secret goes to .env only
 * (PF_SAML_CLIENT_SECRET) and is never printed. --remove undoes the PingFederate objects, not the key pair.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const pf = require('./pf-admin');
const { args, setting, report, writeEnv, acceptAll, from } = pf;

const ID = { ca: 'idjagkitsamlca', proc: 'idJagKitSaml', policy: 'idJagKitSamlPolicy', sp: args.sp || 'idJagKitResourceAsSp', client: 'id-jag-kit-saml' };
const AUDIENCE = 'idJagKitSamlAud'; // the default SAML_AUDIENCE of the server
const SAML2 = 'urn:ietf:params:oauth:token-type:saml2';
const DEFAULT_SCOPE = 'read mcp:invoke'; // mcp-sample's scopes; the SP connection's existing mappings win
const RESOURCE_AS_CLIENT = process.env.RESOURCE_AS_CLIENT_ID || 'id-jag-playground'; // draft 4.4.1: client_id names the client at the resource AS
const SAML_DIR = path.join(__dirname, '../deploy/local/saml');
const KEY = path.join(SAML_DIR, 'signer.key.pem');
const CERT = path.join(SAML_DIR, 'signer.cert.pem');

const text = (value) => ({ source: { type: 'TEXT' }, value });
const names = (l) => (l || []).map((x) => (typeof x === 'string' ? x : x.name));

/** The SAML 2.0 token processor descriptor: { desc, fields, contract, subjectAttr }, or { error }. */
function pickDescriptor(items) {
  const all = items || [];
  const desc = all.find((x) => /saml\s*2/i.test(`${x.name} ${x.id}`)) || all.find((x) => /saml/i.test(`${x.name} ${x.id}`));
  if (!desc) return { error: `no SAML token processor descriptor on this PingFederate. Available: ${all.map((x) => x.id).join(', ')}` };
  const fields = names(desc.configDescriptor?.fields);
  if (!fields.includes('Audience')) return { error: `descriptor ${desc.id} has no "Audience" field; its fields: ${fields.join(', ')}` };
  const contract = names(desc.attributeContract);
  if (!contract.length) return { error: `descriptor ${desc.id} declares no attribute contract; cannot map the subject` };
  return { desc, fields, contract, subjectAttr: contract.find((n) => /subject/i.test(n)) || contract[0] };
}

/** The scope the SP connection's existing mappings grant, so the SAML mapping grants the same. */
const scopeOf = (sp) => sp?.oauthTokenExchangeSettings?.processorPolicyMappings?.map((m) => m.attributeContractFulfillment?.scope?.value).find(Boolean) || DEFAULT_SCOPE;

/** A processor policy mapping: subject from the policy, client_id pinned to the resource AS's client (not the PF client), a fixed scope. */
const policyMapping = (policyId, scope) => acceptAll({
  processorPolicyRef: { id: policyId },
  attributeContractFulfillment: { ...from('TOKEN_EXCHANGE_PROCESSOR_POLICY', [['TOKEN_SUBJECT', 'TOKEN_SUBJECT']]), client_id: text(RESOURCE_AS_CLIENT), scope: text(scope) },
});

/** The SP connection body with the policy mapped once (the same object when it already is, with the right client_id). */
function withMapping(sp, policyId) {
  const s = sp.oauthTokenExchangeSettings;
  const have = s.processorPolicyMappings.find((m) => m.processorPolicyRef.id === policyId);
  if (have) {
    const want = policyMapping(policyId, scopeOf(sp)).attributeContractFulfillment.client_id;
    const got = have.attributeContractFulfillment?.client_id;
    if (got?.source?.type === want.source.type && got?.value === want.value) return sp;
    return { ...sp, oauthTokenExchangeSettings: { ...s, processorPolicyMappings: s.processorPolicyMappings.map((m) => (m === have ? { ...m, attributeContractFulfillment: { ...m.attributeContractFulfillment, client_id: want } } : m)) } };
  }
  return { ...sp, oauthTokenExchangeSettings: { ...s, processorPolicyMappings: [...s.processorPolicyMappings, policyMapping(policyId, scopeOf(sp))] } };
}

/** The SP connection body without the policy's mapping (the same object when it has none). */
function withoutMapping(sp, policyId) {
  const s = sp.oauthTokenExchangeSettings;
  const kept = (s?.processorPolicyMappings || []).filter((m) => m.processorPolicyRef.id !== policyId);
  return kept.length === (s?.processorPolicyMappings || []).length ? sp : { ...sp, oauthTokenExchangeSettings: { ...s, processorPolicyMappings: kept } };
}

/** The signer key pair under deploy/local/saml, made once. The key is never printed. */
function ensureKeyPair() {
  if (fs.existsSync(KEY) && fs.existsSync(CERT)) { console.log('  keep signer key pair deploy/local/saml/'); return; }
  fs.mkdirSync(SAML_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(SAML_DIR, 0o700);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365',
    '-subj', '/CN=id-jag-kit-saml-idp', '-keyout', KEY, '-out', CERT], { stdio: 'ignore' });
  fs.chmodSync(KEY, 0o600);
  console.log('  ok   create signer key pair deploy/local/saml/ (valid 365 days)');
}

async function setup(api) {
  const ensure = (...a) => pf.ensure(api, ...a);
  const clientId = process.env.PF_EXCHANGE_CLIENT_ID || 'id-jag-kit'; // the client the resource AS already binds to ours
  ensureKeyPair();

  // Discover the SAML token processor descriptor before creating anything.
  const d = await api('GET', '/idp/tokenProcessors/descriptors');
  if (d.status !== 200) { console.error(`  FAIL GET /idp/tokenProcessors/descriptors: HTTP ${d.status}`); process.exit(1); }
  const picked = pickDescriptor(d.body?.items);
  if (picked.error) { console.error(`  FAIL ${picked.error}`); process.exit(1); }
  const { desc, contract, subjectAttr } = picked;
  console.log(`  ok   descriptor ${desc.id} (${desc.name}); subject attribute: ${subjectAttr}`);

  // The SP connection must exist before anything is created for it.
  const sp = await api('GET', `/idp/spConnections/${ID.sp}`);
  if (sp.status !== 200) { console.error(`  FAIL SP connection ${ID.sp} not found: run configure-desktop-clients.js first`); process.exit(1); }
  if (!sp.body?.oauthTokenExchangeSettings?.processorPolicyMappings) { console.error(`  FAIL SP connection ${ID.sp} has no token exchange policy mappings`); process.exit(1); }

  // Trusted CA for the assertion signature.
  const ca = await api('GET', '/certificates/ca');
  if (ca.status !== 200) { console.error(`  FAIL GET /certificates/ca: HTTP ${ca.status} (CA store endpoint missing?)`); process.exit(1); }
  if ((ca.body?.items || []).some((c) => c.id === ID.ca)) console.log(`  keep trusted CA ${ID.ca}`);
  else report(`create trusted CA ${ID.ca}`, await api('POST', '/certificates/ca/import', { id: ID.ca, fileData: fs.readFileSync(CERT).toString('base64') }));

  await ensure(`SAML processor ${ID.proc}`, `/idp/tokenProcessors/${ID.proc}`, '/idp/tokenProcessors', {
    id: ID.proc, name: 'ID-JAG Kit: SAML assertions signed by this app', pluginDescriptorRef: { id: desc.id },
    configuration: { fields: [{ name: 'Audience', value: AUDIENCE }] },
    attributeContract: { coreAttributes: contract.map((name) => ({ name })) },
  });

  await ensure(`exchange policy ${ID.policy}`, `/oauth/tokenExchange/processor/policies/${ID.policy}`, '/oauth/tokenExchange/processor/policies', {
    id: ID.policy, name: 'ID-JAG Kit: SAML assertion → ID-JAG', actorTokenRequired: false,
    attributeContract: { coreAttributes: [{ name: 'subject' }], extendedAttributes: [{ name: 'TOKEN_SUBJECT' }, { name: 'client_id' }] },
    processorMappings: [acceptAll({
      subjectTokenType: SAML2, subjectTokenProcessor: { id: ID.proc },
      attributeContractFulfillment: { ...from('SUBJECT_TOKEN', [['subject', subjectAttr], ['TOKEN_SUBJECT', subjectAttr]]), client_id: text(clientId) },
    })],
  });

  if ((await api('GET', `/oauth/clients/${ID.client}`)).status === 200) {
    console.log(`  keep client ${ID.client}`);
    if (!process.env.PF_SAML_CLIENT_SECRET) console.log(`  note: PF_SAML_CLIENT_SECRET is not set; reset ${ID.client}'s secret in PingFederate (or run --remove, then this again) and set it`);
  } else {
    const secret = crypto.randomBytes(32).toString('base64url');
    const atm = (await api('GET', '/oauth/accessTokenManagers/settings')).body?.defaultAccessTokenManagerRef;
    const ok = report(`create client ${ID.client}`, await api('POST', '/oauth/clients', {
      clientId: ID.client, name: 'ID-JAG Kit: SAML exchange client', enabled: true, grantTypes: ['TOKEN_EXCHANGE'], clientAuth: { type: 'SECRET', secret },
      tokenExchangeProcessorPolicyRef: { id: ID.policy }, restrictScopes: false,
      ...(atm ? { defaultAccessTokenManagerRef: { id: atm.id } } : {}),
    }));
    if (ok) {
      if (!fs.existsSync(pf.ENV_FILE)) fs.writeFileSync(pf.ENV_FILE, '', { mode: 0o600 });
      writeEnv({ PF_SAML_CLIENT_SECRET: secret }); // right away: the secret is shown nowhere else
      console.log('  wrote PF_SAML_CLIENT_SECRET to .env');
    }
  }

  const mapped = withMapping(sp.body, ID.policy);
  if (mapped === sp.body) console.log(`  keep ${ID.sp} mapping for ${ID.policy}`);
  else report(`${ID.sp}: map ${ID.policy}`, await api('PUT', `/idp/spConnections/${ID.sp}`, mapped));

  pf.done('saml', '[saml] done. Restart the playground with the SAML overlay:\n'
    + '  docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.saml.yml up -d');
}

async function remove(api) {
  const del = async (what, p) => {
    const r = await api('DELETE', p);
    if (r.status === 404) console.log(`  keep ${what} (already gone)`); else report(`delete ${what}`, r);
  };
  // Reverse dependency order: the SP mapping and the client use the policy, the policy uses the processor, the CA signs for it.
  const sp = await api('GET', `/idp/spConnections/${ID.sp}`);
  if (sp.status !== 200) console.log(`  keep ${ID.sp} (not found)`);
  else if (withoutMapping(sp.body, ID.policy) === sp.body) console.log(`  keep ${ID.sp} (no mapping for ${ID.policy})`);
  else report(`${ID.sp}: unmap ${ID.policy}`, await api('PUT', `/idp/spConnections/${ID.sp}`, withoutMapping(sp.body, ID.policy)));
  await del(`client ${ID.client}`, `/oauth/clients/${ID.client}`);
  await del(`exchange policy ${ID.policy}`, `/oauth/tokenExchange/processor/policies/${ID.policy}`);
  await del(`SAML processor ${ID.proc}`, `/idp/tokenProcessors/${ID.proc}`);
  await del(`trusted CA ${ID.ca}`, `/certificates/ca/${ID.ca}`);
  pf.done('saml', '[saml] remove done. deploy/local/saml/ and PF_SAML_CLIENT_SECRET in .env are left in place.');
}

module.exports = { ID, pickDescriptor, policyMapping, withMapping, withoutMapping, scopeOf };

if (require.main === module) {
  const NS = setting('ns', null, 'the namespace holding the pingfederate-admin secret');
  const PORT = args.port || '19999';
  console.log(`[saml] ${args.remove ? 'remove' : 'set up'} SAML → ID-JAG (admin via localhost:${PORT}, ns ${NS})`);
  (args.remove ? remove : setup)(pf.adminApi(NS, PORT)).catch(pf.fail('saml', PORT));
}
