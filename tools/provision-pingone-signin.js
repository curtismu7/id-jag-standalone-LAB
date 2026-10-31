#!/usr/bin/env node
'use strict';
/**
 * Provision this app's sign-in in its OWN PingOne environment (never the AI-Demo one).
 * PingFederate federates to it; the app enforces its email rules on the claims too.
 * Idempotent: everything is found by name before it is created.
 *
 *   node tools/provision-pingone-signin.js [--dry-run] [--pf-redirect-uri=<PF OIDC IdP connection callback>]
 *
 * Reads the repo-root .env (never prints secrets):
 *   STANDALONE_P1_ENV_ID, STANDALONE_P1_REGION (NA|EU|AP|CA|AU),
 *   STANDALONE_P1_WORKER_CLIENT_ID, STANDALONE_P1_WORKER_CLIENT_SECRET
 *     (a Worker app in that environment with Identity Data Admin + Environment Admin)
 *   PF_URL (the PingFederate that federates to PingOne)
 * Writes back STANDALONE_P1_PF_APP_CLIENT_ID / STANDALONE_P1_PF_APP_CLIENT_SECRET for PingFederate's IdP connection.
 */
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const DRY = !!args['dry-run'];

const env = Object.fromEntries(fs.readFileSync(ENV_FILE, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const need = (k) => { if (!env[k]) { console.error(`set ${k} in ${ENV_FILE}`); process.exit(2); } return env[k]; };

const ENV_ID = need('STANDALONE_P1_ENV_ID');
const TLD = { NA: 'com', EU: 'eu', AP: 'asia', CA: 'ca', AU: 'com.au' }[env.STANDALONE_P1_REGION || 'NA'];
const AUTH = `https://auth.pingone.${TLD}/${ENV_ID}/as`;
const ROOT = `https://api.pingone.${TLD}/v1`;
const API = `${ROOT}/environments/${ENV_ID}`;
const PF_URL = (env.PF_URL || '').replace(/\/$/, '');

const NAMES = {
  environment: 'ID-JAG Standalone',
  population: 'ID-JAG Kit users',
  adminGroup: env.ADMIN_CLAIM_VALUE || 'id-jag-admins',
  policy: 'id-jag-standalone-signin',
  app: 'PingFederate - ID-JAG Standalone', // PingOne names allow no parentheses
};

let token;
async function getToken() {
  if (token) return token;
  const basic = Buffer.from(`${need('STANDALONE_P1_WORKER_CLIENT_ID')}:${need('STANDALONE_P1_WORKER_CLIENT_SECRET')}`).toString('base64');
  const r = await fetch(`${AUTH}/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const j = await r.json();
  if (!r.ok) throw new Error(`worker token: ${j.error} ${j.error_description || ''}`);
  return (token = j.access_token);
}
async function call(method, url, body) {
  const r = await fetch(url.startsWith('http') ? url : API + url, {
    method, headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { raw: txt.slice(0, 300) }; }
  return { status: r.status, body: j };
}
function fail(what, r) {
  const d = r.body.details ? ` ${JSON.stringify(r.body.details).slice(0, 400)}` : '';
  throw new Error(`${what}: HTTP ${r.status} ${r.body.code || ''} ${r.body.message || ''}${d}`);
}
const list = async (p, key) => ((await call('GET', p)).body._embedded || {})[key] || [];
const log = (m) => console.log(`  ${m}`);

function writeEnv(pairs) {
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => !Object.keys(pairs).some((k) => l.startsWith(`${k}=`)));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(pairs)) lines.push(`${k}=${v}`);
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
}

(async () => {
  console.log(`[pingone] environment ${ENV_ID} (${TLD})${DRY ? ' — dry run' : ''}`);

  // 0. Name the environment.
  const e = await call('GET', API);
  if (e.status !== 200) fail('read environment', e);
  if (e.body.name !== NAMES.environment) {
    if (DRY) log(`would rename "${e.body.name}" to "${NAMES.environment}"`);
    else {
      const r = await call('PUT', API, { name: NAMES.environment, description: e.body.description || 'Sign-in for the standalone ID-JAG playground (separate from AI-Demo).', type: e.body.type, region: e.body.region, license: e.body.license });
      r.status === 200 ? log(`renamed to "${NAMES.environment}"`) : log(`rename skipped: HTTP ${r.status} ${r.body.message || ''}`);
    }
  } else log(`keep name "${NAMES.environment}"`);

  // 1. Population (default) for self-registered users.
  let pop = (await list('/populations', 'populations')).find((p) => p.name === NAMES.population);
  if (!pop) {
    if (DRY) log(`would create population "${NAMES.population}"`);
    else { const r = await call('POST', '/populations', { name: NAMES.population, description: 'Self-registered users of the standalone ID-JAG app' }); if (r.status !== 201) fail('create population', r); pop = r.body; log(`created population ${pop.id}`); }
  } else log(`keep population ${pop.id}`);
  if (pop && !pop.default && !DRY) {
    const r = await call('PUT', `/populations/${pop.id}`, { name: pop.name, description: pop.description || '', default: true });
    r.status === 200 ? log('population set as default') : log(`default population not set: HTTP ${r.status} ${r.body.message || ''}`);
  }

  // 2. Admin group.
  let group = (await list('/groups', 'groups')).find((g) => g.name === NAMES.adminGroup);
  if (!group) {
    if (DRY) log(`would create group "${NAMES.adminGroup}"`);
    else { const r = await call('POST', '/groups', { name: NAMES.adminGroup, description: 'Admins of the standalone ID-JAG app (approve trusted IdPs)' }); if (r.status !== 201) fail('create group', r); group = r.body; log(`created group ${group.id}`); }
  } else log(`keep group ${group.id}`);

  // 3. Sign-on policy: login with self-registration into the population. Email verification
  //    (one-time code) is part of PingOne's hosted registration flow.
  let policy = (await list('/signOnPolicies', 'signOnPolicies')).find((p) => p.name === NAMES.policy);
  if (!policy) {
    if (DRY) log(`would create sign-on policy "${NAMES.policy}"`);
    else { const r = await call('POST', '/signOnPolicies', { name: NAMES.policy, description: 'Username/password with self-registration (standalone ID-JAG app)' }); if (r.status !== 201) fail('create sign-on policy', r); policy = r.body; log(`created sign-on policy ${policy.id}`); }
  } else log(`keep sign-on policy ${policy.id}`);
  if (policy && !DRY) {
    const actions = await list(`/signOnPolicies/${policy.id}/actions`, 'actions');
    const login = actions.find((a) => a.type === 'LOGIN');
    const want = { priority: 1, type: 'LOGIN', recovery: { enabled: true }, registration: { enabled: true, population: { id: pop.id } } };
    const r = login ? await call('PUT', `/signOnPolicies/${policy.id}/actions/${login.id}`, want) : await call('POST', `/signOnPolicies/${policy.id}/actions`, want);
    if (![200, 201].includes(r.status)) fail('login action', r);
    log(`login action: registration ${r.body.registration?.enabled ? 'on' : 'OFF'} → population ${r.body.registration?.population?.id || '?'}`);
  }

  // 4. OIDC web app that PingFederate's IdP connection uses.
  const redirect = args['pf-redirect-uri'] || env.STANDALONE_P1_PF_REDIRECT_URI || '';
  let app = (await list('/applications', 'applications')).find((a) => a.name === NAMES.app);
  const appBody = {
    name: NAMES.app, description: `PingFederate (${PF_URL || 'PF_URL'}) federates sign-in for the standalone ID-JAG app to this environment.`,
    enabled: true, type: 'WEB_APP', protocol: 'OPENID_CONNECT',
    grantTypes: ['AUTHORIZATION_CODE'], responseTypes: ['CODE'], tokenEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
    pkceEnforcement: 'OPTIONAL', redirectUris: redirect ? [redirect] : [],
  };
  if (!app) {
    if (DRY) log(`would create OIDC app "${NAMES.app}"`);
    else { const r = await call('POST', '/applications', appBody); if (r.status !== 201) fail('create OIDC app', r); app = r.body; log(`created OIDC app ${app.id}`); }
  } else if (!DRY && redirect && !(app.redirectUris || []).includes(redirect)) {
    const r = await call('PUT', `/applications/${app.id}`, { ...appBody, redirectUris: [...new Set([...(app.redirectUris || []), redirect])] });
    r.status === 200 ? log('redirect URI added') : fail('update OIDC app', r);
  } else log(`keep OIDC app ${app?.id}`);
  if (app && !DRY) {
    // Scopes: openid profile email (PingOne's OIDC resource).
    const resources = await list('/resources', 'resources');
    const oidc = resources.find((x) => x.name === 'openid');
    if (oidc) {
      const scopes = await list(`/resources/${oidc.id}/scopes`, 'scopes');
      const want = scopes.filter((s) => ['openid', 'profile', 'email'].includes(s.name)).map((s) => ({ id: s.id }));
      const grants = await list(`/applications/${app.id}/grants`, 'grants');
      if (!grants.some((g) => g.resource?.id === oidc.id)) {
        const r = await call('POST', `/applications/${app.id}/grants`, { resource: { id: oidc.id }, scopes: want });
        r.status === 201 ? log('granted openid profile email') : fail('grant scopes', r);
      } else log('keep openid grant');
    }
    // groups claim (group names) in the ID token / userinfo.
    const attrs = await list(`/applications/${app.id}/attributes`, 'attributes');
    if (!attrs.some((a) => a.name === 'groups')) {
      const r = await call('POST', `/applications/${app.id}/attributes`, { name: 'groups', value: '${user.memberOfGroupNames}', required: false, idToken: true, userInfo: true });
      [200, 201].includes(r.status) ? log('mapped groups → memberOfGroupNames') : log(`groups mapping: HTTP ${r.status} ${r.body.message || ''} ${JSON.stringify(r.body.details || '').slice(0, 200)}`);
    } else log('keep groups mapping');
    // email_verified as a claim: the app requires it to be the JSON boolean true. PingOne's
    // metadata does not list it by default; map it from the boolean user attribute.
    if (!attrs.some((x) => x.name === 'email_verified')) {
      const r = await call('POST', `/applications/${app.id}/attributes`, { name: 'email_verified', value: '${user.emailVerified}', required: false, idToken: true, userInfo: true });
      [200, 201].includes(r.status) ? log('mapped email_verified → emailVerified') : log(`email_verified mapping: HTTP ${r.status} ${r.body.message || ''} ${JSON.stringify(r.body.details || '').slice(0, 200)}`);
    } else log('keep email_verified mapping');
    // This app signs in with the self-registration policy.
    const assigns = await list(`/applications/${app.id}/signOnPolicyAssignments`, 'signOnPolicyAssignments');
    if (!assigns.some((x) => x.signOnPolicy?.id === policy.id)) {
      const r = await call('POST', `/applications/${app.id}/signOnPolicyAssignments`, { priority: 1, signOnPolicy: { id: policy.id } });
      r.status === 201 ? log('assigned sign-on policy') : fail('assign sign-on policy', r);
    } else log('keep sign-on policy assignment');
    // Credentials for PingFederate's IdP connection (never printed).
    const sec = await call('GET', `/applications/${app.id}/secret`);
    if (sec.status === 200 && sec.body.secret) {
      writeEnv({ STANDALONE_P1_PF_APP_CLIENT_ID: app.id, STANDALONE_P1_PF_APP_CLIENT_SECRET: sec.body.secret, STANDALONE_P1_ISSUER: AUTH });
      log('wrote STANDALONE_P1_PF_APP_CLIENT_ID / _SECRET / STANDALONE_P1_ISSUER to .env');
    } else log(`app secret not readable: HTTP ${sec.status} ${sec.body.message || ''}`);
  }
  console.log(`[pingone] done. Issuer ${AUTH}`);
})().catch((err) => { console.error(`[pingone] ${err.message}`); process.exit(1); });
