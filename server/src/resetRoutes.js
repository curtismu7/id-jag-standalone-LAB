// POST /api/admin/reset { confirm: "reset" }: admin only, same-origin only. Returns what was cleared; 502 when
// PingFederate could not remove some registered users (local state is reset regardless).

import express from 'express';
import { requireAdmin, sameOrigin } from './auth/oidc.js';
import { _clearProbeCache } from './idJagPlayground.js';
import { removeUserForReset as removeUser } from './idp/index.js';
import { resetRateLimit } from './registrationRoutes.js';
import { removeClient } from './registry/clients.js';
import { reset } from './reset.js';
import { sessionStore } from './sessionStore.js';
import { currentWorkspace, dataDir } from './workspace.js';

const router = express.Router();
router.use('/admin/reset', express.json({ limit: '1kb' }), sameOrigin, requireAdmin);

router.post('/admin/reset', async (req, res) => {
  if (req.body?.confirm !== 'reset') return res.status(400).json({ error: 'invalid_request', message: 'send {"confirm":"reset"}' });
  const report = await reset({
    dataDir: dataDir(), now: new Date(), actor: req.session.user.email, removeUser, removeClient,
    clearSessions: (cb) => sessionStore.clearWorkspace(currentWorkspace(), cb), clearMemory: [_clearProbeCache, resetRateLimit],
  });
  return res.status(report.ok ? 200 : 502).json(report);
});

export default router;
