// Settings for `npm start -w <service>`: the family's shared file (STANDALONE_ENV, else ~/Development/.env), then the repo-root
// .env. A real environment variable always wins (process.loadEnvFile never replaces one), so docker compose is unaffected.
// Same order as server/src/settings.js; a copy because the service images contain no other workspace.
import os from 'node:os';
import path from 'node:path';

export function loadSettings({ repoEnv, env = process.env, home = os.homedir(), load = (f) => process.loadEnvFile(f) } = {}) {
  const found = [];
  for (const file of [env.STANDALONE_ENV || path.join(home, 'Development', '.env'), repoEnv]) {
    if (!file) continue;
    try { load(file); found.push(file); } catch { /* missing or unreadable: skip it */ }
  }
  return found;
}
