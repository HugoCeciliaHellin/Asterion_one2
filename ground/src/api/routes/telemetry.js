
import { Router } from 'express';
import { asyncHandler, apiError } from '../helpers.js';
import { telemetry } from '../../db/manager.js';

export function createTelemetryRouter() {
  const router = Router();

  
  router.get('/', asyncHandler(async (req, res) => {
    const filters = {
      subsystem: req.query.subsystem,
      from: req.query.from,
      to: req.query.to,
      last: req.query.last,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
    };

    const result = await telemetry.query(req.db, filters);
    res.json(result);
  }));


  router.get('/latest', asyncHandler(async (req, res) => {
    const data = await telemetry.getLatestBySubsystem(req.db);
    res.json({ data });
  }));


  router.post('/', asyncHandler(async (req, res) => {
    const { sequence_id, timestamp, subsystem, metrics, fsw_state } = req.body;

    if (sequence_id == null || !timestamp || !subsystem || !metrics || !fsw_state) {
      throw apiError(400, 'VALIDATION_ERROR',
        'sequence_id, timestamp, subsystem, metrics, and fsw_state are required'
      );
    }

    const validSubsystems = ['THERMAL', 'POWER', 'COMMS', 'CPU', 'FSW'];
    if (!validSubsystems.includes(subsystem)) {
      throw apiError(400, 'VALIDATION_ERROR',
        `subsystem must be one of: ${validSubsystems.join(', ')}`
      );
    }

    const validStates = ['BOOT', 'NOMINAL', 'SAFE', 'CRITICAL'];
    if (!validStates.includes(fsw_state)) {
      throw apiError(400, 'VALIDATION_ERROR',
        `fsw_state must be one of: ${validStates.join(', ')}`
      );
    }

    const row = await telemetry.insert(req.db, {
      sequence_id, timestamp, subsystem, metrics, fsw_state,
    });

    res.status(201).json({ data: { id: row.id } });
  }));

  return router;
}