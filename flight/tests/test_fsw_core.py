"""
Unit tests for the flight software core.
Tests FDIR state machine transitions, fault triggers, and anti-oscillation logic.
"""

import sys
import os
import time
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from flight.fsw_core import FswCore
from flight.models import FswState, Severity
from flight.config import FswConfig
from flight.crypto_verifier import CryptoVerifier


def make_fsw(
    tick_interval=0.01,
    stability_timer=0.1,
    temp_warn=75.0,
    hysteresis=5.0,
    max_wd_restarts=3,
    noise=0.0,
    telem_safe_rate=0.01,
):
    """Create an FswCore with test-friendly config."""
    tmp_dir = tempfile.mkdtemp()
    config = FswConfig()
    config.TICK_INTERVAL_SEC = tick_interval
    config.STABILITY_TIMER_SEC = stability_timer
    config.THRESHOLD_TEMP_WARN_C = temp_warn
    config.HYSTERESIS_TEMP_C = hysteresis
    config.MAX_WD_RESTARTS = max_wd_restarts
    config.SENSOR_NOISE_AMPLITUDE = noise
    config.SENSOR_NOMINAL_TEMP_C = 55.0
    config.SENSOR_NOMINAL_VOLTAGE_V = 5.1
    config.TELEMETRY_RATE_SAFE_SEC = telem_safe_rate
    config.AUDIT_LOG_PATH = os.path.join(tmp_dir, "audit.jsonl")
    config.QUEUE_DIR = os.path.join(tmp_dir, "queue")
    config.TRUSTED_KEYS_PATH = "/tmp/nonexistent.json"

    # Clear env to ensure normal boot
    os.environ.pop("RECOVERY_MODE", None)

    fsw = FswCore(config=config)
    fsw._boot_counter_path = os.path.join(tmp_dir, "boot_counter")
    return fsw

def test_t1_boot_to_nominal():
    fsw = make_fsw()
    fsw.start()
    assert fsw.state == FswState.BOOT

    fsw.tick()  # Runs self-test → T1
    assert fsw.state == FswState.NOMINAL

    entries = fsw.audit.get_entries()
    transitions = [e for e in entries if e.event_type == "STATE_TRANSITION"]
    assert any("T1" in e.description for e in transitions)


def test_t2_boot_to_safe():
    fsw = make_fsw()

    # Sabotage sensors to fail self-test
    original = fsw.sensors.read_all
    fsw.sensors.read_all = lambda: {}  # Returns empty → fails check

    fsw.start()
    fsw.tick()
    assert fsw.state == FswState.SAFE

    # Restore
    fsw.sensors.read_all = original

    entries = fsw.audit.get_entries()
    transitions = [e for e in entries if e.event_type == "STATE_TRANSITION"]
    assert any("T2" in e.description for e in transitions)

def test_t3_thermal_fault():
    fsw = make_fsw(temp_warn=75.0, noise=0.0)
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL
    assert fsw.state == FswState.NOMINAL

    # Inject thermal spike above threshold
    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 80.0})

    fsw.tick()  # Evaluate faults → T3
    assert fsw.state == FswState.SAFE

    entries = fsw.audit.get_entries()
    transitions = [e for e in entries if e.event_type == "STATE_TRANSITION"]
    assert any("T3" in e.description and "cpu_temp" in e.description
               for e in transitions)

def test_t3_voltage_fault():
    fsw = make_fsw(noise=0.0)
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    fsw.sensors.set_override("POWER", {"voltage_v": 4.2})

    fsw.tick()  # T3
    assert fsw.state == FswState.SAFE

    entries = fsw.audit.get_entries()
    transitions = [e for e in entries if e.event_type == "STATE_TRANSITION"]
    assert any("voltage" in e.description for e in transitions)

def test_t3_battery_fault():
    fsw = make_fsw(noise=0.0)
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    fsw.sensors.set_override("POWER", {"battery_soc": 0.05})

    fsw.tick()  # T3
    assert fsw.state == FswState.SAFE

def test_t3_comms_fault():
    fsw = make_fsw(noise=0.0)
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    fsw.sensors.set_override("COMMS", {"error_rate": 0.5})

    fsw.tick()  # T3
    assert fsw.state == FswState.SAFE


def test_t5_recovery():
    fsw = make_fsw(
        temp_warn=75.0, hysteresis=5.0,
        stability_timer=0.1,  # 100ms for test speed
        noise=0.0, telem_safe_rate=0.001,
    )
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 80.0})
    fsw.tick()
    assert fsw.state == FswState.SAFE

    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 55.0})

    # First tick: starts stability timer but doesn't transition yet
    fsw.tick()
    assert fsw.state == FswState.SAFE  # Timer just started

    # Wait for stability timer to expire
    time.sleep(0.15)

    fsw.tick()
    assert fsw.state == FswState.NOMINAL  # T5 fired

    entries = fsw.audit.get_entries()
    transitions = [e for e in entries if e.event_type == "STATE_TRANSITION"]
    assert any("T5" in e.description for e in transitions)

def test_t6_watchdog_escalation():
    fsw = make_fsw(max_wd_restarts=3)

    os.environ["RECOVERY_MODE"] = "SAFE"
    fsw._save_boot_counter(3)  # Already 3 restarts

    fsw.start()
    assert fsw.state == FswState.CRITICAL

    entries = fsw.audit.get_entries()
    transitions = [e for e in entries if e.event_type == "STATE_TRANSITION"]
    assert any("T6" in e.description or "escalation" in e.description.lower()
               for e in transitions)

    os.environ.pop("RECOVERY_MODE", None)

def test_t7_safe_remains():
    fsw = make_fsw(noise=0.0, telem_safe_rate=0.001)
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    # Inject persistent fault
    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 80.0})
    fsw.tick()  # T3
    assert fsw.state == FswState.SAFE

    for _ in range(5):
        fsw.tick()
    assert fsw.state == FswState.SAFE

def test_hysteresis_prevents_recovery():
    fsw = make_fsw(
        temp_warn=75.0, hysteresis=5.0,
        stability_timer=0.05, noise=0.0,
        telem_safe_rate=0.001,
    )
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 80.0})
    fsw.tick()
    assert fsw.state == FswState.SAFE

    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 72.0})

    for _ in range(10):
        fsw.tick()
        time.sleep(0.01)

    assert fsw.state == FswState.SAFE  # Still SAFE (hysteresis)


# Anti-oscillation: stability timer resets on fault recurrence 
def test_stability_timer_resets():
    fsw = make_fsw(
        temp_warn=75.0, hysteresis=5.0,
        stability_timer=0.2, noise=0.0,
        telem_safe_rate=0.001,
    )
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 80.0})
    fsw.tick()
    assert fsw.state == FswState.SAFE

    # Clear fault — starts stability timer
    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 55.0})
    fsw.tick()
    time.sleep(0.1)  # Wait 100ms of 200ms stability

    # Re-inject fault — timer should RESET
    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 80.0})
    fsw.tick()

    # Clear again
    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 55.0})
    fsw.tick()

    # Even after another 100ms, shouldn't recover (timer was reset)
    time.sleep(0.1)
    fsw.tick()
    assert fsw.state == FswState.SAFE


def test_nominal_stable():
    fsw = make_fsw(noise=0.0)
    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    for _ in range(20):
        fsw.tick()

    assert fsw.state == FswState.NOMINAL


def test_telemetry_generated():
    fsw = make_fsw(noise=0.0)
    frames = []
    fsw.set_telemetry_callback(lambda f: frames.append(f))

    fsw.start()
    fsw.tick()  # BOOT → NOMINAL
    fsw.tick()  # First NOMINAL tick → telemetry
    fsw.tick()  # Second NOMINAL tick → telemetry

    assert len(frames) >= 2
    assert frames[0].seq_id < frames[1].seq_id
    assert frames[0].fsw_state == FswState.NOMINAL
    assert "THERMAL" in frames[0].subsystems

def test_commands_execute_in_nominal():
    fsw = make_fsw(noise=0.0)
    priv, pub = CryptoVerifier.generate_keypair()
    fsw.cmd_executor._crypto.add_trusted_key("op", pub)

    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    commands = [{"sequence_id": 1, "command_type": "SET_PARAM",
                 "payload": {"x": 1}}]
    sig = CryptoVerifier.sign(commands, priv)
    plan_data = {
        "plan_id": "test-1",
        "commands": commands,
        "signature": sig.hex(),
        "public_key": pub.hex(),
    }

    result = fsw.cmd_executor.execute_plan(plan_data, fsw.state)
    assert result.status == "COMPLETED"

def test_commands_rejected_in_safe():
    fsw = make_fsw(noise=0.0)
    priv, pub = CryptoVerifier.generate_keypair()
    fsw.cmd_executor._crypto.add_trusted_key("op", pub)

    fsw.start()
    fsw.tick()  # BOOT → NOMINAL

    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 80.0})
    fsw.tick()  # T3
    assert fsw.state == FswState.SAFE

    commands = [{"sequence_id": 1, "command_type": "SET_PARAM",
                 "payload": {"x": 1}}]
    sig = CryptoVerifier.sign(commands, priv)
    plan_data = {
        "plan_id": "test-2",
        "commands": commands,
        "signature": sig.hex(),
        "public_key": pub.hex(),
    }

    result = fsw.cmd_executor.execute_plan(plan_data, fsw.state)
    assert result.status == "REJECTED"
    assert result.reason == "NOT_IN_NOMINAL"


def test_critical_stops():
    fsw = make_fsw(max_wd_restarts=3)
    os.environ["RECOVERY_MODE"] = "SAFE"
    fsw._save_boot_counter(3)

    fsw.start()
    assert fsw.state == FswState.CRITICAL
    assert fsw._running is False

    os.environ.pop("RECOVERY_MODE", None)


def test_wd_restart_count():
    fsw = make_fsw()
    os.environ["RECOVERY_MODE"] = "SAFE"
    fsw._save_boot_counter(1)

    fsw.start()  # Increments to 2
    assert fsw.consecutive_wd_restarts == 2
    assert fsw.state == FswState.SAFE  # 2 ≤ 3, so still SAFE

    os.environ.pop("RECOVERY_MODE", None)


def test_boot_counter_persists():
    tmp_dir = tempfile.mkdtemp()
    counter_path = os.path.join(tmp_dir, "boot_counter")

    fsw1 = make_fsw()
    fsw1._boot_counter_path = counter_path
    fsw1._save_boot_counter(2)

    fsw2 = make_fsw()
    fsw2._boot_counter_path = counter_path
    count = fsw2._load_boot_counter()
    assert count == 2

def test_audit_chain_through_transitions():
    fsw = make_fsw(
        noise=0.0, stability_timer=0.05,
        telem_safe_rate=0.001,
    )
    fsw.start()
    fsw.tick()  

    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 80.0})
    fsw.tick()

    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 55.0})
    fsw.tick()
    time.sleep(0.06)
    fsw.tick()

    # Verify chain
    result = fsw.audit.verify_chain()
    assert result.chain_valid is True
    assert result.total_events > 0


# State change callback 
def test_state_change_callback():
    fsw = make_fsw(noise=0.0)
    transitions = []

    def on_change(old_state, new_state):
        transitions.append((old_state, new_state))

    fsw.set_state_change_callback(on_change)

    fsw.start()
    fsw.tick()  

    fsw.sensors.set_override("THERMAL", {"cpu_temp_c": 80.0})
    fsw.tick()  

    assert len(transitions) >= 2
    assert transitions[-1] == (FswState.NOMINAL, FswState.SAFE)


def test_tick_count():
    fsw = make_fsw(noise=0.0)
    assert fsw.tick_count == 0

    fsw.start()
    for _ in range(10):
        fsw.tick()

    assert fsw.tick_count == 10
