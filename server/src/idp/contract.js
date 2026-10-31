// IdP adapter contract (design 4.4). An adapter is a plain object; the registry refuses one that breaks this shape.
export const ADAPTER_IDS = ['pf-local', 'local-mock'];
export const RESERVED_IDS = ['p1', 'aic', 'none']; // named in the design, not built
export const DRIVERS = ['pi-flow', 'session']; // there is no redirect driver (D26)

const fn = (v) => typeof v === 'function';

/** Throws an Error naming the first thing wrong with `a`; returns `a` when the shape is valid. */
export function validateAdapter(a) {
  const bad = (m) => { throw new Error(`idp adapter ${a?.id ?? '(no id)'}: ${m}`); };
  if (!a || typeof a !== 'object') bad('not an object');
  if (RESERVED_IDS.includes(a.id)) bad('id is reserved and not built');
  if (!ADAPTER_IDS.includes(a.id)) bad(`unknown id (use ${ADAPTER_IDS.join(', ')})`);
  if (typeof a.label !== 'string' || !a.label) bad('label is required');
  if (typeof a.available !== 'boolean') bad('available must be a boolean');
  if (!a.available && !(typeof a.reason === 'string' && a.reason)) bad('available:false requires a reason');
  if (!DRIVERS.includes(a.signIn?.driver)) bad(`signIn.driver must be one of ${DRIVERS.join(', ')}`);
  if (a.signIn.driver === 'pi-flow' && !(fn(a.signIn.piFlow?.handlers?.start) && fn(a.signIn.piFlow.handlers.credentials))) bad('pi-flow needs signIn.piFlow.handlers.start and .credentials');
  if (!Array.isArray(a.env)) bad('env must be an array');
  if (!fn(a.oidc)) bad('oidc must be a function');
  if (a.users !== null && !(fn(a.users?.add) && fn(a.users.remove) && fn(a.users.count))) bad('users must be null or { add, remove, count }');
  if (typeof a.capabilities?.selfRegistration !== 'boolean') bad('capabilities.selfRegistration must be a boolean');
  if (a.users === null && a.capabilities.selfRegistration) bad('users:null requires selfRegistration:false');
  if (!fn(a.doctor)) bad('doctor must be a function');
  if (!a.setup || typeof a.setup.needsUsers !== 'boolean' || !('script' in a.setup)) bad('setup needs { script, needsUsers }');
  return a;
}

/** The sign-in routes an adapter contributes: none when unavailable. */
export function routesFor(a) {
  if (!a.available || a.signIn.driver !== 'pi-flow') return [];
  return [
    { method: 'get', path: '/auth/pi-flow/start', handler: a.signIn.piFlow.handlers.start },
    { method: 'post', path: '/auth/pi-flow/credentials', handler: a.signIn.piFlow.handlers.credentials },
  ];
}
