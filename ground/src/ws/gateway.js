// ============================================================
// ASTERION ONE — ws_gateway.js (Phase 3 — Full Implementation)
// Ground Segment WebSocket Gateway
// ============================================================
// Ref: Art.5 §3.2.2 — Component: ws_gateway
// Ref: Art.8 §2 (ICD) — IF-WS-001 through IF-WS-007
//
// REPLACES: Phase 2 stub (in-memory only)
// NEW: Persists to PostgreSQL via db_manager
//
// Interfaces Provided (IWebSocketGateway):
//   - sendToFlight(msg) → void
//   - isFlightConnected() → bool
//   - getStats() → object
//
// Interfaces Required:
//   - IDatabase (db_manager)
//   - IAuditService (audit_service) [optional]
//
// Port: WS_PORT (default 8081)
// Path: /flight (for Flight Segment client)
// Path: /ui     (for Ground UI WebSocket subscription)
// ============================================================

import { WebSocketServer, WebSocket } from 'ws';
import { telemetry, auditEvents, commandPlans, commands } from '../db/manager.js';

// ──────────────────────────────────────────────────────────
// Gateway Factory
// ──────────────────────────────────────────────────────────

/**
 * Create and start the WebSocket gateway.
 *
 * @param {object} options
 * @param {import('knex').Knex} options.db - Database connection
 * @param {number} [options.port=8081] - WebSocket server port
 * @param {object} [options.auditService] - Audit service for Ground events
 * @param {import('http').Server} [options.server] - Existing HTTP server to attach to
 * @returns {WsGateway}
 */
export function createWsGateway({ db, port = 8081, auditService = null, server = null }) {
  return new WsGateway({ db, port, auditService, server });
}

// ──────────────────────────────────────────────────────────
// WsGateway Class
// ──────────────────────────────────────────────────────────

class WsGateway {
  constructor({ db, port, auditService, server }) {
    this.db = db;
    this.auditService = auditService;
    this.port = port;

    /** @type {WebSocket|null} Flight client connection */
    this._flightClient = null;

    /** @type {Set<WebSocket>} UI subscriber connections */
    this._uiClients = new Set();

    /** @type {object} Statistics tracking */
    this._stats = {
      telemetryReceived: 0,
      telemetryAcksSent: 0,
      commandAcksReceived: 0,
      commandNacksReceived: 0,
      auditEventsReceived: 0,
      plansUploaded: 0,
      replayRequestsReceived: 0,
      highestTelemetrySeqId: 0,
    };

    this._startTime = Date.now();

    // Create WS server
    const wssOptions = server
      ? { server, path: undefined } // When using HTTP server, handle paths manually
      : { port };

    this._wss = new WebSocketServer(wssOptions);
    this._setupServer();

    if (!server) {
      console.log(`[ws_gateway] WebSocket server listening on port ${port}`);
    }
  }

  // ── Server Setup ─────────────────────────────────────────

  _setupServer() {
    this._wss.on('connection', (ws, req) => {
      const path = req.url || '/';

      if (path === '/flight' || path.startsWith('/flight')) {
        this._handleFlightConnection(ws);
      } else if (path === '/ui' || path.startsWith('/ui')) {
        this._handleUiConnection(ws);
      } else {
        // Default: treat as flight connection for backward compatibility
        this._handleFlightConnection(ws);
      }
    });

    this._wss.on('error', (err) => {
      console.error(`[ws_gateway] Server error: ${err.message}`);
    });
  }

  // ── Flight Client Connection ──────────────────────────────

  _handleFlightConnection(ws) {
    // Only allow one Flight client at a time
    if (this._flightClient && this._flightClient.readyState === WebSocket.OPEN) {
      console.warn('[ws_gateway] Replacing existing Flight connection');
      this._flightClient.close(1000, 'Replaced by new connection');
    }

    this._flightClient = ws;
    console.log('[ws_gateway] Flight Segment connected');

    // Broadcast connection status to UI
    this._broadcastToUi({
      type: 'FLIGHT_STATUS',
      payload: { connected: true },
      timestamp: new Date().toISOString(),
    });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        await this._handleFlightMessage(msg);
      } catch (err) {
        console.error(`[ws_gateway] Error processing Flight message: ${err.message}`);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`[ws_gateway] Flight Segment disconnected (code=${code})`);
      this._flightClient = null;

      this._broadcastToUi({
        type: 'FLIGHT_STATUS',
        payload: { connected: false, code, reason: reason?.toString() },
        timestamp: new Date().toISOString(),
      });
    });

    ws.on('error', (err) => {
      console.error(`[ws_gateway] Flight client error: ${err.message}`);
    });

    // Start ping/pong heartbeat (30s per ICD §2.1)
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    ws.on('close', () => clearInterval(pingInterval));
  }

  // ── UI Client Connection ──────────────────────────────────

  _handleUiConnection(ws) {
    this._uiClients.add(ws);
    console.log(`[ws_gateway] UI client connected (total: ${this._uiClients.size})`);

    // Send initial status — deferred to next timers phase so the
    // client has time to register its 'message' listener before
    // the message arrives (avoids race condition: 101 Switching
    // Protocols and FLIGHT_STATUS otherwise arrive in the same
    // TCP segment and are processed before the Promise chain
    // microtask can register the listener).
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'FLIGHT_STATUS',
          payload: { connected: this.isFlightConnected() },
          timestamp: new Date().toISOString(),
        }));
      }
    }, 0);

    ws.on('close', () => {
      this._uiClients.delete(ws);
      console.log(`[ws_gateway] UI client disconnected (total: ${this._uiClients.size})`);
    });

    ws.on('error', (err) => {
      console.error(`[ws_gateway] UI client error: ${err.message}`);
      this._uiClients.delete(ws);
    });
  }

  // ── Message Dispatcher ────────────────────────────────────

  /**
   * Route inbound Flight messages to appropriate handlers.
   * Ref: ICD §2.3 — Message type catalog
   * @param {object} msg - Parsed WebSocket message
   */
  async _handleFlightMessage(msg) {
    const { type } = msg;

    switch (type) {
      case 'TELEMETRY':
        await this._handleTelemetry(msg);
        break;
      case 'COMMAND_ACK':
        await this._handleCommandAck(msg);
        break;
      case 'COMMAND_NACK':
        await this._handleCommandNack(msg);
        break;
      case 'AUDIT_EVENT':
        await this._handleAuditEvent(msg);
        break;
      case 'REPLAY_REQUEST':
        await this._handleReplayRequest(msg);
        break;
      default:
        console.warn(`[ws_gateway] Unknown message type: ${type}`);
    }
  }

  // ── IF-WS-001: TELEMETRY Handler ─────────────────────────
  // Flight → Ground: Periodic telemetry frame
  // Action: INSERT into telemetry table, send TELEMETRY_ACK
  // Ref: ICD IF-WS-001, IF-WS-005

  async _handleTelemetry(msg) {
    const { seq_id, timestamp, payload } = msg;
    const { fsw_state, subsystems } = payload;

    this._stats.telemetryReceived++;

    // Track highest seq_id for store-and-forward verification
    if (seq_id > this._stats.highestTelemetrySeqId) {
      this._stats.highestTelemetrySeqId = seq_id;
    }

    // Persist each subsystem as a separate telemetry row
    // Ref: ERD Art.2 §3.4 — one row per subsystem per frame
    const insertPromises = [];
    for (const [subsystem, metrics] of Object.entries(subsystems || {})) {
      insertPromises.push(
        telemetry.insert(this.db, {
          sequence_id: seq_id,
          timestamp,
          subsystem,
          metrics,
          fsw_state,
        }).catch((err) => {
          console.error(`[ws_gateway] Failed to persist telemetry (sub=${subsystem}): ${err.message}`);
        })
      );
    }

    await Promise.all(insertPromises);

    // Send TELEMETRY_ACK (IF-WS-005)
    this._sendToFlightRaw({
      type: 'TELEMETRY_ACK',
      seq_id,
      timestamp: new Date().toISOString(),
      payload: {
        acked_seq_id: seq_id,
      },
    });

    this._stats.telemetryAcksSent++;

    // Broadcast to UI clients for live dashboard
    this._broadcastToUi({
      type: 'TELEMETRY',
      seq_id,
      timestamp,
      payload,
    });
  }

  // ── IF-WS-003: COMMAND_ACK Handler ────────────────────────
  // Flight → Ground: Command executed successfully
  // Action: UPDATE commands SET status=EXECUTED, executed_at
  //         Check if all commands done → plan COMPLETED
  // Ref: ICD IF-WS-003

  async _handleCommandAck(msg) {
    const { payload } = msg;
    const { plan_id, command_seq_id, status, executed_at } = payload;

    this._stats.commandAcksReceived++;

    try {
      // Find the command by plan_id + sequence_id
      const planCmds = await commands.getByPlanId(this.db, plan_id);
      const cmd = planCmds.find((c) => c.sequence_id === command_seq_id);

      if (!cmd) {
        console.warn(`[ws_gateway] ACK for unknown command: plan=${plan_id}, seq=${command_seq_id}`);
        return;
      }

      // Update command status
      await commands.updateStatus(this.db, cmd.id, status || 'EXECUTED', {
        acked_at: new Date().toISOString(),
        executed_at: executed_at || new Date().toISOString(),
      });

      // Check if ALL commands in this plan are now EXECUTED
      const updatedCmds = await commands.getByPlanId(this.db, plan_id);
      const allExecuted = updatedCmds.every((c) => c.status === 'EXECUTED');

      if (allExecuted) {
        // Transition plan to COMPLETED
        try {
          await commandPlans.updateStatus(this.db, plan_id, 'EXECUTING');
        } catch {
          // May already be in EXECUTING state
        }
        try {
          await commandPlans.updateStatus(this.db, plan_id, 'COMPLETED');
          console.log(`[ws_gateway] Plan ${plan_id} COMPLETED (all commands executed)`);
        } catch (err) {
          // Transition might fail if already completed
          console.warn(`[ws_gateway] Could not complete plan: ${err.message}`);
        }
      }

      // Broadcast to UI
      this._broadcastToUi({
        type: 'COMMAND_ACK',
        payload: { plan_id, command_seq_id, status: status || 'EXECUTED' },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[ws_gateway] Error processing COMMAND_ACK: ${err.message}`);
    }
  }

  // ── IF-WS-004: COMMAND_NACK Handler ───────────────────────
  // Flight → Ground: Plan rejected
  // Action: UPDATE command_plans SET status=REJECTED
  //         UPDATE all commands SET status=FAILED
  //         INSERT audit_event (COMMAND_REJECTED, CRITICAL)
  // Ref: ICD IF-WS-004

  async _handleCommandNack(msg) {
    const { payload } = msg;
    const { plan_id, reason, detail } = payload;

    this._stats.commandNacksReceived++;

    try {
      // Reject the plan
      try {
        // May need to transition through EXECUTING first
        const plan = await commandPlans.getById(this.db, plan_id);
        if (plan && plan.status === 'UPLOADED') {
          await commandPlans.updateStatus(this.db, plan_id, 'EXECUTING');
        }
      } catch {
        // Ignore intermediate transition errors
      }

      try {
        await commandPlans.updateStatus(this.db, plan_id, 'REJECTED');
      } catch (err) {
        console.warn(`[ws_gateway] Could not reject plan: ${err.message}`);
      }

      // Mark all commands as FAILED
      await commands.bulkUpdateByPlanId(this.db, plan_id, 'FAILED');

      console.log(`[ws_gateway] Plan ${plan_id} REJECTED: ${reason} — ${detail}`);

      // Log audit event via audit_service if available
      if (this.auditService) {
        await this.auditService.logEvent(
          'COMMAND_REJECTED', 'FLIGHT', 'CRITICAL',
          `Plan ${plan_id} rejected: ${reason}. ${detail || ''}`.trim(),
          { plan_id, reason, detail }
        );
      }

      // Broadcast to UI
      this._broadcastToUi({
        type: 'COMMAND_NACK',
        payload: { plan_id, reason, detail },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[ws_gateway] Error processing COMMAND_NACK: ${err.message}`);
    }
  }

  // ── IF-WS-006: AUDIT_EVENT Handler ────────────────────────
  // Flight → Ground: Hash-chained audit event
  // Action: INSERT into audit_events table (preserving Flight chain)
  // Ref: ICD IF-WS-006, Art.2 §3.5

  async _handleAuditEvent(msg) {
    const { payload } = msg;
    const { event_type, source, severity, description, metadata, hash, prev_hash } = payload;

    this._stats.auditEventsReceived++;

    try {
      await auditEvents.insert(this.db, {
        timestamp: msg.timestamp,
        event_type,
        source: source || 'FLIGHT',
        severity,
        description,
        metadata: metadata || {},
        hash,
        prev_hash,
      });

      // Broadcast to UI
      this._broadcastToUi({
        type: 'AUDIT_EVENT',
        payload,
        timestamp: msg.timestamp,
      });
    } catch (err) {
      console.error(`[ws_gateway] Error persisting audit event: ${err.message}`);
    }
  }

  // ── IF-WS-007: REPLAY_REQUEST Handler ─────────────────────
  // Flight → Ground: Request to resend pending commands
  // Action: Resend all commands with seq_id > last_acked that are QUEUED/SENT
  // Ref: ICD IF-WS-007

  async _handleReplayRequest(msg) {
    const { payload } = msg;
    const { last_acked_seq_id, direction } = payload;

    this._stats.replayRequestsReceived++;

    if (direction !== 'GROUND_TO_FLIGHT') {
      console.warn(`[ws_gateway] Ignoring REPLAY_REQUEST with direction: ${direction}`);
      return;
    }

    try {
      // Find pending commands (QUEUED or SENT)
      const pendingCmds = await commands.list(this.db, { status: 'QUEUED' });
      const sentCmds = await commands.list(this.db, { status: 'SENT' });
      const allPending = [...pendingCmds, ...sentCmds];

      console.log(`[ws_gateway] REPLAY_REQUEST: Resending ${allPending.length} pending commands`);

      // Group by plan and resend
      const planIds = [...new Set(allPending.map((c) => c.plan_id))];

      for (const planId of planIds) {
        const plan = await commandPlans.getById(this.db, planId);
        if (!plan || !plan.signature) continue;

        // Resend as PLAN_UPLOAD
        this._sendToFlightRaw({
          type: 'PLAN_UPLOAD',
          seq_id: 0,
          timestamp: new Date().toISOString(),
          payload: {
            plan_id: plan.id,
            commands: plan.commands.map((c) => ({
              sequence_id: c.sequence_id,
              command_type: c.command_type,
              payload: c.payload,
            })),
            signature: plan.signature,
            signature_algo: plan.signature_algo,
          },
        });
      }
    } catch (err) {
      console.error(`[ws_gateway] Error processing REPLAY_REQUEST: ${err.message}`);
    }
  }

  // ── IWebSocketGateway Interface ───────────────────────────
  // These methods are called by api_server (upload endpoint)

  /**
   * Send a message to the Flight Segment.
   * Used by api_server POST /api/command-plans/:id/upload
   * @param {object} msg - Message conforming to ICD §2.2 envelope
   */
  sendToFlight(msg) {
    if (!this.isFlightConnected()) {
      throw new Error('[ws_gateway] Cannot send: Flight not connected');
    }
    this._sendToFlightRaw(msg);
    this._stats.plansUploaded++;
  }

  /**
   * Check if the Flight Segment is connected.
   * @returns {boolean}
   */
  isFlightConnected() {
    return this._flightClient !== null &&
           this._flightClient.readyState === WebSocket.OPEN;
  }

  /**
   * Get gateway statistics.
   * @returns {object}
   */
  getStats() {
    return {
      ...this._stats,
      flightConnected: this.isFlightConnected(),
      uiClientsConnected: this._uiClients.size,
      uptimeMs: Date.now() - this._startTime,
    };
  }

  // ── Internal Helpers ──────────────────────────────────────

  /**
   * Send raw message to Flight client.
   * @param {object} msg
   */
  _sendToFlightRaw(msg) {
    if (this._flightClient && this._flightClient.readyState === WebSocket.OPEN) {
      this._flightClient.send(JSON.stringify(msg));
    }
  }

  /**
   * Broadcast a message to all connected UI clients.
   * Used for live updates (telemetry, status changes, alerts).
   * @param {object} msg
   */
  _broadcastToUi(msg) {
    const data = JSON.stringify(msg);
    for (const client of this._uiClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Graceful shutdown — close all connections and the server.
   * @returns {Promise<void>}
   */
  async close() {
    // Close Flight client
    if (this._flightClient) {
      this._flightClient.close(1000, 'Gateway shutting down');
      this._flightClient = null;
    }

    // Close all UI clients
    for (const client of this._uiClients) {
      client.close(1000, 'Gateway shutting down');
    }
    this._uiClients.clear();

    // Close server
    return new Promise((resolve) => {
      this._wss.close(() => {
        console.log('[ws_gateway] Server closed');
        resolve();
      });
    });
  }
}

export default { createWsGateway };