// The last step of `npm run setup -- --mode=pf-local`: prove the local PingFederate is a working ID-JAG issuer for the app, by
// asking it the way the app will. Three things must hold, and each failure names its fix:
//   tls     the TLS certificate verifies against PF_CA_FILE (system roots when none), including the 127.0.0.1 address
//   issuer  discovery's issuer equals PF_URL, byte for byte
//   jwks    /pf/JWKS has exactly one distinct RSA key, and it carries x5t (ID-JAGs are signed with x5t and no kid)
// The fetch is injected (tests), and the CA applies to this one origin only.
import https from 'node:https';
import { issuerKeyCheck } from '../server/src/jwksCheck.js';

/** GET a JSON document over node:https, verifying the certificate against `ca` (or the system roots). Rejects with the TLS error code. */
export function httpsGetJson(url, { ca, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca, timeout: timeoutMs }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let body = null; try { body = JSON.parse(out); } catch { /* not JSON */ } resolve({ status: res.statusCode, body }); });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

export async function selfCheck({ pfUrl, caFile, readFile, get = httpsGetJson }) {
  const checks = [];
  const add = (id, ok, message, fix = '') => checks.push({ id, ok, message, fix });
  let ca;
  if (caFile) {
    try { ca = await readFile(caFile); } catch (e) {
      add('tls', false, `PF_CA_FILE ${caFile} cannot be read (${e.code || e.message})`, 'Rerun npm run setup -- --mode=pf-local: it exports the certificate again.');
    }
  }
  if (checks.length) return { ok: false, checks };

  const where = `${pfUrl}/.well-known/openid-configuration`;
  let disco;
  try {
    disco = await get(where, { ca });
    add('tls', true, `${pfUrl} certificate verifies${caFile ? ' against PF_CA_FILE' : ' against the system roots'}`);
  } catch (e) {
    add('tls', false, `${pfUrl} did not verify (${e.code || e.message})`, caFile
      ? 'PingFederate is not serving the certificate in PF_CA_FILE. Rerun npm run setup -- --mode=pf-local; if it still fails, restart PingFederate (docker restart <its container>) and rerun.'
      : 'Rerun npm run setup -- --mode=pf-local so PingFederate gets a certificate for 127.0.0.1 and PF_CA_FILE is written.');
    return { ok: false, checks };
  }
  const issuer = disco.status === 200 ? disco.body?.issuer : undefined;
  add('issuer', issuer === pfUrl, issuer === pfUrl ? `discovery issuer is ${pfUrl}`
    : disco.status !== 200 ? `${where} answered HTTP ${disco.status}` : `discovery says the issuer is ${issuer ?? '(missing)'}, not ${pfUrl}`,
  `Rerun npm run setup -- --mode=pf-local: it sets this PingFederate's base URL to ${pfUrl}. Do not change PF_URL to match a different PingFederate.`);

  try {
    const r = await get(`${pfUrl}/pf/JWKS`, { ca });
    const v = issuerKeyCheck(r.body?.keys);
    const ok = r.status === 200 && v.rsa === 1 && v.withX5t === 1;
    add('jwks', ok, ok ? `${pfUrl}/pf/JWKS has one RSA key, with x5t`
      : r.status !== 200 ? `${pfUrl}/pf/JWKS answered HTTP ${r.status}` : `${pfUrl}/pf/JWKS has ${v.rsa} distinct RSA key(s), ${v.withX5t} with x5t (need exactly 1, with x5t)`,
    'Rerun npm run setup -- --mode=pf-local (pingfederate/configure-idjag-issuer.js publishes the one ID-JAG signing key and a static JWKS that holds only it).');
  } catch (e) {
    add('jwks', false, `${pfUrl}/pf/JWKS could not be read (${e.code || e.message})`, 'Check that PingFederate is up.');
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export const formatSelfCheck = ({ ok, checks }) => [
  ...checks.flatMap((c) => [`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(7)} ${c.message}`, ...(c.ok || !c.fix ? [] : [`      fix: ${c.fix}`])]),
  ok ? 'The local PingFederate is a working ID-JAG issuer for pf-as.' : 'SELF-CHECK FAILED: the local PingFederate is not ready to issue ID-JAGs to the app.',
];
