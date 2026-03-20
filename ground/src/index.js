// ============================================================
// ASTERION ONE — Ground Segment Entry Point
// Starts: REST API (port 3000) + WebSocket Gateway (port 8081)
// ============================================================

import { createConnection, runMigrations } from './db/manager.js';
import { createAuditService } from './services/audit.js';
import { createApp, startServer } from './api/server.js';
import { createWsGateway } from './ws/gateway.js';

const POSTGRES_PORT = process.env.POSTGRES_PORT || 5432;
process.env.POSTGRES_PORT = POSTGRES_PORT;

async function main() {
  // 1. DB connection
  const db = createConnection('development');

  // 2. Audit service
  const auditService = createAuditService(db);

  // 3. WS Gateway (standalone on port 8081)
  const wsGateway = createWsGateway({ db, port: 8081, auditService });

  // 4. REST API (port 3000), injecting gateway + audit
  const app = createApp(db, { wsGateway, auditService });
  await startServer(app);

  // Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      console.log(`[ground] Received ${sig}, shutting down…`);
      await wsGateway.close();
      await db.destroy();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('[ground] Fatal error:', err);
  process.exit(1);
});
