// Test helper: an in-memory PingFederate admin API with the handful of behaviours the configure scripts rely on.
// `api(method, path, body)` has the shape pf-admin.js's adminApi returns. Collections list their items; a POST stores the
// body under <collection>/<id> (clientId for clients); `generate` endpoints make a key pair; singletons start from `seed`.
const clone = (v) => JSON.parse(JSON.stringify(v));
const COLLECTIONS = [
  '/oauth/accessTokenManagers', '/oauth/clients', '/idp/tokenProcessors', '/oauth/tokenExchange/processor/policies', '/idp/spConnections',
  '/keyPairs/signing', '/keyPairs/sslServer', '/passwordCredentialValidators', '/idp/adapters', '/authenticationSelectors',
];

export function fakePf(seed = {}) {
  const store = new Map(Object.entries(clone(seed)));
  const calls = [];
  const idOf = (b) => b.id ?? b.clientId;
  const collectionOf = (p) => COLLECTIONS.find((c) => p === c || p.startsWith(`${c}/`));
  const api = async (method, p, body) => {
    calls.push({ method, path: p, body: body === undefined ? undefined : clone(body) });
    const gen = /^(.*)\/generate$/.exec(p);
    if (method === 'POST' && gen) {
      const item = { id: body.id, subjectDN: `CN=${body.commonName}`, issuerDN: `CN=${body.commonName}`, subjectAlternativeNames: (body.subjectAlternativeNames || []).map((n) => (/^[\d.]+$/.test(n) ? `IP: '${n}'` : `DNS: '${n}'`)), // PingFederate's spelling
        expires: new Date(Date.now() + body.validDays * 864e5).toISOString(), status: 'VALID', keyAlgorithm: body.keyAlgorithm };
      store.set(`${gen[1]}/${body.id}`, item);
      return { status: 200, body: clone(item) };
    }
    if (method === 'POST') {
      const id = idOf(body);
      if (store.has(`${p}/${id}`)) return { status: 409, body: { message: 'exists' } };
      store.set(`${p}/${id}`, clone(body));
      return { status: 201, body: clone(body) };
    }
    if (method === 'PUT') { store.set(p, clone(body)); return { status: 200, body: clone(body) }; }
    if (method === 'DELETE') return store.delete(p) ? { status: 204, body: null } : { status: 404, body: null };
    if (method === 'GET') {
      if (/\/certificate$/.test(p)) return store.has(p.replace(/\/certificate$/, '')) ? { status: 200, body: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' } : { status: 404, body: null };
      if (store.has(p)) return { status: 200, body: clone(store.get(p)) };
      if (collectionOf(p) === p) return { status: 200, body: { items: [...store].filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/') && k !== `${p}/settings`).map(([, v]) => clone(v)) } };
      return { status: 404, body: null };
    }
    return { status: 405, body: null };
  };
  return { api, store, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}
