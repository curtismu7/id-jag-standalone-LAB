// The guards on mock sign-in (rule 11). The mock PingFederate signs a person in with a demo password that is printed in the
// README, so it must never be reachable by anyone else. It works only when all of these hold:
//   ALLOW_MOCK_SIGNIN=1                              someone chose it on purpose
//   no proxy                                         TRUST_PROXY unset and no forwarded headers on the request, except from the
//                                                    lab-proxy: a Host in LAB_ALLOWED_HOSTS (loopback never counts) whose forwarded
//                                                    host/proto match PROXY_ORIGIN (viaProxy in requestOrigin.js)
//   a loopback bind                                  HOST is 127.0.0.1 / localhost / ::1, or LAB_PUBLISH=loopback (the Docker image
//                                                    listens wide inside the container; compose publishes 127.0.0.1 only)
// NODE_ENV=production is not a guard: the Docker image sets it.
import { isMock } from './mode.js';
import { viaProxy } from './requestOrigin.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded'];
const hostName = (req) => String(req?.headers?.host ?? '').trim().toLowerCase().replace(/:\d+$/, '');
const val = (k) => String(process.env[k] ?? '').trim();

/** null when mock sign-in may proceed (or the app is live), else { status, error, message } for the sign-in route to answer. */
export function mockSigninProblem(req) {
  if (!isMock()) return null;
  const refuse = (message) => ({ status: 409, error: 'mock_signin_disabled', message });
  if (val('ALLOW_MOCK_SIGNIN') !== '1') return refuse('Mock sign-in is off. Start the server with ALLOW_MOCK_SIGNIN=1 to use the built-in demo account.');
  const forwarded = FORWARDED.some((h) => req?.get?.(h) !== undefined && req.get(h) !== '');
  // Forwarded headers are tolerated only from the lab-proxy. A loopback Host never counts, even if it was put in the list.
  const fromLabProxy = forwarded && !LOOPBACK.has(hostName(req)) && viaProxy(req);
  if (val('TRUST_PROXY') || (forwarded && !fromLabProxy)) {
    return refuse('Mock sign-in is refused behind a proxy. Open the app directly on this machine.');
  }
  if (!LOOPBACK.has(val('HOST').toLowerCase()) && val('LAB_PUBLISH') !== 'loopback') {
    return refuse('Mock sign-in is refused because the server listens on more than this machine. Start it with HOST=127.0.0.1.');
  }
  return null;
}
