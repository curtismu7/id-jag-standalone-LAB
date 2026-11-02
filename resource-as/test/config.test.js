import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { newRsaKey } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ras-config-'));
const writeJson = (dir, name, data) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
};
const HASH = 'a'.repeat(64);

describe('loadConfig', () => {
  it('generates a signing key once, 0600, and reuses it on the next start', () => {
    const dir = tmp();
    const first = loadConfig({ DATA_DIR: dir });
    const keyFile = path.join(dir, 'signing-key.pem');
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    const second = loadConfig({ DATA_DIR: dir });
    expect(second.signingKey.export({ format: 'jwk' }).n).toBe(first.signingKey.export({ format: 'jwk' }).n);
  });

  it('loads the key from SIGNING_KEY_PEM_FILE instead of generating one', () => {
    const dir = tmp();
    const key = newRsaKey();
    const pemFile = path.join(dir, 'key.pem');
    fs.writeFileSync(pemFile, key.export({ type: 'pkcs8', format: 'pem' }));
    const cfg = loadConfig({ DATA_DIR: path.join(dir, 'data'), SIGNING_KEY_PEM_FILE: pemFile });
    expect(cfg.signingKey.export({ format: 'jwk' }).n).toBe(key.export({ format: 'jwk' }).n);
    expect(fs.existsSync(path.join(dir, 'data', 'signing-key.pem'))).toBe(false);
  });

  it('reads clients, trusted IdPs and the registry settings', () => {
    const dir = tmp();
    const cfg = loadConfig({
      DATA_DIR: dir,
      ISSUER: 'https://as.example.test/',
      ACCEPTED_RESOURCES: 'https://a.example/mcp, https://b.example/mcp',
      ACCESS_TOKEN_TTL: '600',
      ALLOW_PUBLIC_CLIENTS: 'true',
      CLIENTS_FILE: writeJson(dir, 'clients.json', [{ client_id: 'agent-1', client_secret_hash: HASH, scope: 'read' }]),
      TRUSTED_IDPS_FILE: writeJson(dir, 'idps.json', [{ issuer: 'https://pf.example', jwksUrl: 'https://pf.example/jwks', clientAliases: { pf: 'agent-1' }, scopes: 'read' }]),
      TRUSTED_IDPS_REGISTRY_URL: 'https://playground.example/api/id-jag-playground/trusted-idps/registry',
      ID_JAG_REGISTRY_TOKEN: 'registry-token',
      REGISTRY_CA_FILE: '/ca.pem',
    });
    expect(cfg).toMatchObject({
      issuer: 'https://as.example.test',
      acceptedResources: ['https://a.example/mcp', 'https://b.example/mcp'],
      accessTokenTtl: 600,
      allowPublicClients: true,
      clients: [{ client_id: 'agent-1', client_secret_hash: HASH, scope: 'read' }],
      idps: [{ id: 'https://pf.example', issuer: 'https://pf.example', clientAliases: { pf: 'agent-1' }, scopes: 'read' }],
      registry: { token: 'registry-token', caFile: '/ca.pem' },
      replayFile: path.join(dir, 'replay.json'),
    });
  });

  it('adds one confidential client from RESOURCE_AS_CLIENT_ID / _SECRET, hashed', () => {
    const { clients } = loadConfig({ DATA_DIR: tmp(), RESOURCE_AS_CLIENT_SECRET: 's3cret' });
    expect(clients).toEqual([{ client_id: 'id-jag-playground', scope: 'read mcp:invoke',
      client_secret_hash: createHash('sha256').update('s3cret').digest('hex') }]);
    expect(JSON.stringify(clients)).not.toContain('s3cret');
    expect(loadConfig({ DATA_DIR: tmp(), RESOURCE_AS_CLIENT_ID: 'agent-1', RESOURCE_AS_CLIENT_SECRET: 'x', RESOURCE_AS_CLIENT_SCOPE: 'read' }).clients[0])
      .toMatchObject({ client_id: 'agent-1', scope: 'read' });
  });

  it('defaults to confidential clients only', () => {
    expect(loadConfig({ DATA_DIR: tmp() }).allowPublicClients).toBe(false);
  });

  it('refuses a client whose secret hash is not sha256 hex', () => {
    const dir = tmp();
    const CLIENTS_FILE = writeJson(dir, 'c.json', [{ client_id: 'x', client_secret_hash: 'plaintext' }]);
    expect(() => loadConfig({ DATA_DIR: dir, CLIENTS_FILE })).toThrow(/client_secret_hash/);
  });

  it('refuses a trusted IdP entry without issuer or jwksUrl', () => {
    const dir = tmp();
    const TRUSTED_IDPS_FILE = writeJson(dir, 'i.json', [{ issuer: 'https://pf.example' }]);
    expect(() => loadConfig({ DATA_DIR: dir, TRUSTED_IDPS_FILE })).toThrow(/jwksUrl/);
  });
});

describe('the kit\'s own trust list and PingFederate certificate', () => {
  it('reads the trust list from the kit\'s own registry at APP_ORIGIN when nothing else names it', () => {
    const dir = tmp();
    expect(loadConfig({ DATA_DIR: dir }).registry.url).toBe('http://localhost:4720/api/id-jag-playground/trusted-idps/registry');
    expect(loadConfig({ DATA_DIR: dir, APP_ORIGIN: 'http://localhost:4724/', ID_JAG_REGISTRY_TOKEN: 't' }).registry)
      .toEqual({ url: 'http://localhost:4724/api/id-jag-playground/trusted-idps/registry', token: 't', caFile: undefined });
  });
  it('an explicit TRUSTED_IDPS_REGISTRY_URL wins, and a TRUSTED_IDPS_FILE alone means no registry', () => {
    const dir = tmp();
    expect(loadConfig({ DATA_DIR: dir, TRUSTED_IDPS_REGISTRY_URL: 'https://r.example/x', APP_ORIGIN: 'http://localhost:1' }).registry.url).toBe('https://r.example/x');
    const file = writeJson(dir, 'idps.json', [{ issuer: 'https://pf.example', jwksUrl: 'https://pf.example/jwks' }]);
    expect(loadConfig({ DATA_DIR: dir, TRUSTED_IDPS_FILE: file }).registry).toBeUndefined();
  });
  it('PF_CA_FILE becomes a CA for PF_URL\'s origin only; unset, or unreadable (a container with the host\'s path), it is off', () => {
    const dir = tmp();
    const ca = path.join(dir, 'ca.pem');
    fs.writeFileSync(ca, 'PEM');
    expect(loadConfig({ DATA_DIR: dir, PF_URL: 'https://127.0.0.1:4732', PF_CA_FILE: ca }).pfCa).toEqual({ origin: 'https://127.0.0.1:4732', ca: Buffer.from('PEM') });
    expect(loadConfig({ DATA_DIR: dir, PF_URL: 'https://127.0.0.1:4732' }).pfCa).toBeUndefined();
    expect(loadConfig({ DATA_DIR: dir, PF_CA_FILE: ca }).pfCa).toBeUndefined();
    expect(loadConfig({ DATA_DIR: dir, PF_URL: 'https://127.0.0.1:4732', PF_CA_FILE: '/Users/someone/pf-ca.pem' }).pfCa).toBeUndefined();
  });
});
