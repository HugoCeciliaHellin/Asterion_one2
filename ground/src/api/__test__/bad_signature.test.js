// ============================================================
// ASTERION ONE — Bad Signature Integration Test
// ============================================================
// Phase 3 Gate — TEST 2:
//   fault_injector inject bad-signature
//   Criterio: Plan REJECTED, 0 cmds executed,
//             2 CRITICAL events → PASS
//   [REQ-SEC-ED25519 — reject & log]
//
// This test stands up the full Ground stack (API + ws_gateway)
// and connects a mock Flight client that simulates rejecting
// plans with invalid signatures by sending COMMAND_NACK.
//
// Run: npm test -- src/api/__tests__/bad_signature.test.js
// ============================================================

import { jest } from '@jest/globals';
import http from 'http';
import { WebSocket } from 'ws';
import { createApp } from '../server.js';
import { createWsGateway } from '../../ws/gateway.js';
import { createAuditService } from '../../services/audit.js';
import dbManager from '../../db/manager.js';

const {
  createConnection, runMigrations, rollbackMigrations,
  destroyConnection, contactWindows, commandPlans, commands,
  auditEvents,
} = dbManager;

let db;
let app;
let httpServer;
let gateway;
let auditService;

const API_PORT = 19300;
const WS_PORT = 19381;

// ── HTTP request helper ──────────────────────────────────

function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost', port: API_PORT,
      path, method, headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Setup / Teardown ─────────────────────────────────────

beforeAll(async () => {
  db = createConnection('test');
  await rollbackMigrations(db).catch(() => {});
  await runMigrations(db);

  auditService = createAuditService(db);

  // Create ws_gateway
  gateway = createWsGateway({ db, port: WS_PORT, auditService });
  await delay(100);

  // Create and start API server with gateway injected
  app = createApp(db, { wsGateway: gateway, auditService });
  httpServer = app.listen(API_PORT);
  await delay(100);
}, 15000);

afterAll(async () => {
  httpServer?.close();
  await gateway?.close();
  await rollbackMigrations(db);
  await destroyConnection(db);
  await delay(100);
}, 10000);

beforeEach(async () => {
  await db('twin_forecasts').del();
  await db('audit_events').del();
  await db('telemetry').del();
  await db('commands').del();
  await db('command_plans').del();
  await db('contact_windows').del();
});

// ── Mock Flight Client ───────────────────────────────────

/**
 * Connect a mock Flight client that:
 * 1. Receives PLAN_UPLOAD messages
 * 2. Always responds with COMMAND_NACK (SIG_INVALID)
 * This simulates the Flight crypto_verifier rejecting a bad signature.
 */
function connectMockFlight() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}/flight`);

    ws.on('open', () => {
      // Handle incoming messages from Ground
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'PLAN_UPLOAD') {
          // Simulate Flight crypto_verifier rejecting the plan
          // Per SD-1B: Flight sends COMMAND_NACK + 2 AUDIT_EVENTS

          const planId = msg.payload.plan_id;
          const now = new Date().toISOString();

          // 1. Send SIGNATURE_INVALID audit event
          ws.send(JSON.stringify({
            type: 'AUDIT_EVENT',
            seq_id: 900,
            timestamp: now,
            payload: {
              event_type: 'SIGNATURE_INVALID',
              source: 'FLIGHT',
              severity: 'CRITICAL',
              description: `Ed25519 signature verification failed for plan ${planId.slice(0, 8)}`,
              metadata: { plan_id: planId, reason: 'SIG_INVALID' },
              hash: 'flight_sig_invalid_hash_' + Date.now(),
              prev_hash: 'GENESIS',
            },
          }));

          // 2. Send COMMAND_REJECTED audit event
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'AUDIT_EVENT',
              seq_id: 901,
              timestamp: new Date().toISOString(),
              payload: {
                event_type: 'COMMAND_REJECTED',
                source: 'FLIGHT',
                severity: 'CRITICAL',
                description: `Plan ${planId.slice(0, 8)} rejected: invalid signature. 0 commands executed.`,
                metadata: { plan_id: planId, commands_executed: 0 },
                hash: 'flight_cmd_rejected_hash_' + Date.now(),
                prev_hash: 'flight_sig_invalid_hash_' + Date.now(),
              },
            }));
          }, 50);

          // 3. Send COMMAND_NACK
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'COMMAND_NACK',
              seq_id: 902,
              timestamp: new Date().toISOString(),
              payload: {
                plan_id: planId,
                reason: 'SIG_INVALID',
                detail: 'Ed25519 signature verification failed: Bad signature for payload hash',
              },
            }));
          }, 100);
        }
      });

      resolve(ws);
    });

    ws.on('error', reject);
  });
}

// ──────────────────────────────────────────────────────────
// PHASE 3 GATE — TEST 2: inject bad-signature
// ──────────────────────────────────────────────────────────

describe('Phase 3 Gate — TEST 2: inject bad-signature [REQ-SEC-ED25519]', () => {

  test('Full bad-signature flow: plan REJECTED, 0 cmds EXECUTED, ≥2 CRITICAL events', async () => {
    // ── Connect mock Flight ────────────────────────────
    const mockFlight = await connectMockFlight();
    await delay(200);

    expect(gateway.isFlightConnected()).toBe(true);

    // ── STEP 1: Create contact window ──────────────────
    const windowRes = await apiRequest('POST', '/api/contact-windows', {
      name: 'FI-BadSig-Test',
      aos_time: new Date(Date.now() - 60000).toISOString(),
      los_time: new Date(Date.now() + 600000).toISOString(),
    });
    expect(windowRes.status).toBe(201);
    const windowId = windowRes.body.data.id;

    // ── STEP 2: Activate window ────────────────────────
    const activateRes = await apiRequest('PATCH', `/api/contact-windows/${windowId}`, {
      status: 'ACTIVE',
    });
    expect(activateRes.status).toBe(200);
    expect(activateRes.body.data.status).toBe('ACTIVE');

    // ── STEP 3: Create command plan ────────────────────
    const planRes = await apiRequest('POST', '/api/command-plans', {
      contact_window_id: windowId,
      operator_name: 'fault_injector',
      commands: [
        { command_type: 'SET_PARAM', payload: { key: 'test', value: 1 } },
        { command_type: 'RUN_DIAGNOSTIC', payload: { subsystem: 'THERMAL' } },
      ],
    });
    expect(planRes.status).toBe(201);
    const planId = planRes.body.data.id;
    expect(planRes.body.data.status).toBe('DRAFT');
    expect(planRes.body.data.commands.length).toBe(2);

    // ── STEP 4: Sign with CORRUPTED signature ──────────
    const signRes = await apiRequest('PATCH', `/api/command-plans/${planId}`, {
      signature: 'Q09SUlVQVEVEX1NJR05BVFVSRQ==',  // "CORRUPTED_SIGNATURE"
      signature_algo: 'Ed25519',
      public_key: 'Q09SUlVQVEVEX0tFWQ==',          // "CORRUPTED_KEY"
    });
    expect(signRes.status).toBe(200);
    expect(signRes.body.data.status).toBe('SIGNED');

    // ── STEP 5: Upload to Flight ───────────────────────
    const uploadRes = await apiRequest('POST', `/api/command-plans/${planId}/upload`, {
      public_key: 'Q09SUlVQVEVEX0tFWQ==',
    });
    expect(uploadRes.status).toBe(202);
    expect(uploadRes.body.data.status).toBe('UPLOADED');

    // ── STEP 6: Wait for Flight NACK processing ────────
    // Mock Flight sends NACK after ~100ms, ws_gateway processes it
    await delay(800);

    // ── STEP 7: Verify plan status = REJECTED ──────────
    const planCheck = await apiRequest('GET', `/api/command-plans/${planId}`);
    expect(planCheck.status).toBe(200);
    expect(planCheck.body.data.status).toBe('REJECTED');

    // ── STEP 8: Verify 0 commands EXECUTED ─────────────
    const cmdsCheck = await apiRequest('GET', `/api/commands?plan_id=${planId}`);
    expect(cmdsCheck.status).toBe(200);

    const cmdStatuses = cmdsCheck.body.data.map((c) => c.status);
    const executedCount = cmdStatuses.filter((s) => s === 'EXECUTED').length;
    const failedCount = cmdStatuses.filter((s) => s === 'FAILED').length;

    expect(executedCount).toBe(0);
    expect(failedCount).toBe(2); // All commands FAILED

    // ── STEP 9: Verify ≥2 CRITICAL audit events ───────
    const eventsCheck = await apiRequest('GET', '/api/events?severity=CRITICAL');
    expect(eventsCheck.status).toBe(200);

    const criticalEvents = eventsCheck.body.data;
    const eventTypes = criticalEvents.map((e) => e.event_type);

    expect(criticalEvents.length).toBeGreaterThanOrEqual(2);
    expect(eventTypes).toContain('SIGNATURE_INVALID');
    expect(eventTypes).toContain('COMMAND_REJECTED');

    // Verify events have correct source
    const flightCritical = criticalEvents.filter((e) => e.source === 'FLIGHT');
    expect(flightCritical.length).toBeGreaterThanOrEqual(2);

    // ── STEP 10: Verify ws_gateway stats ───────────────
    const stats = gateway.getStats();
    expect(stats.commandNacksReceived).toBeGreaterThanOrEqual(1);
    expect(stats.auditEventsReceived).toBeGreaterThanOrEqual(2);

    // ── Cleanup ────────────────────────────────────────
    await new Promise((resolve) => {
      mockFlight.on('close', resolve);
      mockFlight.close();
    });

    // ── RESULT ─────────────────────────────────────────
    console.log('\n┌─────────────────────────────────────────────┐');
    console.log('│  Phase 3 Gate — TEST 2: bad-signature       │');
    console.log('├─────────────────────────────────────────────┤');
    console.log(`│  Plan status:      ${planCheck.body.data.status.padEnd(24)}│`);
    console.log(`│  Commands EXECUTED: ${String(executedCount).padEnd(23)}│`);
    console.log(`│  Commands FAILED:   ${String(failedCount).padEnd(23)}│`);
    console.log(`│  CRITICAL events:   ${String(criticalEvents.length).padEnd(23)}│`);
    console.log(`│  Event types:       ${eventTypes.join(', ').slice(0,23).padEnd(23)}│`);
    console.log('│                                             │');
    console.log('│  RESULT: ✅ PASS  [REQ-SEC-ED25519]         │');
    console.log('└─────────────────────────────────────────────┘');
  }, 15000);

  test('Upload without Flight connected returns 503 FLIGHT_DISCONNECTED', async () => {
    // No mock Flight connected for this test

    // Create window + plan + sign
    const wRes = await apiRequest('POST', '/api/contact-windows', {
      name: 'NoFlight',
      aos_time: new Date(Date.now() - 60000).toISOString(),
      los_time: new Date(Date.now() + 600000).toISOString(),
    });
    const windowId = wRes.body.data.id;
    await apiRequest('PATCH', `/api/contact-windows/${windowId}`, { status: 'ACTIVE' });

    const pRes = await apiRequest('POST', '/api/command-plans', {
      contact_window_id: windowId,
      operator_name: 'test',
      commands: [{ command_type: 'PING', payload: {} }],
    });
    const planId = pRes.body.data.id;

    await apiRequest('PATCH', `/api/command-plans/${planId}`, {
      signature: 'sig', signature_algo: 'Ed25519', public_key: 'key',
    });

    // Upload should fail — no Flight connected
    const uploadRes = await apiRequest('POST', `/api/command-plans/${planId}/upload`);
    expect(uploadRes.status).toBe(503);
    expect(uploadRes.body.error.code).toBe('FLIGHT_DISCONNECTED');
  });

  test('Upload unsigned plan returns 409 NOT_SIGNED', async () => {
    const mockFlight = await connectMockFlight();
    await delay(200);

    const wRes = await apiRequest('POST', '/api/contact-windows', {
      name: 'Unsigned',
      aos_time: new Date(Date.now() - 60000).toISOString(),
      los_time: new Date(Date.now() + 600000).toISOString(),
    });
    const windowId = wRes.body.data.id;
    await apiRequest('PATCH', `/api/contact-windows/${windowId}`, { status: 'ACTIVE' });

    const pRes = await apiRequest('POST', '/api/command-plans', {
      contact_window_id: windowId,
      operator_name: 'test',
      commands: [{ command_type: 'PING', payload: {} }],
    });
    const planId = pRes.body.data.id;

    // Try upload without signing
    const uploadRes = await apiRequest('POST', `/api/command-plans/${planId}/upload`);
    expect(uploadRes.status).toBe(409);
    expect(uploadRes.body.error.code).toBe('NOT_SIGNED');

    await new Promise((resolve) => { mockFlight.on('close', resolve); mockFlight.close(); });
  });
});

// ──────────────────────────────────────────────────────────
// PHASE 3 GATE — TEST 3: Hash-chain verification
// ──────────────────────────────────────────────────────────

describe('Phase 3 Gate — TEST 3: chain_valid after operations [REQ-FSW-LOG-SECURE]', () => {
  test('GET /api/events/verify returns chain_valid=true after mixed operations', async () => {
    // Create some Ground audit events via the service
    await auditService.logEvent('WINDOW_CREATED', 'GROUND', 'INFO', 'Test window created');
    await auditService.logEvent('PLAN_CREATED', 'GROUND', 'INFO', 'Test plan created');
    await auditService.logEvent('PLAN_SIGNED', 'GROUND', 'INFO', 'Test plan signed');

    // Verify chain
    const verifyRes = await apiRequest('GET', '/api/events/verify');
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.chain_valid).toBe(true);
    expect(verifyRes.body.data.total_events).toBe(3);
    expect(verifyRes.body.data.break_at_index).toBeNull();
  });
});