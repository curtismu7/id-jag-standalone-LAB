// The origin of THIS request, for CSRF checks and OAuth redirect URIs. Dual-homing (owner rule: the kit is served
// via the family lab-proxy AND directly on loopback). A request through the lab-proxy carries X-Forwarded-Host
// (only the proxy sets it): its browser Origin is proxyOrigin (bare), and its redirect URIs carry proxyBase.
// Direct requests use APP_ORIGIN (which may itself carry no path; the kit is served at /).
import { config } from './config.js';

function viaProxy(req) {
  const c = config();
  if (!c.proxyOrigin) return false;
  const fwd = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim().toLowerCase();
  try { return !!fwd && fwd === new URL(c.proxyOrigin).host.toLowerCase(); } catch { return false; }
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
