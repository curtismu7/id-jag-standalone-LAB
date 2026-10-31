// The PingFederate admin API client: the only code in the app that talks to it (design 7.2). Full admin
// credentials live here, so every call passes a method+path allowlist before any network I/O, validator writes
// are checked against the document just fetched, and repeated auth failures latch the module shut.
// Settings: PF_ADMIN_URL, PF_ADMIN_USER (default administrator), PF_ADMIN_PASSWORD, PF_ADMIN_INSECURE_TLS=true (local only).
// Errors carry { pfAdmin: true, code, status } and a message that never holds the URL, user or password.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { demoJson } from '../demoJson.js';
import { isMock } from '../mode.js';
import { mockAdminSend } from '../mock/index.js';
import { guardSocket } from '../outbound.js';
import { mockEnv } from '../mock/env.js';
import { dataDir } from '../workspace.js';

export const LATCH_AFTER = 2;
export const LATCH_MS = 15 * 60 * 1000;

const err = (code, status, message) => Object.assign(new Error(message), { pfAdmin: true, code, status });
const clean = (v) => String(v ?? '').trim();

/** The network hop: resolves { status, body }. Rejects with the raw transport error (the caller scrubs it). */
export function httpSend(url, { method, headers, body, insecureTls }) {
  guardSocket(url); // mock mode: refused here (the mock mode client never gets this far)
  const target = new URL(url);
  const lib = target.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(target, { method, headers, timeout: 10_000, rejectUnauthorized: !insecureTls }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let j = null; try { j = out ? JSON.parse(out) : null; } catch { j = null; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const usernameOf = (r) => String(r?.fields?.find((f) => f.name === 'Username')?.value ?? '').toLowerCase();
const usersTable = (v) => v?.configuration?.tables?.find((t) => t.name === 'Users');

/** Emails of users this app created (approved registrations); the only rows a removal may touch. */
function appAddedEmails() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dataDir(), 'registrations.json'), 'utf8'));
    return new Set(list.filter((r) => r.status === 'approved' && r.email).map((r) => String(r.email).toLowerCase()));
  } catch { return new Set(); }
}

/**
 * Add-only check of a validator PUT against the document fetched for it (design 7.2 item 1). Allowed: one appended
 * row with everything else unchanged, or the removal of rows the app added (never the first row or an ADMIN_EMAILS user).
 */
export function checkValidatorWrite(fetched, body, { adminEmails = [], appAdded = new Set() } = {}) {
  const no = (why) => err('pf_admin_forbidden', 403, `PingFederate admin write refused: ${why}`);
  const ft = usersTable(fetched);
  const bt = usersTable(body);
  if (!ft || !bt) throw no('no Users table');
  const strip = (v) => ({ ...v, configuration: { ...v.configuration, tables: v.configuration.tables.map((t) => (t.name === 'Users' ? { ...t, rows: [] } : t)) } });
  if (!isDeepStrictEqual(strip(fetched), strip(body))) throw no('only the Users table may change');
  const F = ft.rows;
  const B = bt.rows;
  if (B.length >= F.length) {
    if (B.length > F.length + 1) throw no('more than one row added');
    if (!F.every((r, i) => isDeepStrictEqual(r, B[i]))) throw no('an existing row changed');
    return; // unchanged, or exactly one row appended
  }
  // Removal: B must be F minus some rows, in order.
  let j = 0;
  const removed = [];
  F.forEach((r, i) => {
    if (j < B.length && isDeepStrictEqual(r, B[j])) j += 1; else removed.push({ r, i });
  });
  if (j !== B.length) throw no('an existing row changed');
  for (const { r, i } of removed) {
    const u = usernameOf(r);
    if (i === 0) throw no('the anchor user is never removed');
    if (adminEmails.includes(u)) throw no('an admin user is never removed');
    if (!appAdded.has(u)) throw no('only users this app added may be removed');
  }
}

/** A client over `send`; tests pass a fake `send` and clock, the app uses the default instance. */
export function createPfAdmin({ env = process.env, send = httpSend, now = Date.now, appAdded = appAddedEmails } = {}) {
  let fails = 0;
  let lockedUntil = 0;
  const snapshots = new Map(); // validator path -> the document its last GET returned (single use)

  const configured = () => Boolean(clean(env.PF_ADMIN_URL) && clean(env.PF_ADMIN_PASSWORD));
  const latch = () => ({ locked: now() < lockedUntil, until: lockedUntil });

  function allowed(method, p) {
    const vp = `/passwordCredentialValidators/${demoJson().provider.pfValidatorId}`;
    if (p === vp && (method === 'GET' || method === 'PUT')) return true;
    const cid = clean(env.PF_EXCHANGE_CLIENT_ID);
    return method === 'GET' && Boolean(cid) && (p === `/oauth/clients/${encodeURIComponent(cid)}` || p === `/oauth/clients/${cid}`);
  }

  async function call(method, p, body) {
    if (!allowed(method, p)) throw err('pf_admin_forbidden', 403, `PingFederate admin call refused: ${method} is not allowed on that path`);
    if (now() < lockedUntil) throw err('pf_admin_locked', 503, 'PingFederate admin access is paused after repeated credential failures; try again later');
    if (clean(env.PF_ADMIN_INSECURE_TLS) === 'true' && env.NODE_ENV === 'production') throw err('pf_admin_forbidden', 403, 'PF_ADMIN_INSECURE_TLS is not allowed in production');
    if (method === 'PUT') {
      const fetched = snapshots.get(p);
      snapshots.delete(p);
      if (!fetched) throw err('pf_admin_forbidden', 403, 'PingFederate admin write refused: fetch the validator first');
      checkValidatorWrite(fetched, body, {
        adminEmails: clean(env.ADMIN_EMAILS).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean), appAdded: appAdded(),
      });
    }
    const auth = Buffer.from(`${clean(env.PF_ADMIN_USER) || 'administrator'}:${clean(env.PF_ADMIN_PASSWORD)}`).toString('base64');
    let res;
    try {
      res = await send(`${clean(env.PF_ADMIN_URL).replace(/\/$/, '')}/pf-admin-api/v1${p}`, {
        method, insecureTls: clean(env.PF_ADMIN_INSECURE_TLS) === 'true', body: body ? JSON.stringify(body) : undefined,
        headers: { Authorization: `Basic ${auth}`, 'X-XSRF-Header': 'PingFederate', 'Content-Type': 'application/json' },
      });
    } catch (e) {
      const why = e?.code || (e?.message === 'timed out' ? 'timed out' : 'network error');
      throw err('pf_admin_unreachable', 502, `PingFederate admin API unreachable: ${why}`);
    }
    if (res.status === 401 || res.status === 403) {
      fails += 1;
      if (fails >= LATCH_AFTER) lockedUntil = now() + LATCH_MS;
    } else {
      fails = 0;
      if (res.status >= 200 && res.status < 300) lockedUntil = 0;
    }
    if (method === 'GET' && res.status === 200 && p.startsWith('/passwordCredentialValidators/')) snapshots.set(p, JSON.parse(JSON.stringify(res.body)));
    return res;
  }

  return { call, configured, latch };
}

let shared;
let sharedMock;
/** The shared client: the live one, or in mock mode one over the mock PingFederate's admin API (its own failure latch). */
export const pfAdmin = () => (isMock() ? (sharedMock ??= createPfAdmin({ env: mockEnv(), send: mockAdminSend })) : (shared ??= createPfAdmin()));
/** Tests only: swap the shared client (or pass null to reset it). */
export const _usePfAdmin = (c) => { shared = c ?? undefined; sharedMock = undefined; };
