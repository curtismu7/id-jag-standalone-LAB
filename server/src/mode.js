// The app's mode, mock or live (owner decision 2026-10-31: every standalone app has both, with a visible toggle).
//   mock  every outside call is answered by the in-process mock (mock/index.js); the netguard refuses everything else.
//   live  today's behaviour: the real PingFederate servers, resource AS and MCP server named in the environment.
// Which one runs, first match wins: the choice made with the toggle (DATA_DIR/mode.json, so it survives a restart),
// then MODE in the environment (the shell, the repo .env, or the family's shared settings file), then mock.
// This file imports nothing from the app, so config.js can import it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { mockEnv } from './mock/env.js';

export const MODES = ['mock', 'live'];
export const DEFAULT_SHARED_FILE = path.join(os.homedir(), 'Development', '.env');

const val = (env, k) => String(env[k] ?? '').trim();

/**
 * The family's one settings file: STANDALONE_ENV, else ~/Development/.env. Only MODE is taken from it (this app's other
 * settings stay in its own .env and the environment), and a MODE already in the environment wins. Never throws.
 */
export function loadSharedMode({ env = process.env, file = val(env, 'STANDALONE_ENV') || DEFAULT_SHARED_FILE } = {}) {
  if (val(env, 'MODE')) return;
  try {
    const mode = String(parseEnv(fs.readFileSync(file, 'utf8')).MODE ?? '').trim().toLowerCase();
    if (MODES.includes(mode)) env.MODE = mode;
  } catch { /* no shared file */ }
}

// What the toggle chose, read once per process (undefined = not read yet, null = nothing chosen).
let chosen;
const modeFile = () => path.join(path.resolve(val(process.env, 'DATA_DIR') || '.data'), 'mode.json');
function readChosen() {
  if (chosen === undefined) {
    try {
      const m = JSON.parse(fs.readFileSync(modeFile(), 'utf8'))?.mode;
      chosen = MODES.includes(m) ? m : null;
    } catch { chosen = null; }
  }
  return chosen;
}

export function currentMode() {
  const fromEnv = String(process.env.MODE ?? '').trim().toLowerCase();
  return readChosen() ?? (MODES.includes(fromEnv) ? fromEnv : 'mock');
}
export const isMock = () => currentMode() === 'mock';

/** The environment the app reads its settings from: the real one in live mode, the mock's in mock mode. */
export const runtimeEnv = () => (isMock() ? mockEnv() : process.env);

const LIVE_AS = ['PF_URL', 'PF_EXCHANGE_CLIENT_ID', 'PF_EXCHANGE_CLIENT_SECRET'];
const LIVE_PF = ['PF_URL', 'ACME_PF_URL', 'ACME_EXCHANGE_CLIENT_ID', 'ACME_EXCHANGE_CLIENT_SECRET', 'PF_REDEEMER_CLIENT_SECRET'];

/** Live can be selected when PingFederate is configured for "PingFederate to resource AS", or for the Acme pairing. */
export function liveReadiness(env = process.env) {
  const missing = (keys) => keys.filter((k) => !val(env, k));
  const as = missing(LIVE_AS);
  const pf = missing(LIVE_PF);
  return { ready: !as.length || !pf.length, missing: as };
}

/** Writes DATA_DIR/mode.json (mode 600) atomically. */
function persist(mode) {
  const f = modeFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ mode })}\n`, { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/** Choose the mode. Live needs the live settings; without them this throws {code:'live_not_configured', missing}. */
export function setMode(next) {
  if (!MODES.includes(next)) throw Object.assign(new Error('mode must be mock or live'), { code: 'invalid_mode' });
  if (next === 'live') {
    const { ready, missing } = liveReadiness();
    if (!ready) {
      throw Object.assign(new Error(`Live needs PingFederate settings first: set ${missing.join(', ')} in .env, then restart the server`), { code: 'live_not_configured', missing });
    }
  }
  persist(next);
  chosen = next;
  return next;
}

/** Tests only: forget the cached choice (and so re-read DATA_DIR/mode.json and MODE). */
export const _resetMode = () => { chosen = undefined; };
/** Tests only: run as `mode` without touching any file. */
export const _forceMode = (mode) => { chosen = mode; };
