// The one web-session store, shared so an admin reset can empty it. ponytail: MemoryStore, one process (see app.js).
// A wrapper over it prefixes every key with the workspace id, so a session cookie only works in its own workspace.
import session from 'express-session';
import { currentWorkspace } from './workspace.js';

class WorkspaceSessionStore extends session.Store {
  constructor(inner) {
    super();
    this.inner = inner;
  }

  key(sid) { return `${currentWorkspace()}:${sid}`; }

  get(sid, cb) { this.inner.get(this.key(sid), cb); }

  set(sid, sess, cb) { this.inner.set(this.key(sid), sess, cb); }

  destroy(sid, cb) { this.inner.destroy(this.key(sid), cb); }

  touch(sid, sess, cb) { this.inner.touch(this.key(sid), sess, cb); }

  /** Drop every session of one workspace and no other. */
  clearWorkspace(id, cb) {
    this.inner.all((err, all) => {
      if (err) return cb?.(err);
      const mine = Object.keys(all || {}).filter((k) => k.startsWith(`${id}:`));
      let left = mine.length;
      if (!left) return cb?.();
      return mine.forEach((k) => this.inner.destroy(k, () => { if (--left === 0) cb?.(); }));
    });
  }
}

export const sessionStore = new WorkspaceSessionStore(new session.MemoryStore());
