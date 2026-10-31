// IdP adapter registry. pf-local registers itself here; local-mock joins in a later step.
import { demoJson } from '../demoJson.js';
import { runtimeEnv } from '../mode.js';
import { validateAdapter } from './contract.js';
import pfLocal from './pf-local.js';

const adapters = new Map();

export function registerAdapter(a) {
  validateAdapter(a);
  adapters.set(a.id, a);
  return a;
}

export function getAdapter(id) {
  const a = adapters.get(id);
  if (!a) throw new Error(`unknown IdP "${id}" (registered: ${[...adapters.keys()].join(', ')})`);
  return a;
}

/** The adapter for this process: IDP, else the first sign-in IdP demo.json declares. */
export const activeAdapter = (env = runtimeEnv()) => getAdapter(String(env.IDP ?? '').trim() || demoJson().provider.signIn[0]);

/** Reset's removal hook: true when removed, false when absent; throws {lastUser} for a user kept as the last one. */
export async function removeUserForReset(email) {
  const users = activeAdapter().users;
  if (!users) return false;
  const r = await users.remove(email);
  if (r.kept) throw Object.assign(new Error('the last user is kept: PingFederate needs at least one'), { lastUser: true });
  return r.removed;
}

registerAdapter(pfLocal);
