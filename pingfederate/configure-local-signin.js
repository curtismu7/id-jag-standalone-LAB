#!/usr/bin/env node
'use strict';
/**
 * Let PingFederate sign the kit's users in itself, so the app can run the sign-in as a pi.flow in its own modal.
 * PingFederate's Authentication API cannot run an OIDC IdP connection ("the next step requires browser interaction"),
 * so the PingOne hop made by configure-signin.js can never be a pi.flow. This swaps only the "Yes" branch of the kit's
 * own first authentication policy: the kit client -> a kit-only HTML form adapter (its own credential validator) instead
 * of the PingOne connection. Everything else, including the demo's adapters and users, is left as it is.
 *
 *   kubectl -n <ns> port-forward svc/pingfederate-admin 19999:9999 &
 *   node pingfederate/configure-local-signin.js --ns=<ns> [--port=19999] [--users=a@pingidentity.com,b@pingone.com]
 *   node pingfederate/configure-local-signin.js --ns=<ns> --mode=pingone     # put the PingOne hop back
 *
 * Creates (ids prefixed idJagKit): a Simple Username Password credential validator holding ONLY the kit's users, an HTML
 * form adapter on it, the policy branch, and lets the kit's client start a pi.flow (allowAuthenticationApiInit). Usernames must be email addresses the kit would accept (allowed domain, no
 * "+"): the ID token's email is the username and email_verified is a constant, because these accounts are created here.
 * Passwords are generated for each NEW user and written to deploy/local/kit-users.json (mode 600, gitignored); they
 * are never printed. Re-running keeps existing users and their passwords; `--rotate=<email>` replaces one password.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pf = require('./pf-admin');
const { missingFirstUser } = require('./validator-users');
const { args, setting, adminApi, report, acceptAll, from, same } = pf;

const NS = setting('ns', null, 'the namespace holding the pingfederate-admin secret');
const PORT = args.port || '19999';
const MODE = args.mode || 'local';
const CLIENT = process.env.PF_EXCHANGE_CLIENT_ID || 'id-jag-kit';
const ID = { pcv: 'idJagKitPcv', adapter: 'idJagKitHtmlForm', apc: 'idJagKitApc', selector: 'idJagKitClientSelector', conn: 'idJagKitP1' };
const CLAIMS = ['email', 'email_verified', 'name', 'groups'];
const USERS_FILE = path.join(__dirname, '../deploy/local/kit-users.json');
const DOMAINS = String(process.env.ALLOWED_EMAIL_DOMAINS || 'pingidentity.com,pingone.com').split(',').map((d) => d.trim().toLowerCase());

if (!['local', 'pingone'].includes(MODE)) { console.error('--mode must be local or pingone'); process.exit(2); }

/** The kit accepts only plain name@domain addresses on the allowed domains (see server/src/auth/emailRules.js). */
function checkUser(email) {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(email);
  if (!m || !DOMAINS.includes(m[2].toLowerCase()) || m[1].includes('+')) {
    console.error(`refusing "${email}": it is not a plain name@domain address on ${DOMAINS.join(' / ')}, so the kit would not let it in`);
    process.exit(2);
  }
  return email.toLowerCase();
}

const readUsers = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; } };
function writeUsers(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
}
const newPassword = () => crypto.randomBytes(18).toString('base64url');
const userRow = (username, password) => ({ defaultRow: false, fields: [
  { name: 'Username', value: username }, { name: 'Relax Password Requirements', value: 'true' },
  { name: 'Password', value: password }, { name: 'Confirm Password', value: password }] });

(async () => {
  const api = adminApi(NS, PORT);
  const policy = await api('GET', '/authenticationPolicies/default');
  const tree = policy.body?.authnSelectionTrees?.find((t) => t.rootNode.action.authenticationSelectorRef?.id === ID.selector);
  if (!tree) { console.error('the kit policy tree is missing: run pingfederate/configure-signin.js first'); process.exit(1); }

  if (MODE === 'local') {
    // 1. A credential validator that holds only the kit's users: cloned from the demo's so the descriptor is exact.
    const wanted = String(args.users || '').split(',').map((s) => s.trim()).filter(Boolean).map(checkUser);
    const rotate = args.rotate && args.rotate !== true ? checkUser(String(args.rotate)) : null;
    const saved = readUsers();
    let pcv = await api('GET', `/passwordCredentialValidators/${ID.pcv}`);
    const noUser = missingFirstUser({ exists: pcv.status === 200, wanted });
    if (noUser) { console.error(noUser); process.exit(2); }
    const base = (await api('GET', '/passwordCredentialValidators')).body.items.find((p) => p.pluginDescriptorRef.id.endsWith('SimpleUsernamePasswordCredentialValidator'));
    if (!base) { console.error('no Simple Username Password credential validator exists to clone the descriptor from'); process.exit(1); }
    const body = pcv.status === 200 ? pcv.body : {
      id: ID.pcv, name: 'ID-JAG Kit users', pluginDescriptorRef: base.pluginDescriptorRef, attributeContract: base.attributeContract,
      configuration: { fields: [], tables: [{ name: 'Users', rows: [] }] },
    };
    const table = body.configuration.tables.find((t) => t.name === 'Users');
    const have = new Set(table.rows.map((r) => r.fields.find((f) => f.name === 'Username')?.value));
    const changed = [];
    for (const email of [...new Set([...wanted, ...(rotate ? [rotate] : [])])]) {
      if (have.has(email) && email !== rotate) continue;
      const password = newPassword();
      table.rows = table.rows.filter((r) => r.fields.find((f) => f.name === 'Username')?.value !== email);
      table.rows.push(userRow(email, password));
      saved[email] = password;
      changed.push(email);
    }
    if (pcv.status !== 200) report(`create credential validator ${ID.pcv}`, await api('POST', '/passwordCredentialValidators', body));
    else if (changed.length) report(`update credential validator ${ID.pcv}`, await api('PUT', `/passwordCredentialValidators/${ID.pcv}`, body));
    else console.log(`  keep credential validator ${ID.pcv}`);
    if (changed.length) { writeUsers(saved); console.log(`  users written to ${path.relative(process.cwd(), USERS_FILE)} (not printed): ${changed.join(', ')}`); }

    // 2. An HTML form adapter on it, cloned from the demo's so every template field is valid.
    const adapter = await api('GET', `/idp/adapters/${ID.adapter}`);
    if (adapter.status === 200) console.log(`  keep adapter ${ID.adapter}`);
    else {
      const demo = (await api('GET', '/idp/adapters')).body.items.find((a) => a.pluginDescriptorRef.id.endsWith('HtmlFormIdpAuthnAdapter'));
      const clone = JSON.parse(JSON.stringify(demo));
      clone.id = ID.adapter; clone.name = 'ID-JAG Kit sign-in form';
      clone.configuration.tables = [{ name: 'Credential Validators', rows: [{ defaultRow: false, fields: [{ name: 'Password Credential Validator Instance', value: ID.pcv }] }] }];
      report(`create adapter ${ID.adapter}`, await api('POST', '/idp/adapters', clone));
    }
  }

  // The client must be allowed to start a pi.flow (PingFederate's Authentication API), else it answers unauthorized_client.
  if (MODE === 'local') {
    const client = await api('GET', `/oauth/clients/${encodeURIComponent(CLIENT)}`);
    if (client.status !== 200) { console.error(`client ${CLIENT} not found: run pingfederate/configure-signin.js first`); process.exit(1); }
    if (client.body.allowAuthenticationApiInit) console.log(`  keep client ${CLIENT}: pi.flow already allowed`);
    else report(`client ${CLIENT}: allow pi.flow (Authentication API initiation)`, await api('PUT', `/oauth/clients/${encodeURIComponent(CLIENT)}`, { ...client.body, allowAuthenticationApiInit: true }));
  }

  // 3. The policy branch: kit client -> (local adapter | PingOne connection) -> the kit's policy contract.
  const yes = tree.rootNode.children.find((c) => c.action.context === 'Yes');
  const wantSource = MODE === 'local'
    ? { type: 'IDP_ADAPTER', sourceRef: { id: ID.adapter } }
    : { type: 'IDP_CONNECTION', sourceRef: { id: ID.conn } };
  const mapping = MODE === 'local'
    ? acceptAll({ attributeContractFulfillment: {
      subject: { source: { type: 'ADAPTER', id: ID.adapter }, value: 'username' },
      email: { source: { type: 'ADAPTER', id: ID.adapter }, value: 'username' },
      name: { source: { type: 'ADAPTER', id: ID.adapter }, value: 'username' },
      email_verified: { source: { type: 'TEXT' }, value: 'true' },
      groups: { source: { type: 'TEXT' }, value: 'kit-users' },
    } })
    : acceptAll({ attributeContractFulfillment: from('IDP_CONNECTION', [['subject', 'sub'], ...same(CLAIMS)], { id: ID.conn }) });
  if (yes.action.authenticationSource?.type === wantSource.type && yes.action.authenticationSource.sourceRef?.id === wantSource.sourceRef.id) {
    console.log(`  keep policy branch (${MODE})`);
  } else {
    yes.action.authenticationSource = wantSource;
    yes.children = [
      { action: { type: 'DONE', context: 'Fail' } },
      { action: { type: 'APC_MAPPING', context: 'Success', authenticationPolicyContractRef: { id: ID.apc }, attributeMapping: mapping } },
    ];
    tree.name = MODE === 'local' ? 'ID-JAG Kit: its client signs in at PingFederate' : 'ID-JAG Kit: its client signs in at PingOne';
    report(`authentication policy: kit client now signs in via ${MODE === 'local' ? 'the kit form adapter' : 'the PingOne connection'}`, await api('PUT', '/authenticationPolicies/default', policy.body));
  }
  pf.done('local-signin', `[local-signin] done (${MODE}).`);
})().catch(pf.fail('local-signin', PORT));
