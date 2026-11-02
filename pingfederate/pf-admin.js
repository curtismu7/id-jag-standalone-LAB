'use strict';
// Shared by the configure-*.js scripts: options, the PingFederate admin API, and .env writes. The admin password is
// never printed. Two ways to reach the admin API:
//   - a cluster (default): a kubectl port-forward on --port, password from the pingfederate-admin secret in --ns.
//   - direct (`npm run setup`, mode pf-local): PF_ADMIN_URL, PF_ADMIN_USER and PF_ADMIN_PASSWORD in the environment, and
//     PF_ADMIN_INSECURE_TLS=true for the local self-signed certificate. --ns and --port are then not needed.
// writeEnv() updates PF_SETTINGS_FILE (set by `npm run setup`), else the ONE shared settings file (STANDALONE_ENV, else
// ~/Development/.env). Never the repo-root .env: a rerun from another folder must not leave a secret in a second place.
// --context=<kube context> names the cluster for the kubectl calls (a cluster run should always pass it).
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ENV_FILE = process.env.PF_SETTINGS_FILE || process.env.STANDALONE_ENV || path.join(os.homedir(), 'Development', '.env');
for (const f of [ENV_FILE, path.join(__dirname, '../.env')]) { // the repo-root .env is read for existing users, never written
  try { process.loadEnvFile(f); } catch { /* missing: env and args only */ }
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));

/** An option, else the named env var, else a clear exit. */
function setting(option, envName, what) {
  if (option === 'ns' && process.env.PF_ADMIN_URL) return 'direct'; // no cluster: the admin API is reached by URL
  const v = args[option] || (envName && process.env[envName]);
  if (!v) { console.error(`${what}: pass --${option}=…${envName ? ` or set ${envName}` : ''}`); process.exit(2); }
  return String(v).replace(/\/$/, '');
}

function secret(name) {
  if (process.env[name]) return process.env[name];
  console.error(`set ${name} (env or the shared settings file)`);
  process.exit(2);
}

function adminApi(ns, port) {
  const direct = process.env.PF_ADMIN_URL;
  let base; let user; let pw; let agent;
  if (direct) {
    if (!process.env.PF_ADMIN_PASSWORD) { console.error('PF_ADMIN_URL is set but PF_ADMIN_PASSWORD is not'); process.exit(2); }
    base = `${direct.replace(/\/$/, '')}/pf-admin-api/v1`;
    user = process.env.PF_ADMIN_USER || 'administrator';
    pw = process.env.PF_ADMIN_PASSWORD;
    agent = new https.Agent({ rejectUnauthorized: process.env.PF_ADMIN_INSECURE_TLS !== 'true' });
  } else {
    base = `https://localhost:${port}/pf-admin-api/v1`;
    user = 'administrator';
    pw = Buffer.from(execFileSync('kubectl', [...(args.context && args.context !== true ? ['--context', args.context] : []), '-n', ns, 'get', 'secret', 'pingfederate-admin', '-o', 'jsonpath={.data.password}']).toString(), 'base64').toString();
    agent = new https.Agent({ rejectUnauthorized: false }); // port-forwarded admin API, self-signed
  }
  return (method, p, body) => new Promise((resolve, reject) => {
    const req = https.request(`${base}${p}`, {
      method, agent,
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`, 'X-XSRF-Header': 'PingFederate', 'Content-Type': 'application/json' },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let j = null; try { j = out ? JSON.parse(out) : null; } catch { j = out; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** The scripts that set up the kit's own PingFederate (base URL, certificate, ID-JAG issuer) may only reach a loopback admin API. */
function requireLocalAdmin() {
  let host = '';
  try { host = new URL(process.env.PF_ADMIN_URL || '').hostname; } catch { /* unset or not a URL */ }
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    console.error('this script configures the kit\'s own local PingFederate: set PF_ADMIN_URL (https://127.0.0.1:4731), or run npm run setup -- --mode=pf-local');
    process.exit(2);
  }
}

/**
 * The sign-in client's redirect URIs for an app origin. A browser reaches a local app as localhost or 127.0.0.1, and the
 * default port 4720 is always welcome, so a local origin (http, with a port) registers all of those. Callers add these to
 * the client's existing URIs and never replace them.
 */
function signinRedirects(appOrigin) {
  const origins = new Set([appOrigin]);
  const local = /^http:\/\/(localhost|127\.0\.0\.1):(\d+)$/.exec(appOrigin);
  if (local) for (const h of ['localhost', '127.0.0.1']) { origins.add(`http://${h}:${local[2]}`); origins.add(`http://${h}:4720`); }
  return [...origins].flatMap((o) => [`${o}/auth/callback`, `${o}/api/id-jag-playground/issuer/callback`]);
}

let failed = false;
function report(what, r) {
  const ok = r.status >= 200 && r.status < 300;
  if (!ok) failed = true;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: HTTP ${r.status} ${JSON.stringify(r.body?.validationErrors || r.body?.message || r.body)}`}`);
  return ok;
}

/** Create unless GET finds it. */
async function ensure(api, what, getPath, postPath, body) {
  const have = await api('GET', getPath);
  if (have.status === 200) { console.log(`  keep ${what}`); return true; }
  return report(`create ${what}`, await api('POST', postPath, body));
}

function writeEnv(pairs) {
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* a new settings file */ }
  const lines = text.split('\n').filter((l) => !Object.keys(pairs).some((k) => l.startsWith(`${k}=`)));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(pairs)) lines.push(`${k}=${v}`);
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600); // the mode above only applies to a new file
}

const acceptAll = (m) => ({ attributeSources: [], issuanceCriteria: { conditionalCriteria: [] }, ...m });
const from = (type, names, extra = {}) => Object.fromEntries(names.map(([to, value]) => [to, { source: { type, ...extra }, value }]));
const same = (names) => names.map((n) => [n, n]);
const done = (tag, okLine) => { console.log(failed ? `[${tag}] finished with failures` : okLine); process.exit(failed ? 1 : 0); };
const fail = (tag, port) => (err) => { console.error(`[${tag}] ${err.message || err.code} (${process.env.PF_ADMIN_URL ? 'is PingFederate up?' : `is the admin port-forward on ${port} up?`})`); process.exit(1); };

module.exports = { args, setting, secret, adminApi, report, ensure, writeEnv, acceptAll, from, same, done, fail, requireLocalAdmin, signinRedirects, hasFailed: () => failed, ENV_FILE };
