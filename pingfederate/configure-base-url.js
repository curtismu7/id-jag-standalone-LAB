#!/usr/bin/env node
'use strict';
/**
 * Give the kit's own local PingFederate the base URL the app expects as its issuer (PF_URL, https://127.0.0.1:4732).
 * A new PingFederate publishes the image default, https://localhost:9031, which is also the address of any other
 * PingFederate on this machine; until the base URL is set, discovery names that issuer and the kit's preflight fails.
 * Idempotent. Local only: it refuses to run unless PF_ADMIN_URL is a loopback address (see pf-admin.js).
 *
 *   PF_ADMIN_URL=https://127.0.0.1:4731 PF_ADMIN_PASSWORD=… PF_ADMIN_INSECURE_TLS=true node pingfederate/configure-base-url.js [--pf=https://127.0.0.1:4732]
 *
 * Exit 0 either way; the line "restart: base URL" is printed when PingFederate changed it (the caller decides whether to restart).
 */
const pf = require('./pf-admin');

/** Set federationInfo.baseUrl. Returns true when it changed it. */
async function run(api, { url }) {
  const ss = await api('GET', '/serverSettings');
  if (ss.status !== 200 || !ss.body?.federationInfo) { pf.report('read server settings', ss); return false; }
  if (ss.body.federationInfo.baseUrl === url) { console.log('  keep base URL'); return false; }
  ss.body.federationInfo.baseUrl = url;
  ss.body.federationInfo.saml2EntityId = ss.body.federationInfo.saml2EntityId || 'idjag-kit-pf';
  return pf.report(`base URL (issuer) = ${url}`, await api('PUT', '/serverSettings', ss.body));
}

module.exports = { run };

if (require.main === module) {
  pf.requireLocalAdmin();
  const url = pf.setting('pf', 'PF_URL', 'the PingFederate base URL');
  run(pf.adminApi('direct', 0), { url }).then((changed) => {
    if (changed) console.log('restart: base URL');
    pf.done('base-url', '[base-url] done.');
  }).catch(pf.fail('base-url', 0));
}
