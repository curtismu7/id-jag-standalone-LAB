// `npm run setup -- --mode=pf-pf [--acme-settings=<file>]`: pf-pf mode. The outside Acme PingFederate (the shared SE one,
// owned by the demo owner) issues the ID-JAG; this machine's PingFederate redeems it. Setup here is the redeemer half:
//   1. the owner hands over a three-key settings block (ACME_PF_URL, ACME_EXCHANGE_CLIENT_ID, ACME_EXCHANGE_CLIENT_SECRET),
//      a file in mode 600. It is checked, merged into the ONE shared settings file (mode 600), and deleted. Any other key is
//      refused. No value is ever printed.
//   2. pingfederate/configure-pf-redeemer.js sets up the local PingFederate (IdP connection for Acme, token manager, JWT
//      bearer client) and writes PF_REDEEMER_CLIENT_ID / _SECRET and PF_RESOURCE.
// The acme-user password is not part of this: the user types it into the sign-in modal and nothing stores it.
// Prompting, the filesystem and process spawning are injected, as in setup-lib.mjs.
import path from 'node:path';
import { sharedEnvPath } from '../server/src/settings.js';
import { mergeShared, PF_RUNTIME_URL, readPfAdmin } from './setup-pf-local.mjs';

export const ACME_KEYS = ['ACME_PF_URL', 'ACME_EXCHANGE_CLIENT_ID', 'ACME_EXCHANGE_CLIENT_SECRET'];
const MAX_BLOCK_BYTES = 4096; // three short lines; anything bigger is not a settings block
const MAX_PROBLEMS = 10;
const THIS_MACHINE = /^(localhost|\[?::1\]?|0\.0\.0\.0|127(\.\d{1,3}){3})$/i; // Acme is somewhere else: this machine's own PingFederate cannot be it
const PRIVATE = /^[A-Z][A-Z0-9_]{0,63}$/; // a key name safe to show; anything else is reported by line number only

const valueOf = (text, key) => (new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1] ?? '').trim();

/**
 * The three values in a settings block, or an Error listing every problem. A message never contains a value, and names a key
 * only when it looks like a variable name.
 */
export function parseAcmeSettings(text) {
  const values = {};
  const problems = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const n = i + 1;
    const eq = line.indexOf('=');
    if (eq < 1) { problems.push(`line ${n} is not KEY=value`); return; }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    if (!ACME_KEYS.includes(key)) { problems.push(`line ${n}: ${PRIVATE.test(key) ? `${key} is not` : 'that key is not'} one of the three accepted keys (${ACME_KEYS.join(', ')})`); return; }
    if (key in values) { problems.push(`line ${n}: ${key} appears twice`); return; }
    values[key] = value;
  });
  for (const k of ACME_KEYS) {
    if (!(k in values)) problems.push(`${k} is missing`);
    else if (!values[k]) problems.push(`${k} is empty`);
  }
  if (values.ACME_PF_URL && !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/.test(values.ACME_PF_URL)) problems.push('ACME_PF_URL must be an https origin with no path, user or query');
  else if (values.ACME_PF_URL && THIS_MACHINE.test(new URL(values.ACME_PF_URL).hostname)) problems.push('ACME_PF_URL names this machine: it must be the outside Acme PingFederate, not the local one (an IdP must not redeem its own ID-JAG)');
  if (values.ACME_EXCHANGE_CLIENT_ID && !/^[A-Za-z0-9._-]{1,128}$/.test(values.ACME_EXCHANGE_CLIENT_ID)) problems.push('ACME_EXCHANGE_CLIENT_ID has characters a client id does not');
  if (values.ACME_EXCHANGE_CLIENT_SECRET && !/^\S{1,512}$/.test(values.ACME_EXCHANGE_CLIENT_SECRET)) problems.push('ACME_EXCHANGE_CLIENT_SECRET has whitespace or is too long');
  else if (values.ACME_EXCHANGE_CLIENT_SECRET?.includes('#')) problems.push('ACME_EXCHANGE_CLIENT_SECRET contains "#", which the settings file loader reads as the start of a comment: ask the owner to re-issue it');
  if (problems.length) {
    const shown = problems.slice(0, MAX_PROBLEMS);
    if (problems.length > shown.length) shown.push(`...and ${problems.length - shown.length} more`);
    throw new Error(`the Acme settings block is not usable:\n  ${shown.join('\n  ')}`);
  }
  return { ...values, ACME_PF_URL: values.ACME_PF_URL.replace(/\/$/, '') };
}

/** What the owner must still supply, printed when the block is not in the shared file yet. */
export function missingMessage(missing, file) {
  return [
    `pf-pf mode needs ${missing.length === ACME_KEYS.length ? 'three values' : `${missing.join(', ')}`} from the owner of the shared Acme PingFederate:`,
    ...ACME_KEYS.map((k) => `  ${k}${missing.includes(k) ? '   (missing)' : ''}`),
    'The owner sends them as one settings block through the approved secret channel (with an expiry), and sends the acme-user',
    'password separately: you type that into the sign-in modal and nothing stores it. Save the block as a file, then:',
    `  chmod 600 ${file}`,
    `  npm run setup -- --mode=pf-pf --acme-settings=${file}`,
    'Setup merges the three keys into the shared settings file, deletes the file, and sets up this machine\'s PingFederate as the redeemer.',
    'Do not use tools/outside-agent.js with these: it needs the demo\'s acme-agent credential, which is never handed out.',
  ];
}

/** A settings block file: a regular file (not a link), mode 600, read whole. */
async function readBlock(file, fs) {
  const st = await fs.lstat(file).catch(() => null);
  if (!st) throw new Error(`${file} does not exist`);
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if (st.size > MAX_BLOCK_BYTES) throw new Error(`${file} is ${st.size} bytes: a settings block is three short lines, so this is not one`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${file} is readable by others (mode ${(st.mode & 0o777).toString(8)}): run chmod 600 ${file}, and treat it as exposed if others share this machine`);
  return fs.readFile(file, 'utf8');
}

export async function runPfPf({ flags, env, root, home, io, fs, exec }) {
  const log = io.log;
  if (!home) { io.err('cannot find your home folder (HOME is not set)'); return { code: 1 }; }
  const shared = sharedEnvPath({ env, home });
  const sh = (p) => path.join(root, p);
  let text = fs.existsSync(shared) ? await fs.readFile(shared, 'utf8') : '';

  // 1. This machine's PingFederate must be set up first: it is the redeemer.
  const localFirst = `This machine's PingFederate (${PF_RUNTIME_URL}) is the redeemer and is not set up yet: run npm run setup -- --mode=pf-local first.`;
  const needLocal = valueOf(text, 'PF_URL') !== PF_RUNTIME_URL;
  const absent = ACME_KEYS.filter((k) => !valueOf(text, k));
  if (!flags['acme-settings'] && absent.length) {
    missingMessage(absent, '<file>').forEach((l) => io.err(l));
    if (needLocal) io.err(localFirst);
    return { code: 1 };
  }
  if (needLocal) { io.err(localFirst); return { code: 1 }; }

  // 2. The owner's three-key block, when given. Nothing is changed unless all of it is valid.
  const given = flags['acme-settings'];
  if (given === true) { io.err('--acme-settings needs a file: --acme-settings=<file>'); return { code: 2 }; }
  if (given) {
    const file = path.resolve(String(given));
    let block;
    try { block = parseAcmeSettings(await readBlock(file, fs)); } catch (e) { io.err(e.message); return { code: 2 }; }
    text = mergeShared(text, block, ACME_KEYS);
    await fs.mkdir(path.dirname(shared), { recursive: true });
    await fs.writeFile(shared, text, { mode: 0o600 });
    await fs.chmod(shared, 0o600); // writeFile's mode only applies to a new file
    await fs.unlink(file);
    log(`Merged ${ACME_KEYS.join(', ')} into ${shared} (mode 600; values not shown) and deleted ${file}.`);
  }

  // 3. The redeemer half, on the local PingFederate. The admin login goes to the child's environment only.
  let admin;
  try { admin = await readPfAdmin({ fs, home }); } catch (e) { io.err(e.message); return { code: 1 }; }
  const secrets = [admin.password, valueOf(text, 'ACME_EXCHANGE_CLIENT_SECRET'), valueOf(text, 'PF_REDEEMER_CLIENT_SECRET')].filter(Boolean);
  const scrub = (s) => secrets.reduce((acc, v) => acc.split(v).join('***'), String(s ?? ''));
  const show = (r) => {
    const out = scrub(r.stdout).trimEnd(); if (out) log(out);
    const err = scrub(r.stderr).trimEnd(); if (err) io.err(err);
  };
  log('', 'Running pingfederate/configure-pf-redeemer.js (local PingFederate only)');
  const r = await exec('node', [sh('pingfederate/configure-pf-redeemer.js')], {
    env: { PF_ADMIN_URL: admin.adminUrl, PF_ADMIN_USER: admin.username, PF_ADMIN_PASSWORD: admin.password, PF_ADMIN_INSECURE_TLS: 'true', PF_SETTINGS_FILE: shared },
  });
  show(r);
  if (r.code !== 0) { io.err(`configure-pf-redeemer.js failed (exit ${r.code}). It is safe to rerun: npm run setup -- --mode=pf-pf`); return { code: 1 }; }

  log('', 'Running doctor (pf-pf)', '');
  const doc = await exec('node', [sh('scripts/doctor.mjs'), '--mode=pf-pf']);
  show(doc);
  log('', 'Next: start the app (npm run build && npm start), open the ID-JAG playground, pick "Acme PingFederate to PingFederate" and sign in as acme-user.',
    'The acme-user password comes from the Acme owner in a separate message. You type it into the sign-in modal; it is never stored.');
  return { code: doc.code === 0 ? 0 : 1, mode: 'pf-pf' };
}
