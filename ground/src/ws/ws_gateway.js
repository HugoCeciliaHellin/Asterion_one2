/**
 * Asterion One — WebSocket Gateway (Stub)
 * ==========================================
 * Minimal WebSocket server for Phase 2 integration testing.
 * Reference: Art.5 §3.2.2 — ws_gateway
 * Reference: Art.8 §2.1 — IF-WS-CONN
 *
 * This is a STUB: it accepts Flight connections, processes messages
 * per the ICD protocol, and replies with ACKs. No database persistence
 * yet (Phase 3 adds PostgreSQL integration).
 *
 * Protocol (Art.8 §2.3):
 *   Flight → Ground:
 *     TELEMETRY      → reply with TELEMETRY_ACK {highest_ack_seq_id}
 *     COMMAND_ACK     → log and store
 *     COMMAND_NACK    → log and store
 *     AUDIT_EVENT     → log and store
 *     REPLAY_REQUEST  → ignored in stub (Phase 3)
 *
 *   Ground → Flight:
 *     PLAN_UPLOAD     → forwarded from REST API (Phase 3)
 *
 * Port: 8081 (configurable via WS_PORT env var)
 */

const { WebSocketServer } = require('ws');

class WsGateway {
  /**
   * @param {Object} options
   * @param {number} options.port - WebSocket port (default: 8081)
   * @param {Function} options.onTelemetry - Callback for telemetry frames
   * @param {Function} options.onAuditEvent - Callback for audit events
   * @param {Function} options.onCommandAck - Callback for command ACKs
   * @param {Function} options.onCommandNack - Callback for command NACKs
   */
  constructor(options = {}) {
    this.port = options.port || parseInt(process.env.WS_PORT || '8081', 10);
    this.onTelemetry = options.onTelemetry || null;
    this.onAuditEvent = options.onAuditEvent || null;
    this.onCommandAck = options.onCommandAck || null;
    this.onCommandNack = options.onCommandNack || null;

    this.wss = null;
    this.flightSocket = null;

    // Telemetry tracking for ACK
    this.highestAckSeqId = 0;

    // In-memory stores (Phase 3 moves to PostgreSQL)
    this.telemetryBuffer = [];
    this.auditEvents = [];
    this.commandAcks = [];
    this.commandNacks = [];

    // Stats
    this.stats = {
      messagesReceived: 0,
      messagesSent: 0,
      telemetryFrames: 0,
      connectCount: 0,
      disconnectCount: 0,
    };
  }

  /**
   * Start the WebSocket server.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port }, () => {
        console.log(`[ws_gateway] Listening on ws://0.0.0.0:${this.port}`);
        resolve();
      });

      this.wss.on('connection', (ws, req) => {
        console.log(`[ws_gateway] Flight connected from ${req.socket.remoteAddress}`);
        this.flightSocket = ws;
        this.stats.connectCount++;

        ws.on('message', (data) => {
          this._handleMessage(ws, data);
        });

        ws.on('close', (code, reason) => {
          console.log(`[ws_gateway] Flight disconnected (code=${code})`);
          this.flightSocket = null;
          this.stats.disconnectCount++;
        });

        ws.on('error', (err) => {
          console.error(`[ws_gateway] WebSocket error: ${err.message}`);
        });
      });
    });
  }

  /**
   * Stop the WebSocket server.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      if (this.flightSocket) {
        this.flightSocket.close(1000, 'Server shutting down');
      }
      if (this.wss) {
        this.wss.close(() => {
          console.log('[ws_gateway] Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Send a message to the connected Flight segment.
   * @param {Object} message - Message envelope (type, seq_id, payload)
   * @returns {boolean} True if sent, false if no connection
   */
  sendToFlight(message) {
    if (!this.flightSocket || this.flightSocket.readyState !== 1) {
      return false;
    }

    const envelope = {
      type: message.type,
      seq_id: message.seq_id || 0,
      timestamp: new Date().toISOString(),
      payload: message.payload || {},
    };

    this.flightSocket.send(JSON.stringify(envelope));
    this.stats.messagesSent++;
    return true;
  }

  /**
   * Send a PLAN_UPLOAD to Flight.
   * @param {Object} planData - {plan_id, commands, signature, public_key}
   * @returns {boolean}
   */
  sendPlanUpload(planData) {
    return this.sendToFlight({
      type: 'PLAN_UPLOAD',
      seq_id: 0,
      payload: planData,
    });
  }

  /**
   * Check if Flight is connected.
   * @returns {boolean}
   */
  isFlightConnected() {
    return this.flightSocket !== null &&
           this.flightSocket.readyState === 1;
  }

  // -----------------------------------------------------------------
  // Internal message handling
  // -----------------------------------------------------------------

  _handleMessage(ws, rawData) {
    this.stats.messagesReceived++;

    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch (e) {
      console.error('[ws_gateway] Invalid JSON received');
      return;
    }

    const { type, seq_id, payload } = msg;

    switch (type) {
      case 'TELEMETRY':
        this._handleTelemetry(ws, seq_id, payload);
        break;

      case 'COMMAND_ACK':
        this.commandAcks.push({ seq_id, payload, received_at: new Date() });
        this.stats.messagesReceived++;
        if (this.onCommandAck) this.onCommandAck(payload);
        break;

      case 'COMMAND_NACK':
        this.commandNacks.push({ seq_id, payload, received_at: new Date() });
        if (this.onCommandNack) this.onCommandNack(payload);
        break;

      case 'AUDIT_EVENT':
        this.auditEvents.push({ seq_id, payload, received_at: new Date() });
        if (this.onAuditEvent) this.onAuditEvent(payload);
        break;

      case 'REPLAY_REQUEST':
        // Phase 3: fetch missing telemetry from DB and re-send
        console.log(`[ws_gateway] REPLAY_REQUEST from=${payload.from_seq_id} (stub: ignored)`);
        break;

      default:
        console.warn(`[ws_gateway] Unknown message type: ${type}`);
    }
  }

  _handleTelemetry(ws, seqId, payload) {
    // Store in buffer
    this.telemetryBuffer.push({
      seq_id: seqId,
      payload,
      received_at: new Date(),
    });
    this.stats.telemetryFrames++;

    // Update highest ACK
    if (seqId > this.highestAckSeqId) {
      this.highestAckSeqId = seqId;
    }

    // Send TELEMETRY_ACK [Art.8 §2.3 IF-WS-005]
    const ack = {
      type: 'TELEMETRY_ACK',
      seq_id: seqId,
      timestamp: new Date().toISOString(),
      payload: {
        highest_ack_seq_id: this.highestAckSeqId,
      },
    };

    ws.send(JSON.stringify(ack));
    this.stats.messagesSent++;

    if (this.onTelemetry) this.onTelemetry(payload);
  }

  // -----------------------------------------------------------------
  // Test helpers
  // -----------------------------------------------------------------

  /**
   * Get all received telemetry seq_ids (for zero-loss verification).
   * @returns {number[]}
   */
  getReceivedSeqIds() {
    return this.telemetryBuffer.map(t => t.seq_id).sort((a, b) => a - b);
  }

  /**
   * Reset all in-memory stores.
   */
  reset() {
    this.telemetryBuffer = [];
    this.auditEvents = [];
    this.commandAcks = [];
    this.commandNacks = [];
    this.highestAckSeqId = 0;
    this.stats = {
      messagesReceived: 0,
      messagesSent: 0,
      telemetryFrames: 0,
      connectCount: this.stats.connectCount,
      disconnectCount: this.stats.disconnectCount,
    };
  }
}

module.exports = { WsGateway };

// -----------------------------------------------------------------
// Standalone execution
// -----------------------------------------------------------------
if (require.main === module) {
  const gw = new WsGateway();
  gw.start().then(() => {
    console.log(`[ws_gateway] Ready. Waiting for Flight connection on port ${gw.port}...`);
  });

  process.on('SIGINT', async () => {
    await gw.stop();
    process.exit(0);
  });
}
