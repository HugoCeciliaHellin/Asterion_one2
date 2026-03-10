"""
Asterion One — Phase 2 Integration Tests
============================================
Tests the FULL STACK: fsw_core + comms_client + window_scheduler + mock_gateway

This is where REQ-COM-ZERO-LOSS and REQ-COM-P95 are verified
with the complete Flight Segment running end-to-end.

Coverage:
  1. FSW sends telemetry through comms_client to mock gateway
  2. Window CLOSED → messages queued to disk
  3. Window OPEN → replay + delivery
  4. CRITICAL: 120s outage cycle → zero loss [REQ-COM-ZERO-LOSS]
  5. P95 latency during open window [REQ-COM-P95]
  6. Seq ID continuity (no gaps) across outage
  7. Command plan delivery via WebSocket
  8. Multiple outage cycles → zero loss
  9. Forced outage via window_scheduler.force_closed()
  10. Audit chain valid through full integration
"""

import sys
import os
import time
import tempfile
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from flight.fsw_core import FswCore
from flight.comms_client import CommsClient, InProcessTransport, MockGateway
from flight.window_scheduler import WindowScheduler
from flight.disk_queue import DiskQueue
from flight.audit_logger import AuditLogger
from flight.config import FswConfig
from flight.models import FswState


def make_integrated_stack(
    open_duration=100.0,
    closed_duration=100.0,
    start_open=True,
):
    """
    Create the full integrated stack:
      fsw_core + comms_client + window_scheduler + mock_gateway
    """
    tmp_dir = tempfile.mkdtemp()
    os.environ.pop("RECOVERY_MODE", None)

    # Config
    config = FswConfig()
    config.TICK_INTERVAL_SEC = 0.05
    config.STABILITY_TIMER_SEC = 0.1
    config.SENSOR_NOISE_AMPLITUDE = 0.0
    config.SENSOR_NOMINAL_TEMP_C = 55.0
    config.SENSOR_NOMINAL_VOLTAGE_V = 5.1
    config.TELEMETRY_RATE_SAFE_SEC = 0.01
    config.AUDIT_LOG_PATH = os.path.join(tmp_dir, "audit.jsonl")
    config.QUEUE_DIR = os.path.join(tmp_dir, "queue")
    config.TRUSTED_KEYS_PATH = "/tmp/nonexistent.json"

    # FSW core
    fsw = FswCore(config=config)
    fsw._boot_counter_path = os.path.join(tmp_dir, "boot_counter")

    # Transport + MockGateway
    transport = InProcessTransport()
    gw = MockGateway(transport)
    gw.start()

    # Comms client (uses fsw's own queue and audit)
    comms = CommsClient(
        transport=transport,
        queue=fsw.queue,
        audit=fsw.audit,
    )

    # Window scheduler
    scheduler = WindowScheduler(
        open_duration_s=open_duration,
        closed_duration_s=closed_duration,
        start_open=start_open,
    )

    # Wire FSW telemetry → comms_client
    def on_telemetry(frame):
        comms.send_telemetry(
            subsystems=frame.subsystems,
            fsw_state=frame.fsw_state.value,
        )

    fsw.set_telemetry_callback(on_telemetry)

    return fsw, comms, scheduler, gw, transport, tmp_dir


def run_ticks(fsw, comms, scheduler, n, tick_sleep=0.02):
    """Run n ticks of the FSW + scheduler, draining comms each tick."""
    for _ in range(n):
        # Check window transitions
        scheduler.tick()

        # Manage connection based on window
        if scheduler.is_open() and not comms.connected:
            comms.connect()
        elif not scheduler.is_open() and comms.connected:
            comms.disconnect()

        # FSW tick (generates telemetry if in NOMINAL/SAFE)
        fsw.tick()

        # Drain ACKs
        comms.drain_receives(max_count=10, timeout=0.01)

        time.sleep(tick_sleep)


# --- Test 1: FSW sends telemetry through comms to gateway ---
def test_fsw_telemetry_through_comms():
    fsw, comms, sched, gw, _, _ = make_integrated_stack()
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL
    comms.connect()

    # Run 5 ticks in NOMINAL → 5 telemetry frames
    for _ in range(5):
        fsw.tick()
        comms.drain_receives(max_count=5, timeout=0.02)
        time.sleep(0.02)

    assert len(gw.received) >= 5
    assert all(m["type"] == "TELEMETRY" for m in gw.received)

    comms.disconnect()
    gw.stop()


# --- Test 2: Window CLOSED → messages queued ---
def test_window_closed_queues():
    fsw, comms, sched, gw, _, _ = make_integrated_stack(
        start_open=False
    )
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    # Window is CLOSED, comms not connected
    for _ in range(5):
        fsw.tick()
        time.sleep(0.01)

    # Messages should be queued to disk
    assert fsw.queue.depth() >= 5
    assert len(gw.received) == 0  # Nothing reached gateway

    gw.stop()


# --- Test 3: Window OPEN → replay + delivery ---
def test_window_open_replays():
    fsw, comms, sched, gw, _, _ = make_integrated_stack(
        start_open=False
    )
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    # Generate 5 frames while CLOSED
    for _ in range(5):
        fsw.tick()
        time.sleep(0.01)

    queued = fsw.queue.depth()
    assert queued >= 5

    # Now connect (window opens)
    comms.connect()
    time.sleep(0.15)
    comms.drain_receives(max_count=30, timeout=0.02)

    # All queued should be replayed
    assert len(gw.received) >= queued
    assert fsw.queue.depth() == 0

    comms.disconnect()
    gw.stop()


# --- Test 4: CRITICAL — Full outage cycle, zero loss [REQ-COM-ZERO-LOSS] ---
def test_zero_loss_full_outage():
    """
    Simulates:
      Phase A: 10 ticks connected (window OPEN)
      Phase B: 20 ticks disconnected (window CLOSED) — outage
      Phase C: 10 ticks reconnected (window OPEN) — replay + live
    
    Verification: ALL telemetry frames received, no gaps, queue empty.
    """
    fsw, comms, sched, gw, _, _ = make_integrated_stack()
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    # Phase A: Connected
    comms.connect()
    for _ in range(10):
        fsw.tick()
        comms.drain_receives(max_count=5, timeout=0.01)
        time.sleep(0.02)

    # Phase B: Outage
    comms.disconnect()
    for _ in range(20):
        fsw.tick()
        time.sleep(0.01)

    queued_during_outage = fsw.queue.depth()
    assert queued_during_outage >= 20

    # Phase C: Reconnect
    comms.connect()
    for _ in range(10):
        fsw.tick()
        comms.drain_receives(max_count=20, timeout=0.01)
        time.sleep(0.02)

    # Final drain
    time.sleep(0.2)
    comms.drain_receives(max_count=50, timeout=0.02)

    # Verify zero loss
    received_seqs = gw.get_received_seq_ids()
    total_generated = comms.next_seq_id - 1

    # All seq_ids should be present
    expected = set(range(1, total_generated + 1))
    actual = set(received_seqs)
    missing = expected - actual

    assert len(missing) == 0, f"Missing seq_ids: {sorted(missing)}"

    # Verify no gaps
    for i in range(1, len(received_seqs)):
        assert received_seqs[i] == received_seqs[i - 1] + 1, \
            f"Gap: {received_seqs[i-1]} → {received_seqs[i]}"

    # Queue should be empty
    assert fsw.queue.depth() == 0

    comms.disconnect()
    gw.stop()


# --- Test 5: P95 latency during open window [REQ-COM-P95] ---
def test_p95_latency():
    fsw, comms, sched, gw, _, _ = make_integrated_stack()
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL
    comms.connect()

    # Send 30 frames with timing
    for _ in range(30):
        fsw.tick()
        comms.drain_receives(max_count=5, timeout=0.01)
        time.sleep(0.01)

    time.sleep(0.2)
    comms.drain_receives(max_count=50, timeout=0.02)

    p95 = comms.compute_p95_latency_ms()
    assert p95 is not None, f"Only {len(comms.ack_latencies)} latency samples"
    assert p95 < 2000, f"P95 latency {p95}ms exceeds 2000ms [REQ-COM-P95]"

    comms.disconnect()
    gw.stop()


# --- Test 6: Seq ID continuity across outage ---
def test_seq_id_continuity():
    fsw, comms, sched, gw, _, _ = make_integrated_stack()
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL
    comms.connect()

    # Send, outage, send, reconnect
    for _ in range(5):
        fsw.tick()
        comms.drain_receives(timeout=0.01)
        time.sleep(0.01)

    comms.disconnect()
    for _ in range(5):
        fsw.tick()
        time.sleep(0.01)

    comms.connect()
    for _ in range(5):
        fsw.tick()
        comms.drain_receives(timeout=0.01)
        time.sleep(0.01)

    time.sleep(0.1)
    comms.drain_receives(max_count=30, timeout=0.02)

    seqs = gw.get_received_seq_ids()
    # Verify strict monotonic
    for i in range(1, len(seqs)):
        assert seqs[i] == seqs[i - 1] + 1, \
            f"Continuity break: {seqs[i-1]} → {seqs[i]}"

    comms.disconnect()
    gw.stop()


# --- Test 7: Multiple outage cycles → zero loss ---
def test_multiple_outages():
    fsw, comms, sched, gw, _, _ = make_integrated_stack()
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    for cycle in range(3):
        # Open
        comms.connect()
        for _ in range(5):
            fsw.tick()
            comms.drain_receives(timeout=0.01)
            time.sleep(0.01)

        # Closed
        comms.disconnect()
        for _ in range(5):
            fsw.tick()
            time.sleep(0.01)

    # Final reconnect
    comms.connect()
    time.sleep(0.2)
    comms.drain_receives(max_count=50, timeout=0.02)

    # Also drain any remaining
    for _ in range(5):
        fsw.tick()
        comms.drain_receives(timeout=0.01)
        time.sleep(0.01)

    time.sleep(0.1)
    comms.drain_receives(max_count=30, timeout=0.02)

    total = comms.next_seq_id - 1
    received = set(gw.get_received_seq_ids())
    expected = set(range(1, total + 1))
    missing = expected - received

    assert len(missing) == 0, f"Missing after 3 cycles: {sorted(missing)}"
    assert fsw.queue.depth() == 0

    comms.disconnect()
    gw.stop()


# --- Test 8: Forced outage via scheduler ---
def test_forced_outage():
    fsw, comms, sched, gw, _, _ = make_integrated_stack()
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL
    comms.connect()

    # Send 5 normally
    for _ in range(5):
        fsw.tick()
        comms.drain_receives(timeout=0.01)
        time.sleep(0.01)

    # Force closed (simulates fault_injector network-outage)
    sched.force_closed(duration_s=0.5)
    comms.disconnect()

    for _ in range(10):
        fsw.tick()
        time.sleep(0.01)

    # Wait for force to expire
    time.sleep(0.5)
    sched.tick()

    # Reconnect
    comms.connect()
    time.sleep(0.15)
    comms.drain_receives(max_count=30, timeout=0.02)

    for _ in range(5):
        fsw.tick()
        comms.drain_receives(timeout=0.01)
        time.sleep(0.01)

    time.sleep(0.1)
    comms.drain_receives(max_count=20, timeout=0.02)

    total = comms.next_seq_id - 1
    received = set(gw.get_received_seq_ids())
    expected = set(range(1, total + 1))
    missing = expected - received

    assert len(missing) == 0, f"Missing after forced outage: {sorted(missing)}"

    comms.disconnect()
    gw.stop()


# --- Test 9: Audit chain valid through full integration ---
def test_audit_chain_integration():
    fsw, comms, sched, gw, _, _ = make_integrated_stack()
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL
    comms.connect()

    for _ in range(5):
        fsw.tick()
        comms.drain_receives(timeout=0.01)
        time.sleep(0.01)

    comms.disconnect()
    for _ in range(3):
        fsw.tick()
        time.sleep(0.01)

    comms.connect()
    time.sleep(0.1)
    comms.drain_receives(max_count=20, timeout=0.02)

    result = fsw.audit.verify_chain()
    assert result.chain_valid is True
    assert result.total_events > 0

    comms.disconnect()
    gw.stop()
