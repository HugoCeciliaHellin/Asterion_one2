import { Router } from 'express';
import { asyncHandler } from '../helpers.js';
import { commands } from '../../db/manager.js';

export function createCommandsRouter() {
  const router = Router();


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