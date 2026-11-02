// Trust for the local PingFederate's own certificate (PF_CA_FILE), for calls to PF_URL's origin only.
// The family's other TLS settings stay as they are: no NODE_TLS_REJECT_UNAUTHORIZED, no NODE_EXTRA_CA_CERTS, no global
// CA change. A call to any other host goes through the global fetch, which trusts the system roots as before.
// `npm run setup -- --mode=pf-local` writes PF_CA_FILE (the PEM of the certificate it installed in PingFederate).
import fs from 'node:fs';
import https from 'node:https';
import { Readable } from 'node:stream';

/** The CA bytes to use for `url`, or undefined when PF_CA_FILE is unset, unreadable, or `url` is not PF_URL's origin. */
export function caFor(url, env = process.env, read = (f) => fs.readFileSync(f)) {
  const file = String(env.PF_CA_FILE ?? '').trim();
  const pf = String(env.PF_URL ?? '').trim();
  if (!file || !pf) return undefined;
  try {
    const target = new URL(typeof url === 'object' && url !== null && 'url' in url ? url.url : String(url));
    if (target.protocol !== 'https:' || target.origin !== new URL(pf).origin) return undefined;
    return read(file);
  } catch { return undefined; }
}

/** fetch() over node:https with `ca`: the response is a real Response. Redirects are not followed (as redirect:'manual'). */
export function fetchWithCa(url, init = {}, ca, request = https.request) {
  const target = new URL(typeof url === 'object' && url !== null && 'url' in url ? url.url : String(url));
  const body = init.body === undefined || init.body === null ? undefined : String(init.body);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  return new Promise((resolve, reject) => {
    const req = request(target, { method: init.method || 'GET', headers, ca, signal: init.signal }, (res) => {
      const out = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      const empty = [101, 204, 205, 304].includes(res.statusCode);
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage, headers: out }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The fetch the netguard uses for real calls: PF_URL's origin is verified against PF_CA_FILE, everything else is global fetch. */
export function trustedFetch(url, init) {
  const ca = caFor(url);
  return ca ? fetchWithCa(url, init, ca) : globalThis.fetch(url, init);
}
