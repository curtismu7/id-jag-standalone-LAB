// The username last used to sign in at PingFederate, kept on the data volume (DATA_DIR, survives restarts) and sent as
// `login_hint` when no better source exists (the issuer sign-in prefers the app user's own username). A username is not
// a secret; the password is never stored. Only a COMPLETED sign-in saves it, so a typo never becomes the hint.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { dataDir } from '../workspace.js';

const VALID = /^[ -~]{1,256}$/; // printable ASCII, the same cap the sign-in form uses
const file = () => path.join(dataDir(), 'login-hint.json');

export const validHint = (v) => typeof v === 'string' && VALID.test(v);

export function readHint() {
  try {
    const v = JSON.parse(fs.readFileSync(file(), 'utf8'))?.username;
    return validHint(v) ? v : null;
  } catch { return null; }
}

export function saveHint(username) {
  if (!validHint(username) || readHint() === username) return;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ username }), { mode: 0o600 });
  } catch (err) { console.warn(`[${config().slug}] could not remember the sign-in username: ${err.code || err.name}`); }
}
