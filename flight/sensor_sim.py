"""
Synthetic telemetry sensor simulator.
Generates telemetry with configurable Gaussian noise for all subsystems 
(THERMAL, POWER, CPU, COMMS, FSW).

Features optional hardware integration (e.g., reading real CPU temperature 
via vcgencmd on Raspberry Pi) and provides thread-safe, atomic overrides 
for fault injection testing.
"""
import random
import subprocess
import time
import threading
from typing import Dict, Optional

from flight.config import FswConfig


class SensorSim:
    

    # Subsystem names — canonical set referenced throughout the system
    SUBSYSTEM_NAMES = ("THERMAL", "POWER", "CPU", "COMMS", "FSW")

    def __init__(self, config: Optional[FswConfig] = None):
        
        self._config = config or FswConfig()
        self._start_time = time.monotonic()
        self._lock = threading.Lock()

        # Override storage: subsystem_name → {metric: value}
        self._overrides: Dict[str, Dict[str, float]] = {}

        # Internal state for realistic simulation
        self._battery_soc = 0.85  # Start at 85% charge
        self._ws_connected = False
        self._msg_queue_depth = 0
        self._wd_restarts = 0
        self._fsw_state_code = 0  # 0=BOOT, 1=NOMINAL, 2=SAFE, 3=CRITICAL

    # Public Interface — ISensorData

    def read_all(self) -> Dict[str, Dict[str, float]]:
       
        with self._lock:
            return {name: self._read_subsystem_locked(name)
                    for name in self.SUBSYSTEM_NAMES}

    def read_subsystem(self, name: str) -> Dict[str, float]:
       
        if name not in self.SUBSYSTEM_NAMES:
            raise ValueError(
                f"Unknown subsystem '{name}'. "
                f"Valid: {self.SUBSYSTEM_NAMES}"
            )
        with self._lock:
            return self._read_subsystem_locked(name)

    def set_override(self, subsystem: str, values: Dict[str, float]) -> None:
        
        if subsystem not in self.SUBSYSTEM_NAMES:
            raise ValueError(
                f"Unknown subsystem '{subsystem}'. "
                f"Valid: {self.SUBSYSTEM_NAMES}"
            )
        with self._lock:
            self._overrides[subsystem] = dict(values)

    def clear_override(self, subsystem: str) -> None:
        with self._lock:
            self._overrides.pop(subsystem, None)

    def clear_all_overrides(self) -> None:
        with self._lock:
            self._overrides.clear()

    # External State Updates (called by fsw_core, comms_client)

    def update_fsw_state(self, state_code: int) -> None:
        
        with self._lock:
            self._fsw_state_code = state_code

    def update_comms_status(self, connected: bool, queue_depth: int) -> None:
        with self._lock:
            self._ws_connected = connected
            self._msg_queue_depth = queue_depth

    def update_wd_restarts(self, count: int) -> None:
        with self._lock:
            self._wd_restarts = count

    def update_battery_soc(self, soc: float) -> None:
        with self._lock:
            self._battery_soc = max(0.0, min(1.0, soc))

    def _read_subsystem_locked(self, name: str) -> Dict[str, float]:
        # Generate normal synthetic readings
        normal = self._generate_normal(name)

        # Apply overrides: override values replace matching normal values
        override = self._overrides.get(name)
        if override:
            merged = dict(normal)
            merged.update(override)
            return merged

        return normal

    def _generate_normal(self, name: str) -> Dict[str, float]:
        if name == "THERMAL":
            return self._gen_thermal()
        elif name == "POWER":
            return self._gen_power()
        elif name == "CPU":
            return self._gen_cpu()
        elif name == "COMMS":
            return self._gen_comms()
        elif name == "FSW":
            return self._gen_fsw()
        else:
            return {}

    def _gen_thermal(self) -> Dict[str, float]:
       
        cfg = self._config
        noise = cfg.SENSOR_NOISE_AMPLITUDE

        if cfg.SENSOR_USE_REAL_TEMP:
            cpu_temp = self._read_rpi_cpu_temp()
        else:
            cpu_temp = cfg.SENSOR_NOMINAL_TEMP_C + random.gauss(0, noise)

        board_temp = cpu_temp - 15.0 + random.gauss(0, noise * 0.5)

        return {
            "cpu_temp_c": round(cpu_temp, 2),
            "board_temp_c": round(board_temp, 2),
        }

    def _gen_power(self) -> Dict[str, float]:
        
        cfg = self._config
        noise = cfg.SENSOR_NOISE_AMPLITUDE

        voltage = cfg.SENSOR_NOMINAL_VOLTAGE_V + random.gauss(0, noise * 0.02)
        current = 600 + random.gauss(0, 50)
        power = cfg.SENSOR_NOMINAL_POWER_W + random.gauss(0, noise * 0.1)

        # Battery slowly drains (simulates orbital power cycle)
        self._battery_soc = max(0.0, self._battery_soc - 0.00001)

        return {
            "voltage_v": round(voltage, 3),
            "current_ma": round(max(0, current), 1),
            "battery_soc": round(self._battery_soc, 4),
            "power_w": round(max(0, power), 2),
        }

    def _gen_cpu(self) -> Dict[str, float]:
        
        noise = self._config.SENSOR_NOISE_AMPLITUDE

        cpu = 35.0 + random.gauss(0, noise * 2)
        mem = 40.0 + random.gauss(0, noise * 1.5)

        return {
            "cpu_usage_pct": round(max(0, min(100, cpu)), 1),
            "memory_usage_pct": round(max(0, min(100, mem)), 1),
        }

    def _gen_comms(self) -> Dict[str, float]:
       
        error_rate = abs(random.gauss(0, 0.005))

        return {
            "ws_connected": 1.0 if self._ws_connected else 0.0,
            "msg_queue_depth": float(self._msg_queue_depth),
            "error_rate": round(min(1.0, error_rate), 4),
        }

    def _gen_fsw(self) -> Dict[str, float]:
        
        uptime = time.monotonic() - self._start_time

        return {
            "state_code": float(self._fsw_state_code),
            "uptime_s": round(uptime, 1),
            "wd_restarts": float(self._wd_restarts),
        }

    # Hardware Interface — Raspberry Pi CPU Temperature

    @staticmethod
    def _read_rpi_cpu_temp() -> float:
        
        try:
            result = subprocess.run(
                ["vcgencmd", "measure_temp"],
                capture_output=True, text=True, timeout=1
            )
            if result.returncode == 0:
                # Output format: "temp=55.0'C"
                temp_str = (result.stdout.strip()
                            .replace("temp=", "")
                            .replace("'C", ""))
                return float(temp_str)
        except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
            pass

        return 55.0  # Fallback: nominal temperature
