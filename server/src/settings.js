// Where this app reads its settings. Order, first one wins per key:
//   1. real environment variables
//   2. the shared settings file for every standalone app: STANDALONE_ENV, else ~/Development/.env
//   3. the repo-root .env (kept for existing users)
// process.loadEnvFile never replaces a variable that is already set, so loading in this order gives that precedence.
// Admin and worker credentials never belong in the shared file (they live in ~/.config/demo-kit/provisioning.json).
import os from 'node:os';
import path from 'node:path';

export function sharedEnvPath({ env = process.env, home = os.homedir() } = {}) {
  return env.STANDALONE_ENV || path.join(home, 'Development', '.env');
}

/** Load the shared file, then the repo .env. Returns the files that were found, in load order. */
export function loadSettings({ repoEnv, env = process.env, home = os.homedir(), load = (f) => process.loadEnvFile(f) } = {}) {
  const found = [];
  for (const file of [sharedEnvPath({ env, home }), repoEnv]) {
    if (!file) continue;
    try { load(file); found.push(file); } catch { /* missing or unreadable: skip it */ }
  }
  return found;
}
