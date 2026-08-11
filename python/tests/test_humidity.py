"""Offline unit tests for RH derived from specific humidity."""

from trajectories.windfield import relative_humidity_pct


def test_relative_humidity_from_q():
    # q=0.005 kg/kg, p=850 hPa, T=10 °C → ~55.6 % (Magnus over water)
    rh = relative_humidity_pct(0.005, 850.0, 10.0)
    assert rh is not None
    assert abs(rh - 55.562) < 0.01


def test_relative_humidity_clamped():
    # Very moist air at low T saturates → clamp to 100
    rh = relative_humidity_pct(0.02, 1000.0, 0.0)
    assert rh == 100.0


def test_relative_humidity_nan_inputs():
    assert relative_humidity_pct(float("nan"), 850.0, 10.0) is None
    assert relative_humidity_pct(0.005, float("nan"), 10.0) is None
    assert relative_humidity_pct(0.005, 850.0, float("nan")) is None
    assert relative_humidity_pct(0.005, 0.0, 10.0) is None
