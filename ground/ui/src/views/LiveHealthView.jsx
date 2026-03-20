// ============================================================
// ASTERION ONE — LiveHealthView
// /live-health — Real-time FSW telemetry + state indicator
// Ref: Art.5 §3.2.5, ICD IF-WS-001 (TELEMETRY payload)
// ============================================================

import { useState, useEffect, useRef } from 'react';
import { on } from '../lib/ws';
import { telemetry } from '../lib/api';

const FSW_STATE_STYLES = {
  BOOT:     { color: '#60a5fa', label: 'BOOT',     icon: '\u27F3' },
  NOMINAL:  { color: '#34d399', label: 'NOMINAL',  icon: '\u25CF' },
  SAFE:     { color: '#fbbf24', label: 'SAFE',     icon: '\u25B3' },
  CRITICAL: { color: '#f87171', label: 'CRITICAL', icon: '\u26A0' },
};

const SUBSYSTEM_LABELS = {
  THERMAL: { icon: '\uD83C\uDF21', fields: ['cpu_temp_c', 'board_temp_c', 'heatsink_temp_c'] },
  POWER:   { icon: '\u26A1',       fields: ['voltage_v', 'current_ma', 'power_w', 'battery_soc'] },
  CPU:     { icon: '\u25A3',       fields: ['cpu_usage_pct', 'memory_usage_pct', 'disk_pct'] },
  COMMS:   { icon: '\uD83D\uDCE1', fields: ['ws_connected', 'msg_queue_depth', 'error_rate'] },
  FSW:     { icon: '\u25C8',       fields: ['state', 'uptime_s', 'wd_restarts'] },
};

export default function LiveHealthView() {
  const [fswState, setFswState] = useState('BOOT');
  const [subsystems, setSubsystems] = useState({});
  const [lastUpdate, setLastUpdate] = useState(null);
  const [seqId, setSeqId] = useState(0);
  const [history, setHistory] = useState([]);
  const historyRef = useRef([]);

  // Subscribe to live telemetry via WebSocket
  useEffect(() => {
    const unsub = on('TELEMETRY', (msg) => {
      const { fsw_state, subsystems: subs } = msg.payload;
      setFswState(fsw_state);
      setSubsystems((prev) => ({ ...prev, ...subs }));
      setLastUpdate(new Date(msg.timestamp));
      setSeqId(msg.seq_id);

      // Keep last 20 readings for mini-chart
      const entry = { time: msg.timestamp, seq_id: msg.seq_id, fsw_state, ...subs?.THERMAL };
      historyRef.current = [...historyRef.current.slice(-19), entry];
      setHistory([...historyRef.current]);
    });

    // Also fetch initial data from REST
    telemetry.latest().then((res) => {
      if (res.data?.length > 0) {
        const latest = res.data[0];
        setFswState(latest.fsw_state);
        setLastUpdate(new Date(latest.timestamp));
        setSeqId(latest.sequence_id);
      }
    }).catch(() => {});

    return unsub;
  }, []);

  const stateStyle = FSW_STATE_STYLES[fswState] || FSW_STATE_STYLES.BOOT;

  return (
    <div className="view live-health">
      <div className="view-header">
        <h1>&#x25C9; Live Health Monitor</h1>
        <p className="view-sub">Real-time Flight Segment telemetry &mdash; REQ-COM-ZERO-LOSS</p>
      </div>

      {/* ── FSW State Banner ── */}
      <div className="state-banner" style={{ borderColor: stateStyle.color }}>
        <div className="state-icon" style={{ color: stateStyle.color }}>{stateStyle.icon}</div>
        <div className="state-info">
          <div className="state-label" style={{ color: stateStyle.color }}>{stateStyle.label}</div>
          <div className="state-meta">
            Seq #{seqId} &middot; {lastUpdate ? lastUpdate.toLocaleTimeString() : 'Awaiting telemetry...'}
          </div>
        </div>
      </div>

      {/* ── Subsystem Panels ── */}
      <div className="subsystem-grid">
        {Object.entries(SUBSYSTEM_LABELS).map(([name, config]) => {
          const data = subsystems[name] || {};
          return (
            <div key={name} className="subsystem-card">
              <div className="subsystem-header">
                <span className="subsystem-icon">{config.icon}</span>
                <span className="subsystem-name">{name}</span>
              </div>
              <div className="subsystem-metrics">
                {config.fields.map((field) => (
                  <div key={field} className="metric-row">
                    <span className="metric-label">{field.replace(/_/g, ' ')}</span>
                    <span className="metric-value mono">
                      {data[field] !== undefined ? formatMetric(field, data[field]) : '\u2014'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Mini History ── */}
      {history.length > 0 && (
        <div className="panel history-panel">
          <h3>Recent Telemetry ({history.length} frames)</h3>
          <div className="history-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Seq</th><th>Time</th><th>State</th><th>CPU Temp</th>
                </tr>
              </thead>
              <tbody>
                {history.slice().reverse().map((h, i) => (
                  <tr key={i}>
                    <td className="mono">{h.seq_id}</td>
                    <td>{new Date(h.time).toLocaleTimeString()}</td>
                    <td><span className={`badge badge-${h.fsw_state === 'NOMINAL' ? 'green' : h.fsw_state === 'SAFE' ? 'amber' : 'red'}`}>{h.fsw_state}</span></td>
                    <td className="mono">{h.cpu_temp_c?.toFixed(1) || '\u2014'} &deg;C</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function formatMetric(field, value) {
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  if (field.includes('temp')) return `${Number(value).toFixed(1)} \u00B0C`;
  if (field.includes('voltage')) return `${Number(value).toFixed(2)} V`;
  if (field.includes('current')) return `${Number(value).toFixed(0)} mA`;
  if (field.includes('power')) return `${Number(value).toFixed(2)} W`;
  if (field.includes('pct') || field.includes('soc')) return `${Number(value * (value <= 1 ? 100 : 1)).toFixed(1)}%`;
  if (field.includes('uptime')) return `${Math.floor(value / 60)}m ${value % 60}s`;
  if (field.includes('rate')) return Number(value).toFixed(4);
  return String(value);
}