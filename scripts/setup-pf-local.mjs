// `npm run setup -- --mode=pf-local`: set up the app against a PingFederate on this machine (admin 4731, engine 4732).
// Installs or finds it (scripts/pingfederate-setup.sh), runs the configure scripts against it (sign-in, base URL, a certificate
// the app can verify, the ID-JAG issuer), proves the result with a self-check (pf-selfcheck.mjs), and writes the app's
// runtime settings to the ONE shared settings file. The admin login lives only in ~/.config/demo-kit/provisioning.json:
// it is read here, handed to the configure scripts through their environment, and never printed, put on a command
// line, or written anywhere else. Prompting, the filesystem and process spawning are injected, as in setup-lib.mjs.
import path from 'node:path';
import { sharedEnvPath } from '../server/src/settings.js';
import { formatSelfCheck, selfCheck } from './pf-selfcheck.mjs';

export const PF_ADMIN_ORIGIN = 'https://127.0.0.1:4731'; // the only admin API this mode ever contacts
export const PF_RUNTIME_URL = 'https://127.0.0.1:4732';
const PROVISIONING = ['.config', 'demo-kit', 'provisioning.json'];
const CA_FILE = ['.config', 'demo-kit', 'id-jag-kit', 'pf-ca.pem']; // the local PingFederate's own certificate (public)
export const DEFAULT_APP_ORIGIN = 'http://localhost:4720';

// Keys setup generates for the shared file, written only when the file has no value for them.
const GENERATED = ['SESSION_SECRET', 'REGISTRATION_KEY', 'ID_JAG_REGISTRY_TOKEN', 'RESOURCE_AS_CLIENT_SECRET'];
const LOCAL_BACKENDS = {
  RESOURCE_AS_ISSUER: 'http://localhost:9080',
  MCP_URL: 'http://localhost:9090/mcp',
  ID_JAG_RESOURCE: 'http://localhost:9090/mcp',
};
const ADMIN_KEY = /^PF_ADMIN_(USER|PASSWORD)$/;

const valueOf = (text, key) => (new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1] ?? '').trim();

/**
 * Add settings to .env text. A key is written only when the file has no value for it, unless it is in `overwrite`.
 * Every other line (comments, other apps' keys) is kept as it is. PF_ADMIN_USER / PF_ADMIN_PASSWORD are refused.
 */
export function mergeShared(text, entries, overwrite = []) {
  let out = text;
  for (const [k, v] of Object.entries(entries)) {
    if (ADMIN_KEY.test(k)) throw new Error(`${k} must not be written to the shared settings file`);
    if (/[\r\n]/.test(v)) throw new Error(`${k}: value contains a line break`);
    if (valueOf(out, k) && !overwrite.includes(k)) continue;
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    out = re.test(out) ? out.replace(re, () => line) : `${out.replace(/\n*$/, '\n')}${line}\n`;
  }
  return out;
}

/** The pingfederate entry of provisioning.json, checked to be the local admin. Errors never contain a value. */
export async function readPfAdmin({ fs, home }) {
  const file = path.join(home, ...PROVISIONING);
  let entry;
  try { entry = JSON.parse(await fs.readFile(file, 'utf8')).pingfederate; } catch { entry = null; }
  if (!entry || typeof entry.adminUrl !== 'string' || typeof entry.username !== 'string' || typeof entry.password !== 'string' || !entry.password) {
    throw new Error(`no usable "pingfederate" admin login in ${file}: rerun npm run setup -- --mode=pf-local, or scripts/pingfederate-setup.sh`);
  }
  if (entry.adminUrl.replace(/\/$/, '') !== PF_ADMIN_ORIGIN) {
    throw new Error(`the saved PingFederate admin URL is not ${PF_ADMIN_ORIGIN}; pf-local only ever configures the local install on 4731`);
  }
  return { adminUrl: PF_ADMIN_ORIGIN, username: entry.username, password: entry.password };
}

export async function runPfLocal({ flags, yes, env, root, home, io, fs, exec, rand, check = selfCheck }) {
  const log = io.log;
  const shared = sharedEnvPath({ env, home });
  const sh = (p) => path.join(root, p);

  if (!home) { io.err('cannot find your home folder (HOME is not set)'); return { code: 1 }; }

  log('PingFederate: find or install it on 127.0.0.1 (admin 4731, engine 4732).');
  // The installer asks for YES itself, so it gets the terminal. PF_ACCEPT_EULA comes from the caller's environment only.
  const install = await exec('bash', [sh('scripts/pingfederate-setup.sh')], {
    stdio: 'inherit',
    env: { PF_ADMIN_PORT: '4731', PF_ENGINE_PORT: '4732' },
  });
  if (install.code !== 0) {
    io.err(`PingFederate setup did not finish (exit ${install.code}). Nothing else was changed. Read the message above, fix it, and rerun.`);
    return { code: 1 };
  }

  let admin;
  try { admin = await readPfAdmin({ fs, home }); } catch (e) { io.err(e.message); return { code: 1 }; }
  const scrub = (s) => String(s ?? '').split(admin.password).join('***'); // belt and braces: no child output can echo it
  const show = (r) => {
    const out = scrub(r.stdout).trimEnd(); if (out) log(out);
    const err = scrub(r.stderr).trimEnd(); if (err) io.err(err);
  };

  // The shared settings file: created if missing, mode 600, other apps' keys untouched, existing values of ours kept.
  let text = '';
  if (fs.existsSync(shared)) text = await fs.readFile(shared, 'utf8');
  else { await fs.mkdir(path.dirname(shared), { recursive: true }); text = '# Settings shared by the standalone apps. Mode 600. Admin logins do NOT go here.\n'; }
  let users = typeof flags.users === 'string' ? flags.users : '';
  if (!users && !yes) users = await io.ask('Kit sign-in users, comma-separated emails (blank keeps the existing ones)', '');
  // APP_ORIGIN: where the browser reaches the app (the sign-in client's redirect URIs); ADMIN_EMAILS: the first user administers it.
  const appFlag = typeof flags['app-origin'] === 'string' ? flags['app-origin'].replace(/\/$/, '') : '';
  const firstUser = users.split(',').map((u) => u.trim()).find(Boolean);
  const entries = { PF_URL: PF_RUNTIME_URL, ...LOCAL_BACKENDS, APP_ORIGIN: appFlag || DEFAULT_APP_ORIGIN, ...(firstUser ? { ADMIN_EMAILS: firstUser } : {}) };
  for (const k of GENERATED) entries[k] = rand(32);
  const before = text;
  text = mergeShared(text, entries, ['PF_URL', ...(appFlag ? ['APP_ORIGIN'] : [])]);
  await fs.writeFile(shared, text, { mode: 0o600 });
  await fs.chmod(shared, 0o600); // writeFile's mode only applies to a new file
  log(before === text ? `${shared}: nothing to add (mode 600).` : `${shared}: settings added (mode 600). Generated secrets are not shown; PF_URL=${PF_RUNTIME_URL}.`);

  const caFile = path.join(home, ...CA_FILE);
  const child = {
    PF_ADMIN_URL: admin.adminUrl, PF_ADMIN_USER: admin.username, PF_ADMIN_PASSWORD: admin.password,
    PF_ADMIN_INSECURE_TLS: 'true', // PingFederate's own self-signed certificate on the admin port
    PF_SETTINGS_FILE: shared,
  };
  const steps = [
    ['pingfederate/configure-signin.js', ['--local']],
    ['pingfederate/configure-local-signin.js', users ? [`--users=${users}`] : []],
    ['pingfederate/configure-base-url.js', []], // discovery must name PF_URL, not the image default (another PingFederate's address)
    ['pingfederate/configure-local-tls.js', [`--ca-out=${caFile}`]], // the image's certificate expired; writes PF_CA_FILE
    ['pingfederate/configure-idjag-issuer.js', []], // signing key, JWKS, exchange policy, SP connection to the resource AS
  ];
  for (const [script, args] of steps) {
    log('', `Running ${script}`);
    const r = await exec('node', [sh(script), ...args], { env: child });
    show(r);
    if (r.code !== 0) { io.err(`${script} failed (exit ${r.code}). The scripts are safe to rerun.`); return { code: 1 }; }
  }

  // PingFederate 13.1.3 applies the base URL and the runtime certificate without a restart (observed); the self-check proves it.
  log('', 'Self-check: asking the local PingFederate the way the app will');
  const settingsNow = await fs.readFile(shared, 'utf8');
  const checked = await check({ pfUrl: PF_RUNTIME_URL, caFile: valueOf(settingsNow, 'PF_CA_FILE') || undefined, readFile: (f) => fs.readFile(f) });
  formatSelfCheck(checked).forEach((l) => (checked.ok ? log(l) : io.err(l)));
  if (!checked.ok) return { code: 1, mode: 'pf-local' };

  log('', 'Running doctor (pf-as)', '');
  const doc = await exec('node', [sh('scripts/doctor.mjs'), '--mode=pf-as']);
  show(doc);

  log('', 'PingFederate is configured and issues ID-JAGs for pf-as. Doctor FAIL lines for resource-as and mcp are expected until you start them:',
    '  npm start -w resource-as     (separate terminal, :9080)',
    '  npm start -w mcp-sample      (separate terminal, :9090)',
    `  npm run build && npm start    # ${valueOf(text, 'APP_ORIGIN')}`,
    'Docker: the PingFederate issuer is https://127.0.0.1:4732, which a container cannot reach (127.0.0.1 is the container). Run pf-as with npm; see the README, "Docker and the local PingFederate".');
  return { code: doc.code === 0 ? 0 : 1, mode: 'pf-local' };
}
