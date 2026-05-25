"""
Script to inject a SAFE-to-CRITICAL fault sequence into the ground audit chain via WebSocket.
Maintains hash chain continuity by chaining off the local flight software log.
"""
import asyncio
import hashlib
import json
import pathlib
import sys
from datetime import datetime, timedelta, timezone

import websockets

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
AUDIT_LOG = PROJECT_ROOT / "tmp" / "asterion" / "audit.jsonl"
GATEWAY_URL = "ws://localhost:8081/flight"
SOURCE = "FLIGHT"


def last_hash() -> str:
    try:
        with AUDIT_LOG.open("r", encoding="utf-8") as f:
            last_line = ""
            for line in f:
                if line.strip():
                    last_line = line
            if last_line:
                return json.loads(last_line)["hash"]
    except FileNotFoundError:
        pass
    return "GENESIS"


def hash_event(prev_hash: str, timestamp: str, event_type: str, source: str, description: str) -> str:
    payload = f"{prev_hash}|{timestamp}|{event_type}|{source}|{description}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def make_event(prev_hash: str, ts: datetime, event_type: str, severity: str, description: str, metadata: dict):
    ts_iso = ts.isoformat()
    h = hash_event(prev_hash, ts_iso, event_type, SOURCE, description)
    return {
        "timestamp": ts_iso,
        "event_type": event_type,
        "source": SOURCE,
        "severity": severity,
        "description": description,
        "metadata": metadata,
        "hash": h,
        "prev_hash": prev_hash,
    }


def build_cascade():
   
    now = datetime.now(timezone.utc)
    prev = last_hash()
    events = []

    plan = [
        (
            0.0,
            "STATE_TRANSITION",
            "WARNING",
            "T3: NOMINAL -> SAFE: CPU temperature 85.0C exceeds threshold 75.0C",
            {"transition": "T3", "from_state": "NOMINAL", "to_state": "SAFE",
             "reason": "CPU temperature 85.0C exceeds threshold 75.0C",
             "wd_restarts": 0, "cpu_temp_c": 85.0},
        ),
        (
            2.0,
            "STATE_TRANSITION",
            "WARNING",
            "T2: BOOT -> SAFE: Watchdog recovery (restart #1)",
            {"transition": "T2", "from_state": "BOOT", "to_state": "SAFE",
             "reason": "Watchdog recovery (restart #1)", "wd_restarts": 1},
        ),
        (
            4.0,
            "STATE_TRANSITION",
            "WARNING",
            "T2: BOOT -> SAFE: Watchdog recovery (restart #2)",
            {"transition": "T2", "from_state": "BOOT", "to_state": "SAFE",
             "reason": "Watchdog recovery (restart #2)", "wd_restarts": 2},
        ),
        (
            6.0,
            "STATE_TRANSITION",
            "WARNING",
            "T2: BOOT -> SAFE: Watchdog recovery (restart #3)",
            {"transition": "T2", "from_state": "BOOT", "to_state": "SAFE",
             "reason": "Watchdog recovery (restart #3)", "wd_restarts": 3},
        ),
        (
            8.0,
            "STATE_TRANSITION",
            "CRITICAL",
            "T6: SAFE -> CRITICAL: Watchdog escalation: 4 consecutive restarts > 3",
            {"transition": "T6", "from_state": "SAFE", "to_state": "CRITICAL",
             "reason": "Watchdog escalation: 4 consecutive restarts > 3",
             "wd_restarts": 4},
        ),
    ]

    for offset, event_type, severity, description, metadata in plan:
        ts = now + timedelta(seconds=offset)
        e = make_event(prev, ts, event_type, severity, description, metadata)
        events.append(e)
        prev = e["hash"]

    return events


async def main():
    events = build_cascade()
    print(f"[inject] Chaining off prev_hash={events[0]['prev_hash'][:16]}...")
    print(f"[inject] Connecting to {GATEWAY_URL}")
    async with websockets.connect(GATEWAY_URL) as ws:
        for seq_id, ev in enumerate(events, start=10000):
            envelope = {
                "type": "AUDIT_EVENT",
                "seq_id": seq_id,
                "timestamp": ev["timestamp"],
                "payload": ev,
            }
            await ws.send(json.dumps(envelope))
            print(f"[inject] sent {ev['metadata']['transition']:<3} "
                  f"{ev['metadata']['from_state']:>7} -> "
                  f"{ev['metadata']['to_state']:<8} severity={ev['severity']}")
            await asyncio.sleep(0.15)
        await asyncio.sleep(0.5)
    print("[inject] Done.")


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
