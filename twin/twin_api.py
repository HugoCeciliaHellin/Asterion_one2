"""
Digital twin orchestrator component.
Manages the prediction cycle by fetching telemetry, executing models, and publishing forecasts and alerts to the ground API.
"""
import json
import time
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Optional

from .twin_engine import PredictionEngine
from .alert_engine import AlertEngine, Alert
from . import config


class TwinOrchestrator:


    def __init__(self, engine=None, alert_engine=None, api_base=None):
        self.engine = engine or PredictionEngine()
        self.alert_engine = alert_engine or AlertEngine()
        self.api_base = api_base or config.GROUND_API_BASE
        self._cycle_count = 0
        self._running = False


    def run_cycle(self):
       
        self._cycle_count += 1
        cycle_start = time.time()
        result = {
            "cycle": self._cycle_count,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "thermal": None,
            "energy": None,
            "alerts": [],
            "errors": [],
        }

        try:
            thermal_telem = self._fetch_telemetry("THERMAL")
            power_telem = self._fetch_telemetry("POWER")

            # Merge POWER data into thermal for complete picture
            merged_telem = self._merge_telemetry(thermal_telem, power_telem)

            # SD-4 step 4-7: Predict thermal
            thermal_fc = self.engine.predict_thermal(merged_telem)
            result["thermal"] = {
                "breach_detected": thermal_fc.breach_detected,
                "lead_time_min": thermal_fc.lead_time_min,
                "current_temp": thermal_fc.current_value,
                "rate_per_min": thermal_fc.rate_per_min,
            }

            # Predict energy
            energy_fc = self.engine.predict_energy(power_telem)
            result["energy"] = {
                "breach_detected": energy_fc.breach_detected,
                "lead_time_min": energy_fc.lead_time_min,
                "current_soc": energy_fc.current_value,
                "rate_per_min": energy_fc.rate_per_min,
            }

            thermal_alert = self.alert_engine.evaluate(thermal_fc)
            if thermal_alert:
                result["alerts"].append({
                    "model": "THERMAL",
                    "severity": thermal_alert.severity,
                    "lead_time_min": thermal_alert.lead_time_min,
                    "meets_req": thermal_alert.meets_requirement,
                })

            # Evaluate energy alert
            energy_alert = self.alert_engine.evaluate(energy_fc)
            if energy_alert:
                result["alerts"].append({
                    "model": "ENERGY",
                    "severity": energy_alert.severity,
                    "lead_time_min": energy_alert.lead_time_min,
                    "meets_req": energy_alert.meets_requirement,
                })

            self._post_forecast(thermal_fc, thermal_alert)
            self._post_forecast(energy_fc, energy_alert)

        except Exception as e:
            result["errors"].append(str(e))
            print(f"[twin_api] Cycle {self._cycle_count} error: {e}", file=sys.stderr)

        result["duration_ms"] = round((time.time() - cycle_start) * 1000, 2)
        return result

    def run_loop(self):
        
        self._running = True
        print(f"[twin_api] Starting Twin loop (cycle={config.TWIN_CYCLE_SEC}s, "
              f"horizon={config.HORIZON_MIN}min)")

        while self._running:
            result = self.run_cycle()

            # Log cycle summary
            alerts_str = f", {len(result['alerts'])} alerts" if result["alerts"] else ""
            breach_th = result["thermal"]["breach_detected"] if result["thermal"] else False
            breach_en = result["energy"]["breach_detected"] if result["energy"] else False
            print(
                f"[twin_api] Cycle {result['cycle']}: "
                f"thermal_breach={breach_th}, energy_breach={breach_en}"
                f"{alerts_str} ({result['duration_ms']}ms)"
            )

            if result["errors"]:
                for err in result["errors"]:
                    print(f"[twin_api]   ERROR: {err}", file=sys.stderr)

            time.sleep(config.TWIN_CYCLE_SEC)

    def stop(self):
        """Stop the continuous loop."""
        self._running = False

    def _fetch_telemetry(self, subsystem):
       
        url = (
            f"{self.api_base}/telemetry"
            f"?subsystem={subsystem}"
            f"&last={config.TELEM_LOOKBACK_MIN}m"
            f"&limit=500"
        )

        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                frames = data.get("data", [])

                # Convert to flat metric dicts
                result = []
                for frame in frames:
                    metrics = frame.get("metrics", {})
                    if isinstance(metrics, str):
                        metrics = json.loads(metrics)
                    entry = {
                        "timestamp": frame.get("timestamp"),
                        **metrics,
                    }
                    result.append(entry)

                # Sort by timestamp ascending
                result.sort(key=lambda x: x.get("timestamp", ""))
                return result

        except (urllib.error.URLError, Exception) as e:
            print(f"[twin_api] Failed to fetch {subsystem} telemetry: {e}",
                  file=sys.stderr)
            return []

    def _merge_telemetry(self, thermal, power):
        if not thermal:
            return power
        if not power:
            return thermal

        # Simple merge: for each thermal frame, find closest power frame
        merged = []
        for t_frame in thermal:
            entry = dict(t_frame)
            # Find closest power reading
            if power:
                # Simple: use latest power data for all
                latest_power = power[-1]
                entry.update({
                    k: v for k, v in latest_power.items()
                    if k != "timestamp"
                })
            merged.append(entry)

        return merged

    def _post_forecast(self, forecast, alert: Optional[Alert] = None):
        body = {
            "model_type": forecast.model_type,
            "horizon_min": forecast.horizon_min,
            "predicted_values": {
                "values": forecast.predicted_values,
                "timestamps": forecast.timestamps,
                "threshold": forecast.threshold,
                "breach_index": forecast.breach_index,
            },
            "breach_detected": forecast.breach_detected,
            "breach_time": forecast.breach_time,
            "lead_time_min": forecast.lead_time_min,
            "rationale": alert.rationale if alert else None,
            "alert_emitted": alert is not None,
        }

        url = f"{self.api_base}/twin/forecasts"
        data = json.dumps(body).encode("utf-8")

        try:
            req = urllib.request.Request(
                url, data=data, method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                return result
        except (urllib.error.URLError, Exception) as e:
            print(f"[twin_api] Failed to post {forecast.model_type} forecast: {e}",
                  file=sys.stderr)
            return None


# CLI Entry Point

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Asterion One — Digital Twin Prediction Engine"
    )
    parser.add_argument(
        "--api-base", default=config.GROUND_API_BASE,
        help=f"Ground API URL (default: {config.GROUND_API_BASE})"
    )
    parser.add_argument(
        "--once", action="store_true",
        help="Run single cycle then exit"
    )
    parser.add_argument(
        "--cycle-sec", type=int, default=config.TWIN_CYCLE_SEC,
        help=f"Cycle interval (default: {config.TWIN_CYCLE_SEC}s)"
    )

    args = parser.parse_args()
    config.TWIN_CYCLE_SEC = args.cycle_sec

    orchestrator = TwinOrchestrator(api_base=args.api_base)

    if args.once:
        result = orchestrator.run_cycle()
        print(json.dumps(result, indent=2))
    else:
        try:
            orchestrator.run_loop()
        except KeyboardInterrupt:
            print("\n[twin_api] Stopped by user")
            orchestrator.stop()


if __name__ == "__main__":
    main()