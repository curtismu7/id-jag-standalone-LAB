#!/usr/bin/env node
'use strict';
/**
 * Make the kit's own local PingFederate the REDEEMER for pf-pf mode: the outside Acme PingFederate issues the ID-JAG, this
 * PingFederate trusts Acme's keys and exchanges the ID-JAG for an access token (an IdP must not redeem its own ID-JAG,
 * draft section 9.3). LOCAL ONLY (PF_ADMIN_URL must be a loopback address); it never contacts Acme. Idempotent.
 *
 *   PF_ADMIN_URL=https://127.0.0.1:4731 PF_ADMIN_PASSWORD=… PF_ADMIN_INSECURE_TLS=true node pingfederate/configure-pf-redeemer.js
 *     [--acme=…  else ACME_PF_URL] [--pf=…  else PF_URL] [--resource=…  else PF_RESOURCE, else ID_JAG_RESOURCE, else http://localhost:9090/mcp]
 *     [--client=…  else PF_REDEEMER_CLIENT_ID, else id-jag-redeemer] [--backup-dir=…] [--no-restart] [--remove]
 *   Needs the kit's issuer setup first (npm run setup -- --mode=pf-local): the signing key idjagkit-signing.
 *
 * Creates (ids prefixed idJagKit, except the client):
 *   - the JWT access token manager idJagKitRedeemerAtm, selected by the resource URI (selectionSettings.resourceUris =
 *     PF_RESOURCE, else the redeem fails with invalid_target)
 *   - the IdP connection idJagKit-acme: entity id = the Acme issuer, JWKS URL = <ACME_PF_URL>/pf/JWKS, and an OAuth grant
 *     attribute mapping (sub, client_id, scope from the ID-JAG) into that token manager
 *   - the JWT bearer client PF_REDEEMER_CLIENT_ID (EXTENSION grant, client secret authentication); its generated secret is
 *     written to the settings file as PF_REDEEMER_CLIENT_SECRET (never printed), with PF_REDEEMER_CLIENT_ID and PF_RESOURCE.
 *     An existing client keeps its secret while the settings file still has it; if the file lost it, a new one is set.
 * Before the first write it saves a configuration backup (admin API bulk export, mode 600) and stops if it cannot. PingFederate
 * caches an issuer's JWKS forever, so after an IdP connection is created or changed it restarts the container.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pf = require('./pf-admin');
const { args } = pf;
const { connectionFor, connectionMatches } = require('./sync-id-jag-trusted-idps');

const ID = { atm: args.atm || 'idJagKitRedeemerAtm', idp: args.idp || 'acme', key: args.key || 'idjagkit-signing' };
const IDP_CONNECTION = `idJagKit-${ID.idp}`;
const JWT_ATM = 'com.pingidentity.pf.access.token.management.plugins.JwtBearerAccessTokenManagementPlugin';
const DEFAULT_RESOURCE = 'http://localhost:9090/mcp';
const DEFAULT_CLIENT = 'id-jag-redeemer';

/** The api with a backup before its first write (deps.backup throws: nothing is written without it); a run that writes nothing takes none. */
const withBackup = (api, deps) => {
  let saved = false;
  return async (method, p, body) => {
    if (method !== 'GET' && !saved) { await deps.backup(); saved = true; }
    return api(method, p, body);
  };
};

const atmBody = (descriptor, { pfUrl, resource }) => {
  const fields = (descriptor?.configDescriptor?.fields || []).filter((x) => x.defaultValue !== undefined && x.defaultValue !== null)
    .map((x) => ({ name: x.name, value: String(x.defaultValue) }));
  const setField = (name, value) => { const x = fields.find((y) => y.name === name); if (x) x.value = value; else fields.push({ name, value }); };
  setField('Use Centralized Signing Key', 'false');
  setField('JWS Algorithm', 'RS256');
  setField('Active Signing Certificate Key ID', ID.key);
  setField('Publish Keys to the PingFederate JWKS Endpoint', 'false'); // the ID-JAG key is already published by idJagKitKeyPublisher; twice fails the kid uniqueness check
  setField('Issuer Claim Value', pfUrl);
  return {
    id: ID.atm, name: 'ID-JAG Kit redeemer access tokens', pluginDescriptorRef: { id: JWT_ATM },
    configuration: { fields, tables: [
      { name: 'Certificates', rows: [{ defaultRow: false, fields: [{ name: 'Key ID', value: ID.key }, { name: 'Certificate', value: ID.key }] }] },
      { name: 'Symmetric Keys', rows: [] }] },
    attributeContract: { extendedAttributes: ['sub', 'client_id', 'scope'].map((name) => ({ name })) },
    selectionSettings: { resourceUris: [resource] },
  };
};

const clientBody = (o, secret) => ({
  clientId: o.client, name: 'ID-JAG Kit: redeemer (JWT bearer)', enabled: true,
  grantTypes: ['EXTENSION'], ...(secret && { clientAuth: { type: 'SECRET', secret } }),
  defaultAccessTokenManagerRef: { id: ID.atm }, restrictToDefaultAccessTokenManager: false,
  restrictScopes: false, bypassApprovalPage: true,
});

/**
 * @param o { pfUrl, acmeUrl, resource, client, existingSecret }
 * @param deps { backup(), restart(), writeSettings(pairs), rand() }
 * @returns { changed } (an IdP connection was created or changed, so the container was restarted)
 */
async function run(api, o, deps) {
  const { report } = pf;
  const ensure = (...a) => pf.ensure(api, ...a);
  const acme = o.acmeUrl.replace(/\/$/, '');
  if (acme === o.pfUrl.replace(/\/$/, '')) throw new Error('ACME_PF_URL is this PingFederate: an IdP must not redeem its own ID-JAG (draft section 9.3)');

  api = withBackup(api, deps);

  const keys = await api('GET', '/keyPairs/signing');
  if (!(keys.body?.items || []).some((k) => k.id === ID.key)) throw new Error(`the signing key ${ID.key} is missing: run npm run setup -- --mode=pf-local first`);

  const as = (await api('GET', '/oauth/authServerSettings')).body || {};
  const haveScope = new Set([...(as.scopes || []), ...(as.exclusiveScopes || [])].map((x) => x.name));
  for (const name of ['read', 'mcp:invoke']) {
    if (haveScope.has(name)) console.log(`  keep scope ${name}`);
    else report(`create scope ${name}`, await api('POST', '/oauth/authServerSettings/scopes/commonScopes', { name, description: `${name} (ID-JAG Kit)` }));
  }

  // The token manager that is selected by the resource URI.
  const atm = await api('GET', `/oauth/accessTokenManagers/${ID.atm}`);
  if (atm.status !== 200) {
    const desc = await api('GET', `/oauth/accessTokenManagers/descriptors/${JWT_ATM}`);
    report(`token manager ${ID.atm} (resource ${o.resource})`, await api('POST', '/oauth/accessTokenManagers', atmBody(desc.body, o)));
  } else if (!(atm.body.selectionSettings?.resourceUris || []).includes(o.resource)) {
    atm.body.selectionSettings = { ...atm.body.selectionSettings, resourceUris: [...new Set([...(atm.body.selectionSettings?.resourceUris || []), o.resource])] };
    report(`token manager ${ID.atm}: resource ${o.resource} added`, await api('PUT', `/oauth/accessTokenManagers/${ID.atm}`, atm.body));
  } else console.log(`  keep token manager ${ID.atm}`);

  // The IdP connection: how this PingFederate learns Acme's keys.
  const idp = { id: ID.idp, name: 'Acme PingFederate', issuer: acme, jwksUrl: `${acme}/pf/JWKS` };
  const want = connectionFor(idp, ID.atm);
  const list = await api('GET', '/sp/idpConnections');
  const other = (list.body?.items || []).find((c) => c.entityId === acme && c.id !== IDP_CONNECTION);
  if (other) throw new Error(`the Acme issuer is already the entity id of connection ${other.id}, which is not the kit's: refusing to add a second one`);
  const have = (list.body?.items || []).find((c) => c.id === IDP_CONNECTION);
  let changed = false;
  if (!have) changed = report(`IdP connection ${IDP_CONNECTION} (Acme issuer and JWKS from ACME_PF_URL)`, await api('POST', '/sp/idpConnections', want));
  else if (connectionMatches(have, idp, ID.atm)) console.log(`  keep IdP connection ${IDP_CONNECTION}`);
  else changed = report(`update IdP connection ${IDP_CONNECTION}`, await api('PUT', `/sp/idpConnections/${IDP_CONNECTION}`, { ...want, id: IDP_CONNECTION }));

  // The redeeming client. Its secret is only ever written to the settings file.
  const client = await api('GET', `/oauth/clients/${encodeURIComponent(o.client)}`);
  let secret = null;
  if (client.status !== 200) {
    secret = deps.rand();
    if (!report(`create client ${o.client} (JWT bearer)`, await api('POST', '/oauth/clients', clientBody(o, secret)))) secret = null;
  } else {
    const c = client.body;
    const fine = (c.grantTypes || []).includes('EXTENSION') && c.defaultAccessTokenManagerRef?.id === ID.atm && c.enabled !== false;
    if (!o.existingSecret) {
      secret = deps.rand();
      if (!report(`client ${o.client}: new secret (the settings file had none)`, await api('PUT', `/oauth/clients/${encodeURIComponent(o.client)}`, { ...c, ...clientBody(o, secret) }))) secret = null;
    } else if (!fine) {
      report(`update client ${o.client}`, await api('PUT', `/oauth/clients/${encodeURIComponent(o.client)}`, { ...c, ...clientBody(o, null), clientAuth: c.clientAuth }));
    } else console.log(`  keep client ${o.client} (its secret is not changed)`);
  }
  if (!pf.hasFailed()) {
    deps.writeSettings({ PF_REDEEMER_CLIENT_ID: o.client, PF_RESOURCE: o.resource, ...(secret ? { PF_REDEEMER_CLIENT_SECRET: secret } : {}) });
    console.log(`  settings written: PF_REDEEMER_CLIENT_ID, PF_RESOURCE${secret ? ', PF_REDEEMER_CLIENT_SECRET (not shown)' : ''}`);
    if (changed) await deps.restart();
  }
  return { changed };
}

/** Remove what run() made (the client, the IdP connection, the token manager). The settings file is not edited. */
async function remove(api, o, deps) {
  api = withBackup(api, deps);
  for (const [what, p] of [['client', `/oauth/clients/${encodeURIComponent(o.client)}`], ['IdP connection', `/sp/idpConnections/${IDP_CONNECTION}`], ['token manager', `/oauth/accessTokenManagers/${ID.atm}`]]) {
    if ((await api('GET', p)).status === 200) pf.report(`delete ${what}`, await api('DELETE', p));
    else console.log(`  keep (absent) ${what}`);
  }
}

/** The container this kit's PingFederate runs in: PF_CONTAINER, else an existing pingfederate-lab (an earlier install), else id-jag-kit-pf. */
function containerName(env = process.env, exec = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8' })) {
  if (env.PF_CONTAINER) return env.PF_CONTAINER;
  let names = '';
  try { names = exec('docker', ['ps', '-a', '--format', '{{.Names}}']); } catch { /* docker not answering: the default */ }
  return names.split('\n').includes('pingfederate-lab') ? 'pingfederate-lab' : 'id-jag-kit-pf';
}

/** A configuration backup through the admin API, saved mode 600. Returns the file path. */
async function saveBackup(api, dir, now = new Date()) {
  const r = await api('GET', '/bulk/export');
  if (r.status !== 200 || !r.body || typeof r.body !== 'object') throw new Error(`the configuration backup failed (HTTP ${r.status}): nothing was changed`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `pf-redeemer-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(r.body), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** docker restart, then wait until the admin API answers again. */
async function restartContainer(api, name, { adminPort = process.env.PF_ADMIN_PORT || '4731', exec = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8' }), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 90 } = {}) {
  if (exec('docker', ['context', 'show']).trim() !== 'orbstack') throw new Error('the docker context is not orbstack: run docker context use orbstack, then restart the container by hand');
  if (!new RegExp(`:${adminPort}$`, 'm').test(exec('docker', ['port', name]))) throw new Error(`container ${name} does not publish the admin port ${adminPort}, so it is not the kit's PingFederate: restart the right container by hand`);
  console.log(`  restarting ${name} (PingFederate caches an issuer's JWKS forever); this takes a minute or two`);
  exec('docker', ['restart', name]);
  for (let i = 0; i < tries; i++) {
    await sleep(3000);
    try { if ((await api('GET', '/version')).status === 200) { console.log('  PingFederate is back'); return; } } catch { /* still starting */ }
  }
  throw new Error(`${name} did not come back within ${tries * 3} seconds: check docker logs ${name}`);
}

module.exports = { run, remove, atmBody, clientBody, containerName, saveBackup, restartContainer, ID, IDP_CONNECTION, DEFAULT_RESOURCE, DEFAULT_CLIENT };

if (require.main === module) {
  pf.requireLocalAdmin();
  (async () => {
    const { args } = pf;
    const flag = (k) => (args[k] && args[k] !== true ? String(args[k]) : '');
    const api = pf.adminApi('direct', 0);
    const o = {
      pfUrl: flag('pf') || process.env.PF_URL || '',
      acmeUrl: flag('acme') || process.env.ACME_PF_URL || '',
      resource: flag('resource') || process.env.PF_RESOURCE || process.env.ID_JAG_RESOURCE || DEFAULT_RESOURCE,
      client: flag('client') || process.env.PF_REDEEMER_CLIENT_ID || DEFAULT_CLIENT,
      existingSecret: process.env.PF_REDEEMER_CLIENT_SECRET || '', // pf-admin.js has loaded the settings file into the environment
    };
    if (!args['allow-remote'] && !/^https:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o.pfUrl)) { console.error('PF_URL (or --pf) must be this machine\'s PingFederate, like https://127.0.0.1:4732: run npm run setup -- --mode=pf-local first (or pass --allow-remote for a PingFederate you administer remotely)'); process.exit(2); }
    if (!args.remove && !/^https:\/\/[^/\s]+$/.test(o.acmeUrl.replace(/\/$/, ''))) {
      console.error('ACME_PF_URL is not set: it comes from the Acme owner\'s three-key settings block. Run npm run setup -- --mode=pf-pf --acme-settings=<file>'); process.exit(2);
    }
    await pf.requireIssuer(api, o.pfUrl);
    const dir = flag('backup-dir') || path.join(os.homedir(), '.config', 'demo-kit', 'id-jag-kit', 'backups');
    const deps = {
      backup: async () => { try { console.log(`  backup saved: ${await saveBackup(api, dir)} (mode 600)`); } catch (e) { console.log(`  backup skipped (${e.message.split('(')[0].trim()})`); } },
      restart: async () => (args['no-restart'] ? console.log('  --no-restart: restart the PingFederate container yourself before the first redeem') : restartContainer(api, containerName())),
      writeSettings: pf.writeEnv,
      rand: () => crypto.randomBytes(24).toString('base64url'),
    };
    console.log(`[pf-redeemer] local PingFederate ${o.pfUrl}; redeem resource ${o.resource}`);
    if (args.remove) await remove(api, o, deps); else await run(api, o, deps);
    pf.done('pf-redeemer', '[pf-redeemer] done.');
  })().catch((e) => { console.error(`[pf-redeemer] ${e.message}`); process.exit(1); });
}
