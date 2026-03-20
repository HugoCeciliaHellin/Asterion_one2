// ============================================================
// ASTERION ONE — Route: /api/twin/*
// IF-REST-005: Twin Forecasts & Alerts
// Ref: ICD §3.2, IF-REST-005
// Req: REQ-DT-EARLY-15m, REQ-DT-RATIONALE
// ============================================================

import { Router } from 'express';
import { asyncHandler, apiError } from '../helpers.js';
import { twinForecasts } from '../../db/manager.js';

export function createTwinRouter() {
  const router = Router();

  // ── GET /api/twin/forecasts ────────────────────────────
  // Query params: ?model_type, ?breach_only, ?from, ?to, ?limit
  // Response 200: { data: [...] }
  router.get('/forecasts', asyncHandler(async (req, res) => {
    const filters = {
      model_type: req.query.model_type,
      breach_only: req.query.breach_only === 'true',
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
    };

    const data = await twinForecasts.query(req.db, filters);
    res.json({ data });
  }));

  // ── GET /api/twin/alerts ───────────────────────────────
  // Returns active alerts (breach_detected=true, alert_emitted=true)
  // Response 200: { data: [...] }
  router.get('/alerts', asyncHandler(async (req, res) => {
    const data = await twinForecasts.getActiveAlerts(req.db);
    res.json({ data });
  }));

  // ── POST /api/twin/forecasts ───────────────────────────
  // Body: { model_type, horizon_min, predicted_values,
  //         breach_detected, breach_time?, lead_time_min?,
  //         rationale?, alert_emitted? }
  // Response 201: { data: { id: 'uuid' } }
  router.post('/forecasts', asyncHandler(async (req, res) => {
    const {
      model_type, horizon_min, predicted_values,
      breach_detected, breach_time, lead_time_min,
      rationale, alert_emitted,
    } = req.body;

    // Validate required fields
    if (!model_type || horizon_min == null || !predicted_values) {
      throw apiError(400, 'VALIDATION_ERROR',
        'model_type, horizon_min, and predicted_values are required'
      );
    }

    const validTypes = ['THERMAL', 'ENERGY'];
    if (!validTypes.includes(model_type)) {
      throw apiError(400, 'VALIDATION_ERROR',
        `model_type must be one of: ${validTypes.join(', ')}`
      );
    }

    if (typeof horizon_min !== 'number' || horizon_min <= 0) {
      throw apiError(400, 'VALIDATION_ERROR', 'horizon_min must be a positive number');
    }

    const row = await twinForecasts.insert(req.db, {
      model_type, horizon_min, predicted_values,
      breach_detected: breach_detected || false,
      breach_time, lead_time_min, rationale,
      alert_emitted: alert_emitted || false,
    });

    // If breach detected and alert emitted, log audit event
    if (breach_detected && alert_emitted && req.auditService) {
      await req.auditService.logEvent(
        'TWIN_ALERT', 'TWIN',
        lead_time_min < 15 ? 'CRITICAL' : 'WARNING',
        rationale || `Twin detected ${model_type} breach in ${lead_time_min} min`,
        { forecast_id: row.id, model_type, lead_time_min }
      );
    }

    res.status(201).json({ data: { id: row.id } });
  }));

  return router;
}