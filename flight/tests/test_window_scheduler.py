"""
Asterion One — window_scheduler Unit Tests
=============================================
Reference: Art.5 §3.2.3, Art.8 §2.1 IF-WS-CONN

Coverage:
  1. Starts OPEN by default
  2. Transitions OPEN → CLOSED after open_duration
  3. Transitions CLOSED → OPEN after closed_duration
  4. Full cycle: OPEN → CLOSED → OPEN
  5. force_closed overrides natural OPEN
  6. force_closed with duration auto-expires
  7. clear_force restores natural state
  8. time_until_next_open returns 0 when OPEN
  9. time_until_close returns 0 when CLOSED
  10. window_id increments on each OPEN transition
  11. total_completed increments on each CLOSED transition
  12. on_state_change callback fires on transitions
  13. on_state_change fires on force_closed
  14. current_window_info snapshot
  15. start_closed option
  16. Concurrent reads are safe
"""

import sys
import os
import time
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from flight.window_scheduler import WindowScheduler


# --- Test 1: Starts OPEN by default ---
def test_starts_open():
    ws = WindowScheduler(open_duration_s=10, closed_duration_s=5)
    assert ws.is_open() is True


# --- Test 2: OPEN → CLOSED after open_duration ---
def test_open_to_closed():
    ws = WindowScheduler(open_duration_s=0.1, closed_duration_s=10)
    assert ws.is_open() is True

    time.sleep(0.15)
    ws.tick()

    assert ws.is_open() is False


# --- Test 3: CLOSED → OPEN after closed_duration ---
def test_closed_to_open():
    ws = WindowScheduler(
        open_duration_s=0.05, closed_duration_s=0.1, start_open=False
    )
    assert ws.is_open() is False

    time.sleep(0.15)
    ws.tick()

    assert ws.is_open() is True


# --- Test 4: Full cycle OPEN → CLOSED → OPEN ---
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


# --- Test 5: force_closed overrides OPEN ---
def test_force_closed():
    ws = WindowScheduler(open_duration_s=100, closed_duration_s=100)
    assert ws.is_open() is True

    ws.force_closed()
    assert ws.is_open() is False


# --- Test 6: force_closed with duration auto-expires ---
def test_force_closed_duration():
    ws = WindowScheduler(open_duration_s=100, closed_duration_s=100)
    ws.force_closed(duration_s=0.1)

    assert ws.is_open() is False

    time.sleep(0.15)
    assert ws.is_open() is True  # Auto-expired


# --- Test 7: clear_force restores natural state ---
def test_clear_force():
    ws = WindowScheduler(open_duration_s=100, closed_duration_s=100)
    ws.force_closed()
    assert ws.is_open() is False

    ws.clear_force()
    assert ws.is_open() is True  # Natural state is OPEN


# --- Test 8: time_until_next_open is 0 when OPEN ---
def test_time_until_open_when_open():
    ws = WindowScheduler(open_duration_s=100, closed_duration_s=100)
    assert ws.time_until_next_open() == 0.0


# --- Test 9: time_until_close is 0 when CLOSED ---
def test_time_until_close_when_closed():
    ws = WindowScheduler(
        open_duration_s=100, closed_duration_s=100, start_open=False
    )
    assert ws.time_until_close() == 0.0


# --- Test 10: window_id increments on OPEN ---
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


# --- Test 11: total_completed increments on CLOSED ---
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


# --- Test 12: on_state_change callback fires ---
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


# --- Test 13: Callback fires on force_closed ---
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


# --- Test 14: current_window_info snapshot ---
def test_window_info():
    ws = WindowScheduler(open_duration_s=100, closed_duration_s=100)
    info = ws.current_window_info()

    assert info.is_open is True
    assert info.window_id == 0
    assert info.forced_closed is False
    assert info.elapsed_in_state_s >= 0
    assert info.remaining_in_state_s > 0
    assert info.total_windows_completed == 0


# --- Test 15: start_closed option ---
def test_start_closed():
    ws = WindowScheduler(
        open_duration_s=100, closed_duration_s=100, start_open=False
    )
    assert ws.is_open() is False


# --- Test 16: Concurrent reads are safe ---
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


# --- Test 17: Transitions log ---
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
