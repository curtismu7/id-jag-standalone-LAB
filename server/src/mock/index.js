// The mock world: a PingFederate, an outside "Acme" PingFederate, a resource authorization server and an MCP server, all
// in this process, reached through fetch(url) like the real ones (netguard.js hands them the calls). Nothing here opens a
// socket. Its tokens and responses are labelled as simulated (mock: true in every token, x-simulated on every response).

import { createHash } from 'node:crypto';
import { demoJson } from '../demoJson.js';
import { CLIENT_IDS, MCP_RESOURCE, MOCK_ORIGINS, MOCK_USER, ORIGINS, PF_ADMIN_USER, SECRETS } from './env.js';
import { listClients, resetClients } from './clients.js';
import { createMockMcp } from './mcp.js';
import { createMockPf } from './pf.js';
import { createMockResourceAs } from './resourceAs.js';
import { createGatewayWorld } from './gatewayWorld.js';

export { MOCK_ORIGINS, MOCK_USER, ORIGINS };

// The trusted IdPs the resource AS accepts come from the app (idJagPlayground registers them), so approving one changes what it trusts.
let registrySource = () => ({ idps: [] });
export const setRegistrySource = (fn) => { registrySource = fn; };

function createWorld() {
  const scope = 'read mcp:invoke';
  const pf = createMockPf({
    origin: ORIGINS.pf, label: 'pf', user: MOCK_USER, validatorId: demoJson().provider.pfValidatorId,
    admin: { user: PF_ADMIN_USER, password: SECRETS.pfAdmin },
    clients: { [CLIENT_IDS.exchange]: { secret: SECRETS.exchange, scope, idJagClientId: CLIENT_IDS.resourceAs }, [CLIENT_IDS.redeemer]: { secret: SECRETS.redeemer, scope: '' } },
  });
  const acme = createMockPf({
    origin: ORIGINS.acme, label: 'acme', user: MOCK_USER, validatorId: 'acmeValidator', admin: { user: PF_ADMIN_USER, password: SECRETS.pfAdmin },
    clients: { [CLIENT_IDS.acme]: { secret: SECRETS.acme, scope, idJagClientId: CLIENT_IDS.redeemer } },
  });
  pf.trust(ORIGINS.acme, acme.publicKey); // pf-pf mode: the redeemer accepts the ID-JAGs Acme issues
  const services = new Map();
  const base = { client_id: CLIENT_IDS.resourceAs, client_secret_hash: createHash('sha256').update(SECRETS.resourceAs).digest('hex'), scope };
  const rs = createMockResourceAs({
    origin: ORIGINS.as, resource: MCP_RESOURCE,
    clients: () => [base, ...listClients()],
    idps: () => registrySource().idps,
    // An IdP's keys are readable only if it lives in the mock world; any other host is outside the simulation.
    async fetchJwks(url) {
      const res = MOCK_ORIGINS.has(new URL(url).origin) ? await fetchMock(url) : null;
      if (!res || res.status !== 200) throw new Error('mock mode cannot read keys from outside the simulation');
      return res.json();
    },
  });
  const mcp = createMockMcp({ origin: ORIGINS.mcp, asIssuer: ORIGINS.as, asKey: rs.publicKey, resource: MCP_RESOURCE });
  const gateway = createGatewayWorld(); // gateway redeem mode: exchange issuer, partner issuer, target issuer, target API
  for (const s of [pf, acme, rs, mcp, ...gateway.services]) services.set(s.origin, s.handle);

  async function fetchMock(url, init) {
    const handle = services.get(new URL(url).origin);
    if (!handle) throw new TypeError(`no mock server at ${url}`);
    const res = await handle(url, init);
    res.headers.set('x-simulated', 'mock');
    return res;
  }
  return {
    fetch: fetchMock,
    adminSend: pf.adminSend,
    gateway,
    reset() { pf.reset(); acme.reset(); rs.reset(); resetClients(); gateway.reset(); },
  };
}

let world;
export const mockWorld = () => (world ??= createWorld());
export const mockFetch = (url, init) => mockWorld().fetch(url, init);
/** The gateway redeem mode's mock servers (mock/gatewayWorld.js). */
export const gatewayWorld = () => mockWorld().gateway;
/** The mock PingFederate's admin API, shaped for pfAdmin's `send`. */
export const mockAdminSend = (url, opts) => mockWorld().adminSend(url, opts);
export const resetMock = () => { if (world) world.reset(); };
/** Tests only: drop the world (new keys, no users, no history). */
export const _dropMockWorld = () => { world = undefined; };
