// The PingFederate IdP adapter (design 4.4): pi.flow sign-in against a local or hosted PF, users in the kit's
// credential validator through pfUsers.js, admin access through the guarded client in pfAdmin.js.
import { appHandlers } from '../auth/piFlow.js';
import { missingConfig, oidcConfig } from '../auth/oidc.js';
import { demoJson } from '../demoJson.js';
import { runtimeEnv } from '../mode.js';
import { addUser, removeUser } from '../pfUsers.js';
import { pfAdmin } from './pfAdmin.js';

const val = (env, k) => String(env[k] ?? '').trim();
const r = (id, status, message, fix = '') => ({ id, status, message, fix });
const pass = (id, message) => r(id, 'pass', message);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Production-like: NODE_ENV=production, or an APP_ORIGIN whose host is not loopback. */
function productionLike(env) {
  if (val(env, 'NODE_ENV') === 'production') return true;
  try { return !LOOPBACK.has(new URL(val(env, 'APP_ORIGIN') || 'http://localhost:4720').hostname); } catch { return true; }
}

/** PF admin slice of the doctor: reachable, the kit validator (with its anchor user), the pi.flow client, the account rule. */
async function doctor({ env = runtimeEnv(), adminCall, client = pfAdmin() } = {}) {
  if (!val(env, 'PF_ADMIN_URL')) return [];
  if (!val(env, 'PF_ADMIN_PASSWORD')) {
    return [r('pf-admin', 'fail', 'PF_ADMIN_URL is set but PF_ADMIN_PASSWORD is unset', 'Set PF_ADMIN_PASSWORD (and PF_ADMIN_USER if not administrator).')];
  }
  const validatorId = demoJson().provider.pfValidatorId;
  const callAdmin = adminCall ?? client.call;
  if (!adminCall && client.latch().locked) {
    return [r('pf-admin', 'fail', `PF admin access is paused until ${new Date(client.latch().until).toISOString()} after repeated credential failures (no call made)`, 'Fix PF_ADMIN_USER and PF_ADMIN_PASSWORD, then wait for the pause to end or restart the server.')];
  }
  let v;
  try { v = await callAdmin('GET', `/passwordCredentialValidators/${validatorId}`); } catch (err) {
    return [r('pf-admin', 'fail', `PF admin API unreachable (${err?.code || err?.message})`, 'Check PF_ADMIN_URL (https://host:9999); for a self-signed local certificate set PF_ADMIN_INSECURE_TLS=true.')];
  }
  if (v.status === 401 || v.status === 403) return [r('pf-admin', 'fail', `PF admin API refused the credentials (HTTP ${v.status})`, 'Check PF_ADMIN_USER and PF_ADMIN_PASSWORD.')];
  const out = [
    pass('pf-admin', 'PF admin API reachable'),
    v.status === 200 ? pass('pf-validator', `${validatorId} exists`)
      : r('pf-validator', 'fail', v.status === 404 ? `PingFederate has no ${validatorId}` : `${validatorId} lookup answered HTTP ${v.status}`, 'Run pingfederate/configure-local-signin.js.'),
  ];
  const users = v.body?.configuration?.tables?.find((t) => t.name === 'Users');
  if (users) {
    out.push(users.rows.length
      ? pass('pf-anchor-user', `${validatorId} has ${users.rows.length} user(s)`)
      : r('pf-anchor-user', 'fail', `${validatorId} has no users; PingFederate refuses to save an empty Users table (HTTP 422)`, 'Run pingfederate/configure-local-signin.js --users=you@example.com.'));
  }
  const clientId = val(env, 'PF_EXCHANGE_CLIENT_ID');
  if (clientId) {
    try {
      const c = await callAdmin('GET', `/oauth/clients/${encodeURIComponent(clientId)}`);
      out.push(c.status !== 200 ? r('pi-flow-client', 'fail', `client ${clientId} lookup answered HTTP ${c.status}`, 'Create the client: run pingfederate/configure-local-signin.js.')
        : c.body?.allowAuthenticationApiInit ? pass('pi-flow-client', `client ${clientId} allows pi.flow`)
          : r('pi-flow-client', 'fail', `client ${clientId} does not allow Authentication API initiation`, 'Run pingfederate/configure-local-signin.js, or enable Authentication API initiation on the client.'));
    } catch (err) {
      out.push(r('pi-flow-client', 'fail', `client lookup failed (${err?.code || err?.message})`, 'Check the PF admin API.'));
    }
  }
  const prod = productionLike(env);
  if ((val(env, 'PF_ADMIN_USER') || 'administrator') === 'administrator') {
    out.push(r('pf-admin-account', prod ? 'fail' : 'warn', 'PF admin user is the full administrator account', 'Use a dedicated PF admin account for this app (PF_ADMIN_USER); the app limits its own calls, PingFederate does not.'));
  } else out.push(pass('pf-admin-account', 'PF admin user is not the default administrator'));
  if (val(env, 'PF_ADMIN_INSECURE_TLS') === 'true' && val(env, 'NODE_ENV') === 'production') {
    out.push(r('pf-admin-tls', 'fail', 'PF_ADMIN_INSECURE_TLS=true is set in production', 'Remove PF_ADMIN_INSECURE_TLS; it is for local self-signed certificates only.'));
  }
  return out;
}

export function createPfLocal({ client = pfAdmin } = {}) {
  const validatorPath = () => `/passwordCredentialValidators/${demoJson().provider.pfValidatorId}`;
  return {
    id: 'pf-local',
    label: 'PingFederate (pi.flow sign-in)',
    available: true,
    reason: '',
    signIn: { driver: 'pi-flow', piFlow: { kind: 'app', handlers: appHandlers } },
    env: ['PF_ADMIN_URL', 'PF_ADMIN_USER', 'PF_ADMIN_PASSWORD', 'PF_ADMIN_INSECURE_TLS'].map((key) => ({ key, privilege: 'admin' })),
    oidc: () => {
      const c = oidcConfig();
      return missingConfig(c).length ? null : { issuer: c.issuer, clientId: c.clientId, redirectUri: c.redirectUri, scope: c.scope };
    },
    users: {
      add: (email, password) => addUser(email, password),
      async remove(email) {
        try { return { removed: await removeUser(email), kept: false }; } catch (e) {
          if (e.lastUser) return { removed: false, kept: true };
          throw e;
        }
      },
      async count() {
        const got = await client().call('GET', validatorPath());
        return got.body?.configuration?.tables?.find((t) => t.name === 'Users')?.rows?.length ?? 0;
      },
    },
    capabilities: { selfRegistration: true },
    doctor: (ctx = {}) => doctor({ ...ctx, client: client() }),
    setup: { get script() { return demoJson().provider.setupScripts?.['pf-local'] ?? null; }, needsUsers: true },
  };
}

export default createPfLocal();
