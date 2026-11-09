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

// Family same-origin write rule (reference: token-workbench-LAB server/src/safety.js). A write's Origin is accepted when it is:
//   - this app's own origin as above (requestOrigin: APP_ORIGIN direct, PROXY_ORIGIN through the proxy), or
//   - a loopback http origin identical to a loopback Host (http://127.0.0.1:4720 on Host 127.0.0.1:4720), or
//   - on a LAB_ALLOWED_HOSTS Host on this app's port only: exactly `${X-Forwarded-Proto}://${X-Forwarded-Host}`.
// Forwarded headers count on no other Host. Anything else is cross-origin.
const parseHostHeader = (raw) => {
  const h = String(raw ?? '').trim().toLowerCase();
  if (!/^(\[::1\]|[a-z0-9.-]+)(:\d{1,5})?$/.test(h)) return null;
  const i = h.lastIndexOf(':');
  return i > h.lastIndexOf(']') ? { name: h.slice(0, i), port: h.slice(i + 1), host: h } : { name: h, port: '', host: h };
};
const isLoopbackName = (name) => name === 'localhost' || name === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);

/** True when Host is a LAB_ALLOWED_HOSTS name (never loopback) carrying this app's own port. */
export function isLabHost(hostHeader) {
  const h = parseHostHeader(hostHeader);
  const c = config();
  return !!h && !isLoopbackName(h.name) && c.labAllowedHosts.includes(h.name) && h.port === String(c.port);
}

export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return false;
  if (origin === requestOrigin(req)) return true;
  const h = parseHostHeader(req.headers.host);
  if (!h) return false;
  if (isLabHost(req.headers.host)) {
    const xfh = String(req.headers['x-forwarded-host'] ?? '').trim().toLowerCase();
    const xfp = String(req.headers['x-forwarded-proto'] ?? '').trim().toLowerCase();
    return xfh !== '' && (xfp === 'https' || xfp === 'http') && origin === `${xfp}://${xfh}`;
  }
  if (!isLoopbackName(h.name)) return false;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && isLoopbackName(u.hostname) && u.host === h.host && origin === u.origin;
  } catch { return false; }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Global write guard, mounted right after the Host check: a cross-site write, or one whose Origin is not same-origin, is 403
 *  before routing. A write without Origin is not a browser cross-site request and passes here (as token-workbench); the routes
 *  that act on the session or the registry still require a same-origin Origin themselves (sameOrigin in auth/oidc.js). */
export function sameOriginWrites() {
  return (req, res, next) => {
    if (READ_METHODS.has(req.method)) return next();
    const crossSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site';
    if (crossSite || (req.headers.origin !== undefined && !isSameOrigin(req))) return res.status(403).json({ error: 'invalid_origin' });
    return next();
  };
}
