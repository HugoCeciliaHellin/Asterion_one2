"""
Configuration parameters for the digital twin.
Defines thermal/energy model constants, thresholds, and simulation parameters.
"""

import os

# RC Thermal Model Parameters 
# dT/dt = (Q_in - (T - T_amb) / R) / C

# Thermal resistance (°C/W) — calibrate from RPi baseline data
# Typical RPi 4 passive cooling: R ≈ 8-12 °C/W
# T_eq = T_amb + P * R → at 5W: T_eq = 25 + 5*10 = 75°C (at threshold)
THERMAL_R = float(os.environ.get("TWIN_THERMAL_R", "10.0"))

# Thermal capacitance (J/°C) — calibrate from RPi baseline data
# Typical RPi 4: C ≈ 12-20 J/°C (small board, fast response)
# Time constant τ = R*C = 10*15 = 150s ≈ 2.5 min
THERMAL_C = float(os.environ.get("TWIN_THERMAL_C", "15.0"))

# Ambient temperature (°C)
THERMAL_T_AMB = float(os.environ.get("TWIN_T_AMB", "25.0"))


# Energy (SOC) Model Parameters 
# SOC[n+1] = SOC[n] + dt * (P_charge - P_load) / C_battery

# Battery capacity (Wh)
BATTERY_CAPACITY_WH = float(os.environ.get("TWIN_BATTERY_WH", "50.0"))

# Charge power (W) — solar panel equivalent
CHARGE_POWER_W = float(os.environ.get("TWIN_CHARGE_W", "7.0"))


# Prediction horizon (minutes)
HORIZON_MIN = int(os.environ.get("TWIN_HORIZON_MIN", "30"))

# Time step for Euler forward integration (seconds)
DT_SEC = int(os.environ.get("TWIN_DT_SEC", "60"))

# Number of prediction steps = HORIZON_MIN * 60 / DT_SEC
HORIZON_STEPS = (HORIZON_MIN * 60) // DT_SEC



# Thermal breach threshold (°C) — same as FSW T3 guard
THRESHOLD_TEMP_C = float(os.environ.get("TWIN_THRESHOLD_TEMP", "75.0"))

# Thermal critical threshold (°C) — above this = CRITICAL alert
THRESHOLD_TEMP_CRITICAL_C = float(os.environ.get("TWIN_THRESHOLD_TEMP_CRIT", "80.0"))

# Battery SOC breach threshold (fraction 0-1)
THRESHOLD_SOC_LOW = float(os.environ.get("TWIN_THRESHOLD_SOC", "0.15"))

# Battery SOC critical threshold
THRESHOLD_SOC_CRITICAL = float(os.environ.get("TWIN_THRESHOLD_SOC_CRIT", "0.10"))

# Minimum lead time to consider alert useful (minutes)
# [REQ-DT-EARLY-15m: must be ≥ 15]
MIN_USEFUL_LEAD_TIME_MIN = float(os.environ.get("TWIN_MIN_LEAD_TIME", "15.0"))

# Cycle interval (seconds) — how often twin_api runs predictions
TWIN_CYCLE_SEC = int(os.environ.get("TWIN_CYCLE_SEC", "60"))

# Ground API base URL
GROUND_API_BASE = os.environ.get("GROUND_API_BASE", "http://localhost:3000/api")

# Telemetry lookback window for fetching recent data
TELEM_LOOKBACK_MIN = int(os.environ.get("TWIN_TELEM_LOOKBACK", "30"))

POWER_BASE_W = float(os.environ.get("TWIN_POWER_BASE", "2.0"))
POWER_PER_CPU_PCT_W = float(os.environ.get("TWIN_POWER_PER_PCT", "0.03"))