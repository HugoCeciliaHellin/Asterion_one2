"""
Unit tests for the disk queue.
Tests FIFO ordering, file persistence, overflow limits, and thread safety.
"""

import sys
import os
import tempfile
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from flight.disk_queue import DiskQueue


def make_queue(max_depth=10000):
    tmp_dir = tempfile.mkdtemp()
    q_dir = os.path.join(tmp_dir, "queue")
    return DiskQueue(queue_dir=q_dir, max_depth=max_depth), q_dir


def make_msg(seq_id, data="test"):
    return {"seq_id": seq_id, "type": "TELEMETRY", "data": data}


def test_enqueue_and_depth():
    q, _ = make_queue()
    assert q.depth() == 0
    q.enqueue(make_msg(1))
    assert q.depth() == 1
    q.enqueue(make_msg(2))
    q.enqueue(make_msg(3))
    assert q.depth() == 3

def test_get_from():
    q, _ = make_queue()
    q.enqueue(make_msg(1, "a"))
    q.enqueue(make_msg(2, "b"))
    q.enqueue(make_msg(3, "c"))
    q.enqueue(make_msg(4, "d"))

    msgs = q.get_from(2)
    assert len(msgs) == 3
    assert msgs[0]["seq_id"] == 2
    assert msgs[1]["seq_id"] == 3
    assert msgs[2]["seq_id"] == 4

    # Get from seq_id=1 → should return all
    msgs = q.get_from(1)
    assert len(msgs) == 4

    # Get from seq_id=5 → should return empty
    msgs = q.get_from(5)
    assert len(msgs) == 0

def test_remove_up_to():
    q, _ = make_queue()
    q.enqueue(make_msg(1))
    q.enqueue(make_msg(2))
    q.enqueue(make_msg(3))
    q.enqueue(make_msg(4))

    removed = q.remove_up_to(2)
    assert removed == 2
    assert q.depth() == 2

    # Remaining should be 3 and 4
    msgs = q.get_from(1)
    assert len(msgs) == 2
    assert msgs[0]["seq_id"] == 3
    assert msgs[1]["seq_id"] == 4


def test_is_empty():
    q, _ = make_queue()
    assert q.is_empty() is True
    q.enqueue(make_msg(1))
    assert q.is_empty() is False
    q.remove_up_to(1)
    assert q.is_empty() is True

def test_peek():
    q, _ = make_queue()
    assert q.peek() is None  # Empty queue
    q.enqueue(make_msg(5))
    q.enqueue(make_msg(3))
    q.enqueue(make_msg(7))

    # peek should return lowest seq_id (3)
    msg = q.peek()
    assert msg["seq_id"] == 3

    # peek is non-destructive
    assert q.depth() == 3


def test_fifo_order():
    q, _ = make_queue()
    for i in range(10):
        q.enqueue(make_msg(i + 1, f"msg_{i}"))

    msgs = q.get_from(1)
    assert len(msgs) == 10
    for i, msg in enumerate(msgs):
        assert msg["seq_id"] == i + 1

def test_no_tmp_files():
    q, q_dir = make_queue()
    q.enqueue(make_msg(1))
    q.enqueue(make_msg(2))

    files = os.listdir(q_dir)
    tmp_files = [f for f in files if f.endswith(".tmp")]
    assert len(tmp_files) == 0, f"Found leftover .tmp files: {tmp_files}"
    json_files = [f for f in files if f.endswith(".json")]
    assert len(json_files) == 2

def test_overflow_drops_oldest():
    q, _ = make_queue(max_depth=3)
    q.enqueue(make_msg(1))
    q.enqueue(make_msg(2))
    q.enqueue(make_msg(3))
    assert q.depth() == 3

    # Adding 4th should drop oldest (1)
    q.enqueue(make_msg(4))
    assert q.depth() == 3

    msgs = q.get_from(1)
    seq_ids = [m["seq_id"] for m in msgs]
    assert 1 not in seq_ids, "seq_id=1 should have been dropped"
    assert 4 in seq_ids

def test_survives_restart():
    tmp_dir = tempfile.mkdtemp()
    q_dir = os.path.join(tmp_dir, "queue")

    # Session 1: enqueue 3 messages
    q1 = DiskQueue(queue_dir=q_dir)
    q1.enqueue(make_msg(1, "session1_a"))
    q1.enqueue(make_msg(2, "session1_b"))
    q1.enqueue(make_msg(3, "session1_c"))

    # "Restart": new instance on same directory
    q2 = DiskQueue(queue_dir=q_dir)
    assert q2.depth() == 3

    msgs = q2.get_from(1)
    assert len(msgs) == 3
    assert msgs[0]["data"] == "session1_a"
    assert msgs[2]["data"] == "session1_c"


def test_clear():
    q, _ = make_queue()
    q.enqueue(make_msg(1))
    q.enqueue(make_msg(2))
    q.enqueue(make_msg(3))

    removed = q.clear()
    assert removed == 3
    assert q.depth() == 0
    assert q.is_empty() is True

def test_missing_seq_id():
    q, _ = make_queue()
    try:
        q.enqueue({"type": "TELEMETRY", "data": "no seq_id"})
        assert False, "Should have raised ValueError"
    except ValueError as e:
        assert "seq_id" in str(e)

def test_concurrent_enqueue():
    q, _ = make_queue()
    errors = []

    def enqueue_batch(start, count):
        try:
            for i in range(count):
                q.enqueue(make_msg(start + i))
        except Exception as e:
            errors.append(e)

    threads = []
    for t_id in range(4):
        t = threading.Thread(
            target=enqueue_batch, args=(t_id * 25 + 1, 25)
        )
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    assert len(errors) == 0, f"Errors: {errors}"
    assert q.depth() == 100


def test_stability_cycles():
    q, _ = make_queue()

    for i in range(500):
        q.enqueue(make_msg(i + 1))
    assert q.depth() == 500

    for chunk in range(10):
        removed = q.remove_up_to((chunk + 1) * 50)
        assert removed >= 0

    assert q.depth() == 0

    for i in range(100):
        q.enqueue(make_msg(501 + i))
    assert q.depth() == 100
    msgs = q.get_from(501)
    assert len(msgs) == 100

def test_get_from_empty():
    q, _ = make_queue()
    msgs = q.get_from(1)
    assert msgs == []


def test_remove_up_to_empty():
    q, _ = make_queue()
    removed = q.remove_up_to(100)
    assert removed == 0
