// Doctor: pre-demo checks. Pure functions with injectable fetch / fs / net / admin-API so tests need no network.
// Each check returns { id, status: 'pass'|'warn'|'fail', message, fix }. Messages say set/unset/length, never a value.
// Used by `npm run doctor` (scripts/doctor.mjs) and the admin-only GET /api/doctor (doctorRoute.js).

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.js';
import { dataDir } from './workspace.js';
import { missingConfig, oidcConfig } from './auth/oidc.js';
import { probeBackends, settings } from './idJagPlayground.js';
import { activeAdapter } from './idp/index.js';
import { currentMode, isMock, runtimeEnv } from './mode.js';
import { issuerKeyCheck } from './jwksCheck.js';
import { mockSigninProblem } from './mockSignin.js';
import { netguard, outboundFetch } from './outbound.js';

export const MODES = ['mock', 'pf-as', 'pf-pf', 'byo'];
const MIN_NODE = 26;

const REQUIRED = {
  'pf-as': ['PF_EXCHANGE_CLIENT_ID', 'PF_EXCHANGE_CLIENT_SECRET', 'RESOURCE_AS_ISSUER', 'RESOURCE_AS_CLIENT_SECRET', 'ID_JAG_RESOURCE', 'MCP_URL', 'ID_JAG_REGISTRY_TOKEN'],
  'pf-pf': ['ACME_PF_URL', 'ACME_EXCHANGE_CLIENT_ID', 'ACME_EXCHANGE_CLIENT_SECRET', 'PF_REDEEMER_CLIENT_SECRET', 'PF_RESOURCE', 'MCP_URL'],
  byo: ['RESOURCE_AS_ISSUER', 'RESOURCE_AS_CLIENT_SECRET', 'MCP_URL', 'ID_JAG_REGISTRY_TOKEN'],
};

const r = (id, status, message, fix = '') => ({ id, status, message, fix });
const pass = (id, message) => r(id, 'pass', message);
const val = (env, k) => String(env[k] ?? '').trim();

export function checkNode(version = process.versions.node) {
  const major = Number(String(version).split('.')[0]);
  return major >= MIN_NODE
    ? pass('node', `Node ${version}`)
    : r('node', 'fail', `Node ${version} is older than ${MIN_NODE}`, `Install Node ${MIN_NODE} or newer (engines in package.json).`);
}

export function checkEnvFile(mode, envFile, fsImpl = fs) {
  if (envFile && fsImpl.existsSync(envFile)) return pass('env-file', '.env present');
  if (mode === 'mock') return pass('env-file', 'no .env (not needed in mock mode)');
  return r('env-file', 'warn', 'no .env file found', 'cp .env.example .env and fill it in (or set the variables in the environment, as compose does).');
}

export function checkEnvRequired(mode, env = runtimeEnv()) {
  const missing = (REQUIRED[mode] || []).filter((k) => !val(env, k));
  return missing.length
    ? r('env-required', 'fail', `unset: ${missing.join(', ')}`, mode === 'pf-pf'
      ? `The ACME_* values come from the owner of the shared Acme PingFederate as a three-key settings block; PF_REDEEMER_CLIENT_SECRET and PF_RESOURCE are written by the same step: npm run setup -- --mode=pf-pf --acme-settings=<file> (needs npm run setup -- --mode=pf-local first). Unset: ${missing.join(', ')}.`
      : `Set ${missing.join(', ')} in .env (see .env.example for what each is).`)
    : pass('env-required', `all ${REQUIRED[mode].length} settings for ${mode} are set`);
}

export function checkSignin() {
  const missing = missingConfig(oidcConfig());
  return missing.length
    ? r('env-signin', 'fail', `sign-in not configured, missing: ${missing.join('; ')}`, 'Set the OIDC client (or PF_EXCHANGE_CLIENT_ID/_SECRET) in .env; without it /auth/pi-flow/start answers 503.')
    : pass('env-signin', 'OIDC sign-in client is configured');
}

export function checkSessionSecret(env = runtimeEnv()) {
  const n = val(env, 'SESSION_SECRET').length;
  return n >= 16 ? pass('env-session', `SESSION_SECRET set (${n} chars)`)
    : r('env-session', 'warn', n ? `SESSION_SECRET is short (${n} chars)` : 'SESSION_SECRET unset: sessions end on every restart', 'Set SESSION_SECRET to a long random value: openssl rand -hex 32');
}

export function checkRegistrationKey(env = runtimeEnv()) {
  const n = val(env, 'REGISTRATION_KEY').length;
  return n >= 16 ? pass('env-registration', `REGISTRATION_KEY set (${n} chars)`)
    : r('env-registration', 'warn', n ? `REGISTRATION_KEY is short (${n} chars, needs 16+)` : 'REGISTRATION_KEY unset: /register answers 503', 'Set REGISTRATION_KEY (16+ characters): openssl rand -hex 32');
}

export function checkAccess(env = runtimeEnv()) {
  if (!val(env, 'ADMIN_EMAILS')) {
    return r('env-access', 'warn', `ADMIN_EMAILS unset: only ID tokens whose ${val(env, 'ADMIN_CLAIM') || 'groups'} claim contains ${val(env, 'ADMIN_CLAIM_VALUE') || 'demo-admins'} are admins`, 'Set ADMIN_EMAILS to your email so you can approve registrations.');
  }
  return pass('env-access', `ADMIN_EMAILS set; allowed domains ${val(env, 'ALLOWED_EMAIL_DOMAINS') ? 'set' : 'default (pingidentity.com, pingone.com)'}`);
}

export function checkDataDir(dir, fsImpl = fs) {
  const abs = path.resolve(dir);
  let at = abs;
  while (!fsImpl.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  try {
    fsImpl.accessSync(at, fsImpl.constants.W_OK);
    return pass('data-dir', at === abs ? `${abs} is writable` : `${abs} will be created (${at} is writable)`);
  } catch {
    return r('data-dir', 'fail', `${at} is not writable, so ${abs} cannot be used`, `Set DATA_DIR to a writable directory, or fix permissions: chmod u+w ${at}`);
  }
}

export function portFree(port, netImpl = net) {
  return new Promise((resolve) => {
    const s = netImpl.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port);
  });
}
export async function checkPort(port, netImpl = net) {
  return (await portFree(port, netImpl))
    ? pass('port', `port ${port} is free`)
    : r('port', 'fail', `port ${port} is already in use`, `Stop whatever listens on ${port} (lsof -i :${port}) or set PORT to another value.`);
}

/** PF discovery must answer and name an issuer equal, byte for byte, to the configured URL. */
export async function checkDiscovery(id, label, url, fetchImpl = outboundFetch) {
  try {
    const res = await fetchImpl(`${url}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(4000) });
    if (res.status < 200 || res.status >= 300) return r(id, 'fail', `${url} discovery answered HTTP ${res.status}`, `Check ${label} and that the server is up.`);
    const issuer = (await res.json().catch(() => ({}))).issuer;
    if (issuer === url) return pass(id, `${url} discovery OK, issuer matches`);
    // A PingFederate that was never given a base URL publishes the image default; the fix is on the PingFederate side.
    const local = /^https:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
    return r(id, 'fail', `${label} is ${url} but discovery says issuer is ${issuer ?? '(missing)'}`, local
      ? `Do not change ${label} to match: that issuer may belong to another PingFederate on this machine. Rerun npm run setup -- --mode=pf-local, which sets this PingFederate's base URL to ${url}.`
      : `Set ${label} to exactly the issuer the server publishes (no trailing slash, same scheme and host).`);
  } catch (err) {
    return r(id, 'fail', `could not reach ${url} (${err?.cause?.code || err?.message})`, `Check ${label}, the network and VPN.`);
  }
}

/** pf-as, live only (the mock PingFederate signs with an EC key): the issuer's /pf/JWKS must carry an RSA key with x5t (what ID-JAGs are signed with), and ideally only one. */
export async function checkIssuerJwks(id, url, fetchImpl = outboundFetch, { label = 'PF_URL', fix = null } = {}) {
  const jwksUrl = `${url}/pf/JWKS`;
  try {
    const res = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(4000) });
    if (res.status < 200 || res.status >= 300) return r(id, 'fail', `${jwksUrl} answered HTTP ${res.status}`, `Check ${label} and that the server is up.`);
    const v = issuerKeyCheck((await res.json().catch(() => ({}))).keys);
    fix ??= 'Rerun npm run setup -- --mode=pf-local (it publishes the one ID-JAG signing key), or publish it yourself through a JWT access token manager and set a static JWKS.';
    if (v.status === 'fail') return r(id, 'fail', `${jwksUrl} has no RSA key with x5t, so nothing can verify an ID-JAG from this issuer`, fix);
    return v.status === 'warn'
      ? r(id, 'warn', `${jwksUrl} lists ${v.rsa} distinct RSA keys (${v.withX5t} with x5t): PingFederate's own JWT-bearer consumer may pick the wrong one`, fix)
      : pass(id, `${jwksUrl} has one RSA key, with x5t`);
  } catch (err) {
    return r(id, 'fail', `could not read ${jwksUrl} (${err?.cause?.code || err?.message})`, `Check ${label}, the network, and PF_CA_FILE if PingFederate uses its own certificate.`);
  }
}

/** pf-pf, live only: Acme starts a pi.flow sign-in for the kit's client at Acme (what step 1 does), asking for nothing a user could type. */
export async function checkAcmeSignin(id, { acmeUrl, clientId, redirectUri }, fetchImpl = outboundFetch) {
  const fix = 'Ask the owner of the shared Acme PingFederate to run pingfederate/configure-acme-signin.js (the client, its redirect URIs and the Authentication API), then to send a fresh three-key settings block.';
  if (!clientId) return r(id, 'fail', 'ACME_EXCHANGE_CLIENT_ID is unset, so no sign-in can start at Acme', fix);
  const url = new URL(`${acmeUrl}/as/authorization.oauth2`);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'offline_access', response_mode: 'pi.flow', state: 'doctor',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
  }).toString();
  try {
    const res = await fetchImpl(url.toString(), { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(6000) });
    const data = await res.json().catch(() => ({}));
    if (data?.status === 'USERNAME_PASSWORD_REQUIRED') return pass(id, 'Acme starts a pi.flow sign-in for this client (it asks for a username and password)');
    return r(id, 'fail', `Acme answered HTTP ${res.status}${data?.status || data?.code || data?.error ? ` (${String(data.status || data.code || data.error).slice(0, 60)})` : ''} instead of starting a pi.flow sign-in`,
      `${fix} The redirect URI Acme must have is ${redirectUri}.`);
  } catch (err) {
    return r(id, 'fail', `could not start a sign-in at Acme (${err?.cause?.code || err?.message})`, 'Check ACME_PF_URL, the network and VPN.');
  }
}

/** The mode's resource AS and MCP server, through the playground's own backend probe (PF itself is checked by discovery). */
export async function checkBackends(mode, fetchImpl = outboundFetch) {
  const rows = (await probeBackends(settings(mode === 'pf-pf' ? 'pf-pf' : 'pf-as'), config().mcpUrl, fetchImpl)).filter((b) => b.id !== 'idp');
  return rows.map((b) => (b.state === 'down'
    ? r(b.id, 'fail', `${b.label} down at ${b.url} (${b.detail})`, b.id === 'mcp' ? 'Start mcp-sample (npm start -w mcp-sample) and check MCP_URL.' : 'Start resource-as (npm start -w resource-as) and check RESOURCE_AS_ISSUER.')
    : b.state === 'slow' ? r(b.id, 'warn', `${b.label} slow (${b.detail})`, 'Check the network before presenting.')
      : pass(b.id, `${b.label} up (${b.detail})`)));
}

/** Mock mode: the netguard refuses what it should (its self-test), proving it without any network. */
export async function checkNetguard() {
  const t = await netguard.selfTest();
  const failed = t.checks.filter((c) => !c.ok);
  return failed.length
    ? r('netguard', 'fail', `the netguard is leaking: ${failed.map((c) => c.name).join('; ')}`, 'Mock mode would reach the real network. Do not present it; fix server/src/netguard.js.')
    : pass('netguard', `self-test passed (${t.checks.length} checks): real hosts are refused and counted, the real fetch is never called`);
}

/** Mock mode: the demo account works only when the three guards allow it. A warning, since everything else still runs. */
export function checkMockSignin() {
  const problem = mockSigninProblem(undefined);
  return problem
    ? r('mock-signin', 'warn', problem.message, 'Start the server with ALLOW_MOCK_SIGNIN=1 HOST=127.0.0.1 (the Docker image sets both).')
    : pass('mock-signin', 'mock sign-in is allowed: loopback bind, no proxy, ALLOW_MOCK_SIGNIN=1');
}

/** Run every check that applies to `mode`. `skip` names ids to leave out (the route skips `port`: it is us). */
export async function runDoctor({ mode = 'mock', env = runtimeEnv(), fetchImpl = outboundFetch, fsImpl = fs, netImpl = net, adminCall, envFile, skip = [] } = {}) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode} (use ${MODES.join(', ')})`);
  const c = config();
  const guard = (id, fn) => Promise.resolve().then(fn).catch((err) => [r(id, 'fail', `check crashed: ${err?.message}`)]);
  const groups = [
    [checkNode()],
    [checkEnvFile(mode, envFile, fsImpl)],
    [checkDataDir(dataDir(), fsImpl)],
    skip.includes('port') ? [] : await guard('port', async () => [await checkPort(c.port, netImpl)]),
  ];
  if (isMock()) {
    // The mock world answers like the servers it stands for (the same discovery check the live mode runs), and the guard holds.
    groups.push([await checkNetguard(), checkMockSignin()], await guard('mock-pf', async () => [await checkDiscovery('mock-pf', 'PF_URL', c.pfUrl, fetchImpl)]));
  }
  if (mode !== 'mock') {
    groups.push(
      [checkEnvRequired(mode, env), checkSignin(), checkSessionSecret(env), checkRegistrationKey(env), checkAccess(env)],
      ...await Promise.all([
        guard('pf-discovery', async () => [await checkDiscovery('pf-discovery', 'PF_URL', c.pfUrl, fetchImpl)]),
        mode === 'pf-as' && !isMock() ? guard('pf-jwks', async () => [await checkIssuerJwks('pf-jwks', c.pfUrl, fetchImpl)]) : [],
        mode === 'pf-pf' ? guard('acme-discovery', async () => [await checkDiscovery('acme-discovery', 'ACME_PF_URL', c.acmePfUrl, fetchImpl)]) : [],
        mode === 'pf-pf' && !isMock() ? guard('acme-jwks', async () => [await checkIssuerJwks('acme-jwks', c.acmePfUrl, fetchImpl, { label: 'ACME_PF_URL',
          fix: 'Acme\'s /pf/JWKS must list exactly one RSA key with x5t (its ID-JAG signing key). Ask the Acme owner; after Acme changes keys, rerun npm run setup -- --mode=pf-pf to restart your PingFederate (it caches Acme\'s keys forever).' })]) : [],
        mode === 'pf-pf' && !isMock() ? guard('acme-signin', async () => [await checkAcmeSignin('acme-signin', { acmeUrl: c.acmePfUrl, clientId: c.acmeExchangeClientId, redirectUri: `${c.appOrigin}/api/id-jag-playground/issuer/callback` }, fetchImpl)]) : [],
        guard('pf-admin', () => activeAdapter(env).doctor({ env, adminCall })),
        guard('backends', () => checkBackends(mode, fetchImpl)),
      ]),
    );
  }
  const checks = groups.flat();
  return { mode, appMode: currentMode(), ok: !checks.some((x) => x.status === 'fail'), checks };
}

const MARK = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
export function formatReport({ mode, appMode, ok, checks }) {
  const lines = [`Doctor (${mode} mode${appMode ? `, app ${appMode}` : ''})`, ''];
  for (const x of checks) {
    lines.push(`${MARK[x.status]}  ${x.id.padEnd(16)} ${x.message}`);
    if (x.status !== 'pass' && x.fix) lines.push(`      fix: ${x.fix}`);
  }
  const n = (s) => checks.filter((x) => x.status === s).length;
  lines.push('', `${n('pass')} passed, ${n('warn')} warnings, ${n('fail')} failed${ok ? '' : ': fix the FAIL lines above'}`);
  return lines.join('\n');
}
