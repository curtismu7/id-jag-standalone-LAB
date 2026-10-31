// GET /api/doctor?mode=mock|pf-as|pf-pf|byo: the doctor's report for an admin. The port check is left out (it is us).
import express from 'express';
import { requireAdmin } from './auth/oidc.js';
import { MODES, runDoctor } from './doctor.js';
import { requireDefaultWorkspace } from './workspace.js';

const router = express.Router();
router.get('/', requireDefaultWorkspace, requireAdmin, async (req, res) => {
  const mode = String(req.query.mode || 'pf-as');
  if (!MODES.includes(mode)) return res.status(400).json({ error: 'invalid_request', message: `mode must be one of ${MODES.join(', ')}` });
  res.json(await runDoctor({ mode, skip: ['port'] }));
});
export default router;
