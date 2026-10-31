// The logic behind `npm run setup`. Prompting, the filesystem, process spawning and randomness are injected so
// the tests run without a terminal, a network or a Docker engine. Nothing here prints a secret value.
import crypto from 'node:crypto';
import path from 'node:path';
import { MODES } from '../server/src/doctor.js';

export const IDPS = [
  { id: 'local', label: 'Local PingFederate users (pi.flow)', available: true },
  { id: 'pingone', label: 'PingOne behind PingFederate', available: false, reason: 'the PingOne hop is a redirect login, which this kit does not use (PingFederate\'s Authentication API cannot run it)' },
  { id: 'aic', label: 'AIC', available: false, reason: 'AIC sign-in waits for pi.flow support' },
];

// Asked (or taken from a flag or the environment) only for the modes listed. `flag` is the --flag form for non-secrets.
const FIELDS = [
  { key: 'PF_URL', flag: 'pf-url', label: 'PingFederate base URL', modes: ['pf-as', 'pf-pf', 'byo'] },
  { key: 'PF_EXCHANGE_CLIENT_ID', flag: 'pf-client-id', label: 'PingFederate exchange client id', modes: ['pf-as', 'pf-pf'] },
  { key: 'PF_EXCHANGE_CLIENT_SECRET', secret: true, label: 'PingFederate exchange client secret', modes: ['pf-as', 'pf-pf'] },
  { key: 'PF_ADMIN_URL', flag: 'pf-admin-url', label: 'PingFederate admin URL (blank to skip the admin checks)', modes: ['pf-as', 'pf-pf'] },
  { key: 'PF_ADMIN_PASSWORD', secret: true, label: 'PingFederate admin password', modes: ['pf-as', 'pf-pf'], when: (v) => v.PF_ADMIN_URL },
  { key: 'ACME_EXCHANGE_CLIENT_ID', flag: 'acme-client-id', label: 'Acme PingFederate exchange client id', modes: ['pf-pf'] },
  { key: 'ACME_EXCHANGE_CLIENT_SECRET', secret: true, label: 'Acme PingFederate exchange client secret', modes: ['pf-pf'] },
];

// Where `npm start -w resource-as` and `-w mcp-sample` listen, for npm runs (compose sets its own).
const LOCAL_BACKENDS = {
  RESOURCE_AS_ISSUER: 'http://localhost:9080',
  MCP_URL: 'http://localhost:9090/mcp',
  ID_JAG_RESOURCE: 'http://localhost:9090/mcp',
};
const GENERATED = ['SESSION_SECRET', 'REGISTRATION_KEY', 'ID_JAG_REGISTRY_TOKEN'];

export function parseArgs(argv) {
  const flags = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? true;
  }
  return flags;
}

/** Set KEY=value in .env text: replace the line if there is one, else append. */
export function setEnv(text, key, value) {
  if (/[\r\n]/.test(value)) throw new Error(`${key}: value contains a line break`);
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
}

export async function checkDockerContext(exec) {
  const { code, stdout } = await exec('docker', ['context', 'show']);
  if (code !== 0) return 'Docker did not answer. Start OrbStack (open the OrbStack app), then rerun.';
  const ctx = String(stdout).trim();
  if (ctx === 'orbstack') return null;
  return `Docker context is "${ctx}", not "orbstack". This kit runs on OrbStack, not Docker Desktop. Switch with: docker context use orbstack`;
}

export async function runSetup({ argv = [], env = {}, root, io, fs, exec, rand = (n) => crypto.randomBytes(n).toString('hex') }) {
  const flags = parseArgs(argv);
  const yes = flags.yes === true;
  const envFile = path.join(root, '.env');
  const log = io.log;

  if (fs.existsSync(envFile) && flags.force !== true) {
    io.err('.env already exists; not touching it. Rerun with --force to replace it (the old one is saved as .env.bak.<n>).');
    return { code: 1 };
  }

  const mode = flags.mode ?? (yes ? 'mock' : await io.ask(`Mode to configure (${MODES.join(', ')})`, 'mock'));
  if (!MODES.includes(mode)) { io.err(`unknown mode ${mode}; use one of ${MODES.join(', ')}`); return { code: 2 }; }

  if (mode !== 'mock') {
    log('How PingFederate signs users in:');
    IDPS.forEach((i) => log(`  ${i.id.padEnd(8)} ${i.label}${i.available ? '' : ` (unavailable: ${i.reason})`}`));
    const pick = flags.idp ?? (yes ? 'local' : await io.ask('Sign-in', 'local'));
    const idp = IDPS.find((i) => i.id === pick);
    if (!idp) { io.err(`unknown sign-in ${pick}; use one of ${IDPS.map((i) => i.id).join(', ')}`); return { code: 2 }; }
    if (!idp.available) { io.err(`${idp.label} is not available: ${idp.reason}. Use "local".`); return { code: 2 }; }
  }

  const runner = flags.run ?? 'npm';
  if (!['npm', 'docker'].includes(runner)) { io.err(`unknown --run=${runner}; use npm or docker`); return { code: 2 }; }
  if (runner === 'docker') {
    const problem = await checkDockerContext(exec);
    if (problem) { io.err(problem); return { code: 1 }; }
  }

  const values = {};
  for (const f of FIELDS) {
    if (!f.modes.includes(mode) || (f.when && !f.when(values))) continue;
    let v = (f.flag && flags[f.flag] !== true && flags[f.flag]) || env[f.key] || '';
    if (!v && !yes) v = f.secret ? await io.askSecret(f.label) : await io.ask(f.label, '');
    if (v) values[f.key] = v;
  }

  let text = await fs.readFile(path.join(root, '.env.example'), 'utf8');
  for (const k of GENERATED) text = setEnv(text, k, rand(32));
  if (mode !== 'mock') {
    text = setEnv(text, 'RESOURCE_AS_CLIENT_SECRET', rand(32));
    for (const [k, v] of Object.entries(LOCAL_BACKENDS)) text = setEnv(text, k, v);
  }
  for (const [k, v] of Object.entries(values)) text = setEnv(text, k, v);

  if (fs.existsSync(envFile)) {
    let n = 1;
    while (fs.existsSync(`${envFile}.bak.${n}`)) n++;
    await fs.copyFile(envFile, `${envFile}.bak.${n}`);
    await fs.chmod(`${envFile}.bak.${n}`, 0o600); // copyFile keeps the old mode; the backup holds real secrets
    log(`Saved the old .env as .env.bak.${n}`);
  }
  await fs.writeFile(envFile, text, { mode: 0o600 });
  await fs.chmod(envFile, 0o600); // writeFile's mode only applies to a new file; --force replaces an existing one
  log(`Wrote .env (${mode} mode). SESSION_SECRET, REGISTRATION_KEY and ID_JAG_REGISTRY_TOKEN were generated; they are not shown.`);

  log('', `Running doctor (${mode})`, '');
  const doc = await exec('node', [path.join(root, 'scripts', 'doctor.mjs'), `--mode=${mode}`]);
  log(String(doc.stdout).trimEnd());
  if (doc.stderr) io.err(String(doc.stderr).trimEnd());

  log('', 'Next:');
  if (mode !== 'mock') {
    log('  node pingfederate/configure-local-signin.js --ns=<ns> --users=<email>,...   (once; local PingFederate users)');
    if (runner === 'npm') log('  npm start -w resource-as     (separate terminal, :9080)', '  npm start -w mcp-sample      (separate terminal, :9090)');
  }
  log(runner === 'docker' ? '  docker compose -f deploy/docker-compose.yml up --build -d    # http://localhost:4720'
    : '  npm run build && npm start    # http://localhost:4720');
  return { code: doc.code === 0 ? 0 : 1, mode };
}
