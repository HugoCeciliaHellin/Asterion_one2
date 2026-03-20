// ============================================================
// ASTERION ONE — db_manager Tests
// ============================================================
// Tests require a running PostgreSQL instance (docker compose up).
// Uses 'asterion_test' database to avoid polluting dev data.
//
// Run: npm run test:db
// ============================================================

import { jest } from '@jest/globals';
import dbManager from '../manager.js';

const {
  createConnection,
  runMigrations,
  rollbackMigrations,
  destroyConnection,
  isConnected,
  contactWindows,
  commandPlans,
  commands,
  telemetry,
  auditEvents,
  twinForecasts,
} = dbManager;

let db;

// ──────────────────────────────────────────────────────────
// Setup / Teardown
// ──────────────────────────────────────────────────────────

beforeAll(async () => {
  db = createConnection('test');
  await rollbackMigrations(db).catch(() => {}); // Clean slate
  await runMigrations(db);
});

afterAll(async () => {
  await rollbackMigrations(db);
  await destroyConnection(db);
});

beforeEach(async () => {
  // Clean all tables before each test (order matters for FKs)
  await db('twin_forecasts').del();
  await db('audit_events').del();
  await db('telemetry').del();
  await db('commands').del();
  await db('command_plans').del();
  await db('contact_windows').del();
});

// ──────────────────────────────────────────────────────────
// Connection & Migration Tests
// ──────────────────────────────────────────────────────────

describe('Database Connection', () => {
  test('isConnected returns true for live database', async () => {
    const result = await isConnected(db);
    expect(result).toBe(true);
  });

  test('all 6 tables exist after migration', async () => {
    const tables = [
      'contact_windows', 'command_plans', 'commands',
      'telemetry', 'audit_events', 'twin_forecasts',
    ];

    for (const table of tables) {
      const exists = await db.schema.hasTable(table);
      expect(exists).toBe(true);
    }
  });

  test('all 5 ENUM types exist', async () => {
    const result = await db.raw(`
      SELECT typname FROM pg_type 
      WHERE typname IN (
        'contact_window_status', 'command_plan_status',
        'command_status', 'fsw_state', 'event_severity'
      )
      ORDER BY typname
    `);
    expect(result.rows.length).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────
// contact_windows [REQ-GND-PLAN]
// ──────────────────────────────────────────────────────────

describe('contactWindows', () => {
  const validWindow = {
    name: 'Pass-017',
    aos_time: '2026-03-10T14:00:00.000Z',
    los_time: '2026-03-10T14:10:00.000Z',
  };

  test('create: inserts with SCHEDULED status and returns UUID', async () => {
    const row = await contactWindows.create(db, validWindow);

    expect(row.id).toBeDefined();
    expect(row.name).toBe('Pass-017');
    expect(row.status).toBe('SCHEDULED');
    expect(row.created_at).toBeDefined();
  });

  test('create: rejects los_time <= aos_time', async () => {
    await expect(
      contactWindows.create(db, {
        name: 'Bad',
        aos_time: '2026-03-10T14:10:00.000Z',
        los_time: '2026-03-10T14:00:00.000Z',
      })
    ).rejects.toThrow('los_time must be after aos_time');
  });

  test('create: rejects missing required fields', async () => {
    await expect(
      contactWindows.create(db, { name: 'Test' })
    ).rejects.toThrow('required');
  });

  test('list: returns all windows ordered by aos_time', async () => {
    await contactWindows.create(db, {
      name: 'Pass-B', aos_time: '2026-03-10T16:00:00Z', los_time: '2026-03-10T16:10:00Z',
    });
    await contactWindows.create(db, {
      name: 'Pass-A', aos_time: '2026-03-10T14:00:00Z', los_time: '2026-03-10T14:10:00Z',
    });

    const rows = await contactWindows.list(db);
    expect(rows.length).toBe(2);
    expect(rows[0].name).toBe('Pass-A'); // earlier AOS first
  });

  test('list: filters by status', async () => {
    const w = await contactWindows.create(db, validWindow);
    await contactWindows.updateStatus(db, w.id, 'CANCELLED');

    const scheduled = await contactWindows.list(db, { status: 'SCHEDULED' });
    const cancelled = await contactWindows.list(db, { status: 'CANCELLED' });

    expect(scheduled.length).toBe(0);
    expect(cancelled.length).toBe(1);
  });

  test('getById: returns window or null', async () => {
    const w = await contactWindows.create(db, validWindow);

    const found = await contactWindows.getById(db, w.id);
    expect(found.name).toBe('Pass-017');

    const notFound = await contactWindows.getById(db, '00000000-0000-0000-0000-000000000000');
    expect(notFound).toBeUndefined();
  });

  test('updateStatus: SCHEDULED → ACTIVE (valid)', async () => {
    const w = await contactWindows.create(db, validWindow);
    const updated = await contactWindows.updateStatus(db, w.id, 'ACTIVE');
    expect(updated.status).toBe('ACTIVE');
  });

  test('updateStatus: SCHEDULED → CANCELLED (valid)', async () => {
    const w = await contactWindows.create(db, validWindow);
    const updated = await contactWindows.updateStatus(db, w.id, 'CANCELLED');
    expect(updated.status).toBe('CANCELLED');
  });

  test('updateStatus: ACTIVE → COMPLETED (valid)', async () => {
    const w = await contactWindows.create(db, validWindow);
    await contactWindows.updateStatus(db, w.id, 'ACTIVE');
    const updated = await contactWindows.updateStatus(db, w.id, 'COMPLETED');
    expect(updated.status).toBe('COMPLETED');
  });

  test('updateStatus: SCHEDULED → COMPLETED (invalid transition)', async () => {
    const w = await contactWindows.create(db, validWindow);
    await expect(
      contactWindows.updateStatus(db, w.id, 'COMPLETED')
    ).rejects.toThrow('Invalid transition');
  });

  test('findOverlapping: detects time overlap', async () => {
    await contactWindows.create(db, validWindow);

    const overlaps = await contactWindows.findOverlapping(
      db, '2026-03-10T14:05:00Z', '2026-03-10T14:15:00Z'
    );
    expect(overlaps.length).toBe(1);
  });

  test('findOverlapping: no overlap for non-intersecting windows', async () => {
    await contactWindows.create(db, validWindow);

    const overlaps = await contactWindows.findOverlapping(
      db, '2026-03-10T15:00:00Z', '2026-03-10T15:10:00Z'
    );
    expect(overlaps.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────
// command_plans [REQ-SEC-ED25519]
// ──────────────────────────────────────────────────────────

describe('commandPlans', () => {
  let windowId;

  beforeEach(async () => {
    const w = await contactWindows.create(db, {
      name: 'Pass-018',
      aos_time: '2026-03-10T15:00:00Z',
      los_time: '2026-03-10T15:10:00Z',
    });
    windowId = w.id;
  });

  const makePlanData = (windowId) => ({
    contact_window_id: windowId,
    operator_name: 'hugo.cecilia',
    commands: [
      { command_type: 'SET_PARAM', payload: { param_name: 'gain', param_value: 3.5 } },
      { command_type: 'RUN_DIAGNOSTIC', payload: { subsystem: 'THERMAL' } },
    ],
  });

  test('create: inserts plan + commands in transaction', async () => {
    const plan = await commandPlans.create(db, makePlanData(windowId));

    expect(plan.id).toBeDefined();
    expect(plan.status).toBe('DRAFT');
    expect(plan.operator_name).toBe('hugo.cecilia');
    expect(plan.commands.length).toBe(2);
    expect(plan.commands[0].sequence_id).toBe(1);
    expect(plan.commands[1].sequence_id).toBe(2);
    expect(plan.commands[0].command_type).toBe('SET_PARAM');
    expect(plan.commands[0].status).toBe('QUEUED');
  });

  test('create: rejects empty commands array', async () => {
    await expect(
      commandPlans.create(db, {
        operator_name: 'test', commands: [],
      })
    ).rejects.toThrow('At least one command');
  });

  test('create: allows null contact_window_id', async () => {
    const plan = await commandPlans.create(db, {
      operator_name: 'hugo.cecilia',
      commands: [{ command_type: 'PING', payload: {} }],
    });
    expect(plan.contact_window_id).toBeNull();
  });

  test('getById: returns plan with commands', async () => {
    const created = await commandPlans.create(db, makePlanData(windowId));
    const fetched = await commandPlans.getById(db, created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.commands.length).toBe(2);
  });

  test('getById: returns null for missing plan', async () => {
    const result = await commandPlans.getById(db, '00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  test('sign: transitions DRAFT → SIGNED with signature', async () => {
    const plan = await commandPlans.create(db, makePlanData(windowId));

    const signed = await commandPlans.sign(db, plan.id, {
      signature: 'dGVzdF9zaWduYXR1cmU=',
      public_key: 'dGVzdF9wdWJsaWNfa2V5',
    });

    expect(signed.status).toBe('SIGNED');
    expect(signed.signature).toBe('dGVzdF9zaWduYXR1cmU=');
    expect(signed.signature_algo).toBe('Ed25519');
  });

  test('sign: rejects non-DRAFT plan', async () => {
    const plan = await commandPlans.create(db, makePlanData(windowId));
    await commandPlans.sign(db, plan.id, {
      signature: 'sig', public_key: 'key',
    });

    await expect(
      commandPlans.sign(db, plan.id, { signature: 'sig2', public_key: 'key2' })
    ).rejects.toThrow('must be DRAFT');
  });

  test('updateStatus: enforces valid transitions', async () => {
    const plan = await commandPlans.create(db, makePlanData(windowId));

    // DRAFT → SIGNED (via sign)
    await commandPlans.sign(db, plan.id, { signature: 's', public_key: 'k' });

    // SIGNED → UPLOADED
    const uploaded = await commandPlans.updateStatus(db, plan.id, 'UPLOADED');
    expect(uploaded.status).toBe('UPLOADED');

    // UPLOADED → EXECUTING
    const executing = await commandPlans.updateStatus(db, plan.id, 'EXECUTING');
    expect(executing.status).toBe('EXECUTING');

    // EXECUTING → COMPLETED
    const completed = await commandPlans.updateStatus(db, plan.id, 'COMPLETED');
    expect(completed.status).toBe('COMPLETED');
  });

  test('updateStatus: rejects invalid transition DRAFT → UPLOADED', async () => {
    const plan = await commandPlans.create(db, makePlanData(windowId));
    await expect(
      commandPlans.updateStatus(db, plan.id, 'UPLOADED')
    ).rejects.toThrow('Invalid transition');
  });

  test('list: filters by status and contact_window_id', async () => {
    await commandPlans.create(db, makePlanData(windowId));
    await commandPlans.create(db, makePlanData(windowId));

    const all = await commandPlans.list(db);
    expect(all.length).toBe(2);

    const byWindow = await commandPlans.list(db, { contact_window_id: windowId });
    expect(byWindow.length).toBe(2);

    const byStatus = await commandPlans.list(db, { status: 'DRAFT' });
    expect(byStatus.length).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────
// commands [REQ-COM-ZERO-LOSS, REQ-COM-P95]
// ──────────────────────────────────────────────────────────

describe('commands', () => {
  let planId;

  beforeEach(async () => {
    const w = await contactWindows.create(db, {
      name: 'Pass-019', aos_time: '2026-03-10T16:00:00Z', los_time: '2026-03-10T16:10:00Z',
    });
    const plan = await commandPlans.create(db, {
      contact_window_id: w.id,
      operator_name: 'hugo.cecilia',
      commands: [
        { command_type: 'SET_PARAM', payload: { key: 'val' } },
        { command_type: 'PING', payload: {} },
        { command_type: 'RUN_DIAGNOSTIC', payload: { sub: 'CPU' } },
      ],
    });
    planId = plan.id;
  });

  test('getByPlanId: returns commands ordered by sequence_id', async () => {
    const cmds = await commands.getByPlanId(db, planId);
    expect(cmds.length).toBe(3);
    expect(cmds[0].sequence_id).toBe(1);
    expect(cmds[1].sequence_id).toBe(2);
    expect(cmds[2].sequence_id).toBe(3);
  });

  test('updateStatus: QUEUED → SENT with sent_at timestamp', async () => {
    const cmds = await commands.getByPlanId(db, planId);
    const now = new Date().toISOString();

    const updated = await commands.updateStatus(db, cmds[0].id, 'SENT', { sent_at: now });
    expect(updated.status).toBe('SENT');
    expect(updated.sent_at).toBeDefined();
  });

  test('updateStatus: tracks full lifecycle QUEUED → SENT → ACKED → EXECUTED', async () => {
    const cmds = await commands.getByPlanId(db, planId);
    const id = cmds[0].id;
    const t1 = '2026-03-10T16:01:00Z';
    const t2 = '2026-03-10T16:01:01Z';
    const t3 = '2026-03-10T16:01:02Z';

    await commands.updateStatus(db, id, 'SENT', { sent_at: t1 });
    await commands.updateStatus(db, id, 'ACKED', { acked_at: t2 });
    const final = await commands.updateStatus(db, id, 'EXECUTED', { executed_at: t3 });

    expect(final.status).toBe('EXECUTED');
    expect(final.sent_at).toBeDefined();
    expect(final.acked_at).toBeDefined();
    expect(final.executed_at).toBeDefined();
  });

  test('bulkUpdateByPlanId: sets all commands to FAILED on plan rejection', async () => {
    const count = await commands.bulkUpdateByPlanId(db, planId, 'FAILED');
    expect(count).toBe(3);

    const cmds = await commands.getByPlanId(db, planId);
    cmds.forEach((cmd) => expect(cmd.status).toBe('FAILED'));
  });

  test('incrementRetry: increments retry_count', async () => {
    const cmds = await commands.getByPlanId(db, planId);
    const updated = await commands.incrementRetry(db, cmds[0].id);
    expect(updated.retry_count).toBe(1);

    const updated2 = await commands.incrementRetry(db, cmds[0].id);
    expect(updated2.retry_count).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────
// telemetry
// ──────────────────────────────────────────────────────────

describe('telemetry', () => {
  const makeFrame = (seqId, subsystem = 'THERMAL') => ({
    sequence_id: seqId,
    timestamp: new Date(Date.now() - (100 - seqId) * 1000).toISOString(),
    subsystem,
    metrics: { cpu_temp_c: 62.3 + seqId * 0.1 },
    fsw_state: 'NOMINAL',
  });

  test('insert: stores telemetry frame with UUID', async () => {
    const row = await telemetry.insert(db, makeFrame(1));
    expect(row.id).toBeDefined();
    expect(row.sequence_id).toBe(1);
    expect(row.fsw_state).toBe('NOMINAL');
    expect(row.subsystem).toBe('THERMAL');
  });

  test('insert: rejects missing required fields', async () => {
    await expect(
      telemetry.insert(db, { sequence_id: 1 })
    ).rejects.toThrow('required');
  });

  test('query: returns data with meta (total, returned)', async () => {
    for (let i = 1; i <= 5; i++) {
      await telemetry.insert(db, makeFrame(i));
    }

    const result = await telemetry.query(db, { limit: 3 });
    expect(result.data.length).toBe(3);
    expect(result.meta.total).toBe(5);
    expect(result.meta.returned).toBe(3);
  });

  test('query: filters by subsystem', async () => {
    await telemetry.insert(db, makeFrame(1, 'THERMAL'));
    await telemetry.insert(db, makeFrame(2, 'POWER'));
    await telemetry.insert(db, makeFrame(3, 'THERMAL'));

    const result = await telemetry.query(db, { subsystem: 'THERMAL' });
    expect(result.data.length).toBe(2);
    expect(result.data.every((r) => r.subsystem === 'THERMAL')).toBe(true);
  });

  test('query: filters by time range', async () => {
    const base = new Date('2026-03-10T12:00:00Z');
    for (let i = 0; i < 5; i++) {
      await telemetry.insert(db, {
        sequence_id: i + 1,
        timestamp: new Date(base.getTime() + i * 60000).toISOString(),
        subsystem: 'CPU',
        metrics: { cpu_usage_pct: 50 + i },
        fsw_state: 'NOMINAL',
      });
    }

    const result = await telemetry.query(db, {
      from: '2026-03-10T12:01:00Z',
      to: '2026-03-10T12:03:00Z',
    });
    expect(result.data.length).toBe(3);
  });

  test('getLatest: returns most recent frame', async () => {
    await telemetry.insert(db, makeFrame(1));
    await telemetry.insert(db, makeFrame(5));
    await telemetry.insert(db, makeFrame(3));

    const latest = await telemetry.getLatest(db);
    expect(latest.sequence_id).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────
// audit_events [REQ-FSW-LOG-SECURE]
// ──────────────────────────────────────────────────────────

describe('auditEvents', () => {
  const makeEvent = (index, type = 'STATE_TRANSITION', severity = 'INFO') => ({
    timestamp: new Date(Date.now() + index * 1000).toISOString(),
    event_type: type,
    source: 'FLIGHT',
    severity,
    description: `Test event ${index}`,
    metadata: { index },
    hash: `hash_${index}`,
    prev_hash: index === 0 ? 'GENESIS' : `hash_${index - 1}`,
  });

  test('insert: stores event with all fields', async () => {
    const row = await auditEvents.insert(db, makeEvent(0));

    expect(row.id).toBeDefined();
    expect(row.event_type).toBe('STATE_TRANSITION');
    expect(row.severity).toBe('INFO');
    expect(row.hash).toBe('hash_0');
    expect(row.prev_hash).toBe('GENESIS');
  });

  test('insert: rejects missing required fields', async () => {
    await expect(
      auditEvents.insert(db, { timestamp: new Date().toISOString() })
    ).rejects.toThrow('Required fields missing');
  });

  test('query: filters by source', async () => {
    await auditEvents.insert(db, { ...makeEvent(0), source: 'FLIGHT' });
    await auditEvents.insert(db, { ...makeEvent(1), source: 'GROUND' });

    const flight = await auditEvents.query(db, { source: 'FLIGHT' });
    expect(flight.length).toBe(1);
    expect(flight[0].source).toBe('FLIGHT');
  });

  test('query: filters by severity', async () => {
    await auditEvents.insert(db, makeEvent(0, 'STATE_TRANSITION', 'INFO'));
    await auditEvents.insert(db, makeEvent(1, 'COMMAND_REJECTED', 'CRITICAL'));

    const critical = await auditEvents.query(db, { severity: 'CRITICAL' });
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe('CRITICAL');
  });

  test('query: returns events in timestamp ASC order', async () => {
    for (let i = 0; i < 5; i++) {
      await auditEvents.insert(db, makeEvent(i));
    }

    const events = await auditEvents.query(db);
    expect(events.length).toBe(5);
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i].timestamp).getTime())
        .toBeGreaterThan(new Date(events[i - 1].timestamp).getTime());
    }
  });

  test('getLastEvent: returns most recent event', async () => {
    await auditEvents.insert(db, makeEvent(0));
    await auditEvents.insert(db, makeEvent(1));
    await auditEvents.insert(db, makeEvent(2));

    const last = await auditEvents.getLastEvent(db);
    expect(last.hash).toBe('hash_2');
  });

  test('getAllOrdered: returns full chain for verification', async () => {
    for (let i = 0; i < 3; i++) {
      await auditEvents.insert(db, makeEvent(i));
    }

    const all = await auditEvents.getAllOrdered(db);
    expect(all.length).toBe(3);
    expect(all[0].prev_hash).toBe('GENESIS');
    expect(all[1].prev_hash).toBe('hash_0');
    expect(all[2].prev_hash).toBe('hash_1');
  });
});

// ──────────────────────────────────────────────────────────
// twin_forecasts [REQ-DT-EARLY-15m, REQ-DT-RATIONALE]
// ──────────────────────────────────────────────────────────

describe('twinForecasts', () => {
  const makeForecast = (breach = false) => ({
    model_type: 'THERMAL',
    horizon_min: 30,
    predicted_values: {
      timestamps: ['2026-03-10T14:00:00Z', '2026-03-10T14:05:00Z'],
      cpu_temp_c: [62.3, 64.1],
      threshold_c: 80.0,
    },
    breach_detected: breach,
    breach_time: breach ? '2026-03-10T14:25:00Z' : null,
    lead_time_min: breach ? 25.0 : null,
    rationale: breach
      ? 'Predicted Overheat in 25 min: CPU load sustained at 87%'
      : null,
    alert_emitted: breach,
  });

  test('insert: stores forecast with all fields', async () => {
    const row = await twinForecasts.insert(db, makeForecast(true));

    expect(row.id).toBeDefined();
    expect(row.model_type).toBe('THERMAL');
    expect(row.horizon_min).toBe(30);
    expect(row.breach_detected).toBe(true);
    expect(row.lead_time_min).toBe(25.0);
    expect(row.rationale).toContain('Overheat');
    expect(row.alert_emitted).toBe(true);
  });

  test('insert: stores non-breach forecast', async () => {
    const row = await twinForecasts.insert(db, makeForecast(false));

    expect(row.breach_detected).toBe(false);
    expect(row.breach_time).toBeNull();
    expect(row.lead_time_min).toBeNull();
    expect(row.rationale).toBeNull();
  });

  test('insert: rejects missing required fields', async () => {
    await expect(
      twinForecasts.insert(db, { model_type: 'THERMAL' })
    ).rejects.toThrow('required');
  });

  test('query: filters by model_type', async () => {
    await twinForecasts.insert(db, makeForecast(false));
    await twinForecasts.insert(db, {
      ...makeForecast(false), model_type: 'ENERGY',
    });

    const thermal = await twinForecasts.query(db, { model_type: 'THERMAL' });
    expect(thermal.length).toBe(1);
  });

  test('query: filters breach_only', async () => {
    await twinForecasts.insert(db, makeForecast(false));
    await twinForecasts.insert(db, makeForecast(true));

    const breaches = await twinForecasts.query(db, { breach_only: true });
    expect(breaches.length).toBe(1);
    expect(breaches[0].breach_detected).toBe(true);
  });

  test('getActiveAlerts: returns breach + emitted forecasts', async () => {
    await twinForecasts.insert(db, makeForecast(false)); // No breach
    await twinForecasts.insert(db, makeForecast(true));  // Breach + emitted
    await twinForecasts.insert(db, {
      ...makeForecast(true), alert_emitted: false, // Breach but not emitted
    });

    const alerts = await twinForecasts.getActiveAlerts(db);
    expect(alerts.length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────
// Cross-table integrity (FK constraints)
// ──────────────────────────────────────────────────────────

describe('Referential Integrity', () => {
  test('command_plans FK: cascading delete from contact_windows sets NULL', async () => {
    const w = await contactWindows.create(db, {
      name: 'Pass-X', aos_time: '2026-03-10T20:00:00Z', los_time: '2026-03-10T20:10:00Z',
    });
    const plan = await commandPlans.create(db, {
      contact_window_id: w.id,
      operator_name: 'test',
      commands: [{ command_type: 'PING', payload: {} }],
    });

    // Delete window → plan.contact_window_id should become NULL (ON DELETE SET NULL)
    await db('contact_windows').where({ id: w.id }).del();

    const updatedPlan = await db('command_plans').where({ id: plan.id }).first();
    expect(updatedPlan).toBeDefined();
    expect(updatedPlan.contact_window_id).toBeNull();
  });

  test('commands FK: cascade delete from command_plans', async () => {
    const w = await contactWindows.create(db, {
      name: 'Pass-Y', aos_time: '2026-03-10T21:00:00Z', los_time: '2026-03-10T21:10:00Z',
    });
    const plan = await commandPlans.create(db, {
      contact_window_id: w.id,
      operator_name: 'test',
      commands: [
        { command_type: 'CMD_A', payload: {} },
        { command_type: 'CMD_B', payload: {} },
      ],
    });

    // Delete plan → commands should be cascaded
    await db('command_plans').where({ id: plan.id }).del();
    const remaining = await db('commands').where({ plan_id: plan.id });
    expect(remaining.length).toBe(0);
  });

  test('UNIQUE constraint: (plan_id, sequence_id) prevents duplicates', async () => {
    const w = await contactWindows.create(db, {
      name: 'Pass-Z', aos_time: '2026-03-10T22:00:00Z', los_time: '2026-03-10T22:10:00Z',
    });
    const plan = await commandPlans.create(db, {
      contact_window_id: w.id,
      operator_name: 'test',
      commands: [{ command_type: 'PING', payload: {} }],
    });

    // Try to insert duplicate (plan_id, sequence_id=1) directly
    await expect(
      db('commands').insert({
        plan_id: plan.id,
        sequence_id: 1,
        command_type: 'DUPE',
        payload: '{}',
        status: 'QUEUED',
      })
    ).rejects.toThrow(); // UNIQUE violation
  });

  test('CHECK constraint: los_time > aos_time enforced at DB level', async () => {
    await expect(
      db('contact_windows').insert({
        name: 'Invalid',
        aos_time: '2026-03-10T14:10:00Z',
        los_time: '2026-03-10T14:00:00Z', // Before aos!
        status: 'SCHEDULED',
      })
    ).rejects.toThrow(); // CHECK violation
  });
});