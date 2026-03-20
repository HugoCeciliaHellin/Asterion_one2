// ============================================================
// ASTERION ONE — Ground Control Dashboard
// App.jsx — Layout + Routing (5 views per Art.5 §3.2.5)
// ============================================================

import { useState, useEffect } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { connect, disconnect, on } from './lib/ws';
import { health } from './lib/api';

import PassPlannerView from './views/PassPlannerView';
import LiveHealthView from './views/LiveHealthView';
import AlertDashboardView from './views/AlertDashboardView';
import AuditTimelineView from './views/AuditTimelineView';
import TwinInsightsView from './views/TwinInsightsView';

export default function App() {
  const [flightConnected, setFlightConnected] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [systemHealth, setSystemHealth] = useState(null);

  useEffect(() => {
    connect();

    const unsub1 = on('connection', (data) => setWsConnected(data.connected));
    const unsub2 = on('FLIGHT_STATUS', (msg) => setFlightConnected(msg.payload.connected));

    // Poll health every 10s
    const fetchHealth = () => health.get().then((r) => setSystemHealth(r)).catch(() => {});
    fetchHealth();
    const interval = setInterval(fetchHealth, 10000);

    return () => { unsub1(); unsub2(); clearInterval(interval); disconnect(); };
  }, []);

  return (
    <div className="app">
      {/* ── Sidebar Navigation ── */}
      <nav className="sidebar">
        <div className="sidebar-header">
          <div className="logo">&#x25C8; ASTERION</div>
          <div className="logo-sub">GROUND CONTROL</div>
        </div>

        <div className="nav-links">
          <NavLink to="/pass-planner" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
            <span className="nav-icon">&#x25EB;</span> Pass Planner
          </NavLink>
          <NavLink to="/live-health" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
            <span className="nav-icon">&#x25C9;</span> Live Health
          </NavLink>
          <NavLink to="/alerts" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
            <span className="nav-icon">&#x25B3;</span> Alerts
          </NavLink>
          <NavLink to="/timeline" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
            <span className="nav-icon">&#x2261;</span> Audit Timeline
          </NavLink>
          <NavLink to="/twin-insights" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>
            <span className="nav-icon">&#x25CE;</span> Twin Insights
          </NavLink>
        </div>

        {/* ── Status Bar ── */}
        <div className="status-bar">
          <div className="status-row">
            <span className={`status-dot ${wsConnected ? 'green' : 'red'}`} />
            <span>Ground WS</span>
          </div>
          <div className="status-row">
            <span className={`status-dot ${flightConnected ? 'green' : 'amber'}`} />
            <span>Flight Link</span>
          </div>
          <div className="status-row">
            <span className={`status-dot ${systemHealth?.status === 'healthy' ? 'green' : 'red'}`} />
            <span>Database</span>
          </div>
        </div>
      </nav>

      {/* ── Main Content ── */}
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/live-health" replace />} />
          <Route path="/pass-planner" element={<PassPlannerView />} />
          <Route path="/live-health" element={<LiveHealthView />} />
          <Route path="/alerts" element={<AlertDashboardView />} />
          <Route path="/timeline" element={<AuditTimelineView />} />
          <Route path="/twin-insights" element={<TwinInsightsView />} />
        </Routes>
      </main>
    </div>
  );
}