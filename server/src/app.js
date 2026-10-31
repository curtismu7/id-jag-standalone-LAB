import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { config, useDemoConfig } from './config.js';
import * as demo from './demo/index.js';
import auth, { requireAdmin, requireUser } from './auth/oidc.js';
import piFlow from './auth/piFlow.js';
import { customerConfig } from './customerConfig.js';
import registrations from './registrationRoutes.js';
import resetRoutes from './resetRoutes.js';
import { sessionStore } from './sessionStore.js';
import { DEFAULT_WORKSPACE, requireDefaultWorkspace, workspaceMiddleware } from './workspace.js';
import doctor from './doctorRoute.js';
import health from './health.js';

const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

// workspaceResolver: req -> workspace id (design 6). The default ignores the request; a client never picks an id.
export function createApp({ workspaceResolver = () => DEFAULT_WORKSPACE } = {}) {
  useDemoConfig(demo.config);
  const WEB_DIST = process.env.WEB_DIST || DEFAULT_WEB_DIST; // read per app so tests can point it away from a built web/dist
  const c = config();
  const app = express();
  app.disable('x-powered-by');
  app.use(workspaceMiddleware(workspaceResolver));
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  let secret = process.env.SESSION_SECRET;
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    console.warn(`[${c.slug}] SESSION_SECRET is not set; using a random one (sessions end on restart)`);
  }
  // ponytail: MemoryStore, one process, sessions lost on restart; swap in a shared store before running replicas.
  app.use(session({
    store: sessionStore, name: `${c.slug}.sid`, secret, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: c.appOrigin.startsWith('https:') },
  }));

  app.use(auth); // /auth/pi-flow/*, /auth/callback, /auth/logout, /api/me
  app.use(piFlow); // /auth/pi-flow/start, /auth/pi-flow/credentials
  app.use('/api', registrations); // /api/register, /api/registrations
  app.use('/api', resetRoutes); // /api/admin/reset
  app.use('/api/health', health); // public, coarse (demo-health/1)
  app.use('/api/doctor', doctor); // admin only
  for (const { path: mount, router, auth: level, singleTenant } of demo.routes) {
    app.use(mount, ...(singleTenant ? [requireDefaultWorkspace] : []), ...(level === 'admin' ? [requireAdmin] : level === 'user' ? [requireUser] : []), router);
  }
  app.get('/api/customer-config', (_req, res) => res.set('Cache-Control', 'no-store').json(customerConfig()));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get('*', (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  }
  return app;
}
