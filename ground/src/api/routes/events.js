
import { Router } from 'express';
import { asyncHandler } from '../helpers.js';
import { auditEvents } from '../../db/manager.js';
import { computeEventHash } from '../../services/auditHash.js';

export function createEventsRouter() {
  const router = Router();

 
  router.get('/verify', asyncHandler(async (req, res) => {
    const events = await auditEvents.getAllOrdered(req.db);

    if (events.length === 0) {
      return res.json({
        data: {
          chain_valid: true,
          total_events: 0,
          first_event: null,
          last_event: null,
          break_at_index: null,
        },
      });
    }

    let chainValid = true;
    let breakAtIndex = null;
    let expectedHash = null;
    let actualHash = null;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      const recomputedHash = computeEventHash(
        event.prev_hash,
        event.timestamp,
        event.event_type,
        event.source,
        event.description
      );

      if (event.hash !== recomputedHash) {
        chainValid = false;
        breakAtIndex = i;
        expectedHash = recomputedHash;
        actualHash = event.hash;
        break;
      }

      if (i > 0) {
        if (event.prev_hash !== events[i - 1].hash) {
          chainValid = false;
          breakAtIndex = i;
          expectedHash = events[i - 1].hash;
          actualHash = event.prev_hash;
          break;
        }
      } else {
        if (event.prev_hash !== 'GENESIS') {
          chainValid = false;
          breakAtIndex = 0;
          expectedHash = 'GENESIS';
          actualHash = event.prev_hash;
          break;
        }
      }
    }

    const result = {
      chain_valid: chainValid,
      total_events: events.length,
      first_event: events[0]?.timestamp || null,
      last_event: events[events.length - 1]?.timestamp || null,
      break_at_index: breakAtIndex,
    };

    if (!chainValid) {
      result.expected_hash = expectedHash;
      result.actual_hash = actualHash;
    }

    res.json({ data: result });
  }));

  router.get('/', asyncHandler(async (req, res) => {
    const filters = {
      source: req.query.source,
      severity: req.query.severity,
      event_type: req.query.event_type,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
    };

    const data = await auditEvents.query(req.db, filters);
    res.json({ data });
  }));

  return router;
}

