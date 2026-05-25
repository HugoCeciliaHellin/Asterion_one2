"""
Unit tests for the digital twin prediction engine.
Tests the thermal and energy models, breach detection, and 15-minute early warning calculations.
"""

import pytest
import numpy as np
from twin.twin_engine import ThermalModel, EnergyModel, PredictionEngine, Forecast
from twin import config

# ThermalModel Unit Tests

class TestThermalModel:

    def test_constant_temperature_at_equilibrium(self):
        """When Q_in exactly balances Q_out, temperature stays constant."""
        model = ThermalModel(R=10.0, C=15.0, T_amb=25.0)
        # At equilibrium: Q_in = (T - T_amb) / R = (62.5 - 25) / 10.0 = 3.75W
        T = model.predict(
            current_temp=62.5,
            power_profile=np.array([3.75] * 30),
            horizon_steps=30,
            dt=60
        )
        # Temperature should stay near 62.5
        assert abs(T[-1] - 62.5) < 0.5, f"Expected ~62.5, got {T[-1]}"

    def test_temperature_rises_with_high_power(self):
        """High power input drives temperature up."""
        model = ThermalModel(R=10.0, C=15.0, T_amb=25.0)
        T = model.predict(
            current_temp=60.0,
            power_profile=np.array([25.0] * 30),  # High power
            horizon_steps=30,
            dt=60
        )
        assert T[-1] > T[0], f"Temperature should rise: {T[0]} -> {T[-1]}"
        assert T[-1] > 60.0

    def test_temperature_drops_with_zero_power(self):
        model = ThermalModel(R=10.0, C=15.0, T_amb=25.0)
        T = model.predict(
            current_temp=70.0,
            power_profile=np.array([0.0] * 30),
            horizon_steps=30,
            dt=60
        )
        assert T[-1] < T[0], f"Temperature should drop: {T[0]} -> {T[-1]}"
        assert T[-1] > 25.0, "Should not drop below ambient instantly"

    def test_monotonic_rise_with_constant_high_power(self):
        model = ThermalModel(R=10.0, C=15.0, T_amb=25.0)
        T = model.predict(
            current_temp=50.0,
            power_profile=np.array([30.0] * 30),
            horizon_steps=30,
            dt=60
        )
        for i in range(1, len(T)):
            assert T[i] >= T[i - 1], f"Non-monotonic at step {i}"

    def test_first_step_equals_current_temp(self):
        """First value of prediction equals the current temperature."""
        model = ThermalModel(R=10.0, C=15.0, T_amb=25.0)
        T = model.predict(
            current_temp=65.3,
            power_profile=np.array([10.0] * 5),
            horizon_steps=5,
            dt=60
        )
        assert T[0] == 65.3

    def test_custom_parameters(self):
        """Model uses custom R, C, T_amb when provided."""
        model = ThermalModel(R=5.0, C=100.0, T_amb=20.0)
        assert model.R == 5.0
        assert model.C == 100.0
        assert model.T_amb == 20.0

    def test_short_power_profile_extends(self):
        model = ThermalModel(R=10.0, C=15.0, T_amb=25.0)
        T = model.predict(
            current_temp=60.0,
            power_profile=np.array([20.0]),  # Only 1 value
            horizon_steps=10,
            dt=60
        )
        assert len(T) == 10
        # Should still produce valid trajectory
        assert all(np.isfinite(T))

# EnergyModel Unit Tests

class TestEnergyModel:

    def test_soc_depletes_under_high_load(self):
        model = EnergyModel(capacity_wh=50.0, charge_power_w=5.0)
        SOC = model.predict(
            current_soc=0.8,
            load_profile_w=np.array([10.0] * 30),  # 10W load > 5W charge
            horizon_steps=30,
            dt=60
        )
        assert SOC[-1] < SOC[0], f"SOC should deplete: {SOC[0]} -> {SOC[-1]}"

    def test_soc_charges_under_low_load(self):
        model = EnergyModel(capacity_wh=50.0, charge_power_w=10.0)
        SOC = model.predict(
            current_soc=0.5,
            load_profile_w=np.array([3.0] * 30),  # 3W < 10W charge
            horizon_steps=30,
            dt=60
        )
        assert SOC[-1] > SOC[0]

    def test_soc_clamped_to_zero(self):
        model = EnergyModel(capacity_wh=10.0, charge_power_w=0.0)
        SOC = model.predict(
            current_soc=0.05,
            load_profile_w=np.array([50.0] * 30),  # Massive drain
            horizon_steps=30,
            dt=60
        )
        assert all(s >= 0.0 for s in SOC)

    def test_soc_clamped_to_one(self):
        model = EnergyModel(capacity_wh=10.0, charge_power_w=50.0)
        SOC = model.predict(
            current_soc=0.95,
            load_profile_w=np.array([0.0] * 30),  # No load, lots of charge
            horizon_steps=30,
            dt=60
        )
        assert all(s <= 1.0 for s in SOC)

    def test_first_step_equals_current_soc(self):
        model = EnergyModel()
        SOC = model.predict(0.73, np.array([5.0] * 5), 5, 60)
        assert SOC[0] == 0.73


# PredictionEngine Integration Tests

class TestPredictionEngine:

    def make_thermal_telemetry(self, cpu_temp=65.0, cpu_usage=80.0, power=4.5, count=10):
        """Generate synthetic thermal telemetry window."""
        return [
            {
                "timestamp": f"2026-03-20T14:{i:02d}:00Z",
                "cpu_temp_c": cpu_temp + i * 0.1,
                "cpu_usage_pct": cpu_usage,
                "power_w": power,
            }
            for i in range(count)
        ]

    def make_power_telemetry(self, soc=0.7, power=4.5, count=10):
        return [
            {
                "timestamp": f"2026-03-20T14:{i:02d}:00Z",
                "battery_soc": soc - i * 0.005,
                "power_w": power,
                "current_ma": power * 1000 / 5.0,
            }
            for i in range(count)
        ]

    def test_predict_thermal_returns_forecast(self):
        engine = PredictionEngine()
        telem = self.make_thermal_telemetry()
        fc = engine.predict_thermal(telem)

        assert isinstance(fc, Forecast)
        assert fc.model_type == "THERMAL"
        assert fc.horizon_min == config.HORIZON_MIN
        assert len(fc.predicted_values) == config.HORIZON_STEPS
        assert len(fc.timestamps) == config.HORIZON_STEPS
        assert fc.current_value > 0

    def test_predict_thermal_detects_breach(self):
        engine = PredictionEngine(
            thermal_model=ThermalModel(R=10.0, C=50.0, T_amb=25.0)
        )
        # Start near threshold with high power
        telem = self.make_thermal_telemetry(cpu_temp=70.0, cpu_usage=95.0, power=8.0)
        fc = engine.predict_thermal(telem, horizon_min=30)

        assert fc.breach_detected is True
        assert fc.breach_index is not None
        assert fc.breach_time is not None
        assert fc.lead_time_min is not None
        assert fc.lead_time_min > 0

    def test_predict_thermal_no_breach_normal_conditions(self):
        engine = PredictionEngine(
            thermal_model=ThermalModel(R=10.0, C=50.0, T_amb=25.0)
        )
        # Low temp, low power
        telem = self.make_thermal_telemetry(cpu_temp=40.0, cpu_usage=30.0, power=2.0)
        fc = engine.predict_thermal(telem, horizon_min=30)

        assert fc.breach_detected is False
        assert fc.breach_index is None
        assert fc.lead_time_min is None

    def test_predict_thermal_empty_telemetry(self):
        engine = PredictionEngine()
        fc = engine.predict_thermal([])

        assert isinstance(fc, Forecast)
        assert fc.model_type == "THERMAL"
        assert fc.breach_detected is False

    def test_predict_energy_detects_depletion(self):
        engine = PredictionEngine(
            energy_model=EnergyModel(capacity_wh=15.0, charge_power_w=2.0)
        )
        telem = self.make_power_telemetry(soc=0.25, power=8.0)
        fc = engine.predict_energy(telem, horizon_min=30)

        assert fc.breach_detected is True
        assert fc.lead_time_min is not None
        assert fc.lead_time_min > 0

    def test_predict_energy_no_breach_healthy_battery(self):
        engine = PredictionEngine(
            energy_model=EnergyModel(capacity_wh=50.0, charge_power_w=10.0)
        )
        telem = self.make_power_telemetry(soc=0.9, power=3.0)
        fc = engine.predict_energy(telem, horizon_min=30)

        assert fc.breach_detected is False


    def test_gate_thermal_lead_time_ge_15_min(self):
        engine = PredictionEngine(
            thermal_model=ThermalModel(R=10.0, C=50.0, T_amb=25.0)
        )

        telem = self.make_thermal_telemetry(
            cpu_temp=40.0, cpu_usage=70.0, power=5.5, count=15
        )
        fc = engine.predict_thermal(telem, horizon_min=30)

        assert fc.breach_detected is True, (
            f"Expected breach with high power. Final temp: {fc.predicted_values[-1]:.1f}°C"
        )
        assert fc.lead_time_min is not None
        assert fc.lead_time_min >= 15.0, (
            f"REQ-DT-EARLY-15m FAILED: lead_time={fc.lead_time_min:.1f}min < 15min"
        )

        print(f"\n  ✓ GATE TEST 1: lead_time={fc.lead_time_min:.1f}min >= 15min [REQ-DT-EARLY-15m]")

    def test_rate_per_min_is_positive_for_rising_temp(self):
        engine = PredictionEngine(
            thermal_model=ThermalModel(R=10.0, C=50.0, T_amb=25.0)
        )
        telem = self.make_thermal_telemetry(cpu_temp=60.0, cpu_usage=85.0, power=6.0)
        fc = engine.predict_thermal(telem, horizon_min=30)

        assert fc.rate_per_min > 0, f"Rate should be positive, got {fc.rate_per_min}"

    def test_metadata_includes_model_params(self):
        engine = PredictionEngine(
            thermal_model=ThermalModel(R=3.0, C=60.0, T_amb=22.0)
        )
        telem = self.make_thermal_telemetry()
        fc = engine.predict_thermal(telem)

        assert fc.metadata["R"] == 3.0
        assert fc.metadata["C"] == 60.0
        assert fc.metadata["T_amb"] == 22.0