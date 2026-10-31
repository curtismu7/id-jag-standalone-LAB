// Trusted-IdP registry for "bring your own ID-JAG": outside IdPs whose ID-JAGs our resource
// authorization servers (our resource AS, the PingFederate redeemer) accept.
//
// v2: self-service registration + admin approval. Entries start `pending` and are trusted only once
// `approved`. Every change goes to the audit log. An approved entry that targets the resource AS gets
// a dedicated client there (idp-<id>), removed again when the entry leaves `approved`.
//
// Entries hold no secrets. Persisted as one JSON file under DATA_DIR, written atomically (temp + rename).

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { dataDir } from './workspace.js';
import * as audit from './registry/audit.js';
import { removeClient, setClient } from './registry/clients.js';
import { publicHttpsUrl } from './registry/net.js';

export const TARGETS = ['resource-as', 'pingfederate'];
export const PRODUCTS = ['pingfederate', 'okta', 'auth0', 'keycloak', 'generic'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Changing any of these on an approved entry changes whom we trust: it goes back to review.
const TRUST_FIELDS = ['issuer', 'jwksUrl', 'idJagClientId', 'pfClientId', 'targets', 'scopes'];
const DEFAULT_CLIENT_SCOPE = 'read mcp:invoke'; // what mcp-sample's tools need, when the entry has no scope cap

const file = () => path.resolve(dataDir(), 'trusted-idps.json');
const fail = (status, message) => Object.assign(new Error(message), { status });
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const now = () => new Date().toISOString();

/** v1 entries (no status) were admin-made: approved, or disabled when they were. */
function migrate(e) {
  if (e.status) return e;
  const { enabled, ...rest } = e;
  return {
    product: 'generic', ...rest, status: enabled === false ? 'disabled' : 'approved', owner: 'system',
    createdAt: null, updatedAt: null, reviewedBy: 'system', reviewedAt: null, reviewReason: 'migrated from the v1 registry', secretIssuedAt: null,
  };
}

export function list() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(parsed) ? parsed.map(migrate) : [];
  } catch {
    return []; // no file yet (or unreadable): empty registry
  }
}

export const get = (id) => list().find((e) => e.id === id) || null;
export const trusted = () => list().filter((e) => e.status === 'approved');

// ponytail: sync read-modify-write, one process; a lock is needed if several replicas ever share DATA_DIR.
function save(entries) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, f);
}

/** Normalize and validate the user-editable fields against the other entries (id and issuer unique). */
function validate(input, others) {
  if (!input || typeof input !== 'object') throw fail(400, 'body must be an object');
  const id = str(input.id).toLowerCase();
  if (!SLUG.test(id)) throw fail(400, 'id must be a slug (lowercase letters, digits, dashes)');
  const name = str(input.name);
  if (!name) throw fail(400, 'name is required');
  const product = str(input.product) || 'generic';
  if (!PRODUCTS.includes(product)) throw fail(400, `product must be one of ${PRODUCTS.join(', ')}`);
  // Kept exactly as typed: the issuer is compared byte-for-byte with the ID-JAG's iss.
  const issuer = publicHttpsUrl(input.issuer, 'issuer');
  const jwksUrl = publicHttpsUrl(input.jwksUrl, 'jwksUrl');
  const idJagClientId = str(input.idJagClientId);
  if (!idJagClientId) throw fail(400, 'idJagClientId is required');
  const targets = Array.isArray(input.targets) ? [...new Set(input.targets)] : [];
  if (!targets.length || targets.some((t) => !TARGETS.includes(t))) throw fail(400, `targets must be a non-empty subset of ${TARGETS.join(', ')}`);
  if (typeof input.scopes !== 'undefined' && typeof input.scopes !== 'string') throw fail(400, 'scopes must be a space-separated string');
  if (others.some((e) => e.id === id)) throw fail(400, `id "${id}" is already used`);
  if (others.some((e) => e.issuer === issuer)) throw fail(400, `issuer ${issuer} is already registered`);
  return {
    id, name, product, issuer, jwksUrl, idJagClientId,
    pfClientId: str(input.pfClientId) || config().pfRedeemerClientId,
    scopes: str(input.scopes).split(/\s+/).filter(Boolean).join(' '),
    targets,
  };
}

/** Our client at the resource AS for this entry, when we provision one (not for migrated v1 entries). */
const dedicatedClient = (e) => (e.targets.includes('resource-as') && e.clientId === `idp-${e.id}` ? e.clientId : null);

/** Persist one entry change and audit it. Leaving `approved` removes the entry's client (after the save untrusts it). */
function commit(entries, { action, actor, id, before, after, reason }) {
  save(entries);
  audit.append({ actor, action, id, before, after, ...(reason ? { reason } : {}) });
  if (before?.status === 'approved' && after?.status !== 'approved' && dedicatedClient(before)) removeClient(before.clientId);
  return after;
}

function find(entries, id) {
  const i = entries.findIndex((e) => e.id === id);
  if (i < 0) throw fail(404, `no trusted IdP "${id}"`);
  return i;
}

export async function create(input, actor) {
  const entries = list();
  const v = validate(input, entries);
  const at = now();
  const entry = {
    ...v, clientId: `idp-${v.id}`, status: 'pending', owner: actor, createdAt: at, updatedAt: at,
    reviewedBy: null, reviewedAt: null, reviewReason: null, secretIssuedAt: null,
  };
  return commit([...entries, entry], { action: 'create', actor, id: entry.id, before: null, after: entry });
}

/** Owner (or admin) edit. Trust-field changes, or any edit of a rejected entry, go back to pending. */
export async function update(id, input, actor) {
  const entries = list();
  const i = find(entries, id);
  const before = entries[i];
  const v = validate({ ...input, id }, entries.filter((_, j) => j !== i));
  const trustChanged = TRUST_FIELDS.some((k) => JSON.stringify(v[k]) !== JSON.stringify(before[k]));
  const repend = trustChanged || before.status === 'rejected';
  const after = {
    ...before, ...v, updatedAt: now(),
    ...(repend ? { status: 'pending', reviewedBy: null, reviewedAt: null, reviewReason: null, secretIssuedAt: null } : {}),
  };
  entries[i] = after;
  return commit(entries, { action: 'update', actor, id, before, after });
}

const ACTIONS = { approved: 'approve', rejected: 'reject', disabled: 'disable' };

/**
 * Admin review: approve, reject (reason required) or disable. An approval that names the updatedAt
 * the admin reviewed is refused if the owner edited the entry since.
 */
export async function setStatus(id, status, actor, reasonInput, reviewedVersion) {
  const entries = list();
  const i = find(entries, id);
  const before = entries[i];
  if (!ACTIONS[status]) throw fail(400, 'unknown status');
  if (before.status === status) throw fail(409, `already ${status}`);
  if (status === 'approved' && reviewedVersion !== undefined && reviewedVersion !== before.updatedAt) {
    throw fail(409, 'this IdP changed since you loaded it: reload and review it again');
  }
  const reason = str(reasonInput).slice(0, 500);
  if (status === 'rejected' && !reason) throw fail(400, 'a reason is required to reject');
  const after = { ...before, status, reviewedBy: actor, reviewedAt: now(), reviewReason: reason || null, updatedAt: now() };
  // Provision before trusting: if the clients file cannot be written, the entry stays untrusted.
  // The secret is discarded: the client stays locked until the owner fetches a fresh one.
  if (status === 'approved' && dedicatedClient(after)) setClient(after.clientId, after.scopes || DEFAULT_CLIENT_SCOPE);
  if (status !== 'approved') after.secretIssuedAt = null;
  entries[i] = after;
  return commit(entries, { action: ACTIONS[status], actor, id, before, after, reason });
}

/** Owner withdraws, or an admin deletes. The client goes with it. */
export async function remove(id, actor, action = 'withdraw') {
  const entries = list();
  const i = find(entries, id);
  commit(entries.filter((_, j) => j !== i), { action, actor, id, before: entries[i], after: null });
}

/** Owner only: a fresh client secret, returned once. */
export async function rotateSecret(id, actor) {
  const entries = list();
  const i = find(entries, id);
  const before = entries[i];
  if (before.status !== 'approved' || !dedicatedClient(before)) {
    throw fail(409, 'a client secret exists only for an approved IdP that targets the resource AS');
  }
  const clientSecret = setClient(before.clientId, before.scopes || DEFAULT_CLIENT_SCOPE);
  const after = { ...before, secretIssuedAt: now() };
  entries[i] = after;
  commit(entries, { action: 'rotate-secret', actor, id, before, after });
  return { clientId: before.clientId, clientSecret };
}

/** Approved entry for an issuer (exact match), or null. */
export const findByIssuer = (iss) => trusted().find((e) => e.issuer === iss) || null;
export const findById = (id) => trusted().find((e) => e.id === id) || null;

/** What anyone may see: approved entries, no owner or review details. */
export const publicView = (e) => ({
  id: e.id, name: e.name, product: e.product, issuer: e.issuer, jwksUrl: e.jwksUrl, idJagClientId: e.idJagClientId,
  clientId: e.clientId, pfClientId: e.pfClientId, scopes: e.scopes, targets: e.targets, enabled: true,
});

const trustedFor = (target) => trusted().filter((e) => e.targets.includes(target));

/** What our resource AS reads server-to-server. */
export const resourceAsRegistry = () => ({
  idps: trustedFor('resource-as').map((e) => ({
    id: e.id, issuer: e.issuer, jwksUrl: e.jwksUrl, clientAliases: { [e.idJagClientId]: e.clientId }, scopes: e.scopes,
  })),
});

/** What the PingFederate sync script reads to build IdP connections. */
export const pingfederateRegistry = () => ({
  idps: trustedFor('pingfederate').map((e) => ({
    id: e.id, name: e.name, issuer: e.issuer, jwksUrl: e.jwksUrl, pfClientId: e.pfClientId, scopes: e.scopes,
  })),
});
