// Host header check (rule 3): the server answers only the names it is meant to be reached by, so a page on another
// site cannot use DNS rebinding to read this loopback-only server from a browser.
// Allowed: localhost, 127.0.0.1, [::1], the host of APP_ORIGIN, and any names in ALLOWED_HOSTS (comma-separated; the
// Docker form sets it to the service name the resource AS uses to reach this app). Ports are not compared.
import { config } from './config.js';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

const hostnameOf = (hostHeader) => {
  try { return new URL(`http://${String(hostHeader ?? '').trim()}`).hostname.toLowerCase(); } catch { return ''; }
};

export function allowedHosts(env = process.env) {
  const extra = String(env.ALLOWED_HOSTS ?? '').split(',').map(hostnameOf).filter(Boolean);
  return new Set([...LOOPBACK, hostnameOf(new URL(config().appOrigin).host), ...extra].filter(Boolean));
}

export function hostCheck(env = process.env) {
  const allowed = allowedHosts(env);
  return (req, res, next) => {
    const host = hostnameOf(req.headers.host);
    if (host && allowed.has(host)) return next();
    return res.status(403).json({ error: 'invalid_host', message: 'This server answers only on localhost. Open it at its APP_ORIGIN.' });
  };
}
