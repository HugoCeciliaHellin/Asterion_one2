"""
Digital twin prediction engine.
Implements 1st-order RC thermal and linear SOC models to forecast trajectories 
and provide a 15-minute early warning horizon.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Optional
import numpy as np

from . import config


# Data Types


@dataclass
class Forecast:
    """Result of a prediction run."""
    model_type: str                     # "THERMAL" or "ENERGY"
    horizon_min: int                    # Prediction horizon in minutes
    timestamps: List[str]               # ISO 8601 timestamps for each step
    predicted_values: List[float]       # Predicted metric values
    breach_detected: bool = False       # Whether threshold was exceeded
    breach_index: Optional[int] = None  # Index where breach first occurs
    breach_time: Optional[str] = None   # ISO timestamp of breach
    lead_time_min: Optional[float] = None  # Minutes before breach
    current_value: float = 0.0          # Starting value
    threshold: float = 0.0             # Threshold used for breach detection
    rate_per_min: float = 0.0          # Average rate of change (unit/min)
    metadata: Dict = field(default_factory=dict)  # Extra info for rationale



# Thermal Model (RC 1st Order)


class ThermalModel:
  

    def __init__(self, R=None, C=None, T_amb=None):
        self.R = R if R is not None else config.THERMAL_R
        self.C = C if C is not None else config.THERMAL_C
        self.T_amb = T_amb if T_amb is not None else config.THERMAL_T_AMB

    def predict(self, current_temp, power_profile, horizon_steps, dt=None):
    
        if dt is None:
            dt = config.DT_SEC

        T = np.zeros(horizon_steps)
        T[0] = current_temp

        for n in range(horizon_steps - 1):
            # Q_in from power profile (extend last value if profile shorter)
            Q_in = power_profile[min(n, len(power_profile) - 1)]
            # Q_out via thermal resistance
            Q_out = (T[n] - self.T_amb) / self.R
            # Euler forward step
            T[n + 1] = T[n] + dt * (Q_in - Q_out) / self.C

        return T

# Energy Model (SOC Linear)

class EnergyModel:
    def __init__(self, capacity_wh=None, charge_power_w=None):
        self.capacity_wh = capacity_wh or config.BATTERY_CAPACITY_WH
        self.charge_power_w = charge_power_w or config.CHARGE_POWER_W
        # Convert Wh to Joules for consistent dt in seconds
        self.capacity_j = self.capacity_wh * 3600

    def predict(self, current_soc, load_profile_w, horizon_steps, dt=None):
 
        if dt is None:
            dt = config.DT_SEC

        SOC = np.zeros(horizon_steps)
        SOC[0] = current_soc

        for n in range(horizon_steps - 1):
            P_load = load_profile_w[min(n, len(load_profile_w) - 1)]
            P_net = self.charge_power_w - P_load
            SOC[n + 1] = SOC[n] + dt * P_net / self.capacity_j
            # Clamp to [0, 1]
            SOC[n + 1] = np.clip(SOC[n + 1], 0.0, 1.0)

        return SOC

# IPredictionEngine — Main Interface
class PredictionEngine:


    def __init__(self, thermal_model=None, energy_model=None):
        self.thermal = thermal_model or ThermalModel()
        self.energy = energy_model or EnergyModel()

    def predict_thermal(self, telemetry_window, horizon_min=None):
        
        if horizon_min is None:
            horizon_min = config.HORIZON_MIN

        horizon_steps = (horizon_min * 60) // config.DT_SEC

        if not telemetry_window:
            return self._empty_forecast("THERMAL", horizon_min, horizon_steps)

        # Extract current state from latest telemetry
        latest = telemetry_window[-1]
        current_temp = latest.get("cpu_temp_c", 60.0)
        current_cpu = latest.get("cpu_usage_pct", 50.0)
        current_power = latest.get("power_w", None)

        # Build power profile from telemetry trend
        power_profile = self._build_power_profile(
            telemetry_window, horizon_steps, current_cpu, current_power
        )

        # Run RC model
        temperatures = self.thermal.predict(
            current_temp, power_profile, horizon_steps, config.DT_SEC
        )

        # Build timestamps
        now = datetime.now(timezone.utc)
        timestamps = [
            (now + timedelta(seconds=i * config.DT_SEC)).isoformat()
            for i in range(horizon_steps)
        ]

        # Detect breach
        threshold = config.THRESHOLD_TEMP_C
        breach_idx = None
        for i, t in enumerate(temperatures):
            if t >= threshold:
                breach_idx = i
                break

        # Calculate rate of change (°C/min) from prediction
        if len(temperatures) > 1:
            rate = float(
                (temperatures[-1] - temperatures[0])
                / (horizon_min if horizon_min > 0 else 1)
            )
        else:
            rate = 0.0

        # Build forecast
        forecast = Forecast(
            model_type="THERMAL",
            horizon_min=horizon_min,
            timestamps=timestamps,
            predicted_values=temperatures.tolist(),
            current_value=current_temp,
            threshold=threshold,
            rate_per_min=round(rate, 4),
            metadata={
                "cpu_usage_pct": current_cpu,
                "power_w": current_power or self._estimate_power(current_cpu),
                "R": self.thermal.R,
                "C": self.thermal.C,
                "T_amb": self.thermal.T_amb,
            },
        )

        if breach_idx is not None:
            forecast.breach_detected = True
            forecast.breach_index = breach_idx
            forecast.breach_time = timestamps[breach_idx]
            lead_time_sec = breach_idx * config.DT_SEC
            forecast.lead_time_min = round(lead_time_sec / 60.0, 2)

        return forecast

    def predict_energy(self, telemetry_window, horizon_min=None):
      
        if horizon_min is None:
            horizon_min = config.HORIZON_MIN

        horizon_steps = (horizon_min * 60) // config.DT_SEC

        if not telemetry_window:
            return self._empty_forecast("ENERGY", horizon_min, horizon_steps)

        latest = telemetry_window[-1]
        current_soc = latest.get("battery_soc", 0.8)
        current_power = latest.get("power_w", 4.0)

        # Build load profile
        load_profile = self._build_load_profile(
            telemetry_window, horizon_steps, current_power
        )

        # Run SOC model
        soc_values = self.energy.predict(
            current_soc, load_profile, horizon_steps, config.DT_SEC
        )

        # Build timestamps
        now = datetime.now(timezone.utc)
        timestamps = [
            (now + timedelta(seconds=i * config.DT_SEC)).isoformat()
            for i in range(horizon_steps)
        ]

        # Detect breach
        threshold = config.THRESHOLD_SOC_LOW
        breach_idx = None
        for i, s in enumerate(soc_values):
            if s <= threshold:
                breach_idx = i
                break

        # Rate
        if len(soc_values) > 1:
            rate = float(
                (soc_values[-1] - soc_values[0])
                / (horizon_min if horizon_min > 0 else 1)
            )
        else:
            rate = 0.0

        forecast = Forecast(
            model_type="ENERGY",
            horizon_min=horizon_min,
            timestamps=timestamps,
            predicted_values=soc_values.tolist(),
            current_value=current_soc,
            threshold=threshold,
            rate_per_min=round(rate, 6),
            metadata={
                "power_w": current_power,
                "charge_w": self.energy.charge_power_w,
                "capacity_wh": self.energy.capacity_wh,
            },
        )

        if breach_idx is not None:
            forecast.breach_detected = True
            forecast.breach_index = breach_idx
            forecast.breach_time = timestamps[breach_idx]
            lead_time_sec = breach_idx * config.DT_SEC
            forecast.lead_time_min = round(lead_time_sec / 60.0, 2)

        return forecast


    def _build_power_profile(self, telem, steps, current_cpu, current_power):
        """Build heat input profile from telemetry trend."""
        if current_power is not None:
            # If we have direct power measurement, extrapolate
            powers = [t.get("power_w", current_power) for t in telem[-5:]]
            avg_power = sum(powers) / len(powers) if powers else current_power
        else:
            # Estimate from CPU usage
            avg_power = self._estimate_power(current_cpu)

        # Use constant power assumption (conservative)
        return np.full(steps, avg_power)

    def _build_load_profile(self, telem, steps, current_power):
        """Build power load profile from telemetry trend."""
        powers = [t.get("power_w", current_power) for t in telem[-5:]]
        avg_power = sum(powers) / len(powers) if powers else current_power
        return np.full(steps, avg_power)

    def _estimate_power(self, cpu_pct):
        """Estimate power from CPU load. Ref: config.POWER_BASE_W"""
        return config.POWER_BASE_W + cpu_pct * config.POWER_PER_CPU_PCT_W

    def _empty_forecast(self, model_type, horizon_min, steps):
        """Return an empty forecast when no telemetry is available."""
        now = datetime.now(timezone.utc)
        return Forecast(
            model_type=model_type,
            horizon_min=horizon_min,
            timestamps=[
                (now + timedelta(seconds=i * config.DT_SEC)).isoformat()
                for i in range(steps)
            ],
            predicted_values=[0.0] * steps,
        )