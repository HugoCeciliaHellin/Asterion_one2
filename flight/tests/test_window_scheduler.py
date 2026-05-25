"""
Unit tests for the window scheduler.
Tests open/close state transitions, forced overrides, and timing callbacks.
"""

import sys
import os
import time
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from flight.window_scheduler import WindowScheduler

def test_starts_open():
    ws = WindowScheduler(open_duration_s=10, closed_duration_s=5)
    assert ws.is_open() is True

def test_open_to_closed():
    ws = WindowScheduler(open_duration_s=0.1, closed_duration_s=10)
    assert ws.is_open() is True

    time.sleep(0.15)
    ws.tick()

    assert ws.is_open() is False

def test_closed_to_open():
    ws = WindowScheduler(
        open_duration_s=0.05, closed_duration_s=0.1, start_open=False
    )
    assert ws.is_open() is False

    time.sleep(0.15)
    ws.tick()

    assert ws.is_open() is True

def test_full_cycle():
    ws = WindowScheduler(open_duration_s=0.05, closed_duration_s=0.05)
    assert ws.is_open() is True

    # Wait for OPEN → CLOSED
    time.sleep(0.06)
    ws.tick()
    assert ws.is_open() is False

    # Wait for CLOSED → OPEN
    time.sleep(0.06)
    ws.tick()
    assert ws.is_open() is True

def test_force_closed():
    ws = WindowScheduler(open_duration_s=100, closed_duration_s=100)
    assert ws.is_open() is True

    ws.force_closed()
    assert ws.is_open() is False

def test_force_closed_duration():
    ws = WindowScheduler(open_duration_s=100, closed_duration_s=100)
    ws.force_closed(duration_s=0.1)

    assert ws.is_open() is False

    time.sleep(0.15)
    assert ws.is_open() is True  # Auto-expired

def test_clear_force():
    ws = WindowScheduler(open_duration_s=100, closed_duration_s=100)
    ws.force_closed()
    assert ws.is_open() is False

    ws.clear_force()
    assert ws.is_open() is True  # Natural state is OPEN

def test_time_until_open_when_open():
    ws = WindowScheduler(open_duration_s=100, closed_duration_s=100)
    assert ws.time_until_next_open() == 0.0

def test_time_until_close_when_closed():
    ws = WindowScheduler(
        open_duration_s=100, closed_duration_s=100, start_open=False
    )
    assert ws.time_until_close() == 0.0

def test_window_id_increments():
    ws = WindowScheduler(open_duration_s=0.05, closed_duration_s=0.05)
    assert ws.window_id == 0

    # Cycle through: OPEN→CLOSED→OPEN
    time.sleep(0.06)
    ws.tick()  # OPEN → CLOSED
    time.sleep(0.06)
    ws.tick()  # CLOSED → OPEN (window_id=1)

    assert ws.window_id == 1

    # Another cycle
    time.sleep(0.06)
    ws.tick()  # OPEN → CLOSED
    time.sleep(0.06)
    ws.tick()  # CLOSED → OPEN (window_id=2)

    assert ws.window_id == 2

def test_total_completed():
    ws = WindowScheduler(open_duration_s=0.05, closed_duration_s=0.05)
    assert ws.total_completed == 0

    time.sleep(0.06)
    ws.tick()  # OPEN → CLOSED (completed=1)
    assert ws.total_completed == 1

    time.sleep(0.06)
    ws.tick()  # CLOSED → OPEN
    time.sleep(0.06)
    ws.tick()  # OPEN → CLOSED (completed=2)
    assert ws.total_completed == 2

def test_state_change_callback():
    changes = []
    ws = WindowScheduler(
        open_duration_s=0.05,
        closed_duration_s=0.05,
        on_state_change=lambda is_open, wid: changes.append((is_open, wid)),
    )

    time.sleep(0.06)
    ws.tick()  # OPEN → CLOSED

    assert len(changes) >= 1
    assert changes[-1][0] is False  # Went to CLOSED

def test_callback_on_force():
    changes = []
    ws = WindowScheduler(
        open_duration_s=100,
        closed_duration_s=100,
        on_state_change=lambda is_open, wid: changes.append((is_open, wid)),
    )

    ws.force_closed()
    assert len(changes) == 1
    assert changes[0][0] is False

def test_window_info():
    ws = WindowScheduler(open_duration_s=100, closed_duration_s=100)
    info = ws.current_window_info()

    assert info.is_open is True
    assert info.window_id == 0
    assert info.forced_closed is False
    assert info.elapsed_in_state_s >= 0
    assert info.remaining_in_state_s > 0
    assert info.total_windows_completed == 0

def test_start_closed():
    ws = WindowScheduler(
        open_duration_s=100, closed_duration_s=100, start_open=False
    )
    assert ws.is_open() is False


def test_concurrent_reads():
    ws = WindowScheduler(open_duration_s=0.02, closed_duration_s=0.02)
    errors = []

    def reader():
        for _ in range(100):
            try:
                ws.is_open()
                ws.time_until_next_open()
                ws.current_window_info()
            except Exception as e:
                errors.append(e)

    def ticker():
        for _ in range(50):
            ws.tick()
            time.sleep(0.005)

    threads = [threading.Thread(target=reader) for _ in range(4)]
    threads.append(threading.Thread(target=ticker))
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(errors) == 0


def test_transitions_log():
    ws = WindowScheduler(open_duration_s=0.05, closed_duration_s=0.05)

    time.sleep(0.06)
    ws.tick()

    assert len(ws.transitions) >= 1
    assert ws.transitions[-1]["event"] == "WINDOW_CLOSED"

    ws.force_closed()
    assert ws.transitions[-1]["event"] == "FORCE_CLOSED"

    ws.clear_force()
    assert ws.transitions[-1]["event"] == "FORCE_CLEARED"
