"""
Command-line fault injector for system testing.
Injects simulated faults to verify FDIR recovery metrics and generates JSON reports.

Usage:
  python fault_injector.py inject <fault_type> [args...]
  python fault_injector.py run-all --output results/
"""

import argparse
import json
import os
import sys
import time
import tempfile
import threading
from datetime import datetime, timezone


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _report(injection_type: str, result: dict) -> dict:
    report = {
        "injection_type": injection_type,
        "timestamp": _timestamp(),
        **result,
    }
    print(json.dumps(report, indent=2))
    return report


# Shared: create a running FswCore in a background thread

def _create_fsw(
    stability_timer=0.5,
    max_wd_restarts=3,
    temp_warn=75.0,
    hysteresis=5.0,
    telem_safe_rate=0.1,
):
    
    # Add project root to path
    project_root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..")
    )
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

    from flight.fsw_core import FswCore
    from flight.config import FswConfig

    tmp_dir = tempfile.mkdtemp()
    config = FswConfig()
    config.TICK_INTERVAL_SEC = 0.05
    config.STABILITY_TIMER_SEC = stability_timer
    config.THRESHOLD_TEMP_WARN_C = temp_warn
    config.HYSTERESIS_TEMP_C = hysteresis
    config.MAX_WD_RESTARTS = max_wd_restarts
    config.SENSOR_NOISE_AMPLITUDE = 0.0
    config.SENSOR_NOMINAL_TEMP_C = 55.0
    config.SENSOR_NOMINAL_VOLTAGE_V = 5.1
    config.TELEMETRY_RATE_SAFE_SEC = telem_safe_rate
    config.AUDIT_LOG_PATH = os.path.join(tmp_dir, "audit.jsonl")
    config.QUEUE_DIR = os.path.join(tmp_dir, "queue")
    config.TRUSTED_KEYS_PATH = "/tmp/nonexistent.json"

    os.environ.pop("RECOVERY_MODE", None)

    fsw = FswCore(config=config)
    fsw._boot_counter_path = os.path.join(tmp_dir, "boot_counter")

    return fsw, tmp_dir


def _run_fsw_loop(fsw, stop_event):
    fsw.start()
    while not stop_event.is_set():
        fsw.tick()
        time.sleep(fsw.config.TICK_INTERVAL_SEC)


# Phase 1 Command: kill-process

def cmd_kill_process(args):
    
    sys.path.insert(0, os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..")))
    from flight.fsw_core import FswCore
    from flight.models import FswState

    print("[kill-process] Starting FSW in NOMINAL...")
    fsw, tmp_dir = _create_fsw()
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL
    assert fsw.state == FswState.NOMINAL, \
        f"Expected NOMINAL, got {fsw.state}"

    print("[kill-process] Simulating SIGKILL...")
    injected_at = time.monotonic()
    fsw.stop()  # Simulates process death

    # Simulate Systemd restart with RECOVERY_MODE=SAFE
    os.environ["RECOVERY_MODE"] = "SAFE"

    print("[kill-process] Restarting with RECOVERY_MODE=SAFE...")
    from flight.config import FswConfig
    config = fsw.config
    fsw2 = FswCore(config=config)
    fsw2._boot_counter_path = os.path.join(tmp_dir, "boot_counter")

    fsw2.start()
    recovered_at = time.monotonic()

    recovery_ms = (recovered_at - injected_at) * 1000

    os.environ.pop("RECOVERY_MODE", None)

    passed = (fsw2.state == FswState.SAFE and recovery_ms <= 3000)

    _report("kill-process", {
        "status": "COMPLETED",
        "fsw_state_after": fsw2.state.value,
        "recovery_time_ms": round(recovery_ms, 2),
        "target_ms": 3000,
        "wd_restarts": fsw2.consecutive_wd_restarts,
        "pass": passed,
    })

    sys.exit(0 if passed else 1)


# Phase 1 Command: thermal-spike

def cmd_thermal_spike(args):
    
    sys.path.insert(0, os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..")))
    from flight.fsw_core import FswCore
    from flight.models import FswState

    temp = args.temp
    duration = args.duration

    print(f"[thermal-spike] Injecting temp={temp}°C for {duration}s...")

    fsw, tmp_dir = _create_fsw(
        stability_timer=0.5,
        telem_safe_rate=0.01,
    )
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL
    assert fsw.state == FswState.NOMINAL

    # Inject thermal spike
    injected_at = time.monotonic()
    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": temp})

    fsw.tick()  # Should trigger T3
    detected_at = time.monotonic()
    detection_ms = (detected_at - injected_at) * 1000

    t3_triggered = (fsw.state == FswState.SAFE)

    # Hold fault for specified duration (simulated ticks)
    hold_ticks = min(duration, 10)  # Cap for test speed
    for _ in range(hold_ticks):
        fsw.tick()
        time.sleep(0.05)

    # Clear override and verify recovery
    fsw.sensors.clear_all_overrides()
    recovery_start = time.monotonic()

    # Tick until recovery or timeout
    recovered = False
    for _ in range(100):
        fsw.tick()
        if fsw.state == FswState.NOMINAL:
            recovered = True
            break
        time.sleep(0.05)

    recovery_ms = (time.monotonic() - recovery_start) * 1000

    # Check audit for T3 event
    entries = fsw.audit.get_entries()
    t3_entries = [e for e in entries
                  if "T3" in e.description
                  and e.event_type == "STATE_TRANSITION"]

    passed = t3_triggered and len(t3_entries) > 0

    _report("thermal-spike", {
        "status": "COMPLETED",
        "temp_c": temp,
        "duration_s": duration,
        "t3_triggered": t3_triggered,
        "detection_time_ms": round(detection_ms, 2),
        "t3_audit_events": len(t3_entries),
        "recovered_to_nominal": recovered,
        "recovery_time_ms": round(recovery_ms, 2) if recovered else None,
        "pass": passed,
    })

    sys.exit(0 if passed else 1)



def cmd_power_drop(args):
    
    sys.path.insert(0, os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..")))
    from flight.fsw_core import FswCore
    from flight.models import FswState

    voltage = args.voltage
    duration = args.duration

    print(f"[power-drop] Injecting voltage={voltage}V for {duration}s...")

    fsw, tmp_dir = _create_fsw(telem_safe_rate=0.01)
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL
    assert fsw.state == FswState.NOMINAL

    injected_at = time.monotonic()
    fsw.sensors.set_override("POWER", {"voltage_v": voltage})

    fsw.tick()
    detected_at = time.monotonic()
    t3_triggered = (fsw.state == FswState.SAFE)

    passed = t3_triggered

    _report("power-drop", {
        "status": "COMPLETED",
        "voltage_v": voltage,
        "t3_triggered": t3_triggered,
        "detection_time_ms": round((detected_at - injected_at) * 1000, 2),
        "pass": passed,
    })

    sys.exit(0 if passed else 1)


def cmd_cascade_failure(args):
    
    sys.path.insert(0, os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..")))
    from flight.fsw_core import FswCore
    from flight.models import FswState

    max_restarts = 3

    print(f"[cascade-failure] Simulating {max_restarts + 1} consecutive "
          f"WD restarts (max={max_restarts})...")

    fsw, tmp_dir = _create_fsw(max_wd_restarts=max_restarts)
    boot_counter_path = os.path.join(tmp_dir, "boot_counter")

    states_after_restart = []

    # Simulate consecutive restarts
    for restart_num in range(max_restarts + 1):
        # Save boot counter (simulates persistent counter across restarts)
        with open(boot_counter_path, "w") as f:
            f.write(str(restart_num))

        os.environ["RECOVERY_MODE"] = "SAFE"

        from flight.config import FswConfig
        config = FswConfig()
        config.TICK_INTERVAL_SEC = 0.01
        config.MAX_WD_RESTARTS = max_restarts
        config.SENSOR_NOISE_AMPLITUDE = 0.0
        config.AUDIT_LOG_PATH = os.path.join(tmp_dir, f"audit_{restart_num}.jsonl")
        config.QUEUE_DIR = os.path.join(tmp_dir, "queue")
        config.TRUSTED_KEYS_PATH = "/tmp/nonexistent.json"
        config.TELEMETRY_RATE_SAFE_SEC = 0.01

        fsw_i = FswCore(config=config)
        fsw_i._boot_counter_path = boot_counter_path
        fsw_i.start()

        states_after_restart.append({
            "restart_num": restart_num + 1,
            "state": fsw_i.state.value,
            "wd_restarts": fsw_i.consecutive_wd_restarts,
        })

        print(f"  Restart #{restart_num + 1}: state={fsw_i.state.value}, "
              f"wd_count={fsw_i.consecutive_wd_restarts}")

    os.environ.pop("RECOVERY_MODE", None)

    # Verify: restarts 1-3 → SAFE, restart 4 → CRITICAL
    last = states_after_restart[-1]
    t6_triggered = (last["state"] == "CRITICAL")
    all_safe_before = all(
        s["state"] == "SAFE"
        for s in states_after_restart[:-1]
    )

    passed = t6_triggered and all_safe_before

    _report("cascade-failure", {
        "status": "COMPLETED",
        "max_restarts": max_restarts,
        "restarts": states_after_restart,
        "t6_triggered": t6_triggered,
        "all_safe_before_escalation": all_safe_before,
        "pass": passed,
    })

    sys.exit(0 if passed else 1)

def cmd_network_outage(args):
    
    sys.path.insert(0, os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..")))
    from flight.fsw_core import FswCore
    from flight.comms_client import CommsClient, InProcessTransport, MockGateway
    from flight.window_scheduler import WindowScheduler
    from flight.config import FswConfig
    from flight.models import FswState

    duration = args.duration
    # Scale for test: cap at 5s real time
    real_duration = min(duration, 5.0)
    frames_per_phase = 10

    print(f"[network-outage] Simulating {duration}s outage "
          f"(real: {real_duration}s)...")

    # Setup
    tmp_dir = tempfile.mkdtemp()
    os.environ.pop("RECOVERY_MODE", None)

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

    fsw = FswCore(config=config)
    fsw._boot_counter_path = os.path.join(tmp_dir, "boot_counter")

    transport = InProcessTransport()
    gw = MockGateway(transport)
    gw.start()

    comms = CommsClient(
        transport=transport, queue=fsw.queue, audit=fsw.audit,
    )

    scheduler = WindowScheduler(
        open_duration_s=1000, closed_duration_s=1000, start_open=True,
    )

    # Wire telemetry
    def on_telem(frame):
        comms.send_telemetry(frame.subsystems, frame.fsw_state.value)
    fsw.set_telemetry_callback(on_telem)

    # Boot
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL
    assert fsw.state == FswState.NOMINAL

    # Phase A: Connected baseline
    print("[network-outage] Phase A: sending baseline frames...")
    comms.connect()
    for _ in range(frames_per_phase):
        fsw.tick()
        comms.drain_receives(timeout=0.01)
        time.sleep(0.02)

    time.sleep(0.1)
    comms.drain_receives(max_count=30, timeout=0.02)
    pre_outage_count = comms.next_seq_id - 1

    # Phase B: Force outage
    print(f"[network-outage] Phase B: forcing CLOSED for {real_duration}s...")
    injected_at = time.monotonic()
    scheduler.force_closed(duration_s=real_duration)
    comms.disconnect()

    for _ in range(frames_per_phase * 2):
        fsw.tick()
        time.sleep(0.02)

    queued_during = fsw.queue.depth()
    print(f"[network-outage]   Queued during outage: {queued_during}")

    # Wait for force to expire
    remaining = real_duration - (time.monotonic() - injected_at)
    if remaining > 0:
        time.sleep(remaining + 0.1)

    scheduler.tick()

    # Phase C: Reconnect + send more
    print("[network-outage] Phase C: reconnecting, replaying...")
    comms.connect()
    time.sleep(0.2)
    comms.drain_receives(max_count=50, timeout=0.02)

    for _ in range(frames_per_phase):
        fsw.tick()
        comms.drain_receives(timeout=0.01)
        time.sleep(0.02)

    time.sleep(0.2)
    comms.drain_receives(max_count=50, timeout=0.02)

    # Verify
    total_generated = comms.next_seq_id - 1
    received_seqs = gw.get_received_seq_ids()
    expected = set(range(1, total_generated + 1))
    actual = set(received_seqs)
    missing = expected - actual
    duplicates = len(received_seqs) - len(actual)

    # Check gaps
    gaps = []
    for i in range(1, len(received_seqs)):
        if received_seqs[i] != received_seqs[i - 1] + 1:
            gaps.append((received_seqs[i - 1], received_seqs[i]))

    zero_loss = (len(missing) == 0 and fsw.queue.depth() == 0)

    # P95 latency
    p95 = comms.compute_p95_latency_ms()

    comms.disconnect()
    gw.stop()

    passed = zero_loss

    _report("network-outage", {
        "status": "COMPLETED",
        "outage_duration_s": duration,
        "real_duration_s": round(real_duration, 2),
        "total_generated": total_generated,
        "total_received": len(received_seqs),
        "missing_count": len(missing),
        "missing_seq_ids": sorted(missing)[:10] if missing else [],
        "duplicates": duplicates,
        "gaps": gaps[:5] if gaps else [],
        "queue_remaining": fsw.queue.depth(),
        "queued_during_outage": queued_during,
        "replayed": comms.stats["messages_replayed"],
        "p95_latency_ms": p95,
        "zero_loss": zero_loss,
        "pass": passed,
    })

    sys.exit(0 if passed else 1)

# Phase 3 Skeleton: bad-signature

def cmd_bad_signature(args):
    print("[PHASE 3] inject bad-signature — NOT YET IMPLEMENTED")
    _report("bad-signature", {
        "status": "NOT_IMPLEMENTED",
        "pass": None,
    })
    sys.exit(1)

def cmd_run_all(args):
    output_dir = args.output
    os.makedirs(output_dir, exist_ok=True)

    print(f"[run-all] Output directory: {output_dir}")
    print(f"[run-all] NOT FULLY IMPLEMENTED — Phase 5")
    sys.exit(1)

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fault_injector",
        description=(
            "Asterion One — Fault Injector CLI\n"
            "Injects controlled faults for requirement verification.\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    inject_parser = subparsers.add_parser("inject", help="Inject a fault")
    inject_sub = inject_parser.add_subparsers(dest="fault_type", help="Fault type")

    p = inject_sub.add_parser("kill-process",
        help="Simulate WD recovery [REQ-FSW-WD-03s]")
    p.set_defaults(func=cmd_kill_process)

    # thermal-spike
    p = inject_sub.add_parser("thermal-spike",
        help="Force high temp, trigger T3 [REQ-FSW-STATE-01]")
    p.add_argument("--temp", type=float, default=85.0,
        help="Target temperature °C (default: 85.0)")
    p.add_argument("--duration", type=int, default=60,
        help="Duration of spike in seconds (default: 60)")
    p.set_defaults(func=cmd_thermal_spike)

    # power-drop
    p = inject_sub.add_parser("power-drop",
        help="Force low voltage, trigger T3 [REQ-FSW-STATE-01]")
    p.add_argument("--voltage", type=float, default=4.2,
        help="Target voltage V (default: 4.2)")
    p.add_argument("--duration", type=int, default=60,
        help="Duration seconds (default: 60)")
    p.set_defaults(func=cmd_power_drop)

    # cascade-failure
    p = inject_sub.add_parser("cascade-failure",
        help="3x kill → verify T6 [REQ-FSW-STATE-01]")
    p.set_defaults(func=cmd_cascade_failure)

    # network-outage
    p = inject_sub.add_parser("network-outage",
        help="Force link CLOSED [REQ-COM-ZERO-LOSS] (Phase 2)")
    p.add_argument("--duration", type=int, default=120,
        help="Outage seconds (default: 120)")
    p.set_defaults(func=cmd_network_outage)

    # bad-signature
    p = inject_sub.add_parser("bad-signature",
        help="Corrupted Ed25519 sig [REQ-SEC-ED25519] (Phase 3)")
    p.set_defaults(func=cmd_bad_signature)

    # --- run-all ---
    p = subparsers.add_parser("run-all",
        help="Execute all tests (Phase 5)")
    p.add_argument("--output", type=str, default="results/",
        help="Output dir (default: results/)")
    p.set_defaults(func=cmd_run_all)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    if not hasattr(args, "func"):
        parser.print_help()
        sys.exit(0)

    args.func(args)


if __name__ == "__main__":
    main()
