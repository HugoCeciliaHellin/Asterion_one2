"""
Asterion One — Flight Software entry point (dev/local mode).

Usage:
    python -m flight

Overrides Linux paths with local ./tmp/ dirs and connects to
ws://localhost:8081/flight instead of the production Raspberry Pi URL.
"""

import os
import sys
import time
import signal
import pathlib

# ── Local dev path overrides (before importing config) ──────────────────────
_BASE = pathlib.Path(__file__).parent.parent / "tmp" / "asterion"
os.environ.setdefault("ASTERION_GROUND_WS_URL", "ws://localhost:8081/flight")
os.environ.setdefault("ASTERION_QUEUE_DIR",      str(_BASE / "queue"))
os.environ.setdefault("ASTERION_AUDIT_LOG_PATH", str(_BASE / "audit.jsonl"))
# TRUSTED_KEYS_PATH — leave default (/etc/...), it's missing → graceful skip

from flight.config import FswConfig
from flight.fsw_core import FswCore
from flight.comms_client import CommsClient, WebSocketTransport

# ── Setup ────────────────────────────────────────────────────────────────────
config = FswConfig.from_env()

# Create local directories
pathlib.Path(config.QUEUE_DIR).mkdir(parents=True, exist_ok=True)
pathlib.Path(config.AUDIT_LOG_PATH).parent.mkdir(parents=True, exist_ok=True)

# ── Build components ─────────────────────────────────────────────────────────
fsw = FswCore(config=config)

transport = WebSocketTransport(
    url=config.GROUND_WS_URL,
    connect_timeout=3.0,
)
comms = CommsClient(
    transport=transport,
    queue=fsw.queue,
    audit=fsw.audit,
    on_plan_received=lambda plan: fsw.cmd_executor.execute_plan(plan, fsw.state),
)

# Wire telemetry: FSW emits → CommsClient sends to Ground
def _on_telemetry(frame):
    comms.send_telemetry(
        subsystems=frame.subsystems,
        fsw_state=frame.fsw_state.value,
    )

fsw.set_telemetry_callback(_on_telemetry)

# ── Signal handling ───────────────────────────────────────────────────────────
_running = True

def _stop(sig, frame):
    global _running
    print("\n[FSW] Shutdown requested — stopping...", flush=True)
    _running = False
    fsw.stop()

signal.signal(signal.SIGINT, _stop)
signal.signal(signal.SIGTERM, _stop)

# ── Main loop ─────────────────────────────────────────────────────────────────
print(f"[FSW] Starting — gateway: {config.GROUND_WS_URL}", flush=True)
fsw.start()

_last_connect_attempt = 0.0

while _running and fsw._running:
    now = time.monotonic()

    # Reconnect if link is down
    if not comms.connected:
        if (now - _last_connect_attempt) >= config.WS_RECONNECT_INTERVAL_SEC:
            _last_connect_attempt = now
            print("[FSW] Connecting to gateway...", flush=True)
            if comms.connect():
                print("[FSW] Flight Link UP", flush=True)
            else:
                print("[FSW] Flight Link DOWN — will retry in "
                      f"{config.WS_RECONNECT_INTERVAL_SEC:.0f}s", flush=True)

    # One FSW tick
    state = fsw.tick()

    # Drain incoming messages (ACKs, plan uploads)
    if comms.connected:
        comms.drain_receives()

    time.sleep(config.TICK_INTERVAL_SEC)

# Clean disconnect
if comms.connected:
    comms.disconnect()

print("[FSW] Stopped.", flush=True)
