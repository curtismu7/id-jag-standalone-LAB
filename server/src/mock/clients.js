// The dedicated clients at the mock resource AS, one per approved Trusted IdP (idp-<id>). The mock's counterpart of
// registry/clients.js: only the sha256 of a secret is kept, and the secret is returned once to the caller.
import { createHash } from 'node:crypto';
import { rand } from './util.js';

const clients = new Map();

export function setClient(clientId, scope) {
  const secret = rand(32);
  clients.set(clientId, { client_id: clientId, client_secret_hash: createHash('sha256').update(secret).digest('hex'), scope });
  return secret;
}
export const removeClient = (clientId) => { clients.delete(clientId); };
export const listClients = () => [...clients.values()];
export const resetClients = () => clients.clear();
