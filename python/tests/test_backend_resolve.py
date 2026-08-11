"""Unit tests for OM/HTTP backend resolution (no network / data required)."""

from __future__ import annotations

from pathlib import Path

import pytest

from trajectories import config


@pytest.fixture(autouse=True)
def _restore_config():
    prev_root = config.OM_ROOT
    prev_backend = config.BACKEND
    yield
    config.OM_ROOT = prev_root
    config.BACKEND = prev_backend


def test_backend_http_always():
    config.set_backend("http")
    config.set_om_root("/open-meteo")
    assert config.resolve_backend("icon_d2", warn=False) == "http"


def test_backend_om_requires_dataset(monkeypatch, tmp_path: Path):
    config.set_backend("om")
    config.set_om_root(tmp_path)  # no dwd_icon_* underneath
    monkeypatch.setattr(config, "omfiles_available", lambda: True)
    with pytest.raises(RuntimeError, match="dataset not found"):
        config.resolve_backend("icon_d2", warn=False)


def test_backend_om_requires_omfiles(monkeypatch, tmp_path: Path):
    ds = tmp_path / "dwd_icon_d2"
    ds.mkdir()
    config.set_backend("om")
    config.set_om_root(tmp_path)
    monkeypatch.setattr(config, "omfiles_available", lambda: False)
    with pytest.raises(RuntimeError, match="omfiles"):
        config.resolve_backend("icon_d2", warn=False)


def test_backend_auto_prefers_om_when_ready(monkeypatch, tmp_path: Path):
    (tmp_path / "dwd_icon_d2").mkdir()
    config.set_backend("auto")
    config.set_om_root(tmp_path)
    monkeypatch.setattr(config, "omfiles_available", lambda: True)
    assert config.resolve_backend("icon_d2", warn=False) == "om"


def test_backend_auto_falls_back_without_omfiles(monkeypatch, tmp_path: Path):
    (tmp_path / "dwd_icon_d2").mkdir()
    config.set_backend("auto")
    config.set_om_root(tmp_path)
    monkeypatch.setattr(config, "omfiles_available", lambda: False)
    assert config.resolve_backend("icon_d2", warn=False) == "http"


def test_backend_auto_falls_back_without_root():
    config.set_backend("auto")
    config.OM_ROOT = None
    assert config.resolve_backend("icon_eu", warn=False) == "http"


def test_set_backend_rejects_unknown():
    with pytest.raises(ValueError):
        config.set_backend("s3")


def test_empty_om_root_env_disables(monkeypatch):
    monkeypatch.setenv("TRAJECTORIES_OM_ROOT", "")
    assert config._om_root_from_env() is None
