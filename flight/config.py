"""
Configuration parameters for the flight software.
Defines thresholds, timers, and limits, with overridable defaults for Raspberry Pi.
"""

import os
from dataclasses import dataclass


@dataclass
class FswConfig:
   
    TICK_INTERVAL_SEC: float = 1.0
    
    THRESHOLD_TEMP_WARN_C: float = 75.0

    THRESHOLD_TEMP_CRIT_C: float = 85.0

    HYSTERESIS_TEMP_C: float = 5.0

    VOLTAGE_MIN_V: float = 4.6

    BATTERY_SOC_MIN: float = 0.10

    COMMS_ERROR_RATE_MAX: float = 0.10

    STABILITY_TIMER_SEC: float = 30.0

    WD_HEARTBEAT_INTERVAL_SEC: float = 1.0
   
    WD_TIMEOUT_SEC: float = 3.0

    MAX_WD_RESTARTS: int = 3
   
    BOOT_SELF_TEST_TIMEOUT_SEC: float = 5.0

    TELEMETRY_RATE_NOMINAL_SEC: float = 1.0

    TELEMETRY_RATE_SAFE_SEC: float = 10.0

    GROUND_WS_URL: str = "ws://192.168.1.100:8081/flight"

    WS_RECONNECT_INTERVAL_SEC: float = 5.0

    WS_PING_INTERVAL_SEC: float = 30.0

    QUEUE_DIR: str = "/var/lib/asterion/queue"

    QUEUE_MAX_DEPTH: int = 10000

    AUDIT_LOG_PATH: str = "/var/log/asterion/audit.jsonl"

    TRUSTED_KEYS_PATH: str = "/etc/asterion/trusted_keys.json"

    SENSOR_USE_REAL_TEMP: bool = False

    SENSOR_NOMINAL_TEMP_C: float = 55.0

    SENSOR_NOMINAL_VOLTAGE_V: float = 5.1

    SENSOR_NOMINAL_POWER_W: float = 4.0

    SENSOR_NOISE_AMPLITUDE: float = 2.0


    @classmethod
    def from_env(cls) -> "FswConfig":
        
        config = cls()
        prefix = "ASTERION_"

        for field_name in config.__dataclass_fields__:
            env_key = prefix + field_name
            env_val = os.environ.get(env_key)

            if env_val is not None:
                field_type = type(getattr(config, field_name))
                try:
                    if field_type == bool:
                        # Handle bool specially: "true"/"1" → True
                        setattr(config, field_name, env_val.lower() in ("true", "1", "yes"))
                    elif field_type == int:
                        setattr(config, field_name, int(env_val))
                    elif field_type == float:
                        setattr(config, field_name, float(env_val))
                    else:
                        setattr(config, field_name, env_val)
                except (ValueError, TypeError):
                    pass  # Keep default if env var is malformed

        return config
