// Adds an approved user to the kit's PingFederate credential validator (the one configure-local-signin.js
// creates), through the guarded PingFederate admin client (idp/pfAdmin.js), which is the only place the app holds PF admin credentials.
// Settings: PF_ADMIN_URL (https://host:9999), PF_ADMIN_USER (default administrator), PF_ADMIN_PASSWORD,
// PF_ADMIN_INSECURE_TLS=true to accept PingFederate's self-signed admin certificate (local runs).

import { demoJson } from './demoJson.js';
import { pfAdmin } from './idp/pfAdmin.js';

const VALIDATOR = () => demoJson().provider.pfValidatorId;
const env = (k) => String(process.env[k] ?? '').trim();
const fail = (status, message) => Object.assign(new Error(message), { status });

export const adminConfigured = () => Boolean(env('PF_ADMIN_URL') && env('PF_ADMIN_PASSWORD'));

const call = (method, path, body) => pfAdmin().call(method, path, body);

const row = (username, password) => ({ defaultRow: false, fields: [
  { name: 'Username', value: username }, { name: 'Relax Password Requirements', value: 'true' },
  { name: 'Password', value: password }, { name: 'Confirm Password', value: password }] });

/** The kit validator and its Users table, from the admin API. */
async function loadUsers() {
  if (!adminConfigured()) throw fail(503, 'PingFederate admin access is not configured (PF_ADMIN_URL, PF_ADMIN_PASSWORD)');
  let got;
  try { got = await call('GET', `/passwordCredentialValidators/${VALIDATOR()}`); } catch (e) { throw Object.assign(fail(e.status || 502, e.message), { code: e.code }); }
  if (got.status === 404) throw fail(502, `PingFederate has no ${VALIDATOR()}: run pingfederate/configure-local-signin.js first`);
  if (got.status !== 200) throw fail(502, `PingFederate admin API answered HTTP ${got.status}`);
  const table = got.body.configuration.tables.find((t) => t.name === 'Users');
  if (!table) throw fail(502, `${VALIDATOR()} has no Users table`);
  return { validator: got.body, table };
}
const usernameOf = (r) => r.fields.find((f) => f.name === 'Username')?.value?.toLowerCase();

async function save(validator, what) {
  let put;
  try { put = await call('PUT', `/passwordCredentialValidators/${VALIDATOR()}`, validator); } catch (e) { throw Object.assign(fail(e.status || 502, e.message), { code: e.code }); }
  if (put.status !== 200) throw fail(502, `PingFederate refused ${what} (HTTP ${put.status}: ${put.body?.validationErrors?.[0]?.message || put.body?.message || 'no detail'})`);
}

/** Add `email` with `password` to the kit's users. Refuses (409) a username that already exists; never logs the password. */
export async function addUser(email, password) {
  const { validator, table } = await loadUsers();
  if (table.rows.some((r) => usernameOf(r) === email.toLowerCase())) throw fail(409, `${email} already has an account`);
  table.rows.push(row(email, password));
  await save(validator, 'the new user');
}

/** Remove `email` from the kit's users. Returns false (no write) when it is not there. Touches no other row. */
export async function removeUser(email) {
  const { validator, table } = await loadUsers();
  const kept = table.rows.filter((r) => usernameOf(r) !== email.toLowerCase());
  if (kept.length === table.rows.length) return false;
  // PingFederate refuses a validator with no users (HTTP 422), so say so up front instead of making a doomed write.
  if (!kept.length) throw Object.assign(fail(409, 'PingFederate needs at least one user in the kit validator, so the last one is kept'), { lastUser: true });
  table.rows = kept;
  await save(validator, 'removing the user');
  return true;
}
