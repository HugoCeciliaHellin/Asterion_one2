// ============================================================
// ASTERION ONE — Route: /api/command-plans
// IF-REST-002: Command Plans (Create, Sign, Upload)
// Ref: ICD §3.2, IF-REST-002
// Ref: SD-1 (Sequence Diagram — Ed25519 Handshake)
// Req: REQ-SEC-ED25519, REQ-GND-PLAN, REQ-COM-P95
// ============================================================

import { Router } from 'express';
import { asyncHandler, apiError } from '../helpers.js';
import { commandPlans, commands, contactWindows } from '../../db/manager.js';

export function createCommandPlansRouter() {
  const router = Router();

  // ── GET /api/command-plans ─────────────────────────────
  // Query params: ?status, ?contact_window_id, ?limit
  // Response 200: { data: [...] }
  router.get('/', asyncHandler(async (req, res) => {
    const filters = {
      status: req.query.status,
      contact_window_id: req.query.contact_window_id,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
    };

    const data = await commandPlans.list(req.db, filters);
    res.json({ data });
  }));

  // ── GET /api/command-plans/:id ─────────────────────────
  // Response 200: { data: { ...plan, commands: [...] } }
  // Response 404: { error: { code: 'NOT_FOUND' } }
  router.get('/:id', asyncHandler(async (req, res) => {
    const plan = await commandPlans.getById(req.db, req.params.id);
    if (!plan) {
      throw apiError(404, 'NOT_FOUND', `Command plan not found: ${req.params.id}`);
    }
    res.json({ data: plan });
  }));

  // ── POST /api/command-plans ────────────────────────────
  // Body: { contact_window_id?, operator_name, commands: [{ command_type, payload }] }
  // Server assigns sequence_ids (1, 2, 3, ...)
  // Response 201: { data: { id, status: 'DRAFT', commands: [...] } }
  // Response 400: { error: { code: 'VALIDATION_ERROR' } }
  router.post('/', asyncHandler(async (req, res) => {
    const { contact_window_id, operator_name, commands: cmds } = req.body;

    if (!operator_name) {
      throw apiError(400, 'VALIDATION_ERROR', 'operator_name is required');
    }
    if (!Array.isArray(cmds) || cmds.length === 0) {
      throw apiError(400, 'VALIDATION_ERROR', 'commands array with at least one command is required');
    }

    // Validate each command has command_type
    for (let i = 0; i < cmds.length; i++) {
      if (!cmds[i].command_type) {
        throw apiError(400, 'VALIDATION_ERROR', `commands[${i}].command_type is required`);
      }
    }

    // Validate contact_window_id exists if provided
    if (contact_window_id) {
      const window = await contactWindows.getById(req.db, contact_window_id);
      if (!window) {
        throw apiError(400, 'VALIDATION_ERROR', `Contact window not found: ${contact_window_id}`);
      }
    }

    const plan = await commandPlans.create(req.db, {
      contact_window_id,
      operator_name,
      commands: cmds,
    });

    // Audit event
    if (req.auditService) {
      await req.auditService.logEvent(
        'PLAN_CREATED', 'GROUND', 'INFO',
        `Command plan created with ${cmds.length} commands by ${operator_name}`,
        { plan_id: plan.id, command_count: cmds.length }
      );
    }

    res.status(201).json({ data: plan });
  }));

  // ── PATCH /api/command-plans/:id ───────────────────────
  // Sign plan: attach Ed25519 signature
  // Body: { signature, signature_algo?, public_key }
  // Validation: plan.status must be DRAFT
  // Response 200: { data: { status: 'SIGNED' } }
  // Response 409: { error: { code: 'ALREADY_SIGNED' } }
  // Ref: SD-1A steps 6-9
  router.patch('/:id', asyncHandler(async (req, res) => {
    const { signature, signature_algo, public_key } = req.body;

    if (!signature || !public_key) {
      throw apiError(400, 'VALIDATION_ERROR', 'signature and public_key are required');
    }

    try {
      const updated = await commandPlans.sign(req.db, req.params.id, {
        signature,
        signature_algo,
        public_key,
      });

      // Audit event
      if (req.auditService) {
        await req.auditService.logEvent(
          'PLAN_SIGNED', 'GROUND', 'INFO',
          `Command plan signed by operator`,
          { plan_id: req.params.id, signature_algo: updated.signature_algo }
        );
      }

      res.json({ data: updated });
    } catch (err) {
      if (err.message.includes('not found')) {
        throw apiError(404, 'NOT_FOUND', err.message);
      }
      if (err.message.includes('must be DRAFT')) {
        throw apiError(409, 'ALREADY_SIGNED', 'Plan has already been signed or is in a later state');
      }
      throw err;
    }
  }));

  // ── POST /api/command-plans/:id/upload ─────────────────
  // Upload signed plan to Flight Segment via ws_gateway
  // Preconditions (ICD IF-REST-002):
  //   1. plan.status == SIGNED
  //   2. contact_window.status == ACTIVE  (if window assigned)
  //   3. ws_gateway.isFlightConnected() == true
  // Action: Send IF-WS-002 (PLAN_UPLOAD) via ws_gateway
  // Response 202: { data: { status: 'UPLOADED' } }
  // Response 409: { error: { code: 'NOT_SIGNED' | 'WINDOW_NOT_ACTIVE' } }
  // Response 503: { error: { code: 'FLIGHT_DISCONNECTED' } }
  // Ref: SD-1A steps 10-14
  router.post('/:id/upload', asyncHandler(async (req, res) => {
    const plan = await commandPlans.getById(req.db, req.params.id);
    if (!plan) {
      throw apiError(404, 'NOT_FOUND', `Command plan not found: ${req.params.id}`);
    }

    // Precondition 1: Plan must be SIGNED
    if (plan.status !== 'SIGNED') {
      throw apiError(409, 'NOT_SIGNED',
        `Plan must be SIGNED to upload, current status: ${plan.status}`
      );
    }

    // Precondition 2: Contact window must be ACTIVE (if assigned)
    if (plan.contact_window_id) {
      const window = await contactWindows.getById(req.db, plan.contact_window_id);
      if (!window || window.status !== 'ACTIVE') {
        throw apiError(409, 'WINDOW_NOT_ACTIVE',
          `Contact window must be ACTIVE to upload. Current: ${window?.status || 'NOT_FOUND'}`
        );
      }
    }

    // Precondition 3: Flight must be connected via WebSocket
    const wsGateway = req.wsGateway;
    if (!wsGateway || !wsGateway.isFlightConnected()) {
      throw apiError(503, 'FLIGHT_DISCONNECTED',
        'Flight Segment is not connected. Cannot upload plan.'
      );
    }

    // Build PLAN_UPLOAD message per IF-WS-002
    const planUploadMessage = {
      type: 'PLAN_UPLOAD',
      seq_id: 0, // Ground-originated, not part of telemetry sequence
      timestamp: new Date().toISOString(),
      payload: {
        plan_id: plan.id,
        commands: plan.commands.map((cmd) => ({
          sequence_id: cmd.sequence_id,
          command_type: cmd.command_type,
          payload: cmd.payload,
        })),
        signature: plan.signature,
        signature_algo: plan.signature_algo,
        public_key: req.body.public_key || null,
      },
    };

    // Send via WebSocket gateway
    wsGateway.sendToFlight(planUploadMessage);

    // Update plan status to UPLOADED
    const updated = await commandPlans.updateStatus(req.db, plan.id, 'UPLOADED');

    // Mark commands as SENT with timestamp
    const sentAt = new Date().toISOString();
    for (const cmd of plan.commands) {
      await commands.updateStatus(req.db, cmd.id, 'SENT', { sent_at: sentAt });
    }

    // Audit event
    if (req.auditService) {
      await req.auditService.logEvent(
        'PLAN_UPLOADED', 'GROUND', 'INFO',
        `Command plan uploaded to Flight Segment`,
        { plan_id: plan.id, command_count: plan.commands.length }
      );
    }

    res.status(202).json({ data: updated });
  }));

  return router;
}