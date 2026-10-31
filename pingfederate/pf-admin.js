'use strict';
// Shared by the configure-*.js scripts: options, the PingFederate admin API, and .env writes. The admin password is
// never printed. Two ways to reach the admin API:
//   - a cluster (default): a kubectl port-forward on --port, password from the pingfederate-admin secret in --ns.
//   - direct (`npm run setup`, mode pf-local): PF_ADMIN_URL, PF_ADMIN_USER and PF_ADMIN_PASSWORD in the environment, and
//     PF_ADMIN_INSECURE_TLS=true for the local self-signed certificate. --ns and --port are then not needed.
// PF_SETTINGS_FILE (set by `npm run setup`) names the file writeEnv() updates; default is the repo-root .env.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ENV_FILE = process.env.PF_SETTINGS_FILE || path.join(__dirname, '../.env');
try { process.loadEnvFile(ENV_FILE); } catch { /* no .env: env and args only */ }

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
  console.error(`set ${name} (env or the repo-root .env)`);
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
    pw = Buffer.from(execFileSync('kubectl', ['-n', ns, 'get', 'secret', 'pingfederate-admin', '-o', 'jsonpath={.data.password}']).toString(), 'base64').toString();
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

module.exports = { args, setting, secret, adminApi, report, ensure, writeEnv, acceptAll, from, same, done, fail, ENV_FILE };
