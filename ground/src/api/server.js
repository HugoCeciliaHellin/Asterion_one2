// ============================================================
// ASTERION ONE — api_server.js
// Ground Segment REST API Server
// ============================================================
// Ref: Art.5 §3.2.1 — Component: api_server
// Ref: Art.8 §3 (ICD) — IF-REST-001 through IF-REST-006
//
// 10 endpoints total (see ICD §3.3 summary table)
// Base URL: http://localhost:3000/api
//
// Architecture: Factory pattern (createApp) for testability.
// Dependencies injected: db (Knex), wsGateway (optional).
// ============================================================

import express from 'express';
import cors from 'cors';
import { createHealthRouter } from './routes/health.js';
import { createContactWindowsRouter } from './routes/contactWindows.js';
import { createCommandPlansRouter } from './routes/commandPlans.js';
import { createCommandsRouter } from './routes/commands.js';
import { createTelemetryRouter } from './routes/telemetry.js';
import { createEventsRouter } from './routes/events.js';
import { createTwinRouter } from './routes/twin.js';

// ──────────────────────────────────────────────────────────
// Server start time (for uptime calculation in /api/health)
// ──────────────────────────────────────────────────────────
const startTime = Date.now();

/**
 * Create the Express application with all routes mounted.
 *
 * @param {import('knex').Knex} db - Knex database instance
 * @param {object} [deps] - Optional dependencies
 * @param {object} [deps.wsGateway] - WebSocket gateway reference (for upload)
 * @param {object} [deps.auditService] - Audit service reference (for chain ops)
 * @returns {import('express').Express}
 */
export function createApp(db, deps = {}) {
  const app = express();

  // ── Global Middleware ──────────────────────────────────
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Inject db and deps into request for route handlers
  app.use((req, _res, next) => {
    req.db = db;
    req.wsGateway = deps.wsGateway || null;
    req.auditService = deps.auditService || null;
    req.startTime = startTime;
    next();
  });

  // ── Mount Routes (ICD §3.2) ────────────────────────────
  app.use('/api/health',          createHealthRouter());           // IF-REST-006
  app.use('/api/contact-windows', createContactWindowsRouter());   // IF-REST-001
  app.use('/api/command-plans',   createCommandPlansRouter());     // IF-REST-002
  app.use('/api/commands',        createCommandsRouter());         // IF-REST commands list
  app.use('/api/telemetry',       createTelemetryRouter());        // IF-REST-003
  app.use('/api/events',          createEventsRouter());           // IF-REST-004
  app.use('/api/twin',            createTwinRouter());             // IF-REST-005

  // ── Global Error Handler ───────────────────────────────
  // Ref: ICD §1.2 — Error response format
  app.use((err, _req, res, _next) => {
    console.error(`[api_server] Error: ${err.message}`);

    const statusCode = err.statusCode || 500;
    const code = err.code || 'INTERNAL_ERROR';

    res.status(statusCode).json({
      error: {
        code,
        message: err.message,
      },
    });
  });

  return app;
}

/**
 * Start the server on the configured port.
 * @param {import('express').Express} app
 * @param {number} [port=3000]
 * @returns {Promise<import('http').Server>}
 */
export function startServer(app, port = parseInt(process.env.API_PORT || '3000', 10)) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`[api_server] Asterion Ground API listening on port ${port}`);
      resolve(server);
    });
  });
}

export default { createApp, startServer };