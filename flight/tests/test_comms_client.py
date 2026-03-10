"""
Asterion One — comms_client Unit + Integration Tests
======================================================
Uses InProcessTransport + MockGateway (no external deps).

Coverage:
  1. Send while disconnected → queued to disk
  2. Connect → replay queued messages
  3. Send while connected → sent via transport
  4. TELEMETRY_ACK updates highest_ack_seq_id
  5. ACK purges disk queue
  6. Disconnect → messages queue to disk
  7. CRITICAL: Full outage cycle → zero loss
  8. PLAN_UPLOAD → callback fires
  9. P95 latency calculation
  10. seq_id monotonically increases
  11. verify_zero_loss report
  12. Multiple outage cycles → zero loss
  13. Audit chain through comms events
"""

import sys, os, time, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from flight.comms_client import CommsClient, InProcessTransport, MockGateway
from flight.disk_queue import DiskQueue
from flight.audit_logger import AuditLogger


def make_env():
    """Create transport + mock gateway + comms_client."""
    tmp = tempfile.mkdtemp()
    transport = InProcessTransport()
    gw = MockGateway(transport)
    gw.start()

    queue = DiskQueue(os.path.join(tmp, "queue"), max_depth=10000)
    audit = AuditLogger(os.path.join(tmp, "audit.jsonl"), source="FLIGHT")

    client = CommsClient(transport=transport, queue=queue, audit=audit)
    return client, gw, queue, audit, transport


def drain(client, n=20):
    """Drain incoming messages."""
    for _ in range(n):
        if client.receive_one(timeout=0.02) is None:
            break


# --- Test 1: Send while disconnected → queued ---
def test_send_disconnected_queues():
    tmp = tempfile.mkdtemp()
    transport = InProcessTransport()  # Not connected
    queue = DiskQueue(os.path.join(tmp, "q"), max_depth=10000)
    audit = AuditLogger(os.path.join(tmp, "a.jsonl"), source="F")
    client = CommsClient(transport=transport, queue=queue, audit=audit)

    seq = client.send("TELEMETRY", {"temp": 55.0})
    assert seq == 1
    assert queue.depth() == 1
    assert client.stats["messages_queued"] == 1


# --- Test 2: Connect → replay queued ---
def test_connect_replays_queue():
    client, gw, queue, audit, _ = make_env()

    # Queue 3 while disconnected
    client.send("TELEMETRY", {"x": 1})
    client.send("TELEMETRY", {"x": 2})
    client.send("TELEMETRY", {"x": 3})
    assert queue.depth() == 3

    # Connect → replay
    client.connect()
    time.sleep(0.1)
    drain(client)

    assert client.stats["messages_replayed"] == 3
    assert gw.highest_ack == 3

    client.disconnect()
    gw.stop()


# --- Test 3: Send while connected ---
def test_send_connected():
    client, gw, queue, audit, _ = make_env()
    client.connect()

    seq = client.send_telemetry({"THERMAL": {"cpu_temp_c": 55.0}}, "NOMINAL")
    time.sleep(0.1)
    drain(client)

    assert seq == 1
    assert client.stats["messages_sent"] >= 1
    assert len(gw.received) >= 1

    client.disconnect()
    gw.stop()


# --- Test 4: ACK updates highest_ack ---
def test_ack_updates_highest():
    client, gw, queue, audit, _ = make_env()
    client.connect()

    client.send("TELEMETRY", {"x": 1})
    client.send("TELEMETRY", {"x": 2})
    time.sleep(0.1)
    drain(client)

    assert client.highest_ack_seq_id >= 2

    client.disconnect()
    gw.stop()


# --- Test 5: ACK purges disk queue ---
def test_ack_purges_queue():
    client, gw, queue, audit, _ = make_env()

    # Queue while disconnected
    client.send("TELEMETRY", {"x": 1})
    client.send("TELEMETRY", {"x": 2})
    assert queue.depth() == 2

    # Connect → replay → ACK → purge
    client.connect()
    time.sleep(0.1)
    drain(client)

    assert queue.depth() == 0

    client.disconnect()
    gw.stop()


# --- Test 6: Disconnect → queues ---
def test_disconnect_queues():
    client, gw, queue, audit, _ = make_env()
    client.connect()

    client.send("TELEMETRY", {"x": 1})
    time.sleep(0.05)
    drain(client)

    client.disconnect()
    client.send("TELEMETRY", {"x": 2})

    assert queue.depth() >= 1

    gw.stop()


# --- Test 7: CRITICAL — Full outage cycle, zero loss ---
def test_zero_loss_outage_cycle():
    """
    REQ-COM-ZERO-LOSS:
      1. Connected: send 5 (ack'd)
      2. Disconnected: send 10 (queued)
      3. Reconnected: replay + send 5 more
      4. ALL 20 received, 0 gaps, queue empty
    """
    client, gw, queue, audit, _ = make_env()

    # Phase 1: Connected
    client.connect()
    for i in range(5):
        client.send("TELEMETRY", {"phase": 1, "i": i})
    time.sleep(0.2)
    drain(client, 30)

    # Phase 2: Outage
    client.disconnect()
    for i in range(10):
        client.send("TELEMETRY", {"phase": 2, "i": i})
    assert queue.depth() == 10

    # Phase 3: Reconnect + send 5 more
    client.connect()
    time.sleep(0.2)
    drain(client, 30)

    for i in range(5):
        client.send("TELEMETRY", {"phase": 3, "i": i})
    time.sleep(0.2)
    drain(client, 30)

    # Verify
    received_seqs = gw.get_received_seq_ids()
    expected = set(range(1, 21))
    missing = expected - set(received_seqs)

    assert len(missing) == 0, f"Missing: {missing}"

    # Verify sequential (no gaps)
    for i in range(1, len(received_seqs)):
        assert received_seqs[i] == received_seqs[i-1] + 1, \
            f"Gap: {received_seqs[i-1]} → {received_seqs[i]}"

    assert queue.depth() == 0

    client.disconnect()
    gw.stop()


# --- Test 8: PLAN_UPLOAD → callback ---
def test_plan_upload_callback():
    plans = []
    tmp = tempfile.mkdtemp()
    transport = InProcessTransport()
    gw = MockGateway(transport)
    gw.start()

    queue = DiskQueue(os.path.join(tmp, "q"), max_depth=10000)
    audit = AuditLogger(os.path.join(tmp, "a.jsonl"), source="F")
    client = CommsClient(
        transport=transport, queue=queue, audit=audit,
        on_plan_received=lambda p: plans.append(p),
    )

    gw.queue_plan({
        "plan_id": "test-plan",
        "commands": [{"sequence_id": 1, "command_type": "NOP", "payload": {}}],
    })

    client.connect()
    client.send("TELEMETRY", {"trigger": True})
    time.sleep(0.2)
    drain(client, 10)

    assert len(plans) == 1
    assert plans[0]["plan_id"] == "test-plan"

    client.disconnect()
    gw.stop()


# --- Test 9: P95 latency ---
def test_p95_latency():
    client, gw, queue, audit, _ = make_env()
    client.connect()

    for i in range(20):
        client.send("TELEMETRY", {"i": i})
        time.sleep(0.01)

    time.sleep(0.3)
    drain(client, 40)

    p95 = client.compute_p95_latency_ms()
    assert p95 is not None, f"Latencies: {len(client.ack_latencies)}"
    assert p95 < 2000  # REQ-COM-P95

    client.disconnect()
    gw.stop()


# --- Test 10: seq_id monotonic ---
def test_seq_id_monotonic():
    tmp = tempfile.mkdtemp()
    transport = InProcessTransport()
    queue = DiskQueue(os.path.join(tmp, "q"), max_depth=10000)
    audit = AuditLogger(os.path.join(tmp, "a.jsonl"), source="F")
    client = CommsClient(transport=transport, queue=queue, audit=audit)

    seqs = [client.send("TELEMETRY", {}) for _ in range(10)]
    for i in range(1, len(seqs)):
        assert seqs[i] == seqs[i-1] + 1


# --- Test 11: verify_zero_loss report ---
def test_verify_zero_loss():
    client, gw, queue, audit, _ = make_env()
    client.connect()

    for i in range(10):
        client.send("TELEMETRY", {"i": i})
    time.sleep(0.2)
    drain(client, 20)

    report = client.verify_zero_loss(expected_count=10)
    assert report["total_generated"] == 10
    assert report["highest_ack"] >= 10
    assert report["queue_remaining"] == 0
    assert report["zero_loss"] is True

    client.disconnect()
    gw.stop()


# --- Test 12: Multiple outage cycles → zero loss ---
def test_multiple_outage_cycles():
    client, gw, queue, audit, _ = make_env()
    total_sent = 0

    for cycle in range(3):
        client.connect()
        for i in range(5):
            client.send("TELEMETRY", {"c": cycle, "i": i})
            total_sent += 1
        time.sleep(0.15)
        drain(client, 20)

        client.disconnect()
        for i in range(3):
            client.send("TELEMETRY", {"c": cycle, "out": True})
            total_sent += 1

    # Final flush
    client.connect()
    time.sleep(0.2)
    drain(client, 30)

    received_seqs = gw.get_received_seq_ids()
    expected = set(range(1, total_sent + 1))
    missing = expected - set(received_seqs)

    assert len(missing) == 0, f"Missing: {missing}"
    assert queue.depth() == 0

    client.disconnect()
    gw.stop()


# --- Test 13: Audit chain valid ---
def test_audit_chain_valid():
    client, gw, queue, audit, _ = make_env()
    client.connect()
    client.send("TELEMETRY", {"x": 1})
    time.sleep(0.1)
    drain(client)
    client.disconnect()

    result = audit.verify_chain()
    assert result.chain_valid is True
    assert result.total_events > 0

    gw.stop()
