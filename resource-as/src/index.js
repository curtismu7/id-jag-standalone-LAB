import http from 'node:http';
import { createHandler } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
if (!config.clients.length) console.warn('[resource-as] no clients (CLIENTS_FILE or RESOURCE_AS_CLIENT_SECRET): every redemption will be refused');
if (!config.idps.length && !config.registry) console.warn('[resource-as] no trusted IdPs (TRUSTED_IDPS_FILE / TRUSTED_IDPS_REGISTRY_URL)');

http.createServer(createHandler(config)).listen(config.port, () => {
  console.log(`[resource-as] ${config.issuer} listening on :${config.port}; ${config.clients.length} client(s), `
    + `${config.idps.length} IdP(s) from file, registry ${config.registry ? 'on' : 'off'}; `
    + `resources: ${config.acceptedResources.join(', ')}`);
});
