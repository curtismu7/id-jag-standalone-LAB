#!/usr/bin/env node
'use strict';
/**
 * Make the kit's own local PingFederate trust every IdP this app's Config page lists for the PingFederate target: one IdP
 * connection per IdP (entity id = issuer, its JWKS), mapped to the redeemer token manager (idJagKitRedeemerAtm, made by
 * configure-pf-redeemer.js). PingFederate 13.1 then accepts that IdP's ID-JAGs in a JWT bearer grant. LOCAL ONLY: the admin
 * API is PF_ADMIN_URL (pf-admin.js direct mode, a loopback address), never a cluster.
 *
 *   PF_ADMIN_URL=https://127.0.0.1:4731 PF_ADMIN_PASSWORD=… PF_ADMIN_INSECURE_TLS=true ID_JAG_REGISTRY_TOKEN=… \
 *     node pingfederate/sync-id-jag-trusted-idps.js [--dry-run]
 *   --registry=<url>   default <APP_ORIGIN, else http://localhost:4720>/api/id-jag-playground/trusted-idps/pingfederate
 *   --atm=<id>         the token manager the redeemed token comes from (default idJagKitRedeemerAtm)
 *   --token-env=<VAR>  env var holding the app's registry bearer (default ID_JAG_REGISTRY_TOKEN)
 *
 * Only connections whose id starts with "idJagKit-" are created or updated; nothing is deleted. PingFederate caches an
 * issuer's JWKS forever, so restart its container after a connection is created or changed.
 */
const http = require('http');
const https = require('https');
const pf = require('./pf-admin');

const ATM = 'idJagKitRedeemerAtm';
const PREFIX = 'idJagKit-';

const connectionId = (idp) => `${PREFIX}${idp.id}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 32);

/** The IdP connection for one issuer; its OAuth grant mapping fills the token manager's sub, client_id and scope from the ID-JAG. */
function connectionFor(idp, atm = ATM) {
  const assertion = (name) => ({ source: { type: 'ASSERTION' }, value: name });
  const base = idp.issuer.replace(/\/$/, '');
  return {
    type: 'IDP',
    id: connectionId(idp),
    name: `ID-JAG issuer: ${idp.name || idp.issuer}`.slice(0, 64),
    entityId: idp.issuer,
    active: true,
    loggingMode: 'STANDARD',
    // An OIDC IdP connection is how PingFederate learns an issuer's keys; browser SSO is never used.
    oidcClientCredentials: { clientId: 'id-jag-trust-only' },
    idpBrowserSso: {
      protocol: 'OIDC',
      oidcProviderSettings: {
        scopes: 'openid',
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
        jwksURL: idp.jwksUrl,
        loginType: 'CODE',
        authenticationScheme: 'BASIC',
      },
      enabledProfiles: [],
      idpIdentityMapping: 'NONE',
      attributeContract: { coreAttributes: [{ name: 'sub', masked: false }], extendedAttributes: [] },
      adapterMappings: [],
      authenticationPolicyContractMappings: [],
    },
    idpOAuthGrantAttributeMapping: {
      idpOAuthAttributeContract: { coreAttributes: [], extendedAttributes: [{ name: 'sub' }, { name: 'client_id' }, { name: 'scope' }] },
      accessTokenManagerMappings: [{
        accessTokenManagerRef: { id: atm },
        attributeSources: [],
        attributeContractFulfillment: { sub: assertion('sub'), client_id: assertion('client_id'), scope: assertion('scope') },
        issuanceCriteria: { conditionalCriteria: [] },
      }],
    },
  };
}

/** Does the stored connection already trust this issuer's JWKS and map into this token manager? */
function connectionMatches(stored, idp, atm = ATM) {
  const o = stored.idpBrowserSso?.oidcProviderSettings || {};
  return stored.entityId === idp.issuer && o.jwksURL === idp.jwksUrl
    && (stored.idpOAuthGrantAttributeMapping?.accessTokenManagerMappings || []).some((m) => m.accessTokenManagerRef?.id === atm);
}

/** Create or update one connection per IdP. Returns { changed } (true when PingFederate needs a restart to drop its JWKS cache). */
async function sync(api, idps, { atm = ATM, dry = false, log = console.log } = {}) {
  const existing = await api('GET', '/sp/idpConnections');
  if (existing.status !== 200) throw new Error(`PingFederate admin API -> HTTP ${existing.status}`);
  const byEntity = new Map((existing.body.items || []).map((c) => [c.entityId, c]));
  let changed = false;
  for (const idp of idps) {
    const want = connectionFor(idp, atm);
    const have = byEntity.get(idp.issuer);
    if (have && !have.id.startsWith(PREFIX)) { log(`  skip ${idp.issuer}: already trusted by connection ${have.id} (not managed here)`); continue; }
    if (have && connectionMatches(have, idp, atm)) { log(`  keep ${have.id} for ${idp.issuer}`); continue; }
    if (dry) { log(`  would ${have ? 'update' : 'create'} ${want.id} for ${idp.issuer}`); continue; }
    const r = have ? await api('PUT', `/sp/idpConnections/${have.id}`, { ...want, id: have.id }) : await api('POST', '/sp/idpConnections', want);
    const ok = r.status === 200 || r.status === 201;
    log(`  ${ok ? (have ? 'updated' : 'created') : 'FAILED'} ${want.id} for ${idp.issuer}${ok ? '' : `: HTTP ${r.status} ${JSON.stringify(r.body?.validationErrors || r.body?.message || '')}`}`);
    if (ok) changed = true; else process.exitCode = 1;
  }
  return { changed };
}

function getJson(url, token) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    lib.get(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

module.exports = { connectionFor, connectionMatches, connectionId, sync, ATM, PREFIX };

if (require.main === module) {
  (async () => {
    pf.requireLocalAdmin();
    const { args } = pf;
    const tokenEnv = args['token-env'] || 'ID_JAG_REGISTRY_TOKEN';
    const token = process.env[tokenEnv];
    if (!token) throw new Error(`${tokenEnv} is not set; the registry endpoint needs it as a Bearer (it is in the shared settings file after npm run setup)`);
    const app = String(process.env.APP_ORIGIN || 'http://localhost:4720').replace(/\/$/, '');
    const { idps = [] } = await getJson(args.registry || `${app}/api/id-jag-playground/trusted-idps/pingfederate`, token);
    console.log(`[id-jag-sync] ${idps.length} PingFederate-target IdP(s) in the registry; target: the local PingFederate`);
    const { changed } = await sync(pf.adminApi('direct', 0), idps, { atm: args.atm || ATM, dry: Boolean(args['dry-run']) });
    if (changed) console.log('[id-jag-sync] restart the PingFederate container now: it caches an issuer\'s JWKS forever.');
  })().catch((err) => { console.error(`[id-jag-sync] ${err.message}`); process.exit(1); });
}
