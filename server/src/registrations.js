// Self-registration with admin approval, for the pi.flow sign-in (users live in PingFederate's kit credential
// validator). A request holds the user's chosen password only until an admin decides: it is encrypted at rest
// (AES-256-GCM, key from REGISTRATION_KEY) and wiped on approve, reject or expiry. Approval creates the user through the
// active IdP adapter (idp.users). The same email rules as sign-in apply, so nothing is approved that sign-in would refuse.
// Persisted as one JSON file under DATA_DIR, written atomically; every decision goes to the audit log.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { allowedDomains, checkEmail } from './auth/emailRules.js';
import { config } from './config.js';
import { runtimeEnv } from './mode.js';
import { dataDir } from './workspace.js';
import { activeAdapter } from './idp/index.js';
import * as audit from './registry/audit.js';

export const TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD = 12;
const MAX_PASSWORD = 128;

const file = () => path.resolve(dataDir(), 'registrations.json');
const fail = (status, message) => Object.assign(new Error(message), { status });
const key = () => {
  const k = String(runtimeEnv().REGISTRATION_KEY ?? '').trim();
  if (k.length < 16) throw fail(503, 'Registration is not set up: REGISTRATION_KEY (16+ characters) is missing');
  return crypto.createHash('sha256').update(k).digest();
};

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function open(sealed) {
  const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

function read() {
  try { const p = JSON.parse(fs.readFileSync(file(), 'utf8')); return Array.isArray(p) ? p : []; } catch { return []; }
}
// ponytail: sync read-modify-write, one process; a lock is needed if several replicas share DATA_DIR.
function save(entries) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, f);
}

/** Pending requests past their TTL become `expired` and lose their password. Returns the (possibly rewritten) list. */
function sweep(entries) {
  let changed = false;
  for (const e of entries) {
    if (e.status === 'pending' && Date.now() - Date.parse(e.createdAt) > TTL_MS) {
      Object.assign(e, { status: 'expired', passwordSealed: null, decidedAt: new Date().toISOString(), decidedBy: 'system' });
      changed = true;
    }
  }
  if (changed) save(entries);
  return entries;
}

const view = ({ passwordSealed: _p, ...rest }) => rest;

export const list = () => sweep(read()).map(view);

/** A new pending request. Throws {status} with a message safe to show the requester. */
export function create({ email, password }) {
  key(); // fail early (503) when the encryption key is missing
  const addr = String(email ?? '').trim().toLowerCase();
  // email_verified is the admin's job here: approval is the verification. Everything else is sign-in's own rule set.
  const bad = checkEmail({ email: addr, email_verified: true }, allowedDomains());
  if (bad) throw fail(400, bad.message);
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw fail(400, `Choose a password of ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`);
  }
  const entries = sweep(read());
  if (entries.some((e) => e.email === addr && ['pending', 'approved'].includes(e.status))) {
    throw fail(409, 'That address already has a pending request or an account.');
  }
  const entry = {
    id: crypto.randomUUID(), email: addr, status: 'pending', createdAt: new Date().toISOString(),
    decidedAt: null, decidedBy: null, reason: null, passwordSealed: seal(password),
  };
  save([...entries, entry]);
  audit.append({ actor: addr, action: 'registration.request', target: entry.id, email: addr });
  return view(entry);
}

function pending(entries, id) {
  const e = entries.find((x) => x.id === id);
  if (!e) throw fail(404, `no registration request "${id}"`);
  if (e.status !== 'pending') throw fail(409, `That request is already ${e.status}.`);
  return e;
}

/** Create the user in PingFederate, then mark approved and wipe the password. A PingFederate failure leaves it pending. */
export async function approve(id, admin) {
  const entries = sweep(read());
  const e = pending(entries, id);
  const { users } = activeAdapter();
  if (!users) throw fail(404, 'This sign-in provider has no self-registration.');
  await users.add(e.email, open(e.passwordSealed));
  Object.assign(e, { status: 'approved', passwordSealed: null, decidedAt: new Date().toISOString(), decidedBy: admin });
  save(entries);
  audit.append({ actor: admin, action: 'registration.approve', target: id, email: e.email });
  return view(e);
}

export function reject(id, admin, reason) {
  const entries = sweep(read());
  const e = pending(entries, id);
  Object.assign(e, {
    status: 'rejected', passwordSealed: null, decidedAt: new Date().toISOString(), decidedBy: admin,
    reason: typeof reason === 'string' ? reason.trim().slice(0, 300) || null : null,
  });
  save(entries);
  audit.append({ actor: admin, action: 'registration.reject', target: id, email: e.email, reason: e.reason });
  return view(e);
}
