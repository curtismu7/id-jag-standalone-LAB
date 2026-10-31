// Dedicated clients at our resource AS, one per approved IdP (idp-<id>). Written into resource-as's
// CLIENTS_FILE (RESOURCE_AS_CLIENTS_FILE here, a shared volume): only the sha256 of the secret is
// stored; the secret itself is returned once to the caller and never kept. Other entries are untouched.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMock } from '../mode.js';
import * as mockClients from '../mock/clients.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const file = () => String(process.env.RESOURCE_AS_CLIENTS_FILE || '').trim();
// Mock mode keeps the clients in the mock resource AS (in memory), never in the live CLIENTS_FILE.

function read(f) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
  }
  if (!Array.isArray(parsed)) throw fail(500, 'RESOURCE_AS_CLIENTS_FILE is not a JSON array; fix it by hand before approving');
  return parsed;
}

function write(f, clients) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clients, null, 2));
  fs.renameSync(tmp, f); // atomic: resource-as never reads a half-written file
}

/** Create or replace a client with a fresh random secret. Returns the secret: show it once, store it nowhere. */
export function setClient(clientId, scope) {
  if (isMock()) return mockClients.setClient(clientId, scope);
  const f = file();
  if (!f) throw fail(409, 'RESOURCE_AS_CLIENTS_FILE is not set: this server cannot provision clients at the resource AS');
  const secret = crypto.randomBytes(32).toString('base64url');
  const client_secret_hash = crypto.createHash('sha256').update(secret).digest('hex');
  write(f, [...read(f).filter((c) => c?.client_id !== clientId), { client_id: clientId, client_secret_hash, scope }]);
  return secret;
}

export function removeClient(clientId) {
  if (isMock()) return mockClients.removeClient(clientId);
  const f = file();
  if (!f) return;
  const all = read(f);
  if (all.some((c) => c?.client_id === clientId)) write(f, all.filter((c) => c?.client_id !== clientId));
}
