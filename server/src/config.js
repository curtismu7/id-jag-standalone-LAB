// Every setting comes from the environment (documented in .env.example). Read at call time so
// tests can change process.env between cases.

import { runtimeEnv } from './mode.js';

// runtimeEnv() is process.env in live mode and the mock's environment in mock mode (mode.js).
const env = (k, fallback = '') => String(runtimeEnv()[k] ?? '').trim() || fallback;
const noSlash = (u) => u.replace(/\/$/, '');

// The demo layer (demo/index.js) supplies its own keys; app.js registers it so this file imports no demo code.
let demoConfig = () => ({});
export const useDemoConfig = (fn) => { demoConfig = fn; };

// Until createApp registers the demo config, config() returns the base identity (slug 'demo', appName 'Demo Kit');
// code that calls config() without createApp (CLI scripts, unit tests) sees that, not the demo's 'idjag'.
export function config() {
  const resourceAsIssuer = noSlash(env('RESOURCE_AS_ISSUER'));
  return {
    appName: 'Demo Kit',
    slug: 'demo', // cookie ${slug}.sid and log prefix [${slug}]
    adminGroup: env('ADMIN_CLAIM_VALUE', 'demo-admins'),
    host: env('HOST'),
    port: Number(env('PORT', '4720')),
    appOrigin: noSlash(env('APP_ORIGIN', 'http://localhost:4720')),
    dataDir: env('DATA_DIR', '.data'),
    // The PingFederate that issues ID-JAGs (pf-as mode) and redeems them (pf-pf and byo modes).
    pfUrl: noSlash(env('PF_URL', 'https://pf.example.invalid')),
    pfExchangeClientId: env('PF_EXCHANGE_CLIENT_ID'),
    pfRedeemerClientId: env('PF_REDEEMER_CLIENT_ID', 'id-jag-redeemer'),
    pfResource: env('PF_RESOURCE'),
    // The outside "Acme" PingFederate: issues ID-JAGs addressed to PF_URL (pf-pf mode).
    acmePfUrl: noSlash(env('ACME_PF_URL', 'https://pf-acme.example.invalid')),
    acmeExchangeClientId: env('ACME_EXCHANGE_CLIENT_ID'),
    // Our own resource authorization server (Phase 2).
    resourceAsIssuer,
    resourceAsTokenEndpoint: env('RESOURCE_AS_TOKEN_ENDPOINT', resourceAsIssuer ? `${resourceAsIssuer}/token` : ''),
    resourceAsClientId: env('RESOURCE_AS_CLIENT_ID', 'id-jag-playground'),
    mcpUrl: env('MCP_URL'),
    resource: env('ID_JAG_RESOURCE'),
    scope: env('ID_JAG_SCOPE'),
    ...demoConfig(runtimeEnv()),
  };
}

// Secrets stay out of config(): config() feeds /config, which goes to the browser.
export const secret = (k) => env(k);
