// ============================================================
// ASTERION ONE — Route: /api/telemetry
// IF-REST-003: Telemetry Query and Ingest
// Ref: ICD §3.2, IF-REST-003
// Req: REQ-COM-ZERO-LOSS (telemetry delivery verification)
// ============================================================

import { Router } from 'express';
import { asyncHandler, apiError } from '../helpers.js';
import { telemetry } from '../../db/manager.js';

export function createTelemetryRouter() {
  const router = Router();

  // ── GET /api/telemetry ─────────────────────────────────
  // Query params: ?subsystem (comma-sep), ?from, ?to, ?last, ?limit
  // Response 200: { data: [...], meta: { total, returned } }
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

  // ── GET /api/telemetry/latest ──────────────────────────
  // Returns the most recent telemetry frame per subsystem
  // Used by LiveHealthView for dashboard overview
  router.get('/latest', asyncHandler(async (req, res) => {
    const data = await telemetry.getLatestBySubsystem(req.db);
    res.json({ data });
  }));

  // ── POST /api/telemetry ────────────────────────────────
  // Body: { sequence_id, timestamp, subsystem, metrics, fsw_state }
  // Used by ws_gateway internally to ingest received telemetry
  // Response 201: { data: { id: 'uuid' } }
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