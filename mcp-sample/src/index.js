import http from 'node:http';
import { createHandler } from './app.js';

const port = Number(process.env.PORT || 9090);
const asIssuer = (process.env.AS_ISSUER || 'http://localhost:9080').replace(/\/+$/, '');
const config = {
  asIssuer,
  asJwksUrl: process.env.AS_JWKS_URL || `${asIssuer}/jwks`,
  resource: process.env.MCP_RESOURCE || `http://localhost:${port}/mcp`,
};

http.createServer(createHandler(config)).listen(port, () => {
  console.log(`[mcp-sample] ${config.resource} listening on :${port}; trusting ${config.asIssuer} (keys: ${config.asJwksUrl})`);
});
