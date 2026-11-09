// The origin of THIS request, for CSRF checks and OAuth redirect URIs. Dual-homing (owner rule: the kit is served
// via the family lab-proxy AND directly on loopback). A request through the lab-proxy carries X-Forwarded-Host
// (only the proxy sets it): its browser Origin is proxyOrigin (bare), and its redirect URIs carry proxyBase. The forwarded
// headers are believed only when the request's Host is one of the LAB_ALLOWED_HOSTS names (loopback does not count), so a
// direct caller cannot claim to be the proxy; on any other Host they are ignored.
// Direct requests use APP_ORIGIN (which may itself carry no path; the kit is served at /).
import { config } from './config.js';

/** True when the request came through the lab-proxy: Host is a LAB_ALLOWED_HOSTS name and the forwarded host/proto match PROXY_ORIGIN. */
export function viaProxy(req) {
  const c = config();
  if (!c.proxyOrigin) return false;
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').trim().toLowerCase();
  if (!c.labAllowedHosts.includes(host)) return false;
  const fwd = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim().toLowerCase();
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  try {
    const p = new URL(c.proxyOrigin);
    return !!fwd && fwd === p.host.toLowerCase() && (proto === '' || `${proto}:` === p.protocol);
  } catch { return false; }
}

/** The browser Origin of this request: for CSRF/same-origin checks (never carries a path). */
export function requestOrigin(req) {
  const c = config();
  return viaProxy(req) ? c.proxyOrigin : c.appOrigin;
}

/** The browser URL prefix of this request: for OAuth redirect URIs (carries the proxy's base path when proxied). */
export function requestBase(req) {
  const c = config();
  return viaProxy(req) ? `${c.proxyOrigin}${c.proxyBase}` : c.appOrigin;
}
