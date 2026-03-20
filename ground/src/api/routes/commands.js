// ============================================================
// ASTERION ONE — Route: /api/commands
// Commands List (read-only view of command status)
// Ref: ICD §3.3 summary — /api/commands (G)
// Req: REQ-COM-ZERO-LOSS (verify all commands reach EXECUTED)
// ============================================================

import { Router } from 'express';
import { asyncHandler } from '../helpers.js';
import { commands } from '../../db/manager.js';

export function createCommandsRouter() {
  const router = Router();

  // ── GET /api/commands ──────────────────────────────────
  // Query params: ?status, ?plan_id, ?limit
  // Response 200: { data: [...] }
  router.get('/', asyncHandler(async (req, res) => {
    const filters = {
      status: req.query.status,
      plan_id: req.query.plan_id,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
    };

    const data = await commands.list(req.db, filters);
    res.json({ data });
  }));

  return router;
}