import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { config } from './config.js';
import { startHealth } from './health.js';
import { loadSettings } from './settings.js';

// Local runs read the shared settings file (STANDALONE_ENV, else ~/Development/.env), then the repo-root .env.
// Real env vars win over both. Containers get env from compose.
loadSettings({ repoEnv: fileURLToPath(new URL('../../.env', import.meta.url)) });

if (process.env.PF_ADMIN_INSECURE_TLS === 'true' && process.env.NODE_ENV === 'production') {
  console.error('PF_ADMIN_INSECURE_TLS=true is not allowed when NODE_ENV=production; remove it.');
  process.exit(1);
}

const app = createApp(); // registers the demo config, so read config() after it
const { port, host, slug } = config();
const onListen = () => console.log(`[${slug}] listening on http://${host || 'localhost'}:${port}`);
if (host) app.listen(port, host, onListen); else app.listen(port, onListen);
startHealth();
