// ============================================================
// ASTERION ONE — Migration 001: Initial Schema
// ============================================================
// Source of Truth: Art.2 (ERD) §5 — DDL completo
// Tables: contact_windows, command_plans, commands,
//         telemetry, audit_events, twin_forecasts
// ============================================================

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  // ──────────────────────────────────────────────────────────
  // STEP 1: Create ENUM types
  // Ref: Art.2 §5 — ENUMS
  // ──────────────────────────────────────────────────────────
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE contact_window_status AS ENUM
        ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE command_plan_status AS ENUM
        ('DRAFT', 'SIGNED', 'UPLOADED', 'EXECUTING', 'COMPLETED', 'REJECTED');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE command_status AS ENUM
        ('QUEUED', 'SENT', 'ACKED', 'EXECUTED', 'FAILED', 'EXPIRED');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE fsw_state AS ENUM
        ('BOOT', 'NOMINAL', 'SAFE', 'CRITICAL');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE event_severity AS ENUM
        ('INFO', 'WARNING', 'CRITICAL');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  // ──────────────────────────────────────────────────────────
  // STEP 2: Enable uuid-ossp extension for gen_random_uuid()
  // ──────────────────────────────────────────────────────────
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  // ──────────────────────────────────────────────────────────
  // TABLE 1: contact_windows [REQ-GND-PLAN]
  // Ref: Art.2 §3.1
  // ──────────────────────────────────────────────────────────
  await knex.schema.createTable('contact_windows', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('name').notNullable();
    table.timestamp('aos_time', { useTz: true }).notNullable();
    table.timestamp('los_time', { useTz: true }).notNullable();
    table.specificType('status', 'contact_window_status').notNullable().defaultTo('SCHEDULED');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Indexes: Art.2 §3.1
    table.index('status', 'idx_cw_status');
    table.index('aos_time', 'idx_cw_aos');
  });

  // CHECK constraint: los_time > aos_time (Art.2 §3.1)
  await knex.raw(`
    ALTER TABLE contact_windows
    ADD CONSTRAINT chk_cw_los_after_aos CHECK (los_time > aos_time)
  `);

  // ──────────────────────────────────────────────────────────
  // TABLE 2: command_plans [REQ-SEC-ED25519]
  // Ref: Art.2 §3.2
  // ──────────────────────────────────────────────────────────
  await knex.schema.createTable('command_plans', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('contact_window_id')
      .references('id').inTable('contact_windows')
      .onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text('operator_name').notNullable();
    table.text('signature').nullable();
    table.text('signature_algo').defaultTo('Ed25519');
    table.specificType('status', 'command_plan_status').notNullable().defaultTo('DRAFT');

    // Index: Art.2 §3.2
    table.index('status', 'idx_cp_status');
  });

  // ──────────────────────────────────────────────────────────
  // TABLE 3: commands [REQ-COM-ZERO-LOSS, REQ-COM-P95]
  // Ref: Art.2 §3.3
  // ──────────────────────────────────────────────────────────
  await knex.schema.createTable('commands', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('plan_id')
      .notNullable()
      .references('id').inTable('command_plans')
      .onDelete('CASCADE');
    table.integer('sequence_id').notNullable();
    table.text('command_type').notNullable();
    table.jsonb('payload').notNullable().defaultTo('{}');
    table.specificType('status', 'command_status').notNullable().defaultTo('QUEUED');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('sent_at', { useTz: true }).nullable();
    table.timestamp('acked_at', { useTz: true }).nullable();
    table.timestamp('executed_at', { useTz: true }).nullable();
    table.integer('retry_count').notNullable().defaultTo(0);

    // UNIQUE constraint: Art.2 §3.3
    table.unique(['plan_id', 'sequence_id']);

    // Indexes: Art.2 §3.3
    table.index('status', 'idx_cmd_status');
    table.index(['plan_id', 'sequence_id'], 'idx_cmd_plan_seq');
  });

  // ──────────────────────────────────────────────────────────
  // TABLE 4: telemetry
  // Ref: Art.2 §3.4
  // ──────────────────────────────────────────────────────────
  await knex.schema.createTable('telemetry', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.integer('sequence_id').notNullable();
    table.timestamp('timestamp', { useTz: true }).notNullable();
    table.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text('subsystem').notNullable();
    table.jsonb('metrics').notNullable();
    table.specificType('fsw_state', 'fsw_state').notNullable();

    // Indexes: Art.2 §3.4
    table.index('timestamp', 'idx_telem_ts');
    table.index(['subsystem', 'timestamp'], 'idx_telem_sub_ts');
    table.index('sequence_id', 'idx_telem_seq');
  });

  // ──────────────────────────────────────────────────────────
  // TABLE 5: audit_events [REQ-FSW-LOG-SECURE]
  // Ref: Art.2 §3.5
  // ──────────────────────────────────────────────────────────
  await knex.schema.createTable('audit_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.timestamp('timestamp', { useTz: true }).notNullable();
    table.text('event_type').notNullable();
    table.text('source').notNullable();
    table.specificType('severity', 'event_severity').notNullable();
    table.text('description').notNullable();
    table.jsonb('metadata').defaultTo('{}');
    table.text('hash').notNullable();
    table.text('prev_hash').notNullable();

    // Indexes: Art.2 §3.5
    table.index('timestamp', 'idx_audit_ts');
    table.index('severity', 'idx_audit_severity');
    table.index('event_type', 'idx_audit_type');
  });

  // ──────────────────────────────────────────────────────────
  // TABLE 6: twin_forecasts [REQ-DT-EARLY-15m, REQ-DT-RATIONALE]
  // Ref: Art.2 §3.6
  // ──────────────────────────────────────────────────────────
  await knex.schema.createTable('twin_forecasts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text('model_type').notNullable();
    table.integer('horizon_min').notNullable();
    table.jsonb('predicted_values').notNullable();
    table.boolean('breach_detected').notNullable().defaultTo(false);
    table.timestamp('breach_time', { useTz: true }).nullable();
    table.float('lead_time_min').nullable();
    table.text('rationale').nullable();
    table.boolean('alert_emitted').notNullable().defaultTo(false);

    // Indexes: Art.2 §3.6
    table.index('created_at', 'idx_tf_created');
    table.index('breach_detected', 'idx_tf_breach');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  // Drop tables in reverse dependency order
  await knex.schema.dropTableIfExists('twin_forecasts');
  await knex.schema.dropTableIfExists('audit_events');
  await knex.schema.dropTableIfExists('telemetry');
  await knex.schema.dropTableIfExists('commands');
  await knex.schema.dropTableIfExists('command_plans');
  await knex.schema.dropTableIfExists('contact_windows');

  // Drop ENUM types
  await knex.raw('DROP TYPE IF EXISTS event_severity');
  await knex.raw('DROP TYPE IF EXISTS fsw_state');
  await knex.raw('DROP TYPE IF EXISTS command_status');
  await knex.raw('DROP TYPE IF EXISTS command_plan_status');
  await knex.raw('DROP TYPE IF EXISTS contact_window_status');
}