"""Unit tests for compute_point_wind (mocked WindField; no network)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from trajectories.compute import compute_point_wind


def _fake_wf(*, u=1.2, v=-1.5, w=0.02, z=858.0, elev=308.0, error=None):
    wf = MagicMock()
    wf.__enter__.return_value = wf
    wf.__exit__.return_value = False
    if error:
        wf.wind_at.return_value = {"error": error}
    else:
        sample = {"u": u, "v": v, "zAmsl": z, "met": None}
        if w is not None:
            sample["w"] = w
        wf.wind_at.return_value = sample
    wf.elevation_at.return_value = elev
    return wf


@patch("trajectories.compute.WindField.detect_w_variable", return_value="wind_w")
@patch("trajectories.compute.WindField")
def test_point_wind_direction_and_w(mock_cls, _detect):
    mock_cls.return_value = _fake_wf()
    out = compute_point_wind(
        lat=47.23,
        lon=15.82,
        time="2026-08-02T11:00:00Z",
        models="icon_eu",
        height_m=550,
        height_ref="agl",
        backend="http",
    )
    assert out["height_reference"] == "agl"
    assert out["height_m"] == 550.0
    m = out["models"][0]
    assert m["model"] == "icon_eu"
    assert m["wind_u_ms"] == 1.2
    assert m["wind_v_ms"] == -1.5
    assert m["wind_w_ms"] == 0.02
    assert m["wind_speed_kmh"] == 6.9
    assert m["wind_direction_deg"] == 321
    assert m["z_amsl_m"] == 858
    assert m["terrain_m"] == 308
    # include_w should be True when prefix detected
    kwargs = mock_cls.return_value.init.call_args.kwargs
    assert kwargs.get("include_w") is True
    wa = mock_cls.return_value.wind_at.call_args.args
    assert wa[2] == {"type": "height", "mode": "agl", "value": 550}
    assert wa[3] == pytest.approx(1_785_668_400_000.0)  # 2026-08-02T11:00Z ms


@patch("trajectories.compute.WindField.detect_w_variable", return_value=None)
@patch("trajectories.compute.WindField")
def test_point_wind_w_null_when_unavailable(mock_cls, _detect):
    mock_cls.return_value = _fake_wf(w=None)
    out = compute_point_wind(
        lat=47.23,
        lon=15.82,
        time="2026-08-02T11:00:00Z",
        models=["icon_d2"],
        height_m=500,
        height_ref="amsl",
        backend="http",
    )
    assert out["models"][0]["wind_w_ms"] is None
    kwargs = mock_cls.return_value.init.call_args.kwargs
    assert kwargs.get("include_w") is False


@patch("trajectories.compute.WindField.detect_w_variable", return_value=None)
@patch("trajectories.compute.WindField")
def test_point_wind_partial_multi_model(mock_cls, _detect):
    good = _fake_wf()
    calls = {"n": 0}

    def factory(*_a, **_k):
        calls["n"] += 1
        if calls["n"] == 1:
            return good
        raise RuntimeError("fetch failed")

    mock_cls.side_effect = factory
    out = compute_point_wind(
        lat=47.23,
        lon=15.82,
        time="2026-08-02T11:00:00Z",
        models=["icon_eu", "icon_d2"],
        height_m=550,
        height_ref="agl",
        backend="http",
    )
    assert len(out["models"]) == 2
    assert out["models"][0].get("error") is not True
    assert out["models"][1]["error"] is True
    assert "fetch failed" in out["models"][1]["reason"]


@patch("trajectories.compute.WindField.detect_w_variable", return_value=None)
@patch("trajectories.compute.WindField")
def test_point_wind_all_fail(mock_cls, _detect):
    mock_cls.return_value = _fake_wf(error="Fehlende Winddaten")
    with pytest.raises(ValueError, match="Fehlende Winddaten"):
        compute_point_wind(
            lat=47.23,
            lon=15.82,
            time="2026-08-02T11:00:00Z",
            models="icon_eu",
            height_m=550,
            height_ref="agl",
            backend="http",
        )
