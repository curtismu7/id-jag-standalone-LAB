// The ID-JAG demo's registration point (design 4.2). The base (app.js, config.js) imports only this file;
// everything ID-JAG-specific is wired in here.
import inspectApi from '../inspectApi.js';
import playground from '../idJagPlayground.js';
import registry from '../registry/routes.js';
import { cimdTesterRoutes, enableMockCimd } from '../cimdTester.js';

export const config = (_env) => ({ appName: 'ID-JAG Kit', slug: 'idjag' });

// In mock mode the mock PingFederate fetches this app's CIMD documents through its CIMD policy.
if (process.env.NODE_ENV !== 'test') enableMockCimd();

// Mounted after auth, in this order (the more specific trusted-idps path first).
// auth: 'user' | 'admin' | undefined; these routers enforce their own.
// singleTenant: answers 403 workspace_not_supported outside the default workspace (shared files, live PingFederate).
export const routes = [
  { path: '/api/id-jag-playground/trusted-idps', router: registry, singleTenant: true },
  { path: '/api/id-jag-playground', router: playground, singleTenant: true },
  { path: '/api/inspect', router: inspectApi, singleTenant: true },
  // Public CIMD document paths + /api/cimd/tester/* (no auth: the documents are public by design; the
  // tester endpoints only read discovery and pasted documents, and the probe is the mock's verdict).
  { path: '/', router: cimdTesterRoutes(), singleTenant: true },
];
