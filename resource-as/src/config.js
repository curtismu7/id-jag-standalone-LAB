// Environment + files -> createHandler config. Fails fast on bad input.
import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeIdps } from './trusted-idps.js';

const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

function readJsonArray(file, name) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`${name} must hold a JSON array`);
  return data;
}

function checkClient(c) {
  if (!c || typeof c.client_id !== 'string' || !c.client_id) throw new Error('CLIENTS_FILE: every client needs a client_id');
  if (c.client_secret !== undefined) throw new Error(`CLIENTS_FILE: store client_secret_hash (sha256 hex) for ${c.client_id}, not client_secret`);
  if (c.client_secret_hash !== undefined && !/^[0-9a-f]{64}$/i.test(c.client_secret_hash)) {
    throw new Error(`CLIENTS_FILE: client_secret_hash for ${c.client_id} must be the sha256 hex of the secret`);
  }
  return {
    client_id: c.client_id,
    ...(c.client_secret_hash ? { client_secret_hash: c.client_secret_hash } : {}),
    scope: typeof c.scope === 'string' ? c.scope : '',
  };
}

/**
 * One client straight from the environment, named like the playground server's settings so one
 * .env gives both sides the same secret (docker compose). The secret is hashed here, never stored.
 */
function envClient(env) {
  if (!env.RESOURCE_AS_CLIENT_SECRET) return [];
  return [{
    client_id: env.RESOURCE_AS_CLIENT_ID || 'id-jag-playground',
    client_secret_hash: createHash('sha256').update(env.RESOURCE_AS_CLIENT_SECRET).digest('hex'),
    scope: env.RESOURCE_AS_CLIENT_SCOPE || 'read mcp:invoke',
  }];
}

/** CLIENTS_FILE plus the env client. Throws on a bad file. */
export const loadClients = (env) => [...(env.CLIENTS_FILE ? readJsonArray(env.CLIENTS_FILE, 'CLIENTS_FILE').map(checkClient) : []), ...envClient(env)];

function loadIdps(file) {
  const raw = readJsonArray(file, 'TRUSTED_IDPS_FILE');
  const idps = normalizeIdps(raw);
  if (idps.length !== raw.length) throw new Error('TRUSTED_IDPS_FILE: every entry needs issuer and jwksUrl');
  return idps;
}

/** SIGNING_KEY_PEM_FILE, else DATA_DIR/signing-key.pem, generated (0600) on first start. */
function loadSigningKey(pemFile, dataDir) {
  const file = pemFile || path.join(dataDir, 'signing-key.pem');
  let key;
  if (pemFile || fs.existsSync(file)) {
    key = createPrivateKey(fs.readFileSync(file));
  } else {
    key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    fs.writeFileSync(file, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('signing key must be an RSA private key (RS256)');
  return key;
}

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 9080);
  const dataDir = path.resolve(env.DATA_DIR || '.data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const accessTokenTtl = Number(env.ACCESS_TOKEN_TTL || 3600);
  if (!Number.isInteger(accessTokenTtl) || accessTokenTtl <= 0) throw new Error('ACCESS_TOKEN_TTL must be a positive integer (seconds)');
  return {
    port,
    issuer: (env.ISSUER || `http://localhost:${port}`).replace(/\/+$/, ''),
    acceptedResources: list(env.ACCEPTED_RESOURCES || 'http://localhost:9090/mcp'),
    accessTokenTtl,
    allowPublicClients: env.ALLOW_PUBLIC_CLIENTS === 'true',
    clients: loadClients(env),
    // Re-read per token request: the playground provisions idp-<id> clients into CLIENTS_FILE at runtime.
    reloadClients: env.CLIENTS_FILE ? () => loadClients(env) : undefined,
    idps: env.TRUSTED_IDPS_FILE ? loadIdps(env.TRUSTED_IDPS_FILE) : [],
    registry: env.TRUSTED_IDPS_REGISTRY_URL
      ? { url: env.TRUSTED_IDPS_REGISTRY_URL, token: env.ID_JAG_REGISTRY_TOKEN, caFile: env.REGISTRY_CA_FILE }
      : undefined,
    signingKey: loadSigningKey(env.SIGNING_KEY_PEM_FILE, dataDir),
    replayFile: path.join(dataDir, 'replay.json'),
  };
}
