#!/usr/bin/env node
// Spike: does PingFederate accept a SAML 2.0 assertion as subject_token (…token-type:saml2) for an ID-JAG exchange?
//   kubectl -n <ns> port-forward svc/pingfederate-admin 19999:9999 &
//   node spike.mjs setup    --ns=<ns> [--port=19999] [--signing-key=<id>]
//   node spike.mjs exchange --pf=https://<pf-host>  (or PF_URL)  [--b64] [--insecure]
//   node spike.mjs remove   --ns=<ns> [--port=19999]
// Everything created is prefixed idJagSpike; no existing kit object is modified. Secrets stay in work/ (0600), never printed.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pf = require('../../pingfederate/pf-admin.js'); // the kit's admin helpers (admin password from kubectl)
const { args, report, acceptAll, from, done, fail } = pf;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, 'work');
const CERT = path.join(WORK, 'cert.pem'), CLIENT_FILE = path.join(WORK, 'client.json');
const MODE = process.argv.slice(2).find((a) => !a.startsWith('--'));
const PORT = args.port || '19999';
const ID = { ca: 'idjagspikeca', proc: 'idJagSpikeSaml', policy: 'idJagSpikePolicy', sp: 'idJagSpikeSp', client: 'idJagSpikeClient' };
const AUD = 'idJagSpikeAud', ENTITY = 'https://spike-rs.example.com/', RESOURCE = 'https://spike-rs.example.com/mcp', SCOPE = 'read mcp:invoke';
const SAML2 = 'urn:ietf:params:oauth:token-type:saml2', IDJAG = 'urn:ietf:params:oauth:token-type:id-jag';
const text = (value) => ({ source: { type: 'TEXT' }, value });
const die = (msg) => { console.error(`  FAIL ${msg}`); process.exit(1); };
const names = (l) => (l || []).map((x) => (typeof x === 'string' ? x : x.name));
const admin = () => {
  if (!args.ns) { console.error('the namespace holding the pingfederate-admin secret: pass --ns=…'); process.exit(2); }
  return pf.adminApi(args.ns, PORT);
};

async function setup() {
  const api = admin();
  // Resolve the signing key BEFORE creating anything, so a missing static JWKS leaves nothing behind.
  const keys = (await api('GET', '/keyPairs/oauthOpenIdConnect')).body || {};
  const signingKey = args['signing-key'] || (keys.staticJwksEnabled && keys.rsaActiveCertRef?.id);
  if (!signingKey) die('PingFederate has no static JWKS: pass --signing-key=<signing key pair id>');
  if (!existsSync(CERT)) execFileSync('node', [path.join(HERE, 'mk-saml.mjs'), '--audience', AUD], { stdio: 'ignore' }); // creates work/cert.pem
  // Discover the SAML token processor descriptor.
  const d = await api('GET', '/idp/tokenProcessors/descriptors');
  if (d.status !== 200) die(`GET /idp/tokenProcessors/descriptors: HTTP ${d.status}`);
  const all = d.body?.items || [];
  const desc = all.find((x) => /saml\s*2/i.test(`${x.name} ${x.id}`)) || all.find((x) => /saml/i.test(`${x.name} ${x.id}`));
  if (!desc) die(`no SAML token processor descriptor on this PingFederate. Available: ${all.map((x) => x.id).join(', ')}`);
  const fields = names(desc.configDescriptor?.fields);
  if (!fields.includes('Audience')) die(`descriptor ${desc.id} has no "Audience" field; its fields: ${fields.join(', ')}`);
  const contract = names(desc.attributeContract);
  if (!contract.length) die(`descriptor ${desc.id} declares no attribute contract; cannot map the subject`);
  const subjectAttr = contract.find((n) => /subject/i.test(n)) || contract[0];
  console.log(`  ok   descriptor ${desc.id} (${desc.name}); fields: ${fields.join(' | ')}; subject attribute: ${subjectAttr}`);

  // Trusted CA for the assertion signature.
  const ca = await api('GET', '/certificates/ca');
  if (ca.status !== 200) die(`GET /certificates/ca: HTTP ${ca.status} (CA store endpoint missing?)`);
  if ((ca.body?.items || []).some((c) => c.id === ID.ca)) console.log(`  keep trusted CA ${ID.ca}`);
  else report(`create trusted CA ${ID.ca}`, await api('POST', '/certificates/ca/import', { id: ID.ca, fileData: readFileSync(CERT).toString('base64') }));

  await pf.ensure(api, `SAML processor ${ID.proc}`, `/idp/tokenProcessors/${ID.proc}`, '/idp/tokenProcessors', {
    id: ID.proc, name: 'idJagSpike SAML', pluginDescriptorRef: { id: desc.id },
    configuration: { fields: [{ name: 'Audience', value: AUD }] },
    attributeContract: { coreAttributes: contract.map((name) => ({ name })) },
  });

  await pf.ensure(api, `exchange policy ${ID.policy}`, `/oauth/tokenExchange/processor/policies/${ID.policy}`, '/oauth/tokenExchange/processor/policies', {
    id: ID.policy, name: 'idJagSpike SAML to ID-JAG', actorTokenRequired: false,
    attributeContract: { coreAttributes: [{ name: 'subject' }], extendedAttributes: [{ name: 'TOKEN_SUBJECT' }, { name: 'client_id' }] },
    processorMappings: [acceptAll({
      subjectTokenType: SAML2, subjectTokenProcessor: { id: ID.proc },
      attributeContractFulfillment: { ...from('SUBJECT_TOKEN', [['subject', subjectAttr], ['TOKEN_SUBJECT', subjectAttr]]), client_id: text(ID.client) },
    })],
  });

  await pf.ensure(api, `SP connection ${ID.sp}`, `/idp/spConnections/${ID.sp}`, '/idp/spConnections', {
    type: 'SP', id: ID.sp, name: 'idJagSpike resource', entityId: ENTITY, active: true, loggingMode: 'STANDARD', connectionTargetType: 'STANDARD',
    credentials: { certs: [], signingSettings: { signingKeyPairRef: { id: signingKey }, algorithm: 'SHA256withRSA', includeCertInSignature: false, includeRawKeyInSignature: false } },
    oauthTokenExchangeSettings: {
      resourceUris: [RESOURCE], minutesBefore: 1, minutesAfter: 5, idJagEnabled: true,
      attributeContract: { coreAttributes: [{ name: 'TOKEN_SUBJECT' }], extendedAttributes: [{ name: 'client_id' }, { name: 'scope' }] },
      processorPolicyMappings: [acceptAll({
        processorPolicyRef: { id: ID.policy },
        attributeContractFulfillment: { ...from('TOKEN_EXCHANGE_PROCESSOR_POLICY', [['TOKEN_SUBJECT', 'TOKEN_SUBJECT'], ['client_id', 'client_id']]), scope: text(SCOPE) },
      })],
    },
  });

  if ((await api('GET', `/oauth/clients/${ID.client}`)).status === 200) {
    console.log(`  keep client ${ID.client}${existsSync(CLIENT_FILE) ? '' : ' (work/client.json missing: delete with remove and re-run setup)'}`);
  } else {
    const secret = randomBytes(32).toString('base64url');
    const atm = (await api('GET', '/oauth/accessTokenManagers/settings')).body?.defaultAccessTokenManagerRef;
    const ok = report(`create client ${ID.client}`, await api('POST', '/oauth/clients', {
      clientId: ID.client, name: 'idJagSpike client', enabled: true, grantTypes: ['TOKEN_EXCHANGE'], clientAuth: { type: 'SECRET', secret },
      tokenExchangeProcessorPolicyRef: { id: ID.policy }, restrictScopes: false,
      ...(atm ? { defaultAccessTokenManagerRef: { id: atm.id } } : {}),
    }));
    if (ok) writeFileSync(CLIENT_FILE, JSON.stringify({ clientId: ID.client, clientSecret: secret }), { mode: 0o600 });
  }
  done('spike', `[spike] setup done. Next: node spike.mjs exchange --pf=<PingFederate base URL>`);
}

async function remove() {
  const api = admin();
  const del = async (what, p) => {
    const r = await api('DELETE', p);
    if (r.status === 404) console.log(`  keep ${what} (already gone)`); else report(`delete ${what}`, r);
  };
  await del(`client ${ID.client}`, `/oauth/clients/${ID.client}`);
  await del(`SP connection ${ID.sp}`, `/idp/spConnections/${ID.sp}`);
  await del(`exchange policy ${ID.policy}`, `/oauth/tokenExchange/processor/policies/${ID.policy}`);
  await del(`SAML processor ${ID.proc}`, `/idp/tokenProcessors/${ID.proc}`);
  await del(`trusted CA ${ID.ca}`, `/certificates/ca/${ID.ca}`);
  rmSync(CLIENT_FILE, { force: true });
  done('spike', '[spike] remove done.');
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());

async function exchange() {
  const pfUrl = String(args.pf || process.env.PF_URL || '').replace(/\/$/, '');
  if (!pfUrl) { console.error('PingFederate base URL: pass --pf=https://… or set PF_URL'); process.exit(2); }
  if (!existsSync(CLIENT_FILE)) die('work/client.json missing: run setup first');
  const { clientId, clientSecret } = JSON.parse(readFileSync(CLIENT_FILE, 'utf8'));
  const a = JSON.parse(execFileSync('node', [path.join(HERE, 'mk-saml.mjs'), '--audience', AUD]).toString());
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: args.b64 ? a.assertionB64 : a.assertionB64url, subject_token_type: SAML2,
    requested_token_type: IDJAG, audience: ENTITY, resource: RESOURCE, scope: SCOPE,
  }).toString();
  const res = await new Promise((resolve, reject) => {
    const req = https.request(`${pfUrl}/as/token.oauth2`, {
      method: 'POST', agent: args.insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined,
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (r) => { let o = ''; r.on('data', (c) => { o += c; }); r.on('end', () => resolve({ status: r.statusCode, body: o })); });
    req.on('error', reject); req.end(form);
  });
  let j = {}; try { j = JSON.parse(res.body); } catch { /* non-JSON */ }
  console.log(`HTTP ${res.status}`);
  if (j.error) console.log(`error: ${j.error}\nerror_description: ${j.error_description || ''}`);
  if (j.access_token) {
    const [h, p] = j.access_token.split('.');
    const hd = b64json(h), cl = b64json(p);
    console.log(`issued_token_type: ${j.issued_token_type}\nheader: typ=${hd.typ} alg=${hd.alg} kid=${hd.kid} x5t=${hd.x5t}`);
    console.log(`claim names: ${Object.keys(cl).join(', ')}`);
    for (const k of ['iss', 'aud', 'sub', 'client_id', 'scope']) console.log(`${k}: ${JSON.stringify(cl[k])}`);
  }
  process.exit(res.status === 200 && j.access_token ? 0 : 1);
}

mkdirSync(WORK, { recursive: true, mode: 0o700 });
const run = { setup, exchange, remove }[MODE];
if (!run) { console.error('usage: node spike.mjs setup|exchange|remove [--ns=… --port=19999 --pf=… --b64 --insecure]'); process.exit(2); }
run().catch(fail('spike', PORT));
