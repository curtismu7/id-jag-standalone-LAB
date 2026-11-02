import http from 'node:http';
import { createHandler } from './app.js';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { loadSettings } from './settings.js';

loadSettings({ repoEnv: fileURLToPath(new URL('../../.env', import.meta.url)) });

const config = loadConfig();
if (!config.clients.length) console.warn('[resource-as] no clients (CLIENTS_FILE or RESOURCE_AS_CLIENT_SECRET): every redemption will be refused');
if (!config.idps.length && !config.registry) console.warn('[resource-as] no trusted IdPs (TRUSTED_IDPS_FILE / TRUSTED_IDPS_REGISTRY_URL)');
if (config.registry && !config.registry.token) console.warn('[resource-as] ID_JAG_REGISTRY_TOKEN is unset: the Trusted IdPs registry will refuse every read');

http.createServer(createHandler(config)).listen(config.port, () => {
  console.log(`[resource-as] ${config.issuer} listening on :${config.port}; ${config.clients.length} client(s), `
    + `${config.idps.length} IdP(s) from file, registry ${config.registry ? 'on' : 'off'}; `
    + `resources: ${config.acceptedResources.join(', ')}`);
});
