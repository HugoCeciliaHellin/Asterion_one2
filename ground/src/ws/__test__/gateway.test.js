// ============================================================
// ASTERION ONE — ws_gateway Tests
// ============================================================
// Integration tests for WebSocket gateway (Phase 3 upgrade).
// Validates: DB persistence, ACK/NACK handling, UI broadcast.
// Requires running PostgreSQL (docker compose up).
//
// Run: npm test -- src/ws/__tests__/gateway.test.js
// ============================================================

import { jest } from '@jest/globals';
import { WebSocket } from 'ws';
import { createWsGateway } from '../gateway.js';
import dbManager from '../../db/manager.js';

const {
  createConnection, runMigrations, rollbackMigrations, destroyConnection,
  contactWindows, commandPlans, commands, telemetry, auditEvents,
} = dbManager;

let db;
let gateway;
const TEST_PORT = 18081; // Avoid conflict with real services

// ── Helpers ──────────────────────────────────────────────

/**
 * Connect a WebSocket client to the gateway.
 * @param {string} path - '/flight' or '/ui'
 * @returns {Promise<WebSocket>}
 */
function connectClient(path = '/flight') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/**
 * Send a message and optionally wait for a response.
 * @param {WebSocket} ws
 * @param {object} msg
 * @param {number} [waitMs=100] - ms to wait for response
 * @returns {Promise<object|null>}
 */
function sendAndWait(ws, msg, waitMs = 200) {
  return new Promise((resolve) => {
    let response = null;
    const handler = (raw) => {
      response = JSON.parse(raw.toString());
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(msg));
    setTimeout(() => {
      ws.off('message', handler);
      resolve(response);
    }, waitMs);
  });
}

/**
 * Collect all messages received during a time window.
 * @param {WebSocket} ws
 * @param {number} [waitMs=200]
 * @returns {Promise<object[]>}
 */
function collectMessages(ws, waitMs = 300) {
  return new Promise((resolve) => {
    const messages = [];
    const handler = (raw) => {
      messages.push(JSON.parse(raw.toString()));
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(messages);
    }, waitMs);
  });
}

/**
 * Close a WebSocket client gracefully.
 * @param {WebSocket} ws
 */
function closeClient(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', resolve);
    ws.close();
  });
}

// Small delay helper
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Setup / Teardown ─────────────────────────────────────

beforeAll(async () => {
  db = createConnection('test');
  await rollbackMigrations(db).catch(() => {});
  await runMigrations(db);
});

afterAll(async () => {
  await rollbackMigrations(db);
  await destroyConnection(db);
});

beforeEach(async () => {
  // Clean tables
  await db('twin_forecasts').del();
  await db('audit_events').del();
  await db('telemetry').del();
  await db('commands').del();
  await db('command_plans').del();
  await db('contact_windows').del();

  // Create fresh gateway for each test
  gateway = createWsGateway({ db, port: TEST_PORT });
  await delay(100); // Wait for server to start
});

afterEach(async () => {
  if (gateway) {
    await gateway.close();
    gateway = null;
  }
  await delay(50);
});

// ──────────────────────────────────────────────────────────
// Connection Management
// ──────────────────────────────────────────────────────────

describe('Connection Management', () => {
  test('Flight client connects on /flight path', async () => {
    const flight = await connectClient('/flight');

    expect(gateway.isFlightConnected()).toBe(true);

    await closeClient(flight);
  });

  test('isFlightConnected returns false when no client', () => {
    expect(gateway.isFlightConnected()).toBe(false);
  });

  test('isFlightConnected returns false after disconnect', async () => {
    const flight = await connectClient('/flight');
    expect(gateway.isFlightConnected()).toBe(true);

    await closeClient(flight);
    await delay(50);

    expect(gateway.isFlightConnected()).toBe(false);
  });

  test('UI client connects on /ui path and receives FLIGHT_STATUS', async () => {
    const ui = await connectClient('/ui');
    const msgs = await collectMessages(ui, 200);

    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0].type).toBe('FLIGHT_STATUS');
    expect(msgs[0].payload.connected).toBe(false); // No flight connected yet

    await closeClient(ui);
  });

  test('UI client receives FLIGHT_STATUS when Flight connects', async () => {
    const ui = await connectClient('/ui');
    await delay(100); // Consume initial FLIGHT_STATUS

    // Now connect flight and collect UI messages
    const msgPromise = collectMessages(ui, 300);
    const flight = await connectClient('/flight');
    const msgs = await msgPromise;

    const statusMsg = msgs.find((m) => m.type === 'FLIGHT_STATUS' && m.payload.connected === true);
    expect(statusMsg).toBeDefined();

    await closeClient(flight);
    await closeClient(ui);
  });

  test('getStats returns accurate counters', async () => {
    const stats = gateway.getStats();

    expect(stats.flightConnected).toBe(false);
    expect(stats.uiClientsConnected).toBe(0);
    expect(stats.telemetryReceived).toBe(0);
    expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});

// ──────────────────────────────────────────────────────────
// IF-WS-001: TELEMETRY → DB Persistence + ACK
// ──────────────────────────────────────────────────────────

describe('TELEMETRY handling (IF-WS-001 + IF-WS-005)', () => {
  test('persists telemetry to database and sends TELEMETRY_ACK', async () => {
    const flight = await connectClient('/flight');

    const telemetryMsg = {
      type: 'TELEMETRY',
      seq_id: 42,
      timestamp: '2026-03-10T14:00:01.000Z',
      payload: {
        fsw_state: 'NOMINAL',
        subsystems: {
          THERMAL: { cpu_temp_c: 62.3, board_temp_c: 45.1 },
          POWER: { voltage_v: 5.1, current_ma: 820 },
        },
      },
    };

    const ack = await sendAndWait(flight, telemetryMsg);

    // Verify ACK format per IF-WS-005
    expect(ack).not.toBeNull();
    expect(ack.type).toBe('TELEMETRY_ACK');
    expect(ack.payload.acked_seq_id).toBe(42);

    // Verify DB persistence — one row per subsystem
    const rows = await db('telemetry').orderBy('subsystem', 'asc');
    expect(rows.length).toBe(2);
    expect(rows[0].subsystem).toBe('POWER');
    expect(rows[0].sequence_id).toBe(42);
    expect(rows[0].fsw_state).toBe('NOMINAL');
    expect(rows[1].subsystem).toBe('THERMAL');

    // Verify stats
    const stats = gateway.getStats();
    expect(stats.telemetryReceived).toBe(1);
    expect(stats.telemetryAcksSent).toBe(1);
    expect(stats.highestTelemetrySeqId).toBe(42);

    await closeClient(flight);
  });

  test('broadcasts telemetry to UI clients', async () => {
    const flight = await connectClient('/flight');
    const ui = await connectClient('/ui');
    await delay(100); // Consume initial status messages

    const uiMsgPromise = collectMessages(ui, 300);

    flight.send(JSON.stringify({
      type: 'TELEMETRY',
      seq_id: 1,
      timestamp: new Date().toISOString(),
      payload: {
        fsw_state: 'NOMINAL',
        subsystems: { THERMAL: { cpu_temp_c: 60 } },
      },
    }));

    const uiMsgs = await uiMsgPromise;
    const telemMsg = uiMsgs.find((m) => m.type === 'TELEMETRY');
    expect(telemMsg).toBeDefined();
    expect(telemMsg.payload.fsw_state).toBe('NOMINAL');

    await closeClient(flight);
    await closeClient(ui);
  });

  test('handles multiple sequential telemetry frames', async () => {
    const flight = await connectClient('/flight');

    for (let i = 1; i <= 5; i++) {
      flight.send(JSON.stringify({
        type: 'TELEMETRY',
        seq_id: i,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        payload: {
          fsw_state: 'NOMINAL',
          subsystems: { CPU: { cpu_usage_pct: 50 + i } },
        },
      }));
    }

    await delay(500);

    const rows = await db('telemetry').orderBy('sequence_id', 'asc');
    expect(rows.length).toBe(5);
    expect(rows[4].sequence_id).toBe(5);

    expect(gateway.getStats().highestTelemetrySeqId).toBe(5);

    await closeClient(flight);
  });
});

// ──────────────────────────────────────────────────────────
// IF-WS-003: COMMAND_ACK → Update command + plan status
// ──────────────────────────────────────────────────────────

describe('COMMAND_ACK handling (IF-WS-003)', () => {
  let planId;
  let windowId;

  beforeEach(async () => {
    // Create window + plan + commands for ACK testing
    const w = await contactWindows.create(db, {
      name: 'Pass-ACK',
      aos_time: '2026-03-10T14:00:00Z',
      los_time: '2026-03-10T14:10:00Z',
    });
    windowId = w.id;

    const plan = await commandPlans.create(db, {
      contact_window_id: windowId,
      operator_name: 'hugo.cecilia',
      commands: [
        { command_type: 'SET_PARAM', payload: { key: 'val' } },
        { command_type: 'RUN_DIAGNOSTIC', payload: { sub: 'THERMAL' } },
      ],
    });
    planId = plan.id;

    // Sign and upload the plan
    await commandPlans.sign(db, planId, {
      signature: 'test_sig', public_key: 'test_key',
    });
    await commandPlans.updateStatus(db, planId, 'UPLOADED');

    // Mark commands as SENT
    const cmds = await commands.getByPlanId(db, planId);
    for (const cmd of cmds) {
      await commands.updateStatus(db, cmd.id, 'SENT', {
        sent_at: new Date().toISOString(),
      });
    }
  });

  test('updates command status to EXECUTED on ACK', async () => {
    const flight = await connectClient('/flight');

    flight.send(JSON.stringify({
      type: 'COMMAND_ACK',
      seq_id: 100,
      timestamp: new Date().toISOString(),
      payload: {
        plan_id: planId,
        command_seq_id: 1,
        status: 'EXECUTED',
        executed_at: new Date().toISOString(),
      },
    }));

    await delay(300);

    const cmds = await commands.getByPlanId(db, planId);
    const cmd1 = cmds.find((c) => c.sequence_id === 1);
    expect(cmd1.status).toBe('EXECUTED');
    expect(cmd1.executed_at).not.toBeNull();

    await closeClient(flight);
  });

  test('transitions plan to COMPLETED when all commands EXECUTED', async () => {
    const flight = await connectClient('/flight');

    // ACK command 1
    flight.send(JSON.stringify({
      type: 'COMMAND_ACK',
      seq_id: 100,
      timestamp: new Date().toISOString(),
      payload: { plan_id: planId, command_seq_id: 1, status: 'EXECUTED', executed_at: new Date().toISOString() },
    }));

    await delay(200);

    // ACK command 2
    flight.send(JSON.stringify({
      type: 'COMMAND_ACK',
      seq_id: 101,
      timestamp: new Date().toISOString(),
      payload: { plan_id: planId, command_seq_id: 2, status: 'EXECUTED', executed_at: new Date().toISOString() },
    }));

    await delay(300);

    const plan = await db('command_plans').where({ id: planId }).first();
    expect(plan.status).toBe('COMPLETED');

    await closeClient(flight);
  });

  test('increments commandAcksReceived counter', async () => {
    const flight = await connectClient('/flight');

    flight.send(JSON.stringify({
      type: 'COMMAND_ACK',
      seq_id: 100,
      timestamp: new Date().toISOString(),
      payload: { plan_id: planId, command_seq_id: 1, status: 'EXECUTED', executed_at: new Date().toISOString() },
    }));

    await delay(200);

    expect(gateway.getStats().commandAcksReceived).toBe(1);

    await closeClient(flight);
  });
});

// ──────────────────────────────────────────────────────────
// IF-WS-004: COMMAND_NACK → Reject plan + FAILED commands
// ──────────────────────────────────────────────────────────

describe('COMMAND_NACK handling (IF-WS-004)', () => {
  let planId;

  beforeEach(async () => {
    const w = await contactWindows.create(db, {
      name: 'Pass-NACK',
      aos_time: '2026-03-10T15:00:00Z',
      los_time: '2026-03-10T15:10:00Z',
    });

    const plan = await commandPlans.create(db, {
      contact_window_id: w.id,
      operator_name: 'hugo.cecilia',
      commands: [
        { command_type: 'SET_PARAM', payload: {} },
        { command_type: 'PING', payload: {} },
      ],
    });
    planId = plan.id;

    await commandPlans.sign(db, planId, {
      signature: 'bad_sig', public_key: 'bad_key',
    });
    await commandPlans.updateStatus(db, planId, 'UPLOADED');
  });

  test('rejects plan and marks all commands FAILED on NACK', async () => {
    const flight = await connectClient('/flight');

    flight.send(JSON.stringify({
      type: 'COMMAND_NACK',
      seq_id: 200,
      timestamp: new Date().toISOString(),
      payload: {
        plan_id: planId,
        reason: 'SIG_INVALID',
        detail: 'Ed25519 signature verification failed',
      },
    }));

    await delay(300);

    // Plan should be REJECTED
    const plan = await db('command_plans').where({ id: planId }).first();
    expect(plan.status).toBe('REJECTED');

    // All commands should be FAILED
    const cmds = await commands.getByPlanId(db, planId);
    expect(cmds.every((c) => c.status === 'FAILED')).toBe(true);

    expect(gateway.getStats().commandNacksReceived).toBe(1);

    await closeClient(flight);
  });

  test('broadcasts NACK to UI clients', async () => {
    const flight = await connectClient('/flight');
    const ui = await connectClient('/ui');
    await delay(100);

    const uiMsgPromise = collectMessages(ui, 300);

    flight.send(JSON.stringify({
      type: 'COMMAND_NACK',
      seq_id: 200,
      timestamp: new Date().toISOString(),
      payload: { plan_id: planId, reason: 'SIG_INVALID', detail: 'Bad sig' },
    }));

    const uiMsgs = await uiMsgPromise;
    const nackMsg = uiMsgs.find((m) => m.type === 'COMMAND_NACK');
    expect(nackMsg).toBeDefined();
    expect(nackMsg.payload.reason).toBe('SIG_INVALID');

    await closeClient(flight);
    await closeClient(ui);
  });
});

// ──────────────────────────────────────────────────────────
// IF-WS-006: AUDIT_EVENT → DB Persistence
// ──────────────────────────────────────────────────────────

describe('AUDIT_EVENT handling (IF-WS-006)', () => {
  test('persists Flight audit event to database', async () => {
    const flight = await connectClient('/flight');

    flight.send(JSON.stringify({
      type: 'AUDIT_EVENT',
      seq_id: 44,
      timestamp: '2026-03-10T14:00:05.000Z',
      payload: {
        event_type: 'STATE_TRANSITION',
        source: 'FLIGHT',
        severity: 'INFO',
        description: 'NOMINAL → SAFE: cpu_temp threshold exceeded (78.2°C > 75.0°C)',
        metadata: { trigger: 'THERMAL_FAULT', cpu_temp_c: 78.2, threshold_c: 75.0 },
        hash: 'abc123def456',
        prev_hash: 'GENESIS',
      },
    }));

    await delay(300);

    const rows = await db('audit_events').orderBy('timestamp', 'asc');
    expect(rows.length).toBe(1);
    expect(rows[0].event_type).toBe('STATE_TRANSITION');
    expect(rows[0].source).toBe('FLIGHT');
    expect(rows[0].hash).toBe('abc123def456');
    expect(rows[0].prev_hash).toBe('GENESIS');

    expect(gateway.getStats().auditEventsReceived).toBe(1);

    await closeClient(flight);
  });

  test('broadcasts audit event to UI', async () => {
    const flight = await connectClient('/flight');
    const ui = await connectClient('/ui');
    await delay(100);

    const uiMsgPromise = collectMessages(ui, 300);

    flight.send(JSON.stringify({
      type: 'AUDIT_EVENT',
      seq_id: 45,
      timestamp: new Date().toISOString(),
      payload: {
        event_type: 'WATCHDOG_RESTART',
        source: 'FLIGHT',
        severity: 'WARNING',
        description: 'Watchdog restart detected',
        metadata: {},
        hash: 'hash_1',
        prev_hash: 'hash_0',
      },
    }));

    const uiMsgs = await uiMsgPromise;
    const auditMsg = uiMsgs.find((m) => m.type === 'AUDIT_EVENT');
    expect(auditMsg).toBeDefined();
    expect(auditMsg.payload.event_type).toBe('WATCHDOG_RESTART');

    await closeClient(flight);
    await closeClient(ui);
  });
});

// ──────────────────────────────────────────────────────────
// IWebSocketGateway: sendToFlight
// ──────────────────────────────────────────────────────────

describe('sendToFlight (IWebSocketGateway)', () => {
  test('sends PLAN_UPLOAD to connected Flight client', async () => {
    const flight = await connectClient('/flight');

    const msgPromise = collectMessages(flight, 300);

    const planUpload = {
      type: 'PLAN_UPLOAD',
      seq_id: 0,
      timestamp: new Date().toISOString(),
      payload: {
        plan_id: 'test-plan-uuid',
        commands: [{ sequence_id: 1, command_type: 'PING', payload: {} }],
        signature: 'base64sig',
        signature_algo: 'Ed25519',
      },
    };

    gateway.sendToFlight(planUpload);

    const msgs = await msgPromise;
    const upload = msgs.find((m) => m.type === 'PLAN_UPLOAD');
    expect(upload).toBeDefined();
    expect(upload.payload.plan_id).toBe('test-plan-uuid');

    expect(gateway.getStats().plansUploaded).toBe(1);

    await closeClient(flight);
  });

  test('throws when Flight not connected', () => {
    expect(() => {
      gateway.sendToFlight({ type: 'PLAN_UPLOAD', payload: {} });
    }).toThrow('Flight not connected');
  });
});

// ──────────────────────────────────────────────────────────
// Graceful Shutdown
// ──────────────────────────────────────────────────────────

describe('Graceful Shutdown', () => {
  test('close() disconnects all clients and stops server', async () => {
    const flight = await connectClient('/flight');
    const ui = await connectClient('/ui');

    expect(gateway.isFlightConnected()).toBe(true);

    await gateway.close();
    await delay(100);

    expect(flight.readyState).toBe(WebSocket.CLOSED);
    expect(ui.readyState).toBe(WebSocket.CLOSED);

    // Prevent afterEach from double-closing
    gateway = null;
  });
});