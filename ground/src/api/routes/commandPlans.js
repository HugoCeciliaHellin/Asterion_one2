
import { Router } from 'express';
import { asyncHandler, apiError } from '../helpers.js';
import { commandPlans, commands, contactWindows } from '../../db/manager.js';

export function createCommandPlansRouter() {
  const router = Router();

  
  router.get('/', asyncHandler(async (req, res) => {
    const filters = {
      status: req.query.status,
      contact_window_id: req.query.contact_window_id,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
    };

    const data = await commandPlans.list(req.db, filters);
    res.json({ data });
  }));


  router.get('/:id', asyncHandler(async (req, res) => {
    const plan = await commandPlans.getById(req.db, req.params.id);
    if (!plan) {
      throw apiError(404, 'NOT_FOUND', `Command plan not found: ${req.params.id}`);
    }
    res.json({ data: plan });
  }));

 
  router.post('/', asyncHandler(async (req, res) => {
    const { contact_window_id, operator_name, commands: cmds } = req.body;

    if (!operator_name) {
      throw apiError(400, 'VALIDATION_ERROR', 'operator_name is required');
    }
    if (!Array.isArray(cmds) || cmds.length === 0) {
      throw apiError(400, 'VALIDATION_ERROR', 'commands array with at least one command is required');
    }

    for (let i = 0; i < cmds.length; i++) {
      if (!cmds[i].command_type) {
        throw apiError(400, 'VALIDATION_ERROR', `commands[${i}].command_type is required`);
      }
    }

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


  router.post('/:id/upload', asyncHandler(async (req, res) => {
    const plan = await commandPlans.getById(req.db, req.params.id);
    if (!plan) {
      throw apiError(404, 'NOT_FOUND', `Command plan not found: ${req.params.id}`);
    }

    if (plan.status !== 'SIGNED') {
      throw apiError(409, 'NOT_SIGNED',
        `Plan must be SIGNED to upload, current status: ${plan.status}`
      );
    }

    
    const wsGateway = req.wsGateway;
    if (!wsGateway || !wsGateway.isFlightConnected()) {
      throw apiError(503, 'FLIGHT_DISCONNECTED',
        'Flight Segment is not connected. Cannot upload plan.'
      );
    }

    if (plan.contact_window_id) {
      const window = await contactWindows.getById(req.db, plan.contact_window_id);
      if (!window || window.status !== 'ACTIVE') {
        throw apiError(409, 'WINDOW_NOT_ACTIVE',
          `Contact window must be ACTIVE to upload. Current: ${window?.status || 'NOT_FOUND'}`
        );
      }
    }

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