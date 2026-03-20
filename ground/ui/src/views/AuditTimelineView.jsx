// ============================================================
// ASTERION ONE — AuditTimelineView
// /timeline — Chronological audit events + chain verification
// Ref: Art.5 §3.2.5, ICD IF-REST-004
// Req: REQ-FSW-LOG-SECURE
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { events as eventsApi } from '../lib/api';
import { on } from '../lib/ws';

const SEVERITY_STYLE = {
  INFO: 'badge-blue',
  WARNING: 'badge-amber',
  CRITICAL: 'badge-red',
};

const SOURCE_STYLE = {
  FLIGHT: 'badge-cyan',
  GROUND: 'badge-green',
  TWIN: 'badge-purple',
  SCHEDULER: 'badge-dim',
};

export default function AuditTimelineView() {
  const [eventsList, setEventsList] = useState([]);
  const [chainResult, setChainResult] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [filters, setFilters] = useState({ source: '', severity: '', event_type: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filters.source) params.set('source', filters.source);
      if (filters.severity) params.set('severity', filters.severity);
      if (filters.event_type) params.set('event_type', filters.event_type);
      params.set('limit', '200');

      const res = await eventsApi.query(params.toString());
      setEventsList(res.data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  // Live updates
  useEffect(() => {
    const unsub = on('AUDIT_EVENT', () => fetchEvents());
    return unsub;
  }, [fetchEvents]);

  const handleVerifyChain = async () => {
    setVerifying(true);
    try {
      const res = await eventsApi.verify();
      setChainResult(res.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="view audit-timeline">
      <div className="view-header">
        <h1>&#x2261; Audit Timeline</h1>
        <p className="view-sub">Hash-chained event log &mdash; REQ-FSW-LOG-SECURE</p>
      </div>

      {error && <div className="error-banner" onClick={() => setError(null)}>&#x26A0; {error}</div>}

      {/* ── Controls ── */}
      <div className="controls-bar">
        <div className="filter-group">
          <select value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value })}>
            <option value="">All Sources</option>
            <option value="FLIGHT">FLIGHT</option>
            <option value="GROUND">GROUND</option>
            <option value="TWIN">TWIN</option>
            <option value="SCHEDULER">SCHEDULER</option>
          </select>

          <select value={filters.severity} onChange={(e) => setFilters({ ...filters, severity: e.target.value })}>
            <option value="">All Severity</option>
            <option value="INFO">INFO</option>
            <option value="WARNING">WARNING</option>
            <option value="CRITICAL">CRITICAL</option>
          </select>

          <select value={filters.event_type} onChange={(e) => setFilters({ ...filters, event_type: e.target.value })}>
            <option value="">All Types</option>
            <option value="STATE_TRANSITION">STATE_TRANSITION</option>
            <option value="WATCHDOG_RESTART">WATCHDOG_RESTART</option>
            <option value="COMMAND_EXECUTED">COMMAND_EXECUTED</option>
            <option value="COMMAND_REJECTED">COMMAND_REJECTED</option>
            <option value="SIGNATURE_INVALID">SIGNATURE_INVALID</option>
            <option value="PLAN_SIGNED">PLAN_SIGNED</option>
            <option value="PLAN_UPLOADED">PLAN_UPLOADED</option>
            <option value="TWIN_ALERT">TWIN_ALERT</option>
          </select>
        </div>

        <button className="btn btn-sm btn-amber" onClick={handleVerifyChain} disabled={verifying}>
          {verifying ? '\u27F3 Verifying...' : '\uD83D\uDD17 Verify Chain'}
        </button>
      </div>

      {/* ── Chain Verification Result ── */}
      {chainResult && (
        <div className={`chain-result ${chainResult.chain_valid ? 'chain-valid' : 'chain-broken'}`}>
          <div className="chain-status">
            {chainResult.chain_valid ? '\u2713 CHAIN INTACT' : '\u2717 CHAIN BROKEN'}
          </div>
          <div className="chain-details mono">
            Events: {chainResult.total_events}
            {chainResult.break_at_index !== null && ` \u00B7 Break at index: ${chainResult.break_at_index}`}
          </div>
        </div>
      )}

      {/* ── Events Table ── */}
      {loading ? (
        <div className="view-loading">Loading events...</div>
      ) : (
        <div className="panel">
          <div className="events-count">{eventsList.length} events</div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Severity</th>
                  <th>Description</th>
                  <th>Hash</th>
                </tr>
              </thead>
              <tbody>
                {eventsList.map((evt) => (
                  <tr key={evt.id} className={evt.severity === 'CRITICAL' ? 'row-critical' : ''}>
                    <td className="mono nowrap">{new Date(evt.timestamp).toLocaleTimeString()}</td>
                    <td className="mono">{evt.event_type}</td>
                    <td><span className={`badge ${SOURCE_STYLE[evt.source] || 'badge-dim'}`}>{evt.source}</span></td>
                    <td><span className={`badge ${SEVERITY_STYLE[evt.severity]}`}>{evt.severity}</span></td>
                    <td className="desc-cell">{evt.description}</td>
                    <td className="mono hash-cell" title={evt.hash}>{evt.hash?.slice(0, 12)}&hellip;</td>
                  </tr>
                ))}
                {eventsList.length === 0 && (
                  <tr><td colSpan={6} className="empty">No audit events found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}