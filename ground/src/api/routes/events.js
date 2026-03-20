// ============================================================
// ASTERION ONE — Route: /api/events
// IF-REST-004: Audit Events Query + Chain Verification
// Ref: ICD §3.2, IF-REST-004
// Ref: Art.2 §3.5 — Hash-chaining scheme
// Req: REQ-FSW-LOG-SECURE
// ============================================================

import { Router } from 'express';
import { asyncHandler } from '../helpers.js';
import { auditEvents } from '../../db/manager.js';
import { computeEventHash } from '../../services/auditHash.js';

export function createEventsRouter() {
  const router = Router();

  // ── GET /api/events/verify ─────────────────────────────
  // IMPORTANT: This route must be defined BEFORE /:id
  // to avoid 'verify' being treated as an ID parameter.
  //
  // Verifies hash-chain integrity by recomputing all hashes.
  // Ref: Art.2 §3.5 — hash = SHA256(prev_hash || timestamp || event_type || source || description)
  //
  // Response 200: {
  //   data: {
  //     chain_valid: true|false,
  //     total_events: N,
  //     first_event: "...",
  //     last_event: "...",
  //     break_at_index: null | N
  //   }
  // }
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

    // Verify chain: recompute each hash and compare
    let chainValid = true;
    let breakAtIndex = null;
    let expectedHash = null;
    let actualHash = null;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      // Recompute hash per Art.2 §3.5 scheme
      const recomputedHash = computeEventHash(
        event.prev_hash,
        event.timestamp,
        event.event_type,
        event.source,
        event.description
      );

      // Verify stored hash matches recomputed
      if (event.hash !== recomputedHash) {
        chainValid = false;
        breakAtIndex = i;
        expectedHash = recomputedHash;
        actualHash = event.hash;
        break;
      }

      // Verify chain linkage: this event's prev_hash should match previous event's hash
      if (i > 0) {
        if (event.prev_hash !== events[i - 1].hash) {
          chainValid = false;
          breakAtIndex = i;
          expectedHash = events[i - 1].hash;
          actualHash = event.prev_hash;
          break;
        }
      } else {
        // First event: prev_hash should be 'GENESIS'
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

  // ── GET /api/events ────────────────────────────────────
  // Query params: ?source, ?severity, ?event_type, ?from, ?to, ?limit
  // Response 200: { data: [...] }
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

// Hash computation: see ../../services/auditHash.js (shared module)