// ============================================================
// ASTERION ONE — Route: /api/health
// IF-REST-006: System Health Check
// Ref: ICD §3.2, IF-REST-006
// Req: REQ-OPS-OBSERVABILITY
// ============================================================

import { Router } from 'express';
import { asyncHandler } from '../helpers.js';
import { isConnected } from '../../db/manager.js';

export function createHealthRouter() {
  const router = Router();

  // GET /api/health
  router.get('/', asyncHandler(async (req, res) => {
    const dbConnected = await isConnected(req.db);

    const wsGateway = req.wsGateway;
    const wsStatus = wsGateway ? 'connected' : 'disconnected';
    const flightLink = wsGateway?.isFlightConnected?.() ? 'active' : 'inactive';
    const twinStatus = 'stopped'; // Updated in Phase 4

    const uptimeS = Math.floor((Date.now() - req.startTime) / 1000);

    res.json({
      status: dbConnected ? 'healthy' : 'degraded',
      components: {
        database: dbConnected ? 'connected' : 'disconnected',
        websocket: wsStatus,
        flight_link: flightLink,
        twin: twinStatus,
      },
      uptime_s: uptimeS,
      timestamp: new Date().toISOString(),
    });
  }));

  return router;
}