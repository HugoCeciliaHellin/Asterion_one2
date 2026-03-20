// ============================================================
// ASTERION ONE — api_server Tests
// ============================================================
// Integration tests for all 10 REST endpoints.
// Requires running PostgreSQL (docker compose up).
//
// Run: npm test -- src/api/__tests__/server.test.js
// ============================================================

import { jest } from '@jest/globals';
import { createApp } from '../server.js';
import dbManager from '../../db/manager.js';

const { createConnection, runMigrations, rollbackMigrations, destroyConnection } = dbManager;

let db;
let app;

// ──────────────────────────────────────────────────────────
// Setup / Teardown
// ──────────────────────────────────────────────────────────

beforeAll(async () => {
  db = createConnection('test');
  await rollbackMigrations(db).catch(() => {});
  await runMigrations(db);
  app = createApp(db);
});

afterAll(async () => {
  await rollbackMigrations(db);
  await destroyConnection(db);
});

beforeEach(async () => {
  await db('twin_forecasts').del();
  await db('audit_events').del();
  await db('telemetry').del();
  await db('commands').del();
  await db('command_plans').del();
  await db('contact_windows').del();
});

// ── Minimal HTTP helper (no external deps) ───────────────

/**
 * In-process HTTP request using Node's built-in http module.
 * Avoids need for supertest dependency.
 */
async function request(app, method, path, body = null) {
  const http = await import('http');

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const options = {
        hostname: 'localhost',
        port,
        path,
        method: method.toUpperCase(),
        headers: { 'Content-Type': 'application/json' },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          try {
            resolve({
              status: res.statusCode,
              body: data ? JSON.parse(data) : null,
            });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });

      req.on('error', (err) => {
        server.close();
        reject(err);
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}

// ──────────────────────────────────────────────────────────
// IF-REST-006: /api/health
// ──────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  test('returns healthy status with all components', async () => {
    const res = await request(app, 'GET', '/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.components.database).toBe('connected');
    expect(res.body.components.websocket).toBe('disconnected'); // No gateway injected
    expect(res.body.components.flight_link).toBe('inactive');
    expect(res.body.uptime_s).toBeGreaterThanOrEqual(0);
    expect(res.body.timestamp).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────
// IF-REST-001: /api/contact-windows
// ──────────────────────────────────────────────────────────

describe('/api/contact-windows', () => {
  const validWindow = {
    name: 'Pass-017',
    aos_time: '2026-03-10T14:00:00.000Z',
    los_time: '2026-03-10T14:10:00.000Z',
  };

  test('POST creates window with 201 and SCHEDULED status', async () => {
    const res = await request(app, 'POST', '/api/contact-windows', validWindow);

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.status).toBe('SCHEDULED');
    expect(res.body.data.name).toBe('Pass-017');
  });

  test('POST rejects missing fields with 400', async () => {
    const res = await request(app, 'POST', '/api/contact-windows', { name: 'Bad' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('POST rejects invalid time ordering with 400', async () => {
    const res = await request(app, 'POST', '/api/contact-windows', {
      name: 'Bad',
      aos_time: '2026-03-10T14:10:00Z',
      los_time: '2026-03-10T14:00:00Z',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('POST rejects overlapping window with 400 OVERLAP', async () => {
    await request(app, 'POST', '/api/contact-windows', validWindow);

    const res = await request(app, 'POST', '/api/contact-windows', {
      name: 'Overlap',
      aos_time: '2026-03-10T14:05:00.000Z',
      los_time: '2026-03-10T14:15:00.000Z',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OVERLAP');
  });

  test('GET returns list of windows ordered by aos_time', async () => {
    await request(app, 'POST', '/api/contact-windows', {
      name: 'Pass-B', aos_time: '2026-03-10T16:00:00Z', los_time: '2026-03-10T16:10:00Z',
    });
    await request(app, 'POST', '/api/contact-windows', {
      name: 'Pass-A', aos_time: '2026-03-10T14:00:00Z', los_time: '2026-03-10T14:10:00Z',
    });

    const res = await request(app, 'GET', '/api/contact-windows');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.data[0].name).toBe('Pass-A');
  });

  test('GET filters by status', async () => {
    const create = await request(app, 'POST', '/api/contact-windows', validWindow);
    const id = create.body.data.id;

    await request(app, 'PATCH', `/api/contact-windows/${id}`, { status: 'CANCELLED' });

    const res = await request(app, 'GET', '/api/contact-windows?status=CANCELLED');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].status).toBe('CANCELLED');
  });

  test('PATCH updates status with valid transition', async () => {
    const create = await request(app, 'POST', '/api/contact-windows', validWindow);
    const id = create.body.data.id;

    const res = await request(app, 'PATCH', `/api/contact-windows/${id}`, { status: 'ACTIVE' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ACTIVE');
  });

  test('PATCH rejects invalid transition with 409', async () => {
    const create = await request(app, 'POST', '/api/contact-windows', validWindow);
    const id = create.body.data.id;

    const res = await request(app, 'PATCH', `/api/contact-windows/${id}`, { status: 'COMPLETED' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });
});

// ──────────────────────────────────────────────────────────
// IF-REST-002: /api/command-plans
// ──────────────────────────────────────────────────────────

describe('/api/command-plans', () => {
  let windowId;

  beforeEach(async () => {
    const w = await request(app, 'POST', '/api/contact-windows', {
      name: 'Pass-018', aos_time: '2026-03-10T15:00:00Z', los_time: '2026-03-10T15:10:00Z',
    });
    windowId = w.body.data.id;
  });

  const makePlan = (wId) => ({
    contact_window_id: wId,
    operator_name: 'hugo.cecilia',
    commands: [
      { command_type: 'SET_PARAM', payload: { param_name: 'gain', param_value: 3.5 } },
      { command_type: 'RUN_DIAGNOSTIC', payload: { subsystem: 'THERMAL' } },
    ],
  });

  test('POST creates plan with DRAFT status and assigned sequence_ids', async () => {
    const res = await request(app, 'POST', '/api/command-plans', makePlan(windowId));

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.commands.length).toBe(2);
    expect(res.body.data.commands[0].sequence_id).toBe(1);
    expect(res.body.data.commands[1].sequence_id).toBe(2);
    expect(res.body.data.commands[0].status).toBe('QUEUED');
  });

  test('POST rejects missing operator_name with 400', async () => {
    const res = await request(app, 'POST', '/api/command-plans', {
      commands: [{ command_type: 'PING' }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('POST rejects empty commands array with 400', async () => {
    const res = await request(app, 'POST', '/api/command-plans', {
      operator_name: 'test', commands: [],
    });

    expect(res.status).toBe(400);
  });

  test('GET returns list of plans', async () => {
    await request(app, 'POST', '/api/command-plans', makePlan(windowId));

    const res = await request(app, 'GET', '/api/command-plans');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  test('GET /:id returns plan with commands', async () => {
    const create = await request(app, 'POST', '/api/command-plans', makePlan(windowId));
    const id = create.body.data.id;

    const res = await request(app, 'GET', `/api/command-plans/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.commands.length).toBe(2);
  });

  test('GET /:id returns 404 for missing plan', async () => {
    const res = await request(app, 'GET', '/api/command-plans/00000000-0000-0000-0000-000000000000');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('PATCH signs plan: DRAFT → SIGNED', async () => {
    const create = await request(app, 'POST', '/api/command-plans', makePlan(windowId));
    const id = create.body.data.id;

    const res = await request(app, 'PATCH', `/api/command-plans/${id}`, {
      signature: 'dGVzdF9zaWc=',
      public_key: 'dGVzdF9rZXk=',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SIGNED');
    expect(res.body.data.signature).toBe('dGVzdF9zaWc=');
    expect(res.body.data.signature_algo).toBe('Ed25519');
  });

  test('PATCH rejects signing non-DRAFT plan with 409', async () => {
    const create = await request(app, 'POST', '/api/command-plans', makePlan(windowId));
    const id = create.body.data.id;

    // Sign once
    await request(app, 'PATCH', `/api/command-plans/${id}`, {
      signature: 'sig1', public_key: 'key1',
    });

    // Try to sign again
    const res = await request(app, 'PATCH', `/api/command-plans/${id}`, {
      signature: 'sig2', public_key: 'key2',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SIGNED');
  });

  test('POST upload: returns 503 when no gateway connected', async () => {
    const create = await request(app, 'POST', '/api/command-plans', makePlan(windowId));
    const id = create.body.data.id;

    // Sign plan
    await request(app, 'PATCH', `/api/command-plans/${id}`, {
      signature: 'sig', public_key: 'key',
    });

    // Upload without gateway
    const res = await request(app, 'POST', `/api/command-plans/${id}/upload`);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('FLIGHT_DISCONNECTED');
  });

  test('POST upload: returns 409 when plan not signed', async () => {
    const create = await request(app, 'POST', '/api/command-plans', makePlan(windowId));
    const id = create.body.data.id;

    // Try upload without signing
    const appWithGateway = createApp(db, {
      wsGateway: {
        isFlightConnected: () => true,
        sendToFlight: () => {},
      },
    });

    const res = await request(appWithGateway, 'POST', `/api/command-plans/${id}/upload`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_SIGNED');
  });

  test('POST upload: succeeds with gateway + signed plan + active window', async () => {
    // Activate window
    await request(app, 'PATCH', `/api/contact-windows/${windowId}`, { status: 'ACTIVE' });

    const create = await request(app, 'POST', '/api/command-plans', makePlan(windowId));
    const id = create.body.data.id;

    // Sign plan
    await request(app, 'PATCH', `/api/command-plans/${id}`, {
      signature: 'valid_sig', public_key: 'valid_key',
    });

    // Upload with mock gateway
    const sentMessages = [];
    const appWithGateway = createApp(db, {
      wsGateway: {
        isFlightConnected: () => true,
        sendToFlight: (msg) => sentMessages.push(msg),
      },
    });

    const res = await request(appWithGateway, 'POST', `/api/command-plans/${id}/upload`, {
      public_key: 'valid_key',
    });

    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('UPLOADED');
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].type).toBe('PLAN_UPLOAD');
    expect(sentMessages[0].payload.plan_id).toBe(id);
    expect(sentMessages[0].payload.commands.length).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────
// /api/commands
// ──────────────────────────────────────────────────────────

describe('GET /api/commands', () => {
  test('returns commands list with filters', async () => {
    // Create a plan with commands
    const w = await request(app, 'POST', '/api/contact-windows', {
      name: 'Pass-CMD', aos_time: '2026-03-10T17:00:00Z', los_time: '2026-03-10T17:10:00Z',
    });

    await request(app, 'POST', '/api/command-plans', {
      contact_window_id: w.body.data.id,
      operator_name: 'test',
      commands: [
        { command_type: 'CMD_A', payload: {} },
        { command_type: 'CMD_B', payload: {} },
      ],
    });

    const res = await request(app, 'GET', '/api/commands');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
  });

  test('filters by status', async () => {
    const w = await request(app, 'POST', '/api/contact-windows', {
      name: 'Pass-FS', aos_time: '2026-03-10T18:00:00Z', los_time: '2026-03-10T18:10:00Z',
    });

    await request(app, 'POST', '/api/command-plans', {
      contact_window_id: w.body.data.id,
      operator_name: 'test',
      commands: [{ command_type: 'PING', payload: {} }],
    });

    const res = await request(app, 'GET', '/api/commands?status=QUEUED');

    expect(res.status).toBe(200);
    expect(res.body.data.every((c) => c.status === 'QUEUED')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────
// IF-REST-003: /api/telemetry
// ──────────────────────────────────────────────────────────

describe('/api/telemetry', () => {
  test('POST ingests telemetry frame with 201', async () => {
    const res = await request(app, 'POST', '/api/telemetry', {
      sequence_id: 42,
      timestamp: '2026-03-10T14:00:00.000Z',
      subsystem: 'THERMAL',
      metrics: { cpu_temp_c: 62.3 },
      fsw_state: 'NOMINAL',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeDefined();
  });

  test('POST rejects invalid subsystem with 400', async () => {
    const res = await request(app, 'POST', '/api/telemetry', {
      sequence_id: 1,
      timestamp: '2026-03-10T14:00:00Z',
      subsystem: 'INVALID',
      metrics: {},
      fsw_state: 'NOMINAL',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('POST rejects invalid fsw_state with 400', async () => {
    const res = await request(app, 'POST', '/api/telemetry', {
      sequence_id: 1,
      timestamp: '2026-03-10T14:00:00Z',
      subsystem: 'THERMAL',
      metrics: { temp: 60 },
      fsw_state: 'INVALID_STATE',
    });

    expect(res.status).toBe(400);
  });

  test('GET returns telemetry with meta', async () => {
    for (let i = 1; i <= 3; i++) {
      await request(app, 'POST', '/api/telemetry', {
        sequence_id: i,
        timestamp: new Date(Date.now() - (10 - i) * 1000).toISOString(),
        subsystem: 'THERMAL',
        metrics: { cpu_temp_c: 60 + i },
        fsw_state: 'NOMINAL',
      });
    }

    const res = await request(app, 'GET', '/api/telemetry');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(3);
    expect(res.body.meta.total).toBe(3);
    expect(res.body.meta.returned).toBe(3);
  });

  test('GET filters by subsystem', async () => {
    await request(app, 'POST', '/api/telemetry', {
      sequence_id: 1, timestamp: new Date().toISOString(),
      subsystem: 'THERMAL', metrics: { t: 1 }, fsw_state: 'NOMINAL',
    });
    await request(app, 'POST', '/api/telemetry', {
      sequence_id: 2, timestamp: new Date().toISOString(),
      subsystem: 'POWER', metrics: { v: 5 }, fsw_state: 'NOMINAL',
    });

    const res = await request(app, 'GET', '/api/telemetry?subsystem=THERMAL');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].subsystem).toBe('THERMAL');
  });
});

// ──────────────────────────────────────────────────────────
// IF-REST-004: /api/events
// ──────────────────────────────────────────────────────────

describe('/api/events', () => {
  // Helper: insert hash-chained events directly via db
  async function insertChainedEvents(count) {
    const { createHash } = await import('crypto');
    let prevHash = 'GENESIS';

    for (let i = 0; i < count; i++) {
      const ts = new Date(Date.now() + i * 1000).toISOString();
      const eventType = 'STATE_TRANSITION';
      const source = 'FLIGHT';
      const description = `Event ${i}`;

      const hash = createHash('sha256')
        .update(`${prevHash}${ts}${eventType}${source}${description}`)
        .digest('hex');

      await db('audit_events').insert({
        timestamp: ts,
        event_type: eventType,
        source,
        severity: 'INFO',
        description,
        metadata: JSON.stringify({ index: i }),
        hash,
        prev_hash: prevHash,
      });

      prevHash = hash;
    }
  }

  test('GET returns events ordered by timestamp ASC', async () => {
    await insertChainedEvents(3);

    const res = await request(app, 'GET', '/api/events');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(3);
    expect(res.body.data[0].description).toBe('Event 0');
  });

  test('GET filters by severity', async () => {
    await insertChainedEvents(2);

    // Insert a CRITICAL event
    const { createHash } = await import('crypto');
    const lastEvent = await db('audit_events').orderBy('timestamp', 'desc').first();
    const ts = new Date().toISOString();
    const hash = createHash('sha256')
      .update(`${lastEvent.hash}${ts}COMMAND_REJECTEDFLIGHTCRITICAL event`)
      .digest('hex');

    await db('audit_events').insert({
      timestamp: ts, event_type: 'COMMAND_REJECTED', source: 'FLIGHT',
      severity: 'CRITICAL', description: 'CRITICAL event',
      metadata: '{}', hash, prev_hash: lastEvent.hash,
    });

    const res = await request(app, 'GET', '/api/events?severity=CRITICAL');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].severity).toBe('CRITICAL');
  });

  test('GET /api/events/verify: valid chain returns chain_valid=true', async () => {
    await insertChainedEvents(5);

    const res = await request(app, 'GET', '/api/events/verify');

    expect(res.status).toBe(200);
    expect(res.body.data.chain_valid).toBe(true);
    expect(res.body.data.total_events).toBe(5);
    expect(res.body.data.break_at_index).toBeNull();
  });

  test('GET /api/events/verify: empty chain returns valid', async () => {
    const res = await request(app, 'GET', '/api/events/verify');

    expect(res.status).toBe(200);
    expect(res.body.data.chain_valid).toBe(true);
    expect(res.body.data.total_events).toBe(0);
  });

  test('GET /api/events/verify: tampered event detects break', async () => {
    await insertChainedEvents(5);

    // Tamper with event at index 2
    const events = await db('audit_events').orderBy('timestamp', 'asc');
    await db('audit_events')
      .where({ id: events[2].id })
      .update({ description: 'TAMPERED DESCRIPTION' });

    const res = await request(app, 'GET', '/api/events/verify');

    expect(res.status).toBe(200);
    expect(res.body.data.chain_valid).toBe(false);
    expect(res.body.data.break_at_index).toBe(2);
    expect(res.body.data.expected_hash).toBeDefined();
    expect(res.body.data.actual_hash).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────
// IF-REST-005: /api/twin/*
// ──────────────────────────────────────────────────────────

describe('/api/twin', () => {
  test('POST /api/twin/forecasts creates forecast with 201', async () => {
    const res = await request(app, 'POST', '/api/twin/forecasts', {
      model_type: 'THERMAL',
      horizon_min: 30,
      predicted_values: { cpu_temp_c: [62, 64, 66], threshold_c: 80 },
      breach_detected: false,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeDefined();
  });

  test('POST /api/twin/forecasts with breach data', async () => {
    const res = await request(app, 'POST', '/api/twin/forecasts', {
      model_type: 'THERMAL',
      horizon_min: 30,
      predicted_values: { cpu_temp_c: [62, 70, 80, 85] },
      breach_detected: true,
      breach_time: '2026-03-10T14:25:00Z',
      lead_time_min: 25.0,
      rationale: 'Predicted Overheat in 25 min',
      alert_emitted: true,
    });

    expect(res.status).toBe(201);
  });

  test('POST /api/twin/forecasts rejects invalid model_type', async () => {
    const res = await request(app, 'POST', '/api/twin/forecasts', {
      model_type: 'INVALID',
      horizon_min: 30,
      predicted_values: {},
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('GET /api/twin/forecasts returns list with filters', async () => {
    await request(app, 'POST', '/api/twin/forecasts', {
      model_type: 'THERMAL', horizon_min: 30,
      predicted_values: { t: [1] }, breach_detected: false,
    });
    await request(app, 'POST', '/api/twin/forecasts', {
      model_type: 'ENERGY', horizon_min: 30,
      predicted_values: { e: [1] }, breach_detected: false,
    });

    const res = await request(app, 'GET', '/api/twin/forecasts?model_type=THERMAL');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  test('GET /api/twin/alerts returns only active alerts', async () => {
    // Non-breach forecast
    await request(app, 'POST', '/api/twin/forecasts', {
      model_type: 'THERMAL', horizon_min: 30,
      predicted_values: {}, breach_detected: false,
    });

    // Breach + alert
    await request(app, 'POST', '/api/twin/forecasts', {
      model_type: 'THERMAL', horizon_min: 30,
      predicted_values: {}, breach_detected: true,
      alert_emitted: true, rationale: 'Overheat imminent',
    });

    const res = await request(app, 'GET', '/api/twin/alerts');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].breach_detected).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────
// Error handling
// ──────────────────────────────────────────────────────────

describe('Global error handling', () => {
  test('404 for unknown API route (handled by Express)', async () => {
    const res = await request(app, 'GET', '/api/nonexistent');
    // Express returns 404 by default for unmatched routes
    expect(res.status).toBe(404);
  });
});