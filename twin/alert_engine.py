"""
Alert engine component for the digital twin.
Evaluates forecasts against thresholds to generate early warnings and physics-based rationales.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Dict

from .twin_engine import Forecast
from . import config

# Data Types

@dataclass
class Alert:
    """Result of alert evaluation."""
    model_type: str              # "THERMAL" or "ENERGY"
    severity: str                # "WARNING" or "CRITICAL"
    breach_detected: bool
    breach_time: Optional[str]   # ISO 8601
    lead_time_min: float         # Minutes before breach
    rationale: str               # Physics-based explanation
    forecast_summary: Dict = field(default_factory=dict)
    meets_requirement: bool = False  # lead_time >= 15 min



class AlertEngine:

    def __init__(self, thresholds=None):
        
        self.thresholds = thresholds or {
            "temp_warn": config.THRESHOLD_TEMP_C,
            "temp_crit": config.THRESHOLD_TEMP_CRITICAL_C,
            "soc_warn": config.THRESHOLD_SOC_LOW,
            "soc_crit": config.THRESHOLD_SOC_CRITICAL,
        }

    def evaluate(self, forecast: Forecast) -> Optional[Alert]:
        
        if not forecast.breach_detected:
            return None

        if forecast.lead_time_min is None or forecast.lead_time_min <= 0:
            return None

        # Determine severity
        severity = self._determine_severity(forecast)

        # Generate rationale [REQ-DT-RATIONALE]
        rationale = self.generate_rationale(forecast)

        # Check if lead time meets REQ-DT-EARLY-15m
        meets_req = forecast.lead_time_min >= config.MIN_USEFUL_LEAD_TIME_MIN

        return Alert(
            model_type=forecast.model_type,
            severity=severity,
            breach_detected=True,
            breach_time=forecast.breach_time,
            lead_time_min=forecast.lead_time_min,
            rationale=rationale,
            forecast_summary={
                "current_value": forecast.current_value,
                "threshold": forecast.threshold,
                "breach_index": forecast.breach_index,
                "rate_per_min": forecast.rate_per_min,
                "horizon_min": forecast.horizon_min,
                "predicted_at_breach": (
                    forecast.predicted_values[forecast.breach_index]
                    if forecast.breach_index is not None
                    and forecast.breach_index < len(forecast.predicted_values)
                    else None
                ),
            },
            meets_requirement=meets_req,
        )

    def generate_rationale(self, forecast: Forecast) -> str:
        
        if forecast.model_type == "THERMAL":
            return self._thermal_rationale(forecast)
        elif forecast.model_type == "ENERGY":
            return self._energy_rationale(forecast)
        else:
            return f"Unknown model type: {forecast.model_type}"

    # Private Helpers 

    def _determine_severity(self, forecast: Forecast) -> str:
        """Determine alert severity based on predicted peak value."""
        if forecast.model_type == "THERMAL":
            peak = max(forecast.predicted_values) if forecast.predicted_values else 0
            if peak >= self.thresholds["temp_crit"]:
                return "CRITICAL"
            return "WARNING"

        elif forecast.model_type == "ENERGY":
            trough = min(forecast.predicted_values) if forecast.predicted_values else 1
            if trough <= self.thresholds["soc_crit"]:
                return "CRITICAL"
            return "WARNING"

        return "WARNING"

    def _thermal_rationale(self, forecast: Forecast) -> str:
        """Generate thermal breach rationale per Art.5 §3.3.2 template."""
        meta = forecast.metadata
        cpu_pct = meta.get("cpu_usage_pct", "unknown")
        power_w = meta.get("power_w", "unknown")
        lead = forecast.lead_time_min or 0

        # Format breach time
        breach_utc = "unknown"
        if forecast.breach_time:
            try:
                bt = datetime.fromisoformat(forecast.breach_time.replace("Z", "+00:00"))
                breach_utc = bt.strftime("%H:%M UTC")
            except (ValueError, AttributeError):
                breach_utc = forecast.breach_time

        # Rate formatting
        rate_str = f"{abs(forecast.rate_per_min):.2f}" if forecast.rate_per_min else "N/A"

        # Build factors list
        factors = []
        if isinstance(cpu_pct, (int, float)) and cpu_pct > 70:
            factors.append(f"high computational load ({cpu_pct:.0f}%)")
        if isinstance(power_w, (int, float)) and power_w > 3.5:
            factors.append(f"elevated power draw ({power_w:.1f}W)")
        if forecast.threshold and forecast.current_value:
            margin = forecast.threshold - forecast.current_value
            if margin < 10:
                factors.append(f"narrow thermal margin ({margin:.1f}\u00B0C to threshold)")
        if not factors:
            factors.append("sustained thermal load")

        factors_str = ", ".join(factors)

        return (
            f"Predicted Overheat in {lead:.0f} min: "
            f"CPU load sustained at {cpu_pct}% is driving "
            f"thermal rise at {rate_str}\u00B0C/min. "
            f"At current trajectory, the {forecast.threshold}\u00B0C threshold "
            f"will be breached at ~{breach_utc}. "
            f"Contributing factors: {factors_str}."
        )

    def _energy_rationale(self, forecast: Forecast) -> str:
        """Generate energy depletion rationale per Art.5 §3.3.2 template."""
        meta = forecast.metadata
        power_w = meta.get("power_w", "unknown")
        charge_w = meta.get("charge_w", config.CHARGE_POWER_W)
        lead = forecast.lead_time_min or 0

        breach_utc = "unknown"
        if forecast.breach_time:
            try:
                bt = datetime.fromisoformat(forecast.breach_time.replace("Z", "+00:00"))
                breach_utc = bt.strftime("%H:%M UTC")
            except (ValueError, AttributeError):
                breach_utc = forecast.breach_time

        rate_str = f"{abs(forecast.rate_per_min * 100):.3f}" if forecast.rate_per_min else "N/A"

        # Determine if net drain
        factors = []
        if isinstance(power_w, (int, float)) and isinstance(charge_w, (int, float)):
            net = charge_w - power_w
            if net < 0:
                factors.append(f"net energy drain ({abs(net):.1f}W deficit)")
            factors.append(f"load {power_w:.1f}W vs charge {charge_w:.1f}W")
        if not factors:
            factors.append("sustained power imbalance")

        soc_pct = forecast.current_value * 100
        threshold_pct = forecast.threshold * 100

        return (
            f"Predicted Battery Depletion in {lead:.0f} min: "
            f"Current SOC at {soc_pct:.1f}% declining at "
            f"{rate_str}%/min. "
            f"At current trajectory, the {threshold_pct:.0f}% threshold "
            f"will be breached at ~{breach_utc}. "
            f"Contributing factors: {', '.join(factors)}."
        )