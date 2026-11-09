// Host header check (rule 3): the server answers only the names it is meant to be reached by, so a page on another
// site cannot use DNS rebinding to read this loopback-only server from a browser.
// Allowed: localhost, 127.0.0.1, [::1], the host of APP_ORIGIN, and any names in ALLOWED_HOSTS (comma-separated; the
// Docker form sets it to the service name the resource AS uses to reach this app), and the names in LAB_ALLOWED_HOSTS (the
// lab-proxy's Host for this lab) on this app's own port only. Ports are not compared for the other names.
import { config } from './config.js';
import { isLabHost } from './requestOrigin.js';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

const hostnameOf = (hostHeader) => {
  try { return new URL(`http://${String(hostHeader ?? '').trim()}`).hostname.toLowerCase(); } catch { return ''; }
};

const anyPortHosts = (env) => {
  const extra = String(env.ALLOWED_HOSTS ?? '').split(',').map(hostnameOf).filter(Boolean);
  return [...LOOPBACK, hostnameOf(new URL(config().appOrigin).host), ...extra].filter(Boolean);
};

export function allowedHosts(env = process.env) {
  return new Set([...anyPortHosts(env), ...config().labAllowedHosts]);
}

export function hostCheck(env = process.env) {
  const anyPort = new Set(anyPortHosts(env));
  return (req, res, next) => {
    const host = hostnameOf(req.headers.host);
    // A LAB_ALLOWED_HOSTS name counts only on this app's port (the lab-proxy sends name:PORT); the other names on any port.
    if ((host && anyPort.has(host)) || isLabHost(req.headers.host)) return next();
    return res.status(403).json({ error: 'invalid_host', message: 'This server answers only on localhost. Open it at its APP_ORIGIN.' });
  };
}
