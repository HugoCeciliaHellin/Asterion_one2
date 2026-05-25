import { computeEventHash } from './auditHash.js';
import { auditEvents } from '../db/manager.js';

const VALID_SOURCES = new Set(['GROUND', 'FLIGHT', 'SCHEDULER', 'TWIN']);
const VALID_SEVERITIES = new Set(['INFO', 'WARNING', 'CRITICAL']);


const KNOWN_EVENT_TYPES = new Set([
  'PLAN_CREATED', 'PLAN_SIGNED', 'PLAN_UPLOADED',
  'WINDOW_CREATED', 'OUTAGE_START', 'OUTAGE_END',
  'TWIN_ALERT', 'TELEMETRY_GAP',
  'STATE_TRANSITION', 'COMMAND_EXECUTED', 'COMMAND_REJECTED',
  'COMMS_CONNECTED', 'COMMS_DISCONNECTED',
  'WD_RESTART', 'FAULT_DETECTED', 'RECOVERY',
]);


export class AuditService {
  /**
   * @param {import('knex').Knex} db
   */
  constructor(db) {
    if (!db) throw new Error('Database connection is required');
    this._db = db;
  }

  /**
   * Log an audit event, chaining it to the previous event's hash.
   *
   * @param {string} eventType
   * @param {string} source   - GROUND | FLIGHT | SCHEDULER | TWIN
   * @param {string} severity - INFO | WARNING | CRITICAL
   * @param {string} description
   * @param {object} [metadata={}]
   * @returns {Promise<object>} Inserted event row
   */
  async logEvent(eventType, source, severity, description, metadata = {}) {
    if (!eventType)   throw new Error('eventType is required');
    if (!source)      throw new Error('source is required');
    if (!severity)    throw new Error('severity is required');
    if (!description) throw new Error('description is required');

    if (!VALID_SOURCES.has(source)) {
      throw new Error(`Invalid source: ${source}. Must be one of: ${[...VALID_SOURCES].join(', ')}`);
    }

    if (!VALID_SEVERITIES.has(severity)) {
      throw new Error(`Invalid severity: ${severity}. Must be one of: ${[...VALID_SEVERITIES].join(', ')}`);
    }

    if (!KNOWN_EVENT_TYPES.has(eventType)) {
      console.warn(`[AuditService] Unknown event_type: ${eventType} — allowed but not in catalog`);
    }

    const lastEvent = await this._db('audit_events')
      .orderByRaw('ctid DESC')
      .first();
    const prevHash = lastEvent ? lastEvent.hash : 'GENESIS';

    const timestamp = new Date().toISOString();
    const hash = computeEventHash(prevHash, timestamp, eventType, source, description);

    const event = await auditEvents.insert(this._db, {
      timestamp,
      event_type: eventType,
      source,
      severity,
      description,
      metadata,
      hash,
      prev_hash: prevHash,
    });

    return event;
  }

  /**
   * Verify integrity of the full audit chain.
   *
   * @returns {Promise<{chain_valid: boolean, total_events: number, break_at_index: number|null, first_event?, last_event?, expected_hash?, actual_hash?}>}
   */
  async verifyChain() {
    
    const events = await this._db('audit_events').orderByRaw('ctid ASC');

    if (events.length === 0) {
      return { chain_valid: true, total_events: 0, break_at_index: null };
    }

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const expectedPrevHash = i === 0 ? 'GENESIS' : events[i - 1].hash;

      // Check prev_hash linkage
      if (event.prev_hash !== expectedPrevHash) {
        return {
          chain_valid: false,
          total_events: events.length,
          break_at_index: i,
          expected_hash: expectedPrevHash,
          actual_hash: event.prev_hash,
          first_event: events[0],
          last_event: events[events.length - 1],
        };
      }

      // Recompute hash to detect content tampering
      const recomputedHash = computeEventHash(
        event.prev_hash,
        event.timestamp,
        event.event_type,
        event.source,
        event.description
      );

      if (recomputedHash !== event.hash) {
        return {
          chain_valid: false,
          total_events: events.length,
          break_at_index: i,
          expected_hash: recomputedHash,
          actual_hash: event.hash,
          first_event: events[0],
          last_event: events[events.length - 1],
        };
      }
    }

    return {
      chain_valid: true,
      total_events: events.length,
      break_at_index: null,
      first_event: events[0],
      last_event: events[events.length - 1],
    };
  }
}

/**
 * @param {import('knex').Knex} db
 * @returns {AuditService}
 */
export function createAuditService(db) {
  return new AuditService(db);
}

export default { AuditService, createAuditService };
