"""
Asterion One — Window Scheduler
==================================
Simulates LEO contact windows (OPEN/CLOSED cycles).
Reference: Art.5 §3.2.3 — window_scheduler
Reference: Art.8 §2.1 — IF-WS-CONN (connection lifecycle)

A real LEO satellite has ~10 min contact windows per 90 min orbit.
This scheduler simulates that pattern with configurable durations.

Protocol:
  OPEN   → Flight can connect WebSocket to Ground
  CLOSED → Flight must disconnect; messages queue to disk

The scheduler drives the comms_client's connect/disconnect lifecycle.
It can be overridden by fault_injector (force CLOSED for testing).

Thread-safe: can be read from comms_client thread and written
from scheduler thread or fault_injector.

Interface (IWindowScheduler):
  is_open()              → bool
  time_until_next_open() → float (seconds)
  time_until_close()     → float (seconds, 0 if closed)
  current_window_info()  → WindowInfo
  force_closed(duration) → None  (fault injection)
  clear_force()          → None
"""

import time
import threading
from dataclasses import dataclass
from typing import Optional, Callable, List


@dataclass
class WindowInfo:
    """Snapshot of current window state."""
    is_open: bool
    window_id: int
    elapsed_in_state_s: float
    remaining_in_state_s: float
    forced_closed: bool
    next_open_in_s: Optional[float]
    next_close_in_s: Optional[float]
    total_windows_completed: int


class WindowScheduler:
    """
    Simulates LEO contact windows with configurable OPEN/CLOSED durations.

    Default orbit parameters (scaled for demo):
      OPEN:   600s  (10 min contact window)
      CLOSED: 4800s (80 min blackout)

    For testing, use shorter durations:
      OPEN: 10s, CLOSED: 5s
    """

    def __init__(
        self,
        open_duration_s: float = 600.0,
        closed_duration_s: float = 4800.0,
        start_open: bool = True,
        on_state_change: Optional[Callable] = None,
    ):
        """
        Initialize the window scheduler.

        Args:
            open_duration_s:   Duration of each OPEN window (seconds).
            closed_duration_s: Duration of each CLOSED period (seconds).
            start_open:        If True, start in OPEN state.
            on_state_change:   Callback(is_open: bool, window_id: int)
                               called on every OPEN↔CLOSED transition.
        """
        self._open_duration = open_duration_s
        self._closed_duration = closed_duration_s
        self._on_state_change = on_state_change

        self._lock = threading.Lock()
        self._running = False

        # State
        self._is_open = start_open
        self._state_start = time.monotonic()
        self._window_id = 0
        self._total_completed = 0

        # Force override (fault injection)
        self._forced_closed = False
        self._force_until: Optional[float] = None

        # Transition log (for testing/audit)
        self._transitions: List[dict] = []

    # -------------------------------------------------------------------
    # Public Interface — IWindowScheduler
    # -------------------------------------------------------------------

    def is_open(self) -> bool:
        """
        Check if the contact window is currently OPEN.

        Returns False if force_closed is active, even if the
        natural schedule says OPEN.
        """
        with self._lock:
            self._check_force_expiry()
            if self._forced_closed:
                return False
            return self._is_open

    def time_until_next_open(self) -> float:
        """
        Seconds until the next OPEN window starts.
        Returns 0.0 if already OPEN (and not force-closed).
        """
        with self._lock:
            self._check_force_expiry()

            if self._forced_closed:
                # If forced, remaining = force duration
                if self._force_until:
                    remaining = max(0, self._force_until - time.monotonic())
                    return remaining
                return float("inf")  # Indefinite force

            if self._is_open:
                return 0.0

            # In natural CLOSED state
            elapsed = time.monotonic() - self._state_start
            remaining = max(0, self._closed_duration - elapsed)
            return remaining

    def time_until_close(self) -> float:
        """
        Seconds until the current OPEN window closes.
        Returns 0.0 if already CLOSED.
        """
        with self._lock:
            self._check_force_expiry()

            if self._forced_closed or not self._is_open:
                return 0.0

            elapsed = time.monotonic() - self._state_start
            remaining = max(0, self._open_duration - elapsed)
            return remaining

    def current_window_info(self) -> WindowInfo:
        """Get a complete snapshot of window state."""
        with self._lock:
            self._check_force_expiry()

            now = time.monotonic()
            elapsed = now - self._state_start
            effective_open = self._is_open and not self._forced_closed

            if effective_open:
                remaining = max(0, self._open_duration - elapsed)
            elif self._forced_closed and self._force_until:
                remaining = max(0, self._force_until - now)
            elif not self._is_open:
                remaining = max(0, self._closed_duration - elapsed)
            else:
                remaining = 0.0

            return WindowInfo(
                is_open=effective_open,
                window_id=self._window_id,
                elapsed_in_state_s=round(elapsed, 3),
                remaining_in_state_s=round(remaining, 3),
                forced_closed=self._forced_closed,
                next_open_in_s=(
                    0.0 if effective_open
                    else round(self.time_until_next_open(), 3)
                ),
                next_close_in_s=(
                    round(remaining, 3) if effective_open
                    else 0.0
                ),
                total_windows_completed=self._total_completed,
            )

    # -------------------------------------------------------------------
    # Fault Injection Interface
    # -------------------------------------------------------------------

    def force_closed(self, duration_s: Optional[float] = None) -> None:
        """
        Force the window CLOSED regardless of schedule.

        Args:
            duration_s: Duration of forced closure. None = indefinite.
                        Used by fault_injector inject network-outage.
        """
        with self._lock:
            self._forced_closed = True
            if duration_s is not None:
                self._force_until = time.monotonic() + duration_s
            else:
                self._force_until = None

            self._transitions.append({
                "time": time.monotonic(),
                "event": "FORCE_CLOSED",
                "duration_s": duration_s,
            })

        if self._on_state_change:
            self._on_state_change(False, self._window_id)

    def clear_force(self) -> None:
        """Remove the forced CLOSED override."""
        with self._lock:
            self._forced_closed = False
            self._force_until = None

            self._transitions.append({
                "time": time.monotonic(),
                "event": "FORCE_CLEARED",
            })

        if self._on_state_change and self._is_open:
            self._on_state_change(True, self._window_id)

    # -------------------------------------------------------------------
    # Tick-based scheduler (call from main loop or dedicated thread)
    # -------------------------------------------------------------------

    def tick(self) -> bool:
        """
        Advance the scheduler by checking if a state transition is due.

        Returns True if the state changed this tick.
        Call this periodically from the main loop.
        """
        with self._lock:
            self._check_force_expiry()

            now = time.monotonic()
            elapsed = now - self._state_start

            if self._is_open and elapsed >= self._open_duration:
                # OPEN → CLOSED
                self._is_open = False
                self._state_start = now
                self._total_completed += 1

                self._transitions.append({
                    "time": now,
                    "event": "WINDOW_CLOSED",
                    "window_id": self._window_id,
                })

                if self._on_state_change:
                    self._on_state_change(False, self._window_id)
                return True

            elif not self._is_open and elapsed >= self._closed_duration:
                # CLOSED → OPEN
                self._is_open = True
                self._state_start = now
                self._window_id += 1

                self._transitions.append({
                    "time": now,
                    "event": "WINDOW_OPENED",
                    "window_id": self._window_id,
                })

                if self._on_state_change:
                    self._on_state_change(True, self._window_id)
                return True

        return False

    def start_loop(self, tick_interval: float = 0.5) -> None:
        """Run the scheduler in a blocking loop."""
        self._running = True
        while self._running:
            self.tick()
            time.sleep(tick_interval)

    def stop(self) -> None:
        """Stop the scheduler loop."""
        self._running = False

    # -------------------------------------------------------------------
    # Internal
    # -------------------------------------------------------------------

    def _check_force_expiry(self) -> None:
        """Check if a timed force_closed has expired. Must hold lock."""
        if self._forced_closed and self._force_until is not None:
            if time.monotonic() >= self._force_until:
                self._forced_closed = False
                self._force_until = None

    # -------------------------------------------------------------------
    # Properties (for testing)
    # -------------------------------------------------------------------

    @property
    def transitions(self) -> List[dict]:
        """Get the transition log."""
        return list(self._transitions)

    @property
    def window_id(self) -> int:
        """Current window ID."""
        return self._window_id

    @property
    def total_completed(self) -> int:
        """Total windows that have completed (OPEN→CLOSED)."""
        return self._total_completed
