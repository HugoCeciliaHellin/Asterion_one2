// Ground segment entry point.
// Initializes and starts the REST API on port 3000 and the WebSocket Gateway on port 8081.

import { createConnection, runMigrations } from './db/manager.js';
import { createAuditService } from './services/audit.js';
import { createApp, startServer } from './api/server.js';
import { createWsGateway } from './ws/gateway.js';

const POSTGRES_PORT = process.env.POSTGRES_PORT || 5432;
process.env.POSTGRES_PORT = POSTGRES_PORT;

async function main() {
  const db = createConnection('development');

  const auditService = createAuditService(db);

  const wsGateway = createWsGateway({ db, port: 8081, auditService });

  const app = createApp(db, { wsGateway, auditService });
  await startServer(app);

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
