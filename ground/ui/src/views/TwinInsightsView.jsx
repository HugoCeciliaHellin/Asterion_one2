// ============================================================
// ASTERION ONE — TwinInsightsView
// /twin-insights — Digital Twin forecast visualization
// Ref: Art.5 §3.2.5
// Req: REQ-DT-EARLY-15m, REQ-DT-RATIONALE
//
// NOTE: Twin engine is implemented in Phase 4. This view is
// structurally complete and queries the REST API for forecasts.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { twin } from '../lib/api';

export default function TwinInsightsView() {
  const [forecasts, setForecasts] = useState([]);
  const [breachForecasts, setBreachForecasts] = useState([]);
  const [modelFilter, setModelFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (modelFilter) params.set('model_type', modelFilter);
      params.set('limit', '50');

      const [allRes, breachRes] = await Promise.all([
        twin.forecasts(params.toString()),
        twin.forecasts('breach_only=true&limit=20'),
      ]);
      setForecasts(allRes.data);
      setBreachForecasts(breachRes.data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [modelFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Compute stats
  const totalForecasts = forecasts.length;
  const totalBreaches = breachForecasts.length;
  const avgLeadTime = breachForecasts.length > 0
    ? (breachForecasts.reduce((s, f) => s + (f.lead_time_min || 0), 0) / breachForecasts.length).toFixed(1)
    : '\u2014';
  const meetsReq = breachForecasts.length > 0
    ? breachForecasts.every((f) => f.lead_time_min >= 15)
    : null;

  if (loading) return <div className="view-loading">Loading Twin data...</div>;

  return (
    <div className="view twin-insights">
      <div className="view-header">
        <h1>&#x25CE; Twin Insights</h1>
        <p className="view-sub">Digital Twin predictions and breach analysis &mdash; REQ-DT-EARLY-15m</p>
      </div>

      {error && <div className="error-banner" onClick={() => setError(null)}>&#x26A0; {error}</div>}

      {/* ── Summary Metrics ── */}
      <div className="metrics-row">
        <div className="metric-card">
          <div className="metric-big mono">{totalForecasts}</div>
          <div className="metric-label">Total Forecasts</div>
        </div>
        <div className="metric-card">
          <div className="metric-big mono">{totalBreaches}</div>
          <div className="metric-label">Breaches Detected</div>
        </div>
        <div className="metric-card">
          <div className="metric-big mono">{avgLeadTime} min</div>
          <div className="metric-label">Avg Lead Time</div>
        </div>
        <div className="metric-card">
          <div className={`metric-big ${meetsReq === true ? 'text-green' : meetsReq === false ? 'text-red' : ''}`}>
            {meetsReq === true ? '\u2713 PASS' : meetsReq === false ? '\u2717 FAIL' : '\u2014'}
          </div>
          <div className="metric-label">REQ-DT-EARLY-15m</div>
        </div>
      </div>

      {/* ── Filter ── */}
      <div className="controls-bar">
        <select value={modelFilter} onChange={(e) => setModelFilter(e.target.value)}>
          <option value="">All Models</option>
          <option value="THERMAL">THERMAL</option>
          <option value="ENERGY">ENERGY</option>
        </select>
        <button className="btn btn-sm" onClick={fetchData}>&#x21BB; Refresh</button>
      </div>

      {/* ── Forecasts ── */}
      {forecasts.length === 0 ? (
        <div className="panel">
          <div className="empty-state">
            <div className="empty-icon">&#x25CE;</div>
            <p>No forecasts available yet</p>
            <p className="text-dim">The Digital Twin engine will generate predictions in Phase 4.</p>
            <p className="text-dim">Forecasts use an RC thermal model (1st order Euler forward) to predict temperature trajectories 30 minutes ahead.</p>
          </div>
        </div>
      ) : (
        <div className="panel">
          <h2>Recent Forecasts</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Model</th>
                  <th>Horizon</th>
                  <th>Breach</th>
                  <th>Lead Time</th>
                  <th>Rationale</th>
                </tr>
              </thead>
              <tbody>
                {forecasts.map((f) => (
                  <tr key={f.id} className={f.breach_detected ? 'row-critical' : ''}>
                    <td className="mono nowrap">{new Date(f.created_at).toLocaleTimeString()}</td>
                    <td><span className="badge badge-dim">{f.model_type}</span></td>
                    <td className="mono">{f.horizon_min} min</td>
                    <td>
                      {f.breach_detected
                        ? <span className="badge badge-red">YES</span>
                        : <span className="badge badge-green">NO</span>
                      }
                    </td>
                    <td className="mono">
                      {f.lead_time_min
                        ? <span className={f.lead_time_min >= 15 ? 'text-green' : 'text-red'}>
                            {f.lead_time_min.toFixed(1)} min
                          </span>
                        : '\u2014'
                      }
                    </td>
                    <td className="desc-cell">{f.rationale || '\u2014'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Breach History ── */}
      {breachForecasts.length > 0 && (
        <div className="panel">
          <h2>Breach History</h2>
          <div className="alert-grid">
            {breachForecasts.map((f) => (
              <div key={f.id} className="alert-card">
                <div className="alert-header">
                  <span className="badge badge-red">{f.model_type} BREACH</span>
                  <span className="mono">{f.lead_time_min?.toFixed(1)} min lead</span>
                </div>
                <div className="alert-body">
                  <p className="alert-rationale">{f.rationale || 'No rationale provided'}</p>
                  <p className="mono text-dim">{new Date(f.created_at).toLocaleString()}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}