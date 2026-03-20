// ============================================================
// ASTERION ONE — Knex.js Configuration
// Ref: Art.2 (ERD), Phase 0 docker-compose.yml
// ============================================================

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Database configuration per environment.
 * PostgreSQL connection defaults match docker-compose.yml from Phase 0.
 *
 * Override via environment variables:
 *   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB,
 *   POSTGRES_USER, POSTGRES_PASSWORD
 */
const config = {
  development: {
    client: 'pg',
    connection: {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB || 'asterion',
      user: process.env.POSTGRES_USER || 'asterion',
      password: process.env.POSTGRES_PASSWORD || 'asterion_dev',
    },
    migrations: {
      directory: join(__dirname, 'src', 'db', 'migrations'),
      tableName: 'knex_migrations',
    },
    pool: {
      min: 2,
      max: 10,
    },
  },

  test: {
    client: 'pg',
    connection: {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB || 'asterion_test',
      user: process.env.POSTGRES_USER || 'asterion',
      password: process.env.POSTGRES_PASSWORD || 'asterion_dev',
    },
    migrations: {
      directory: join(__dirname, 'src', 'db', 'migrations'),
      tableName: 'knex_migrations',
    },
    pool: {
      min: 1,
      max: 5,
    },
  },

  production: {
    client: 'pg',
    connection: {
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB || 'asterion',
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
    },
    migrations: {
      directory: join(__dirname, 'src', 'db', 'migrations'),
      tableName: 'knex_migrations',
    },
    pool: {
      min: 2,
      max: 20,
    },
  },
};

export default config;