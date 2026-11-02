'use strict';
/**
 * The guards for the owner-run scripts that talk to the SHARED Acme PingFederate (configure-acme-kit-connection.js,
 * configure-acme-signin.js). Three things must hold before the first request:
 *   1. --acme was passed: nothing reaches a shared PingFederate by accident.
 *   2. PF_ADMIN_URL is not set: pf-admin.js switches to direct mode when it is, and every write would hit the LOCAL
 *      PingFederate (or whatever that URL names) while the output claimed Acme.
 *   3. After the admin API answers, federationInfo.baseUrl equals --expect-issuer: the port-forward and kubectl context
 *      really point at Acme. The expected issuer is always typed by the owner; it is never in this repo.
 * Messages never contain the issuer or any host.
 */

const trim = (v) => String(v).replace(/\/+$/, '');

/** No network: a problem string, or null. */
function acmePreflight(args, env = process.env) {
  if (args.acme !== true) return 'this script changes a shared PingFederate (Acme): pass --acme to say that is what you mean';
  if (env.PF_ADMIN_URL) return 'PF_ADMIN_URL is set, so the admin API would be that URL, not Acme. Run `unset PF_ADMIN_URL`, check that it is not in the shared settings file, and rerun';
  if (typeof args['expect-issuer'] !== 'string' || !/^https:\/\/[^/\s]+$/.test(trim(args['expect-issuer']))) {
    return 'pass --expect-issuer=https://<acme-host> (the issuer Acme publishes): the script refuses to run against any other PingFederate';
  }
  return null;
}

/** One read: the admin API's base URL must be the expected issuer. A problem string, or null. */
async function acmeVerify(api, args) {
  const r = await api('GET', '/serverSettings');
  if (r.status !== 200) return `the admin API answered HTTP ${r.status} to /serverSettings: is the port-forward up and the kubectl context the right one?`;
  const base = r.body?.federationInfo?.baseUrl;
  if (typeof base !== 'string' || trim(base) !== trim(args['expect-issuer'])) {
    return 'the PingFederate behind this admin API is not the one --expect-issuer names (its base URL differs). Nothing was changed. Check the kubectl context, the namespace and the port-forward';
  }
  return null;
}

module.exports = { acmePreflight, acmeVerify };
