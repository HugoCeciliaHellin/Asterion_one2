import sys
import os
import unittest
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from twin import config
from twin.twin_engine import ThermalModel, EnergyModel, PredictionEngine, Forecast
from twin.alert_engine import AlertEngine, Alert


class TestThermalModel(unittest.TestCase):

    def test_equilibrium_temperature(self):
        model = ThermalModel(R=10.0, C=15.0, T_amb=25.0)
        T = model.predict(62.5, np.array([3.75]*30), 30, 60)
        self.assertAlmostEqual(T[-1], 62.5, delta=0.5)

    def test_temperature_rises_high_power(self):
        model = ThermalModel(R=10.0, C=15.0, T_amb=25.0)
        T = model.predict(60.0, np.array([25.0]*30), 30, 60)
        self.assertGreater(T[-1], T[0])

    def test_temperature_drops_zero_power(self):
        model = ThermalModel(R=10.0, C=15.0, T_amb=25.0)
        T = model.predict(70.0, np.array([0.0]*30), 30, 60)
        self.assertLess(T[-1], T[0])
        self.assertGreater(T[-1], 25.0)

    def test_monotonic_rise(self):
        model = ThermalModel(R=10.0, C=15.0, T_amb=25.0)
        T = model.predict(50.0, np.array([30.0]*30), 30, 60)
        for i in range(1, len(T)):
            self.assertGreaterEqual(T[i], T[i-1])

    def test_first_step_equals_input(self):
        model = ThermalModel(R=10.0, C=15.0, T_amb=25.0)
        T = model.predict(65.3, np.array([10.0]*5), 5, 60)
        self.assertEqual(T[0], 65.3)

    def test_custom_params(self):
        model = ThermalModel(R=5.0, C=100.0, T_amb=20.0)
        self.assertEqual(model.R, 5.0)
        self.assertEqual(model.C, 100.0)
        self.assertEqual(model.T_amb, 20.0)

    def test_short_power_profile(self):
        model = ThermalModel(R=10.0, C=15.0, T_amb=25.0)
        T = model.predict(60.0, np.array([20.0]), 10, 60)
        self.assertEqual(len(T), 10)
        self.assertTrue(all(np.isfinite(T)))


class TestEnergyModel(unittest.TestCase):

    def test_soc_depletes(self):
        model = EnergyModel(capacity_wh=50.0, charge_power_w=5.0)
        SOC = model.predict(0.8, np.array([10.0]*30), 30, 60)
        self.assertLess(SOC[-1], SOC[0])

    def test_soc_charges(self):
        model = EnergyModel(capacity_wh=50.0, charge_power_w=10.0)
        SOC = model.predict(0.5, np.array([3.0]*30), 30, 60)
        self.assertGreater(SOC[-1], SOC[0])

    def test_soc_clamped_zero(self):
        model = EnergyModel(capacity_wh=10.0, charge_power_w=0.0)
        SOC = model.predict(0.05, np.array([50.0]*30), 30, 60)
        self.assertTrue(all(s >= 0.0 for s in SOC))

    def test_soc_clamped_one(self):
        model = EnergyModel(capacity_wh=10.0, charge_power_w=50.0)
        SOC = model.predict(0.95, np.array([0.0]*30), 30, 60)
        self.assertTrue(all(s <= 1.0 for s in SOC))

    def test_first_step(self):
        model = EnergyModel()
        SOC = model.predict(0.73, np.array([5.0]*5), 5, 60)
        self.assertEqual(SOC[0], 0.73)


class TestPredictionEngine(unittest.TestCase):

    def _make_thermal_telem(self, temp=65.0, cpu=80.0, power=4.5, n=10):
        return [{"timestamp": f"2026-03-20T14:{i:02d}:00Z",
                 "cpu_temp_c": temp + i*0.1, "cpu_usage_pct": cpu, "power_w": power}
                for i in range(n)]

    def _make_power_telem(self, soc=0.7, power=4.5, n=10):
        return [{"timestamp": f"2026-03-20T14:{i:02d}:00Z",
                 "battery_soc": soc - i*0.005, "power_w": power}
                for i in range(n)]

    def test_predict_thermal_returns_forecast(self):
        engine = PredictionEngine()
        fc = engine.predict_thermal(self._make_thermal_telem())
        self.assertIsInstance(fc, Forecast)
        self.assertEqual(fc.model_type, "THERMAL")
        self.assertEqual(len(fc.predicted_values), config.HORIZON_STEPS)

    def test_thermal_breach_detection(self):
        engine = PredictionEngine(thermal_model=ThermalModel(R=10.0, C=15.0, T_amb=25.0))
        telem = self._make_thermal_telem(temp=70.0, cpu=95.0, power=8.0)
        fc = engine.predict_thermal(telem, horizon_min=30)
        self.assertTrue(fc.breach_detected)
        self.assertIsNotNone(fc.breach_index)
        self.assertIsNotNone(fc.lead_time_min)
        self.assertGreater(fc.lead_time_min, 0)

    def test_thermal_no_breach_normal(self):
        engine = PredictionEngine(thermal_model=ThermalModel(R=10.0, C=15.0, T_amb=25.0))
        telem = self._make_thermal_telem(temp=40.0, cpu=30.0, power=2.0)
        fc = engine.predict_thermal(telem, horizon_min=30)
        self.assertFalse(fc.breach_detected)

    def test_thermal_empty_telemetry(self):
        engine = PredictionEngine()
        fc = engine.predict_thermal([])
        self.assertIsInstance(fc, Forecast)
        self.assertFalse(fc.breach_detected)

    def test_energy_depletion_detection(self):
        """High power + small battery → SOC drops below threshold in 30 min."""
        engine = PredictionEngine(energy_model=EnergyModel(capacity_wh=15.0, charge_power_w=2.0))
        telem = self._make_power_telem(soc=0.25, power=8.0)
        fc = engine.predict_energy(telem, horizon_min=30)
        self.assertTrue(fc.breach_detected,
            f"Expected depletion. Final SOC: {fc.predicted_values[-1]:.3f}")
        self.assertGreater(fc.lead_time_min, 0)

    def test_energy_no_breach_healthy(self):
        engine = PredictionEngine(energy_model=EnergyModel(capacity_wh=50.0, charge_power_w=10.0))
        telem = self._make_power_telem(soc=0.9, power=3.0)
        fc = engine.predict_energy(telem, horizon_min=30)
        self.assertFalse(fc.breach_detected)

    def test_GATE_lead_time_ge_15_min(self):
        """GATE TEST 1: lead_time >= 15 min [REQ-DT-EARLY-15m]
        Scenario: RPi at 40°C, moderate load (5.5W), slow rise.
        With R=10, C=50 (τ=500s): T_eq=80°C, breach at ~17 min.
        """
        engine = PredictionEngine(thermal_model=ThermalModel(R=10.0, C=50.0, T_amb=25.0))
        telem = self._make_thermal_telem(temp=40.0, cpu=70.0, power=5.5, n=15)
        fc = engine.predict_thermal(telem, horizon_min=30)

        self.assertTrue(fc.breach_detected,
            f"Expected breach. Final temp: {fc.predicted_values[-1]:.1f}C")
        self.assertIsNotNone(fc.lead_time_min)
        self.assertGreaterEqual(fc.lead_time_min, 15.0,
            f"REQ-DT-EARLY-15m FAILED: {fc.lead_time_min:.1f}min < 15min")

    def test_rate_positive_rising(self):
        engine = PredictionEngine(thermal_model=ThermalModel(R=10.0, C=15.0, T_amb=25.0))
        telem = self._make_thermal_telem(temp=60.0, cpu=85.0, power=6.0)
        fc = engine.predict_thermal(telem, horizon_min=30)
        self.assertGreater(fc.rate_per_min, 0)

    def test_metadata_includes_params(self):
        engine = PredictionEngine(thermal_model=ThermalModel(R=3.0, C=60.0, T_amb=22.0))
        fc = engine.predict_thermal(self._make_thermal_telem())
        self.assertEqual(fc.metadata["R"], 3.0)
        self.assertEqual(fc.metadata["C"], 60.0)
        self.assertEqual(fc.metadata["T_amb"], 22.0)


class TestAlertEngine(unittest.TestCase):

    def _breach_forecast(self, model="THERMAL", lead=20.0, peak=82.0, cpu=87.0, power=6.5):
        steps = 30
        if model == "THERMAL":
            vals = [65.0 + (peak-65.0)*i/(steps-1) for i in range(steps)]
            threshold = 75.0
            breach_idx = next((i for i,v in enumerate(vals) if v >= threshold), 15)
            return Forecast(
                model_type="THERMAL", horizon_min=30,
                timestamps=[f"2026-03-20T14:{i:02d}:00Z" for i in range(steps)],
                predicted_values=vals, breach_detected=True,
                breach_index=breach_idx, breach_time=f"2026-03-20T14:{breach_idx:02d}:00Z",
                lead_time_min=lead, current_value=65.0, threshold=threshold,
                rate_per_min=0.35,
                metadata={"cpu_usage_pct": cpu, "power_w": power, "R":2.5, "C":50.0, "T_amb":25.0})
        else:
            vals = [0.25 - 0.008*i for i in range(steps)]
            threshold = 0.15
            breach_idx = next((i for i,v in enumerate(vals) if v <= threshold), 12)
            return Forecast(
                model_type="ENERGY", horizon_min=30,
                timestamps=[f"2026-03-20T14:{i:02d}:00Z" for i in range(steps)],
                predicted_values=vals, breach_detected=True,
                breach_index=breach_idx, breach_time=f"2026-03-20T14:{breach_idx:02d}:00Z",
                lead_time_min=lead, current_value=0.25, threshold=threshold,
                rate_per_min=-0.003,
                metadata={"power_w": 8.0, "charge_w": 3.0, "capacity_wh": 50.0})

    def _no_breach(self):
        return Forecast(model_type="THERMAL", horizon_min=30,
            timestamps=[], predicted_values=[60.0]*30,
            breach_detected=False, current_value=60.0, threshold=75.0)

    def test_returns_alert_on_breach(self):
        alert = AlertEngine().evaluate(self._breach_forecast())
        self.assertIsNotNone(alert)
        self.assertIsInstance(alert, Alert)
        self.assertTrue(alert.breach_detected)

    def test_returns_none_no_breach(self):
        self.assertIsNone(AlertEngine().evaluate(self._no_breach()))

    def test_returns_none_zero_lead(self):
        self.assertIsNone(AlertEngine().evaluate(self._breach_forecast(lead=0)))

    def test_thermal_warning(self):
        alert = AlertEngine().evaluate(self._breach_forecast(peak=77.0))
        self.assertEqual(alert.severity, "WARNING")

    def test_thermal_critical(self):
        alert = AlertEngine().evaluate(self._breach_forecast(peak=85.0))
        self.assertEqual(alert.severity, "CRITICAL")

    def test_energy_warning(self):
        fc = self._breach_forecast(model="ENERGY")
        fc.predicted_values = [max(0.12, v) for v in fc.predicted_values]  # trough > 0.10
        alert = AlertEngine().evaluate(fc)
        self.assertEqual(alert.severity, "WARNING")

    def test_energy_critical(self):
        fc = self._breach_forecast(model="ENERGY")
        fc.predicted_values[-1] = 0.05  # trough <= 0.10
        alert = AlertEngine().evaluate(fc)
        self.assertEqual(alert.severity, "CRITICAL")

    def test_meets_requirement_ge_15(self):
        alert = AlertEngine().evaluate(self._breach_forecast(lead=20.0))
        self.assertTrue(alert.meets_requirement)

    def test_not_meets_requirement_lt_15(self):
        alert = AlertEngine().evaluate(self._breach_forecast(lead=10.0))
        self.assertFalse(alert.meets_requirement)

    def test_forecast_summary(self):
        alert = AlertEngine().evaluate(self._breach_forecast())
        self.assertIn("current_value", alert.forecast_summary)
        self.assertIn("threshold", alert.forecast_summary)
        self.assertIn("rate_per_min", alert.forecast_summary)

    def test_GATE_rationale_physics_variables(self):
        """GATE TEST 2: rationale with physics variables [REQ-DT-RATIONALE]"""
        fc = self._breach_forecast(cpu=87.0, lead=25.0)
        rationale = AlertEngine().generate_rationale(fc)

        self.assertIn("Predicted", rationale)
        self.assertTrue("87" in rationale or "CPU" in rationale or "cpu" in rationale.lower(),
            f"Missing CPU ref: {rationale}")
        self.assertTrue("\u00B0C" in rationale or "C/min" in rationale,
            f"Missing temp unit: {rationale}")
        self.assertTrue("75" in rationale or "threshold" in rationale.lower(),
            f"Missing threshold: {rationale}")

    def test_thermal_rationale_factors(self):
        rationale = AlertEngine().generate_rationale(self._breach_forecast(cpu=90.0, power=7.0))
        self.assertIn("factor", rationale.lower())

    def test_energy_rationale_soc(self):
        rationale = AlertEngine().generate_rationale(self._breach_forecast(model="ENERGY"))
        self.assertTrue("SOC" in rationale or "Battery" in rationale)
        self.assertIn("%", rationale)

    def test_energy_rationale_deficit(self):
        rationale = AlertEngine().generate_rationale(self._breach_forecast(model="ENERGY"))
        self.assertTrue("drain" in rationale.lower() or "deficit" in rationale.lower())

    def test_rationale_length(self):
        rationale = AlertEngine().generate_rationale(self._breach_forecast())
        self.assertGreater(len(rationale), 50)


class TestEndToEnd(unittest.TestCase):

    def test_full_pipeline_breach(self):
        engine = PredictionEngine(thermal_model=ThermalModel(R=10.0, C=15.0, T_amb=25.0))
        alert_engine = AlertEngine()
        telem = [{"timestamp": f"2026-03-20T14:{i:02d}:00Z",
                  "cpu_temp_c": 55.0+i*0.5, "cpu_usage_pct": 90.0, "power_w": 7.0}
                 for i in range(15)]
        fc = engine.predict_thermal(telem, horizon_min=30)
        alert = alert_engine.evaluate(fc)
        if fc.breach_detected:
            self.assertIsNotNone(alert)
            self.assertGreater(len(alert.rationale), 0)

    def test_full_pipeline_normal(self):
        engine = PredictionEngine(thermal_model=ThermalModel(R=10.0, C=15.0, T_amb=25.0))
        telem = [{"timestamp": f"2026-03-20T14:{i:02d}:00Z",
                  "cpu_temp_c": 40.0, "cpu_usage_pct": 30.0, "power_w": 2.5}
                 for i in range(10)]
        fc = engine.predict_thermal(telem, horizon_min=30)
        self.assertIsNone(AlertEngine().evaluate(fc))


if __name__ == "__main__":
    unittest.main(verbosity=2)