"""
Asterion One — Communications Client
========================================
Flight-side communications with store-and-forward protocol.
Reference: Art.5 §3.1.2 — comms_client
Reference: Art.8 §2.1-2.4 — WebSocket Interface

Implements the store-and-forward protocol for zero command loss:

Protocol [Art.4 F3.2]:
  1. Flight generates messages with monotonic seq_id
  2. OPEN window:  send via transport, receive ACKs
  3. CLOSED window: queue all messages to disk_queue
  4. On reconnect:  replay all unack'd messages

Transport abstraction:
  - Production: WebSocketTransport (uses websockets library)
  - Testing:    InProcessTransport (thread-safe queue pair)

REQ-COM-ZERO-LOSS: Zero command loss during outages
REQ-COM-P95:       Command-to-actuation latency ≤ 2s (p95)
"""

import json
import time
import threading
import queue as stdlib_queue
from datetime import datetime, timezone
from typing import Optional, Dict, Any, Callable, List, Protocol


# ===================================================================
# Transport Interface
# ===================================================================

class ITransport(Protocol):
    """Abstract transport for comms_client."""

    def connect(self) -> bool: ...
    def disconnect(self) -> None: ...
    def send(self, data: str) -> bool: ...
    def recv(self, timeout: float) -> Optional[str]: ...
    def is_connected(self) -> bool: ...


class InProcessTransport:
    """
    In-process transport for testing. Uses thread-safe queues.
    Simulates a bidirectional link between Flight and Ground.
    """

    def __init__(self):
        self.flight_to_ground: stdlib_queue.Queue = stdlib_queue.Queue()
        self.ground_to_flight: stdlib_queue.Queue = stdlib_queue.Queue()
        self._connected = False

    def connect(self) -> bool:
        self._connected = True
        return True

    def disconnect(self) -> None:
        self._connected = False

    def send(self, data: str) -> bool:
        if not self._connected:
            return False
        self.flight_to_ground.put(data)
        return True

    def recv(self, timeout: float = 0.1) -> Optional[str]:
        if not self._connected:
            return None
        try:
            return self.ground_to_flight.get(timeout=timeout)
        except stdlib_queue.Empty:
            return None

    def is_connected(self) -> bool:
        return self._connected

    # Ground-side methods (used by MockGateway)
    def ground_recv(self, timeout: float = 0.1) -> Optional[str]:
        try:
            return self.flight_to_ground.get(timeout=timeout)
        except stdlib_queue.Empty:
            return None

    def ground_send(self, data: str) -> None:
        self.ground_to_flight.put(data)


class WebSocketTransport:
    """
    Real WebSocket transport (requires websockets library).
    Used in production on the Raspberry Pi.
    """

    def __init__(self, url: str, connect_timeout: float = 3.0):
        self._url = url
        self._timeout = connect_timeout
        self._ws = None

    def connect(self) -> bool:
        try:
            import websockets.sync.client as ws_sync
            self._ws = ws_sync.connect(
                self._url, open_timeout=self._timeout,
                close_timeout=self._timeout,
            )
            return True
        except Exception:
            self._ws = None
            return False

    def disconnect(self) -> None:
        if self._ws:
            try:
                self._ws.close()
            except Exception:
                pass
            self._ws = None

    def send(self, data: str) -> bool:
        if not self._ws:
            return False
        try:
            self._ws.send(data)
            return True
        except Exception:
            self._ws = None
            return False

    def recv(self, timeout: float = 0.1) -> Optional[str]:
        if not self._ws:
            return None
        try:
            return self._ws.recv(timeout=timeout)
        except Exception:
            return None

    def is_connected(self) -> bool:
        return self._ws is not None


# ===================================================================
# Mock Gateway (for in-process testing)
# ===================================================================

class MockGateway:
    """
    Ground-side mock that processes messages via InProcessTransport.
    Runs in a background thread. No external dependencies.
    """

    def __init__(self, transport: InProcessTransport):
        self._transport = transport
        self._running = False
        self._thread = None
        self.received: List[dict] = []
        self.highest_ack = 0
        self._plan_to_send = None

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)

    def queue_plan(self, plan_data: dict):
        self._plan_to_send = plan_data

    def get_received_seq_ids(self):
        return sorted(set(
            m.get("seq_id", 0) for m in self.received
            if m.get("type") == "TELEMETRY"
        ))

    def _loop(self):
        while self._running:
            raw = self._transport.ground_recv(timeout=0.05)
            if raw is None:
                continue

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            self.received.append(msg)

            if msg.get("type") == "TELEMETRY":
                seq = msg.get("seq_id", 0)
                if seq > self.highest_ack:
                    self.highest_ack = seq

                ack = json.dumps({
                    "type": "TELEMETRY_ACK",
                    "seq_id": seq,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "payload": {"highest_ack_seq_id": self.highest_ack},
                })
                self._transport.ground_send(ack)

                if self._plan_to_send:
                    plan_msg = json.dumps({
                        "type": "PLAN_UPLOAD",
                        "seq_id": 0,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "payload": self._plan_to_send,
                    })
                    self._transport.ground_send(plan_msg)
                    self._plan_to_send = None


# ===================================================================
# Communications Client
# ===================================================================

class CommsClient:
    """
    Flight-side communications client with store-and-forward.

    Manages connection lifecycle tied to window_scheduler state.
    Queues messages to disk when offline, replays on reconnect.
    """

    def __init__(
        self,
        transport: ITransport,
        queue,  # DiskQueue
        audit,  # AuditLogger
        on_plan_received: Optional[Callable] = None,
    ):
        self._transport = transport
        self._queue = queue
        self._audit = audit
        self._on_plan_received = on_plan_received

        self._lock = threading.Lock()

        # Sequence tracking [REQ-COM-ZERO-LOSS]
        self._next_seq_id = 1
        self._highest_ack_seq_id = 0

        # Stats
        self._stats = {
            "messages_sent": 0,
            "messages_queued": 0,
            "messages_replayed": 0,
            "acks_received": 0,
            "plans_received": 0,
            "connect_count": 0,
            "disconnect_count": 0,
        }

        # Latency tracking [REQ-COM-P95]
        self._send_timestamps: Dict[int, float] = {}
        self._ack_latencies: List[float] = []

    # -------------------------------------------------------------------
    # Properties
    # -------------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._transport.is_connected()

    @property
    def next_seq_id(self) -> int:
        return self._next_seq_id

    @property
    def highest_ack_seq_id(self) -> int:
        return self._highest_ack_seq_id

    @property
    def stats(self) -> dict:
        return dict(self._stats)

    @property
    def ack_latencies(self) -> List[float]:
        return list(self._ack_latencies)

    # -------------------------------------------------------------------
    # Connection Lifecycle
    # -------------------------------------------------------------------

    def connect(self) -> bool:
        from flight.models import Severity

        ok = self._transport.connect()
        if not ok:
            return False

        self._stats["connect_count"] += 1
        self._audit.log(
            event_type="COMMS_CONNECTED",
            severity=Severity.INFO,
            description="Transport connected",
        )

        # Replay unack'd messages [Art.4 F3.2 Rule 4]
        self._replay_queued()
        return True

    def disconnect(self) -> None:
        from flight.models import Severity

        self._transport.disconnect()
        self._stats["disconnect_count"] += 1
        self._audit.log(
            event_type="COMMS_DISCONNECTED",
            severity=Severity.INFO,
            description="Transport disconnected (window closed)",
        )

    # -------------------------------------------------------------------
    # Send Interface
    # -------------------------------------------------------------------

    def send(self, msg_type: str, payload: Dict[str, Any]) -> int:
        seq_id = self._next_seq_id
        self._next_seq_id += 1

        envelope = {
            "type": msg_type,
            "seq_id": seq_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "payload": payload,
        }

        if self._transport.is_connected():
            success = self._send_transport(envelope)
            if not success:
                self._queue_to_disk(envelope)
        else:
            self._queue_to_disk(envelope)

        return seq_id

    def send_telemetry(self, subsystems: dict, fsw_state: str) -> int:
        return self.send("TELEMETRY", {
            "fsw_state": fsw_state,
            "subsystems": subsystems,
        })

    def send_command_ack(self, plan_id, seq_id, status, executed_at) -> int:
        return self.send("COMMAND_ACK", {
            "plan_id": plan_id, "sequence_id": seq_id,
            "status": status, "executed_at": executed_at,
        })

    def send_command_nack(self, plan_id, reason) -> int:
        return self.send("COMMAND_NACK", {"plan_id": plan_id, "reason": reason})

    def send_audit_event(self, entry: dict) -> int:
        return self.send("AUDIT_EVENT", entry)

    # -------------------------------------------------------------------
    # Receive
    # -------------------------------------------------------------------

    def receive_one(self, timeout: float = 0.1) -> Optional[Dict]:
        raw = self._transport.recv(timeout=timeout)
        if raw is None:
            return None
        try:
            msg = json.loads(raw)
            self._handle_incoming(msg)
            return msg
        except Exception:
            return None

    def drain_receives(self, max_count: int = 50, timeout: float = 0.05):
        """Drain all pending incoming messages."""
        for _ in range(max_count):
            if self.receive_one(timeout=timeout) is None:
                break

    def _handle_incoming(self, msg: Dict) -> None:
        msg_type = msg.get("type", "")
        payload = msg.get("payload", {})

        if msg_type == "TELEMETRY_ACK":
            self._handle_telemetry_ack(payload)
        elif msg_type == "PLAN_UPLOAD":
            self._stats["plans_received"] += 1
            if self._on_plan_received:
                self._on_plan_received(payload)

    def _handle_telemetry_ack(self, payload: Dict) -> None:
        ack_seq = payload.get("highest_ack_seq_id", 0)

        if ack_seq > self._highest_ack_seq_id:
            self._highest_ack_seq_id = ack_seq
            self._stats["acks_received"] += 1

            # Latency tracking
            if ack_seq in self._send_timestamps:
                latency_ms = (time.monotonic() -
                              self._send_timestamps[ack_seq]) * 1000
                self._ack_latencies.append(latency_ms)
                for sid in list(self._send_timestamps):
                    if sid <= ack_seq:
                        del self._send_timestamps[sid]

            # Purge ack'd from disk queue [Art.4 F3.2 Rule 3]
            removed = self._queue.remove_up_to(ack_seq)

    # -------------------------------------------------------------------
    # Store-and-Forward
    # -------------------------------------------------------------------

    def _send_transport(self, envelope: Dict) -> bool:
        with self._lock:
            ok = self._transport.send(json.dumps(envelope))
            if ok:
                self._stats["messages_sent"] += 1
                self._send_timestamps[envelope["seq_id"]] = time.monotonic()
            return ok

    def _queue_to_disk(self, envelope: Dict) -> None:
        self._queue.enqueue(envelope)
        self._stats["messages_queued"] += 1

    def _replay_queued(self) -> None:
        replay_from = self._highest_ack_seq_id + 1
        messages = self._queue.get_from(replay_from)
        if not messages:
            return

        replayed = 0
        for msg in messages:
            ok = self._send_transport(msg)
            if not ok:
                break
            replayed += 1

        if replayed > 0:
            self._stats["messages_replayed"] += replayed

    # -------------------------------------------------------------------
    # Metrics
    # -------------------------------------------------------------------

    def compute_p95_latency_ms(self) -> Optional[float]:
        if len(self._ack_latencies) < 10:
            return None
        s = sorted(self._ack_latencies)
        idx = int(len(s) * 0.95)
        return round(s[min(idx, len(s) - 1)], 2)

    def verify_zero_loss(self, expected_count: int) -> Dict[str, Any]:
        total = self._next_seq_id - 1
        q = self._queue.depth()
        return {
            "total_generated": total,
            "highest_ack": self._highest_ack_seq_id,
            "queue_remaining": q,
            "unacked": total - self._highest_ack_seq_id,
            "zero_loss": (self._highest_ack_seq_id >= expected_count and q == 0),
        }
