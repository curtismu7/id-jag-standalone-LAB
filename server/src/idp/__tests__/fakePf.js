// A fake PingFederate admin API behind the `send` seam of createPfAdmin. It keeps the behaviour found against a
// real PF 13.1.3 on 2026-10-20: a validator whose Users table is empty is refused with HTTP 422.
export const row = (u, pw = 'x') => ({ defaultRow: false, fields: [{ name: 'Username', value: u }, { name: 'Relax Password Requirements', value: 'true' }, { name: 'Password', value: pw }, { name: 'Confirm Password', value: pw }] });

export function createFakePf({ validatorId = 'idJagKitPcv', users = ['setup@example.test'], clientId = 'kit' } = {}) {
  const fake = {
    calls: [], status: null, down: false,
    validator: null,
    setUsers(emails) { fake.validator = { id: validatorId, configuration: { fields: [], tables: [{ name: 'Users', rows: emails.map((u) => row(u)) }] } }; },
    emails: () => fake.validator.configuration.tables[0].rows.map((r) => r.fields[0].value),
    async send(url, { method, body }) {
      const p = new URL(url).pathname.replace('/pf-admin-api/v1', '');
      fake.calls.push(`${method} ${p}`);
      if (fake.down) throw Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: 'ECONNREFUSED' });
      if (fake.status) return { status: fake.status, body: null };
      if (p === `/passwordCredentialValidators/${validatorId}` && method === 'GET') return { status: 200, body: JSON.parse(JSON.stringify(fake.validator)) };
      if (p === `/passwordCredentialValidators/${validatorId}` && method === 'PUT') {
        const next = JSON.parse(body);
        if (!next.configuration.tables[0].rows.length) return { status: 422, body: { validationErrors: [{ message: "Please add at least one user to the 'Users' table." }] } };
        fake.validator = next;
        return { status: 200, body: next };
      }
      if (p === `/oauth/clients/${clientId}` && method === 'GET') return { status: 200, body: { allowAuthenticationApiInit: true } };
      return { status: 404, body: {} };
    },
  };
  fake.setUsers(users);
  return fake;
}
