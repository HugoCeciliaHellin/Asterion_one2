// ============================================================
// ASTERION ONE — db_manager.js
// Database Abstraction Layer (IDatabase Interface)
// ============================================================
// Ref: Art.5 §3.2.3 — Component: db_manager
// Ref: Art.2 (ERD) — Schema definition
// Ref: Art.8 §3 (ICD) — REST API query contracts
//
// Provides: IDatabase interface
// Consumed by: api_server, ws_gateway, audit_service
// ============================================================

import knex from 'knex';
import knexConfig from '../../knexfile.js';

// ──────────────────────────────────────────────────────────
// Database Connection Management
// ──────────────────────────────────────────────────────────

/**
 * Create a Knex instance for the given environment.
 * @param {string} env - 'development' | 'test' | 'production'
 * @returns {import('knex').Knex}
 */
export function createConnection(env = process.env.NODE_ENV || 'development') {
  const config = knexConfig[env];
  if (!config) {
    throw new Error(`[db_manager] Unknown environment: "${env}"`);
  }
  return knex(config);
}

/**
 * Run all pending migrations.
 * @param {import('knex').Knex} db
 */
export async function runMigrations(db) {
  const [batchNo, migrations] = await db.migrate.latest();
  return { batchNo, migrations };
}

/**
 * Rollback the last batch of migrations.
 * @param {import('knex').Knex} db
 */
export async function rollbackMigrations(db) {
  const [batchNo, migrations] = await db.migrate.rollback();
  return { batchNo, migrations };
}

/**
 * Destroy the database connection pool.
 * @param {import('knex').Knex} db
 */
export async function destroyConnection(db) {
  await db.destroy();
}

// ──────────────────────────────────────────────────────────
// contactWindows — [REQ-GND-PLAN]
// Ref: Art.2 §3.1, ICD IF-REST-001
// ──────────────────────────────────────────────────────────

export const contactWindows = {
  /**
   * Create a new contact window.
   * @param {import('knex').Knex} db
   * @param {{ name: string, aos_time: string, los_time: string }} data
   * @returns {Promise<object>} Created window row
   */
  async create(db, { name, aos_time, los_time }) {
    if (!name || !aos_time || !los_time) {
      throw new Error('[contactWindows.create] name, aos_time, los_time are required');
    }
    if (new Date(los_time) <= new Date(aos_time)) {
      throw new Error('[contactWindows.create] los_time must be after aos_time');
    }

    const [row] = await db('contact_windows')
      .insert({ name, aos_time, los_time })
      .returning('*');
    return row;
  },

  /**
   * List contact windows with optional filters.
   * @param {import('knex').Knex} db
   * @param {{ status?: string, from?: string, to?: string, limit?: number }} filters
   * @returns {Promise<object[]>}
   */
  async list(db, filters = {}) {
    let query = db('contact_windows').orderBy('aos_time', 'asc');

    if (filters.status) {
      query = query.where('status', filters.status);
    }
    if (filters.from) {
      query = query.where('aos_time', '>=', filters.from);
    }
    if (filters.to) {
      query = query.where('aos_time', '<=', filters.to);
    }

    const limit = Math.min(filters.limit || 100, 500);
    query = query.limit(limit);

    return query;
  },

  /**
   * Get a single contact window by ID.
   * @param {import('knex').Knex} db
   * @param {string} id - UUID
   * @returns {Promise<object|null>}
   */
  async getById(db, id) {
    return db('contact_windows').where({ id }).first() || null;
  },

  /**
   * Update contact window status.
   * Enforces valid transitions per Art.2 §3.1:
   *   SCHEDULED → ACTIVE | CANCELLED
   *   ACTIVE → COMPLETED
   * @param {import('knex').Knex} db
   * @param {string} id
   * @param {string} newStatus
   * @returns {Promise<object>}
   */
  async updateStatus(db, id, newStatus) {
    const VALID_TRANSITIONS = {
      SCHEDULED: ['ACTIVE', 'CANCELLED'],
      ACTIVE: ['COMPLETED'],
    };

    const window = await db('contact_windows').where({ id }).first();
    if (!window) {
      throw new Error(`[contactWindows.updateStatus] Window not found: ${id}`);
    }

    const allowed = VALID_TRANSITIONS[window.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(
        `[contactWindows.updateStatus] Invalid transition: ${window.status} → ${newStatus}`
      );
    }

    const [updated] = await db('contact_windows')
      .where({ id })
      .update({ status: newStatus })
      .returning('*');
    return updated;
  },

  /**
   * Check for overlapping windows (used during creation validation).
   * Ref: ICD IF-REST-001 POST validation
   * @param {import('knex').Knex} db
   * @param {string} aos_time
   * @param {string} los_time
   * @param {string} [excludeId] - UUID to exclude (for updates)
   * @returns {Promise<object[]>} Overlapping windows
   */
  async findOverlapping(db, aos_time, los_time, excludeId = null) {
    let query = db('contact_windows')
      .whereIn('status', ['SCHEDULED', 'ACTIVE'])
      .where('aos_time', '<', los_time)
      .where('los_time', '>', aos_time);

    if (excludeId) {
      query = query.whereNot('id', excludeId);
    }
    return query;
  },
};

// ──────────────────────────────────────────────────────────
// commandPlans — [REQ-SEC-ED25519, REQ-GND-PLAN]
// Ref: Art.2 §3.2, ICD IF-REST-002
// ──────────────────────────────────────────────────────────

export const commandPlans = {
  /**
   * Create a new command plan with its commands in a transaction.
   * Server assigns sequence_ids (1, 2, 3, ...) per ICD IF-REST-002.
   * @param {import('knex').Knex} db
   * @param {{ contact_window_id?: string, operator_name: string, commands: Array }} data
   * @returns {Promise<object>} Created plan with commands
   */
  async create(db, { contact_window_id, operator_name, commands: cmds }) {
    if (!operator_name) {
      throw new Error('[commandPlans.create] operator_name is required');
    }
    if (!Array.isArray(cmds) || cmds.length === 0) {
      throw new Error('[commandPlans.create] At least one command is required');
    }

    return db.transaction(async (trx) => {
      // Insert plan
      const [plan] = await trx('command_plans')
        .insert({
          contact_window_id: contact_window_id || null,
          operator_name,
        })
        .returning('*');

      // Insert commands with assigned sequence_ids
      const commandRows = cmds.map((cmd, index) => ({
        plan_id: plan.id,
        sequence_id: index + 1,
        command_type: cmd.command_type,
        payload: JSON.stringify(cmd.payload || {}),
      }));

      const insertedCmds = await trx('commands')
        .insert(commandRows)
        .returning('*');

      return { ...plan, commands: insertedCmds };
    });
  },

  /**
   * Get a plan by ID with its commands.
   * @param {import('knex').Knex} db
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getById(db, id) {
    const plan = await db('command_plans').where({ id }).first();
    if (!plan) return null;

    const cmds = await db('commands')
      .where({ plan_id: id })
      .orderBy('sequence_id', 'asc');

    return { ...plan, commands: cmds };
  },

  /**
   * List command plans with optional filters.
   * @param {import('knex').Knex} db
   * @param {{ status?: string, contact_window_id?: string, limit?: number }} filters
   * @returns {Promise<object[]>}
   */
  async list(db, filters = {}) {
    let query = db('command_plans').orderBy('created_at', 'desc');

    if (filters.status) {
      query = query.where('status', filters.status);
    }
    if (filters.contact_window_id) {
      query = query.where('contact_window_id', filters.contact_window_id);
    }

    const limit = Math.min(filters.limit || 100, 500);
    return query.limit(limit);
  },

  /**
   * Attach Ed25519 signature to a DRAFT plan.
   * Transitions: DRAFT → SIGNED
   * Ref: ICD IF-REST-002 PATCH
   * @param {import('knex').Knex} db
   * @param {string} id
   * @param {{ signature: string, signature_algo?: string, public_key: string }} sigData
   * @returns {Promise<object>}
   */
  async sign(db, id, { signature, signature_algo, public_key }) {
    if (!signature || !public_key) {
      throw new Error('[commandPlans.sign] signature and public_key are required');
    }

    const plan = await db('command_plans').where({ id }).first();
    if (!plan) {
      throw new Error(`[commandPlans.sign] Plan not found: ${id}`);
    }
    if (plan.status !== 'DRAFT') {
      throw new Error(
        `[commandPlans.sign] Plan must be DRAFT to sign, current: ${plan.status}`
      );
    }

    const [updated] = await db('command_plans')
      .where({ id })
      .update({
        signature,
        signature_algo: signature_algo || 'Ed25519',
        status: 'SIGNED',
      })
      .returning('*');
    return updated;
  },

  /**
   * Update plan status.
   * Enforces valid transitions per Art.2 §3.2:
   *   DRAFT → SIGNED
   *   SIGNED → UPLOADED
   *   UPLOADED → EXECUTING | REJECTED
   *   EXECUTING → COMPLETED | REJECTED
   * @param {import('knex').Knex} db
   * @param {string} id
   * @param {string} newStatus
   * @returns {Promise<object>}
   */
  async updateStatus(db, id, newStatus) {
    const VALID_TRANSITIONS = {
      DRAFT: ['SIGNED'],
      SIGNED: ['UPLOADED'],
      UPLOADED: ['EXECUTING', 'REJECTED'],
      EXECUTING: ['COMPLETED', 'REJECTED'],
    };

    const plan = await db('command_plans').where({ id }).first();
    if (!plan) {
      throw new Error(`[commandPlans.updateStatus] Plan not found: ${id}`);
    }

    const allowed = VALID_TRANSITIONS[plan.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(
        `[commandPlans.updateStatus] Invalid transition: ${plan.status} → ${newStatus}`
      );
    }

    const [updated] = await db('command_plans')
      .where({ id })
      .update({ status: newStatus })
      .returning('*');
    return updated;
  },
};

// ──────────────────────────────────────────────────────────
// commands — [REQ-COM-ZERO-LOSS, REQ-COM-P95]
// Ref: Art.2 §3.3, ICD IF-REST-003 (commands list)
// ──────────────────────────────────────────────────────────

export const commands = {
  /**
   * Get commands for a plan.
   * @param {import('knex').Knex} db
   * @param {string} planId
   * @returns {Promise<object[]>}
   */
  async getByPlanId(db, planId) {
    return db('commands')
      .where({ plan_id: planId })
      .orderBy('sequence_id', 'asc');
  },

  /**
   * Update command status with corresponding timestamp.
   * Ref: Art.2 §3.3 — status lifecycle
   * @param {import('knex').Knex} db
   * @param {string} id
   * @param {string} newStatus
   * @param {{ sent_at?: string, acked_at?: string, executed_at?: string }} timestamps
   * @returns {Promise<object>}
   */
  async updateStatus(db, id, newStatus, timestamps = {}) {
    const updateData = { status: newStatus };

    if (timestamps.sent_at) updateData.sent_at = timestamps.sent_at;
    if (timestamps.acked_at) updateData.acked_at = timestamps.acked_at;
    if (timestamps.executed_at) updateData.executed_at = timestamps.executed_at;

    const [updated] = await db('commands')
      .where({ id })
      .update(updateData)
      .returning('*');

    if (!updated) {
      throw new Error(`[commands.updateStatus] Command not found: ${id}`);
    }
    return updated;
  },

  /**
   * Bulk update all commands in a plan to a given status.
   * Used when a plan is REJECTED — all commands → FAILED.
   * @param {import('knex').Knex} db
   * @param {string} planId
   * @param {string} newStatus
   * @returns {Promise<number>} Number of rows updated
   */
  async bulkUpdateByPlanId(db, planId, newStatus) {
    return db('commands')
      .where({ plan_id: planId })
      .update({ status: newStatus });
  },

  /**
   * Increment retry count for a command.
   * @param {import('knex').Knex} db
   * @param {string} id
   * @returns {Promise<object>}
   */
  async incrementRetry(db, id) {
    const [updated] = await db('commands')
      .where({ id })
      .increment('retry_count', 1)
      .returning('*');
    return updated;
  },

  /**
   * List commands with optional filters.
   * @param {import('knex').Knex} db
   * @param {{ status?: string, plan_id?: string, limit?: number }} filters
   * @returns {Promise<object[]>}
   */
  async list(db, filters = {}) {
    let query = db('commands').orderBy('created_at', 'desc');

    if (filters.status) {
      query = query.where('status', filters.status);
    }
    if (filters.plan_id) {
      query = query.where('plan_id', filters.plan_id);
    }

    const limit = Math.min(filters.limit || 200, 1000);
    return query.limit(limit);
  },
};

// ──────────────────────────────────────────────────────────
// telemetry
// Ref: Art.2 §3.4, ICD IF-REST-003
// ──────────────────────────────────────────────────────────

export const telemetry = {
  /**
   * Insert a telemetry frame.
   * Called by ws_gateway when TELEMETRY message received from Flight.
   * @param {import('knex').Knex} db
   * @param {{ sequence_id: number, timestamp: string, subsystem: string, metrics: object, fsw_state: string }} frame
   * @returns {Promise<object>}
   */
  async insert(db, { sequence_id, timestamp, subsystem, metrics, fsw_state }) {
    if (sequence_id == null || !timestamp || !subsystem || !metrics || !fsw_state) {
      throw new Error('[telemetry.insert] All fields are required');
    }

    const [row] = await db('telemetry')
      .insert({
        sequence_id,
        timestamp,
        subsystem,
        metrics: JSON.stringify(metrics),
        fsw_state,
      })
      .returning('*');
    return row;
  },

  /**
   * Query telemetry frames with filters.
   * Ref: ICD IF-REST-003 query params
   * @param {import('knex').Knex} db
   * @param {{ subsystem?: string, from?: string, to?: string, last?: string, limit?: number }} filters
   * @returns {Promise<{ data: object[], meta: { total: number, returned: number } }>}
   */
  async query(db, filters = {}) {
    let query = db('telemetry').orderBy('timestamp', 'desc');

    // Filter by subsystem(s) — comma-separated
    if (filters.subsystem) {
      const subsystems = filters.subsystem.split(',').map((s) => s.trim());
      query = query.whereIn('subsystem', subsystems);
    }

    // Time range
    if (filters.from) {
      query = query.where('timestamp', '>=', filters.from);
    }
    if (filters.to) {
      query = query.where('timestamp', '<=', filters.to);
    }

    // Shorthand: ?last=30m → last 30 minutes
    if (filters.last) {
      const match = filters.last.match(/^(\d+)([mhd])$/);
      if (match) {
        const [, value, unit] = match;
        const multiplier = { m: 60000, h: 3600000, d: 86400000 };
        const since = new Date(Date.now() - parseInt(value) * multiplier[unit]);
        query = query.where('timestamp', '>=', since.toISOString());
      }
    }

    const limit = Math.min(filters.limit || 500, 2000);

    // Get total count for meta (before limit)
    const [{ count }] = await db('telemetry')
      .count('* as count')
      .modify((qb) => {
        if (filters.subsystem) {
          const subsystems = filters.subsystem.split(',').map((s) => s.trim());
          qb.whereIn('subsystem', subsystems);
        }
        if (filters.from) qb.where('timestamp', '>=', filters.from);
        if (filters.to) qb.where('timestamp', '<=', filters.to);
      });

    const data = await query.limit(limit);

    return {
      data,
      meta: {
        total: parseInt(count),
        returned: data.length,
      },
    };
  },

  /**
   * Get the latest telemetry frame (for LiveHealthView).
   * @param {import('knex').Knex} db
   * @returns {Promise<object|null>}
   */
  async getLatest(db) {
    return db('telemetry').orderBy('timestamp', 'desc').first() || null;
  },

  /**
   * Get latest frame per subsystem (for health dashboard).
   * @param {import('knex').Knex} db
   * @returns {Promise<object[]>}
   */
  async getLatestBySubsystem(db) {
    return db('telemetry')
      .distinctOn('subsystem')
      .orderBy(['subsystem', { column: 'timestamp', order: 'desc' }]);
  },
};

// ──────────────────────────────────────────────────────────
// auditEvents — [REQ-FSW-LOG-SECURE]
// Ref: Art.2 §3.5, ICD IF-REST-004
// ──────────────────────────────────────────────────────────

export const auditEvents = {
  /**
   * Insert an audit event (already hash-chained by caller).
   * @param {import('knex').Knex} db
   * @param {{ timestamp: string, event_type: string, source: string, severity: string, description: string, metadata?: object, hash: string, prev_hash: string }} event
   * @returns {Promise<object>}
   */
  async insert(db, event) {
    const { timestamp, event_type, source, severity, description, metadata, hash, prev_hash } = event;

    if (!timestamp || !event_type || !source || !severity || !description || !hash || !prev_hash) {
      throw new Error('[auditEvents.insert] Required fields missing');
    }

    const [row] = await db('audit_events')
      .insert({
        timestamp,
        event_type,
        source,
        severity,
        description,
        metadata: JSON.stringify(metadata || {}),
        hash,
        prev_hash,
      })
      .returning('*');
    return row;
  },

  /**
   * Query audit events with filters.
   * Ref: ICD IF-REST-004 query params
   * @param {import('knex').Knex} db
   * @param {{ source?: string, severity?: string, event_type?: string, from?: string, to?: string, limit?: number }} filters
   * @returns {Promise<object[]>}
   */
  async query(db, filters = {}) {
    let query = db('audit_events').orderBy('timestamp', 'asc');

    if (filters.source) {
      query = query.where('source', filters.source);
    }
    if (filters.severity) {
      query = query.where('severity', filters.severity);
    }
    if (filters.event_type) {
      query = query.where('event_type', filters.event_type);
    }
    if (filters.from) {
      query = query.where('timestamp', '>=', filters.from);
    }
    if (filters.to) {
      query = query.where('timestamp', '<=', filters.to);
    }

    const limit = Math.min(filters.limit || 200, 2000);
    return query.limit(limit);
  },

  /**
   * Get the last audit event (for chaining).
   * @param {import('knex').Knex} db
   * @returns {Promise<object|null>}
   */
  async getLastEvent(db) {
    return db('audit_events').orderBy('timestamp', 'desc').first() || null;
  },

  /**
   * Get all events ordered for chain verification.
   * @param {import('knex').Knex} db
   * @returns {Promise<object[]>}
   */
  async getAllOrdered(db) {
    return db('audit_events').orderBy('timestamp', 'asc');
  },
};

// ──────────────────────────────────────────────────────────
// twinForecasts — [REQ-DT-EARLY-15m, REQ-DT-RATIONALE]
// Ref: Art.2 §3.6, ICD IF-REST-005
// ──────────────────────────────────────────────────────────

export const twinForecasts = {
  /**
   * Insert a forecast from the Digital Twin.
   * @param {import('knex').Knex} db
   * @param {{ model_type: string, horizon_min: number, predicted_values: object, breach_detected: boolean, breach_time?: string, lead_time_min?: number, rationale?: string, alert_emitted?: boolean }} forecast
   * @returns {Promise<object>}
   */
  async insert(db, forecast) {
    const {
      model_type, horizon_min, predicted_values,
      breach_detected, breach_time, lead_time_min,
      rationale, alert_emitted,
    } = forecast;

    if (!model_type || horizon_min == null || !predicted_values) {
      throw new Error('[twinForecasts.insert] model_type, horizon_min, predicted_values required');
    }

    const [row] = await db('twin_forecasts')
      .insert({
        model_type,
        horizon_min,
        predicted_values: JSON.stringify(predicted_values),
        breach_detected: breach_detected || false,
        breach_time: breach_time || null,
        lead_time_min: lead_time_min || null,
        rationale: rationale || null,
        alert_emitted: alert_emitted || false,
      })
      .returning('*');
    return row;
  },

  /**
   * Query forecasts with filters.
   * Ref: ICD IF-REST-005
   * @param {import('knex').Knex} db
   * @param {{ model_type?: string, breach_only?: boolean, from?: string, to?: string, limit?: number }} filters
   * @returns {Promise<object[]>}
   */
  async query(db, filters = {}) {
    let query = db('twin_forecasts').orderBy('created_at', 'desc');

    if (filters.model_type) {
      query = query.where('model_type', filters.model_type);
    }
    if (filters.breach_only) {
      query = query.where('breach_detected', true);
    }
    if (filters.from) {
      query = query.where('created_at', '>=', filters.from);
    }
    if (filters.to) {
      query = query.where('created_at', '<=', filters.to);
    }

    const limit = Math.min(filters.limit || 100, 500);
    return query.limit(limit);
  },

  /**
   * Get active alerts (breach_detected=true, alert_emitted=true).
   * Ref: ICD IF-REST-005 GET /api/twin/alerts
   * @param {import('knex').Knex} db
   * @returns {Promise<object[]>}
   */
  async getActiveAlerts(db) {
    return db('twin_forecasts')
      .where({ breach_detected: true, alert_emitted: true })
      .orderBy('created_at', 'desc')
      .limit(50);
  },
};

// ──────────────────────────────────────────────────────────
// Health check utility
// Ref: ICD IF-REST-006
// ──────────────────────────────────────────────────────────

/**
 * Test database connectivity.
 * @param {import('knex').Knex} db
 * @returns {Promise<boolean>}
 */
export async function isConnected(db) {
  try {
    await db.raw('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────
// Default export: IDatabase facade
// ──────────────────────────────────────────────────────────

export default {
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
};