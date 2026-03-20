// ============================================================
// ASTERION ONE — AlertDashboardView
// /alerts — Active alerts from Twin + CRITICAL events
// Ref: Art.5 §3.2.5
// Req: REQ-DT-RATIONALE (visualization), REQ-FSW-STATE-01
//
// NOTE: Twin data is populated in Phase 4. This view is
// structurally complete and shows CRITICAL audit events now.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { twin, events as eventsApi } from '../lib/api';
import { on } from '../lib/ws';

export default function AlertDashboardView() {
  const [twinAlerts, setTwinAlerts] = useState([]);
  const [criticalEvents, setCriticalEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const [alertsRes, eventsRes] = await Promise.all([
        twin.alerts().catch(() => ({ data: [] })),
        eventsApi.query('severity=CRITICAL&limit=20'),
      ]);
      setTwinAlerts(alertsRes.data);
      setCriticalEvents(eventsRes.data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Live updates: refresh on new COMMAND_NACK or AUDIT_EVENT
  useEffect(() => {
    const unsub1 = on('COMMAND_NACK', () => fetchData());
    const unsub2 = on('AUDIT_EVENT', (msg) => {
      if (msg.payload?.severity === 'CRITICAL') fetchData();
    });
    return () => { unsub1(); unsub2(); };
  }, [fetchData]);

  if (loading) return <div className="view-loading">Loading alerts...</div>;

  return (
    <div className="view alert-dashboard">
      <div className="view-header">
        <h1>&#x25B3; Alert Dashboard</h1>
        <p className="view-sub">Active alerts and critical events &mdash; REQ-DT-RATIONALE</p>
      </div>

      {error && <div className="error-banner" onClick={() => setError(null)}>&#x26A0; {error}</div>}

      {/* ── Twin Alerts ── */}
      <section className="panel">
        <h2>Twin Predictive Alerts</h2>
        {twinAlerts.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">&#x25CE;</div>
            <p>No active Twin alerts</p>
            <p className="text-dim">Twin predictions will appear here in Phase 4</p>
          </div>
        ) : (
          <div className="alert-grid">
            {twinAlerts.map((alert) => (
              <div key={alert.id} className="alert-card alert-critical">
                <div className="alert-header">
                  <span className="badge badge-red">BREACH DETECTED</span>
                  <span className="mono">{alert.model_type}</span>
                </div>
                <div className="alert-body">
                  <div className="alert-metric">
                    Lead Time: <strong>{alert.lead_time_min?.toFixed(1)} min</strong>
                  </div>
                  {alert.rationale && (
                    <div className="alert-rationale">{alert.rationale}</div>
                  )}
                </div>
                <div className="alert-actions">
                  <button className="btn btn-sm btn-amber">Send SAFE Command</button>
                  <button className="btn btn-sm btn-dim">View Forecast</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── CRITICAL Audit Events ── */}
      <section className="panel">
        <h2>Recent CRITICAL Events</h2>
        {criticalEvents.length === 0 ? (
          <p className="empty">No critical events recorded</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Time</th><th>Type</th><th>Source</th><th>Description</th></tr>
              </thead>
              <tbody>
                {criticalEvents.map((evt) => (
                  <tr key={evt.id} className="row-critical">
                    <td className="mono nowrap">{new Date(evt.timestamp).toLocaleTimeString()}</td>
                    <td className="mono">{evt.event_type}</td>
                    <td><span className="badge badge-cyan">{evt.source}</span></td>
                    <td>{evt.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}