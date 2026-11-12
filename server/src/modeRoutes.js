// GET /api/mode: the app's Mock/Live setting, whether Live can be chosen, and (in mock mode) the demo account.
// POST /api/mode { mode: "mock" | "live" }: switch (same-origin only). Live needs the live settings; without them the answer is
// 409 live_not_configured naming what to set. A switch ends every web session, because a session holds tokens of one mode only.
import fs from 'node:fs';
import express from 'express';
import { sameOrigin } from './auth/oidc.js';
import { refresh } from './health.js';
import { _clearProbeCache } from './idJagPlayground.js';
import { currentMode, liveReadiness, setMode } from './mode.js';
import { MOCK_USER } from './mock/env.js';
import { mockSigninProblem } from './mockSignin.js';
import { netguard } from './outbound.js';
import { sessionStore } from './sessionStore.js';

const router = express.Router();
router.use(express.json({ limit: '1kb' }));

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || null; } catch { return null; } })();

const view = (req) => {
  const mode = currentMode();
  const live = liveReadiness();
  const blocked = mode === 'mock' ? mockSigninProblem(req) : null;
  return {
    version: VERSION,
    mode,
    live: { ready: live.ready, missing: live.ready ? [] : live.missing },
    // The demo account is public on purpose: it exists only inside the mock PingFederate.
    ...(mode === 'mock' ? { mockUser: { username: MOCK_USER.username, password: MOCK_USER.password }, signin: blocked ? { allowed: false, message: blocked.message } : { allowed: true } } : {}),
  };
};

router.get('/', (req, res) => res.set('Cache-Control', 'no-store').json(view(req)));

router.post('/', sameOrigin, async (req, res) => {
  const next = req.body?.mode;
  if (next !== 'mock' && next !== 'live') return res.status(400).json({ error: 'invalid_mode', message: 'mode must be "mock" or "live"' });
  if (next !== currentMode()) {
    try {
      setMode(next);
    } catch (err) {
      if (err.code === 'live_not_configured') return res.status(409).json({ error: err.code, message: err.message, missing: err.missing });
      return res.status(500).json({ error: 'mode_not_saved', message: 'The mode could not be saved' });
    }
    netguard._reset();
    _clearProbeCache();
    await new Promise((resolve) => { sessionStore.inner.clear(() => resolve()); });
    refresh(); // the health state follows the new mode; the mode field of /api/health is already right
  }
  return res.set('Cache-Control', 'no-store').json(view(req));
});

export default router;
