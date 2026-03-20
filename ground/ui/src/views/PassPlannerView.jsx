// ============================================================
// ASTERION ONE — PassPlannerView
// /pass-planner — Contact window planning + command plan lifecycle
// Ref: Art.5 §3.2.5, Flow F1 (Operator: Plan -> Sign -> Upload)
// Req: REQ-GND-PLAN, REQ-SEC-ED25519
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { contactWindows, commandPlans } from '../lib/api';
import { signCommands, getPublicKey } from '../lib/crypto';

// ── Status badges ───────────────────────────────────────
const STATUS_COLORS = {
  SCHEDULED: 'badge-blue', ACTIVE: 'badge-green', COMPLETED: 'badge-dim', CANCELLED: 'badge-dim',
  DRAFT: 'badge-blue', SIGNED: 'badge-amber', UPLOADED: 'badge-cyan', EXECUTING: 'badge-green',
  REJECTED: 'badge-red',
};

export default function PassPlannerView() {
  const [windows, setWindows] = useState([]);
  const [plans, setPlans] = useState([]);
  const [selectedWindow, setSelectedWindow] = useState(null);
  const [showCreateWindow, setShowCreateWindow] = useState(false);
  const [showCreatePlan, setShowCreatePlan] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(null);
  const pubKey = getPublicKey();

  const fetchData = useCallback(async () => {
    try {
      const [wRes, pRes] = await Promise.all([
        contactWindows.list(), commandPlans.list(),
      ]);
      setWindows(wRes.data);
      setPlans(pRes.data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Create Contact Window ─────────────────────────────
  const handleCreateWindow = async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await contactWindows.create({
        name: form.get('name'),
        aos_time: new Date(form.get('aos_time')).toISOString(),
        los_time: new Date(form.get('los_time')).toISOString(),
      });
      setShowCreateWindow(false);
      fetchData();
    } catch (err) {
      setError(err.message);
    }
  };

  // ── Create Command Plan ───────────────────────────────
  const handleCreatePlan = async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const cmdsRaw = form.get('commands');
    try {
      const cmds = JSON.parse(cmdsRaw);
      await commandPlans.create({
        contact_window_id: selectedWindow?.id || null,
        operator_name: form.get('operator_name'),
        commands: cmds,
      });
      setShowCreatePlan(false);
      fetchData();
    } catch (err) {
      setError(err.message || 'Invalid commands JSON');
    }
  };

  // ── Sign Plan (Ed25519 — SD-1C: canonical JSON -> SHA-256 -> Ed25519.sign) ──
  const handleSign = async (planId) => {
    setSigning(planId);
    try {
      // Fetch the plan to get its commands
      const planRes = await commandPlans.getById(planId);
      const plan = planRes.data;

      // Extract command payloads for signing (same structure Flight will verify)
      const cmdsForSigning = plan.commands.map((c) => ({
        sequence_id: c.sequence_id,
        command_type: c.command_type,
        payload: c.payload,
      }));

      // SD-1C steps 1-2-3: canonical -> SHA-256 -> Ed25519.sign (all in browser)
      const { signature, publicKey } = await signCommands(cmdsForSigning);

      // Send signature to API (PATCH /api/command-plans/:id)
      await commandPlans.sign(planId, {
        signature,
        signature_algo: 'Ed25519',
        public_key: publicKey,
      });

      fetchData();
    } catch (err) {
      setError(`Signing failed: ${err.message}`);
    } finally {
      setSigning(null);
    }
  };

  // ── Upload Plan ───────────────────────────────────────
  const handleUpload = async (planId) => {
    try {
      await commandPlans.upload(planId, { public_key: pubKey });
      fetchData();
    } catch (err) {
      setError(err.message);
    }
  };

  // ── Window Status Change ──────────────────────────────
  const handleWindowStatus = async (id, status) => {
    try {
      await contactWindows.updateStatus(id, status);
      fetchData();
    } catch (err) {
      setError(err.message);
    }
  };

  const windowPlans = selectedWindow
    ? plans.filter((p) => p.contact_window_id === selectedWindow.id)
    : [];

  if (loading) return <div className="view-loading">Loading Pass Planner...</div>;

  return (
    <div className="view pass-planner">
      <div className="view-header">
        <h1>&#x25EB; Pass Planner</h1>
        <p className="view-sub">Plan contact windows and command uploads &mdash; REQ-GND-PLAN</p>
        <p className="view-sub">Operator Key: <span className="mono">{pubKey.slice(0, 16)}&hellip;</span></p>
      </div>

      {error && <div className="error-banner" onClick={() => setError(null)}>&#x26A0; {error}</div>}

      <div className="planner-layout">
        {/* ── Left: Contact Windows ── */}
        <section className="panel windows-panel">
          <div className="panel-header">
            <h2>Contact Windows</h2>
            <button className="btn btn-sm" onClick={() => setShowCreateWindow(true)}>+ New Window</button>
          </div>

          <div className="window-list">
            {windows.length === 0 && <p className="empty">No contact windows scheduled</p>}
            {windows.map((w) => (
              <div
                key={w.id}
                className={`window-card ${selectedWindow?.id === w.id ? 'selected' : ''}`}
                onClick={() => setSelectedWindow(w)}
              >
                <div className="window-name">{w.name}</div>
                <div className="window-times">
                  <span>AOS: {new Date(w.aos_time).toLocaleString()}</span>
                  <span>LOS: {new Date(w.los_time).toLocaleString()}</span>
                </div>
                <div className="window-footer">
                  <span className={`badge ${STATUS_COLORS[w.status]}`}>{w.status}</span>
                  {w.status === 'SCHEDULED' && (
                    <div className="window-actions">
                      <button className="btn-xs btn-green" onClick={(e) => { e.stopPropagation(); handleWindowStatus(w.id, 'ACTIVE'); }}>Activate</button>
                      <button className="btn-xs btn-red" onClick={(e) => { e.stopPropagation(); handleWindowStatus(w.id, 'CANCELLED'); }}>Cancel</button>
                    </div>
                  )}
                  {w.status === 'ACTIVE' && (
                    <button className="btn-xs btn-dim" onClick={(e) => { e.stopPropagation(); handleWindowStatus(w.id, 'COMPLETED'); }}>Complete</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Right: Command Plans ── */}
        <section className="panel plans-panel">
          <div className="panel-header">
            <h2>{selectedWindow ? `Plans for ${selectedWindow.name}` : 'All Command Plans'}</h2>
            <button className="btn btn-sm" onClick={() => setShowCreatePlan(true)}>+ New Plan</button>
          </div>

          <div className="plan-list">
            {(selectedWindow ? windowPlans : plans).length === 0 && (
              <p className="empty">{selectedWindow ? 'No plans for this window' : 'No command plans created yet'}</p>
            )}
            {(selectedWindow ? windowPlans : plans).map((p) => (
              <div key={p.id} className="plan-card">
                <div className="plan-header-row">
                  <span className="plan-id mono">{p.id.slice(0, 8)}</span>
                  <span className={`badge ${STATUS_COLORS[p.status]}`}>{p.status}</span>
                </div>
                <div className="plan-meta">
                  <span>By: {p.operator_name}</span>
                  <span>{new Date(p.created_at).toLocaleString()}</span>
                </div>
                <div className="plan-actions">
                  {p.status === 'DRAFT' && (
                    <button className="btn btn-sm btn-amber" onClick={() => handleSign(p.id)} disabled={signing === p.id}>
                      {signing === p.id ? 'Signing...' : '&#x270E; Sign (Ed25519)'}
                    </button>
                  )}
                  {p.status === 'SIGNED' && (
                    <button className="btn btn-sm btn-cyan" onClick={() => handleUpload(p.id)}>&#x25B2; Upload to Satellite</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── Create Window Modal ── */}
      {showCreateWindow && (
        <div className="modal-overlay" onClick={() => setShowCreateWindow(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create Contact Window</h3>
            <form onSubmit={handleCreateWindow}>
              <label>Name<input name="name" placeholder="Pass-017" required /></label>
              <label>AOS (Acquisition of Signal)<input name="aos_time" type="datetime-local" required /></label>
              <label>LOS (Loss of Signal)<input name="los_time" type="datetime-local" required /></label>
              <div className="modal-actions">
                <button type="button" className="btn btn-dim" onClick={() => setShowCreateWindow(false)}>Cancel</button>
                <button type="submit" className="btn btn-green">Create Window</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Create Plan Modal ── */}
      {showCreatePlan && (
        <div className="modal-overlay" onClick={() => setShowCreatePlan(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create Command Plan</h3>
            <form onSubmit={handleCreatePlan}>
              <label>Operator Name<input name="operator_name" defaultValue="hugo.cecilia" required /></label>
              <label>
                Commands (JSON array)
                <textarea name="commands" rows={6} required
                  defaultValue={JSON.stringify([
                    { command_type: 'SET_PARAM', payload: { param_name: 'telem_freq', param_value: 2 } },
                    { command_type: 'RUN_DIAGNOSTIC', payload: { subsystem: 'THERMAL' } },
                  ], null, 2)}
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="btn btn-dim" onClick={() => setShowCreatePlan(false)}>Cancel</button>
                <button type="submit" className="btn btn-green">Create Plan</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}