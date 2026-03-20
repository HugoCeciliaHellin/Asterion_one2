// ============================================================
// ASTERION ONE — Audit Hash Utility (Shared)
// ============================================================
// Ref: Art.2 §3.5 — Hash-chaining scheme
// hash = SHA-256( prev_hash || timestamp || event_type || source || description )
//
// Used by:
//   - audit_service.js (logEvent — compute hash for new Ground events)
//   - routes/events.js (GET /api/events/verify — recompute chain)
// ============================================================

import { createHash } from 'crypto';

/**
 * Compute SHA-256 hash for an audit event per Art.2 §3.5.
 *
 * @param {string} prevHash - Previous event's hash (or 'GENESIS' for first event)
 * @param {string} timestamp - ISO 8601 UTC timestamp
 * @param {string} eventType - Event type identifier
 * @param {string} source - Event source (FLIGHT, GROUND, TWIN, SCHEDULER)
 * @param {string} description - Human-readable event description
 * @returns {string} SHA-256 hex digest (lowercase)
 */
export function computeEventHash(prevHash, timestamp, eventType, source, description) {
  const ts = typeof timestamp === 'string'
    ? timestamp
    : new Date(timestamp).toISOString();

  const input = `${prevHash}${ts}${eventType}${source}${description}`;
  return createHash('sha256').update(input).digest('hex');
}