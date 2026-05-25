import express from 'express';
import cors from 'cors';
import { createHealthRouter } from './routes/health.js';
import { createContactWindowsRouter } from './routes/contactWindows.js';
import { createCommandPlansRouter } from './routes/commandPlans.js';
import { createCommandsRouter } from './routes/commands.js';
import { createTelemetryRouter } from './routes/telemetry.js';
import { createEventsRouter } from './routes/events.js';
import { createTwinRouter } from './routes/twin.js';


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

  app.use('/api/health',          createHealthRouter());           
  app.use('/api/contact-windows', createContactWindowsRouter());   
  app.use('/api/command-plans',   createCommandPlansRouter());     
  app.use('/api/commands',        createCommandsRouter());         
  app.use('/api/telemetry',       createTelemetryRouter());       
  app.use('/api/events',          createEventsRouter());           
  app.use('/api/twin',            createTwinRouter());            


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