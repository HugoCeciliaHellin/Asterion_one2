// ============================================================
// ASTERION ONE — Route: /api/contact-windows
// IF-REST-001: Contact Windows CRUD
// Ref: ICD §3.2, IF-REST-001
// Req: REQ-GND-PLAN
// ============================================================

import { Router } from 'express';
import { asyncHandler, apiError } from '../helpers.js';
import { contactWindows } from '../../db/manager.js';

export function createContactWindowsRouter() {
  const router = Router();

  // ── GET /api/contact-windows ───────────────────────────
  // Query params: ?status, ?from, ?to
  // Response 200: { data: [...] }
  router.get('/', asyncHandler(async (req, res) => {
    const filters = {
      status: req.query.status,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
    };

    const data = await contactWindows.list(req.db, filters);
    res.json({ data });
  }));

  // ── GET /api/contact-windows/:id ───────────────────────
  // Response 200: { data: {...} }
  // Response 404: { error: { code: 'NOT_FOUND' } }
  router.get('/:id', asyncHandler(async (req, res) => {
    const window = await contactWindows.getById(req.db, req.params.id);
    if (!window) {
      throw apiError(404, 'NOT_FOUND', `Contact window not found: ${req.params.id}`);
    }
    res.json({ data: window });
  }));

  // ── POST /api/contact-windows ──────────────────────────
  // Body: { name, aos_time, los_time }
  // Validation: los_time > aos_time, no overlap
  // Response 201: { data: { id, status: 'SCHEDULED' } }
  // Response 400: { error: { code: 'VALIDATION_ERROR' | 'OVERLAP' } }
  router.post('/', asyncHandler(async (req, res) => {
    const { name, aos_time, los_time } = req.body;

    // Validate required fields
    if (!name || !aos_time || !los_time) {
      throw apiError(400, 'VALIDATION_ERROR', 'name, aos_time, and los_time are required');
    }

    // Validate time ordering
    if (new Date(los_time) <= new Date(aos_time)) {
      throw apiError(400, 'VALIDATION_ERROR', 'los_time must be after aos_time');
    }

    // Check for overlap with existing windows
    const overlaps = await contactWindows.findOverlapping(req.db, aos_time, los_time);
    if (overlaps.length > 0) {
      throw apiError(400, 'OVERLAP',
        `Window overlaps with existing window: ${overlaps[0].name} (${overlaps[0].id})`
      );
    }

    const window = await contactWindows.create(req.db, { name, aos_time, los_time });

    // Log audit event if audit service available
    if (req.auditService) {
      await req.auditService.logEvent(
        'WINDOW_CREATED', 'GROUND', 'INFO',
        `Contact window created: ${name}`,
        { window_id: window.id, aos_time, los_time }
      );
    }

    res.status(201).json({ data: window });
  }));

  // ── PATCH /api/contact-windows/:id ─────────────────────
  // Body: { status: 'ACTIVE' | 'CANCELLED' | 'COMPLETED' }
  // Allowed transitions per Art.2 §3.1:
  //   SCHEDULED → ACTIVE | CANCELLED
  //   ACTIVE → COMPLETED
  // Response 200: { data: { ...updated } }
  // Response 409: { error: { code: 'INVALID_TRANSITION' } }
  router.patch('/:id', asyncHandler(async (req, res) => {
    const { status } = req.body;

    if (!status) {
      throw apiError(400, 'VALIDATION_ERROR', 'status is required');
    }

    try {
      const updated = await contactWindows.updateStatus(req.db, req.params.id, status);
      res.json({ data: updated });
    } catch (err) {
      if (err.message.includes('not found')) {
        throw apiError(404, 'NOT_FOUND', err.message);
      }
      if (err.message.includes('Invalid transition')) {
        throw apiError(409, 'INVALID_TRANSITION', err.message);
      }
      throw err;
    }
  }));

  return router;
}