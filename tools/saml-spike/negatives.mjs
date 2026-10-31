// SAML subject-token negatives against PingFederate: each must be refused; the control must be issued. Prints statuses only.
import fs from 'node:fs';
import { buildAssertion } from './mk-saml.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const PF = 'https://pf.example.invalid', AUD = 'idJagSpikeAud', ENTITY = 'https://spike-rs.example.com/', RESOURCE = 'https://spike-rs.example.com/mcp';
const { clientId, clientSecret } = JSON.parse(fs.readFileSync('work/client.json', 'utf8'));
const b64url = (s) => Buffer.from(s).toString('base64url');
async function exchange(xml) {
  const r = await fetch(`${PF}/as/token.oauth2`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: b64url(xml), subject_token_type: 'urn:ietf:params:oauth:token-type:saml2', requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag', audience: ENTITY, resource: RESOURCE, scope: 'read mcp:invoke' }).toString() });
  const j = await r.json().catch(() => ({}));
  return `HTTP ${r.status} ${j.access_token ? '(ID-JAG issued)' : `${j.error}: ${String(j.error_description || '').slice(0, 100)}`}`;
}
// A second key pair PingFederate has never been told to trust: same module, a different work dir, loaded afresh.
process.env.SAML_SPIKE_WORK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'work-untrusted');
const { buildAssertion: buildUntrusted } = await import('./mk-saml.mjs?untrusted');
const base = { audience: AUD };
const cases = [
  ['control: valid assertion', buildAssertion(base).xml],
  ['tampered subject after signing', buildAssertion(base).xml.replace('idjag-spike@example.com', 'attacker@example.com')],
  ['wrong audience', buildAssertion({ audience: 'https://wrong.example.com' }).xml],
  ['expired (an hour ago)', buildAssertion({ ...base, nowMs: Date.now() - 3600_000 }).xml],
  ['signed by an UNTRUSTED key', buildUntrusted(base).xml],
  ['no signature at all', buildAssertion(base).xml.replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, '')],
];
for (const [name, xml] of cases) console.log(name.padEnd(34), '->', await exchange(xml));
