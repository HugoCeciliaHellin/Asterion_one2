// ============================================================
// ASTERION ONE — audit_service Tests
// ============================================================
// Tests for Ground-side hash-chained audit log.
// Validates: chain integrity, tamper detection, mixed sources,
//            GENESIS sentinel, verifyChain correctness.
// Requires running PostgreSQL (docker compose up).
//
// Run: npm test -- src/services/__tests__/audit.test.js
// ============================================================

import { jest } from '@jest/globals';
import { AuditService, createAuditService } from '../audit.js';
import { computeEventHash } from '../auditHash.js';
import dbManager from '../../db/manager.js';

const {
  createConnection, runMigrations, rollbackMigrations,
  destroyConnection, auditEvents,
} = dbManager;

let db;
let service;

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
  await db('audit_events').del();
  service = createAuditService(db);
});

// ──────────────────────────────────────────────────────────
// Construction
// ──────────────────────────────────────────────────────────

describe('AuditService construction', () => {
  test('creates instance via factory function', () => {
    const svc = createAuditService(db);
    expect(svc).toBeInstanceOf(AuditService);
  });

  test('throws if db is missing', () => {
    expect(() => new AuditService(null)).toThrow('Database connection is required');
  });
});

// ──────────────────────────────────────────────────────────
// logEvent — Basic Functionality
// ──────────────────────────────────────────────────────────

describe('logEvent', () => {
  test('creates first event with prev_hash = GENESIS', async () => {
    const event = await service.logEvent(
      'PLAN_SIGNED', 'GROUND', 'INFO',
      'Command plan signed by operator',
      { plan_id: 'test-uuid' }
    );

    expect(event.id).toBeDefined();
    expect(event.event_type).toBe('PLAN_SIGNED');
    expect(event.source).toBe('GROUND');
    expect(event.severity).toBe('INFO');
    expect(event.prev_hash).toBe('GENESIS');
    expect(event.hash).toBeDefined();
    expect(event.hash.length).toBe(64); // SHA-256 hex = 64 chars
  });

  test('chains second event to first event hash', async () => {
    const first = await service.logEvent(
      'PLAN_SIGNED', 'GROUND', 'INFO', 'First event'
    );

    const second = await service.logEvent(
      'PLAN_UPLOADED', 'GROUND', 'INFO', 'Second event'
    );

    expect(second.prev_hash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
  });

  test('chains 5 events correctly', async () => {
    const events = [];
    for (let i = 0; i < 5; i++) {
      const event = await service.logEvent(
        'PLAN_SIGNED', 'GROUND', 'INFO', `Event ${i}`,
        { index: i }
      );
      events.push(event);
    }

    // Verify chain linkage
    expect(events[0].prev_hash).toBe('GENESIS');
    for (let i = 1; i < events.length; i++) {
      expect(events[i].prev_hash).toBe(events[i - 1].hash);
    }
  });

  test('computes hash per Art.2 §3.5 scheme', async () => {
    const event = await service.logEvent(
      'PLAN_UPLOADED', 'GROUND', 'INFO', 'Test hash computation'
    );

    // Recompute hash independently
    const expected = computeEventHash(
      event.prev_hash,
      event.timestamp,
      event.event_type,
      event.source,
      event.description
    );

    expect(event.hash).toBe(expected);
  });

  test('stores metadata as JSONB', async () => {
    const metadata = {
      plan_id: 'abc-123',
      command_count: 3,
      operator: 'hugo.cecilia',
    };

    const event = await service.logEvent(
      'PLAN_CREATED', 'GROUND', 'INFO', 'Plan created', metadata
    );

    // Fetch from DB to verify JSONB storage
    const row = await db('audit_events').where({ id: event.id }).first();
    expect(row.metadata).toEqual(metadata);
  });

  test('defaults metadata to empty object', async () => {
    const event = await service.logEvent(
      'OUTAGE_START', 'SCHEDULER', 'INFO', 'Blackout started'
    );

    const row = await db('audit_events').where({ id: event.id }).first();
    expect(row.metadata).toEqual({});
  });
});

// ──────────────────────────────────────────────────────────
// logEvent — Validation
// ──────────────────────────────────────────────────────────

describe('logEvent validation', () => {
  test('rejects missing eventType', async () => {
    await expect(
      service.logEvent(null, 'GROUND', 'INFO', 'Desc')
    ).rejects.toThrow('required');
  });

  test('rejects missing source', async () => {
    await expect(
      service.logEvent('PLAN_SIGNED', null, 'INFO', 'Desc')
    ).rejects.toThrow('required');
  });

  test('rejects missing severity', async () => {
    await expect(
      service.logEvent('PLAN_SIGNED', 'GROUND', null, 'Desc')
    ).rejects.toThrow('required');
  });

  test('rejects missing description', async () => {
    await expect(
      service.logEvent('PLAN_SIGNED', 'GROUND', 'INFO', null)
    ).rejects.toThrow('required');
  });

  test('rejects invalid source', async () => {
    await expect(
      service.logEvent('PLAN_SIGNED', 'INVALID_SOURCE', 'INFO', 'Desc')
    ).rejects.toThrow('Invalid source');
  });

  test('rejects invalid severity', async () => {
    await expect(
      service.logEvent('PLAN_SIGNED', 'GROUND', 'DEBUG', 'Desc')
    ).rejects.toThrow('Invalid severity');
  });

  test('allows unknown event_type with console warning (Flight-originated)', async () => {
    // Unknown event types should be allowed but warn
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const event = await service.logEvent(
      'CUSTOM_EVENT', 'FLIGHT', 'INFO', 'Custom from Flight'
    );

    expect(event.event_type).toBe('CUSTOM_EVENT');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown event_type')
    );

    consoleSpy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────
// logEvent — All Ground Event Types (Art.2 §3.5 catalog)
// ──────────────────────────────────────────────────────────

describe('Ground event types per catalog', () => {
  const groundEvents = [
    ['PLAN_CREATED', 'GROUND', 'INFO', 'Plan created with 3 commands'],
    ['PLAN_SIGNED', 'GROUND', 'INFO', 'Plan signed by hugo.cecilia'],
    ['PLAN_UPLOADED', 'GROUND', 'INFO', 'Plan uploaded to Flight'],
    ['WINDOW_CREATED', 'GROUND', 'INFO', 'Contact window created: Pass-017'],
    ['OUTAGE_START', 'SCHEDULER', 'INFO', 'Blackout started'],
    ['OUTAGE_END', 'SCHEDULER', 'INFO', 'Contact window opened (AOS)'],
    ['TWIN_ALERT', 'TWIN', 'WARNING', 'Thermal breach predicted in 25 min'],
    ['TELEMETRY_GAP', 'GROUND', 'WARNING', 'Gap in seq_id: 42 missing'],
  ];

  test.each(groundEvents)(
    'logs %s from %s with severity %s',
    async (eventType, source, severity, description) => {
      const event = await service.logEvent(eventType, source, severity, description);

      expect(event.event_type).toBe(eventType);
      expect(event.source).toBe(source);
      expect(event.severity).toBe(severity);
    }
  );
});

// ──────────────────────────────────────────────────────────
// verifyChain — Integrity Verification
// ──────────────────────────────────────────────────────────

describe('verifyChain', () => {
  test('empty chain is valid', async () => {
    const result = await service.verifyChain();

    expect(result.chain_valid).toBe(true);
    expect(result.total_events).toBe(0);
    expect(result.break_at_index).toBeNull();
  });

  test('single event chain is valid', async () => {
    await service.logEvent('PLAN_SIGNED', 'GROUND', 'INFO', 'First event');

    const result = await service.verifyChain();

    expect(result.chain_valid).toBe(true);
    expect(result.total_events).toBe(1);
    expect(result.first_event).toBeDefined();
    expect(result.last_event).toBeDefined();
  });

  test('chain of 10 events is valid', async () => {
    for (let i = 0; i < 10; i++) {
      await service.logEvent('PLAN_SIGNED', 'GROUND', 'INFO', `Event ${i}`);
    }

    const result = await service.verifyChain();

    expect(result.chain_valid).toBe(true);
    expect(result.total_events).toBe(10);
    expect(result.break_at_index).toBeNull();
  });

  test('detects tampered description', async () => {
    for (let i = 0; i < 5; i++) {
      await service.logEvent('PLAN_SIGNED', 'GROUND', 'INFO', `Event ${i}`);
    }

    // Tamper with event at index 2
    const events = await db('audit_events').orderBy('timestamp', 'asc');
    await db('audit_events')
      .where({ id: events[2].id })
      .update({ description: 'TAMPERED!' });

    const result = await service.verifyChain();

    expect(result.chain_valid).toBe(false);
    expect(result.break_at_index).toBe(2);
    expect(result.expected_hash).toBeDefined();
    expect(result.actual_hash).toBeDefined();
    expect(result.expected_hash).not.toBe(result.actual_hash);
  });

  test('detects tampered hash', async () => {
    for (let i = 0; i < 3; i++) {
      await service.logEvent('PLAN_SIGNED', 'GROUND', 'INFO', `Event ${i}`);
    }

    // Tamper with stored hash at index 1
    const events = await db('audit_events').orderBy('timestamp', 'asc');
    await db('audit_events')
      .where({ id: events[1].id })
      .update({ hash: 'deadbeef'.repeat(8) });

    const result = await service.verifyChain();

    expect(result.chain_valid).toBe(false);
    // Break detected at index 1 (hash mismatch) or index 2 (prev_hash mismatch)
    expect(result.break_at_index).toBeLessThanOrEqual(2);
  });

  test('detects broken chain linkage (prev_hash tampered)', async () => {
    for (let i = 0; i < 4; i++) {
      await service.logEvent('PLAN_SIGNED', 'GROUND', 'INFO', `Event ${i}`);
    }

    // Tamper with prev_hash at index 3
    const events = await db('audit_events').orderBy('timestamp', 'asc');
    await db('audit_events')
      .where({ id: events[3].id })
      .update({ prev_hash: 'fake_prev_hash' });

    const result = await service.verifyChain();

    expect(result.chain_valid).toBe(false);
    expect(result.break_at_index).toBe(3);
  });

  test('detects tampered GENESIS (first event prev_hash changed)', async () => {
    await service.logEvent('PLAN_SIGNED', 'GROUND', 'INFO', 'First');

    const events = await db('audit_events').orderBy('timestamp', 'asc');
    await db('audit_events')
      .where({ id: events[0].id })
      .update({ prev_hash: 'NOT_GENESIS' });

    const result = await service.verifyChain();

    expect(result.chain_valid).toBe(false);
    expect(result.break_at_index).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────
// Mixed Chain: Flight + Ground events sharing same table
// ──────────────────────────────────────────────────────────

describe('Mixed Flight + Ground chain', () => {
  test('Ground events chain correctly after Flight events', async () => {
    // Simulate Flight events arriving via ws_gateway (pre-hashed)
    const flightTimestamp = new Date().toISOString();
    const flightHash = computeEventHash(
      'GENESIS', flightTimestamp, 'STATE_TRANSITION', 'FLIGHT', 'BOOT → NOMINAL'
    );

    await auditEvents.insert(db, {
      timestamp: flightTimestamp,
      event_type: 'STATE_TRANSITION',
      source: 'FLIGHT',
      severity: 'INFO',
      description: 'BOOT → NOMINAL',
      metadata: {},
      hash: flightHash,
      prev_hash: 'GENESIS',
    });

    // Now log a Ground event — it should chain from the Flight event
    const groundEvent = await service.logEvent(
      'PLAN_SIGNED', 'GROUND', 'INFO', 'Plan signed after Flight boot'
    );

    expect(groundEvent.prev_hash).toBe(flightHash);

    // Verify the full chain
    const result = await service.verifyChain();
    expect(result.chain_valid).toBe(true);
    expect(result.total_events).toBe(2);
  });

  test('interleaved Flight and Ground events maintain valid chain', async () => {
    // Flight event 1
    const ts1 = new Date(Date.now() - 4000).toISOString();
    const hash1 = computeEventHash('GENESIS', ts1, 'STATE_TRANSITION', 'FLIGHT', 'BOOT → NOMINAL');
    await auditEvents.insert(db, {
      timestamp: ts1, event_type: 'STATE_TRANSITION', source: 'FLIGHT',
      severity: 'INFO', description: 'BOOT → NOMINAL',
      metadata: {}, hash: hash1, prev_hash: 'GENESIS',
    });

    // Ground event 2
    const groundEvent1 = await service.logEvent(
      'PLAN_CREATED', 'GROUND', 'INFO', 'Plan created'
    );

    // Flight event 3 (simulated — must chain from groundEvent1)
    const ts3 = new Date(Date.now() - 1000).toISOString();
    const hash3 = computeEventHash(groundEvent1.hash, ts3, 'COMMAND_EXECUTED', 'FLIGHT', 'Cmd executed');
    await auditEvents.insert(db, {
      timestamp: ts3, event_type: 'COMMAND_EXECUTED', source: 'FLIGHT',
      severity: 'INFO', description: 'Cmd executed',
      metadata: {}, hash: hash3, prev_hash: groundEvent1.hash,
    });

    // Ground event 4
    const groundEvent2 = await service.logEvent(
      'PLAN_UPLOADED', 'GROUND', 'INFO', 'Plan uploaded'
    );

    expect(groundEvent2.prev_hash).toBe(hash3);

    // Full chain verification
    const result = await service.verifyChain();
    expect(result.chain_valid).toBe(true);
    expect(result.total_events).toBe(4);
  });
});

// ──────────────────────────────────────────────────────────
// computeEventHash utility
// ──────────────────────────────────────────────────────────

describe('computeEventHash', () => {
  test('produces consistent 64-char hex string', () => {
    const hash = computeEventHash(
      'GENESIS', '2026-03-10T14:00:00.000Z',
      'STATE_TRANSITION', 'FLIGHT', 'BOOT → NOMINAL'
    );

    expect(hash.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  test('same inputs produce same hash (deterministic)', () => {
    const args = ['GENESIS', '2026-03-10T14:00:00.000Z', 'PLAN_SIGNED', 'GROUND', 'Test'];
    const hash1 = computeEventHash(...args);
    const hash2 = computeEventHash(...args);

    expect(hash1).toBe(hash2);
  });

  test('different inputs produce different hashes', () => {
    const hash1 = computeEventHash('GENESIS', '2026-03-10T14:00:00Z', 'A', 'GROUND', 'Desc');
    const hash2 = computeEventHash('GENESIS', '2026-03-10T14:00:00Z', 'B', 'GROUND', 'Desc');

    expect(hash1).not.toBe(hash2);
  });

  test('changing prev_hash changes output (avalanche)', () => {
    const hash1 = computeEventHash('hash_a', '2026-03-10T14:00:00Z', 'X', 'GROUND', 'D');
    const hash2 = computeEventHash('hash_b', '2026-03-10T14:00:00Z', 'X', 'GROUND', 'D');

    expect(hash1).not.toBe(hash2);
  });
});