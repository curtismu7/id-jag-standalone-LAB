// Workspace seam (design 6): a per-request workspace id that keys the data directory, sessions and trace sink.
// Local runs always use 'default', which maps to DATA_DIR itself, so nothing changes. A client never picks an id:
// only the resolver passed to createApp() does, and the default resolver ignores the request.
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { config } from './config.js';

export const DEFAULT_WORKSPACE = 'default';
const VALID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const als = new AsyncLocalStorage();

export const validWorkspaceId = (id) => typeof id === 'string' && VALID.test(id);

/** 'default' is DATA_DIR itself (existing data stays put); any other id is <root>/ws/<id>/. */
export const workspaceDir = (root, id) => (id === DEFAULT_WORKSPACE ? root : path.join(root, 'ws', id));

/** The workspace of the running request; 'default' outside one (CLI scripts, tests). */
export const currentWorkspace = () => als.getStore() ?? DEFAULT_WORKSPACE;

export const runInWorkspace = (id, fn) => als.run(id, fn);

/** The data directory of a workspace (default: the current one). The only reader of config().dataDir. */
export const dataDir = (id = currentWorkspace()) => workspaceDir(config().dataDir, id);

/** Resolve the id for this request, refuse a bad one (400), and run the rest of the chain inside it. */
export function workspaceMiddleware(resolver) {
  return (req, res, next) => {
    let id;
    try { id = resolver(req); } catch { id = null; }
    if (!validWorkspaceId(id)) return res.status(400).json({ error: 'bad_workspace' });
    req.workspaceId = id;
    return als.run(id, next);
  };
}

/** Fail closed for anything that is still single-tenant (shared files, live PingFederate, in-process maps). */
export const requireDefaultWorkspace = (_req, res, next) => (currentWorkspace() === DEFAULT_WORKSPACE
  ? next() : res.status(403).json({ error: 'workspace_not_supported' }));
