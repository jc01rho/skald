"""Tests for worker application lifespan behavior."""

import asyncio
from unittest.mock import MagicMock

import pytest

from skald_worker.main import lifespan


@pytest.mark.asyncio
async def test_lifespan_stops_scheduler_when_app_raises(monkeypatch):
    """Scheduler shutdown should happen even if the app exits with an error."""
    import skald_worker.main as main

    start_scheduler = MagicMock()
    stop_scheduler = MagicMock()

    async def never_finishes():
        await asyncio.sleep(60)

    monkeypatch.setattr(main, "start_scheduler", start_scheduler)
    monkeypatch.setattr(main, "stop_scheduler", stop_scheduler)
    monkeypatch.setattr(main, "bootstrap_initial_full_sync", never_finishes)

    manager = lifespan(MagicMock())
    await manager.__aenter__()

    try:
        raise RuntimeError("boom")
    except RuntimeError as exc:
        result = await manager.__aexit__(type(exc), exc, exc.__traceback__)

    start_scheduler.assert_called_once()
    stop_scheduler.assert_called_once()
    assert result is False
