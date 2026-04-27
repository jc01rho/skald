"""Tests for initial bootstrap sync scheduling."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from skald_worker.scheduler import bootstrap_initial_full_sync


@pytest.mark.asyncio
async def test_bootstrap_initial_full_sync_runs_full_spms_and_notion(monkeypatch):
    """Fresh DB sources trigger full SPMS sync and forced full Notion sync."""
    import skald_worker.scheduler as scheduler

    monkeypatch.setattr(scheduler.settings, "docs_enabled", True)
    monkeypatch.setattr(scheduler.settings, "spms_base_url", "https://spms.test")
    monkeypatch.setattr(scheduler.settings, "notion_enabled", True)
    monkeypatch.setattr(scheduler.settings, "notion_token", "secret_notion")
    monkeypatch.setattr(scheduler.settings, "notion_root_page_id", "root-page")

    skald = AsyncMock()
    skald.count_memos.return_value = 0
    docs_collector = AsyncMock()
    docs_collector.sync_all.return_value = {"total": {"processed": 4, "failed": 0, "skipped": 0}}
    notion_collector = AsyncMock()
    notion_collector.sync_all.return_value = {"processed": 2, "failed": 0}

    monkeypatch.setattr(scheduler, "get_skald_client", lambda: skald)
    monkeypatch.setattr(scheduler, "get_docs_collector", lambda: docs_collector)
    monkeypatch.setattr(scheduler, "get_notion_collector", lambda: notion_collector)

    await bootstrap_initial_full_sync()

    assert skald.count_memos.await_count == 5
    docs_collector.sync_all.assert_awaited_once_with(updated_since=None)
    notion_collector.sync_all.assert_awaited_once_with(force_full=True)


@pytest.mark.asyncio
async def test_bootstrap_initial_full_sync_skips_existing_sources(monkeypatch):
    """Existing source data prevents startup from rerunning expensive full syncs."""
    import skald_worker.scheduler as scheduler

    monkeypatch.setattr(scheduler.settings, "docs_enabled", True)
    monkeypatch.setattr(scheduler.settings, "spms_base_url", "https://spms.test")
    monkeypatch.setattr(scheduler.settings, "notion_enabled", True)
    monkeypatch.setattr(scheduler.settings, "notion_token", "secret_notion")
    monkeypatch.setattr(scheduler.settings, "notion_root_page_id", "root-page")

    skald = AsyncMock()
    skald.count_memos.return_value = 1
    docs_collector = MagicMock()
    notion_collector = MagicMock()

    monkeypatch.setattr(scheduler, "get_skald_client", lambda: skald)
    monkeypatch.setattr(scheduler, "get_docs_collector", lambda: docs_collector)
    monkeypatch.setattr(scheduler, "get_notion_collector", lambda: notion_collector)

    await bootstrap_initial_full_sync()

    docs_collector.sync_all.assert_not_called()
    notion_collector.sync_all.assert_not_called()


@pytest.mark.asyncio
async def test_bootstrap_initial_full_sync_runs_notion_when_spms_fails(monkeypatch):
    """SPMS bootstrap failures must not prevent Notion bootstrap."""
    import skald_worker.scheduler as scheduler

    monkeypatch.setattr(scheduler.settings, "docs_enabled", True)
    monkeypatch.setattr(scheduler.settings, "spms_base_url", "https://spms.test")
    monkeypatch.setattr(scheduler.settings, "notion_enabled", True)
    monkeypatch.setattr(scheduler.settings, "notion_token", "secret_notion")
    monkeypatch.setattr(scheduler.settings, "notion_root_page_id", "root-page")

    skald = AsyncMock()
    skald.count_memos.return_value = 0
    docs_collector = AsyncMock()
    docs_collector.sync_all.side_effect = RuntimeError("spms failed")
    notion_collector = AsyncMock()
    notion_collector.sync_all.return_value = {"processed": 1, "failed": 0}

    monkeypatch.setattr(scheduler, "get_skald_client", lambda: skald)
    monkeypatch.setattr(scheduler, "get_docs_collector", lambda: docs_collector)
    monkeypatch.setattr(scheduler, "get_notion_collector", lambda: notion_collector)

    await bootstrap_initial_full_sync()

    docs_collector.sync_all.assert_awaited_once_with(updated_since=None)
    notion_collector.sync_all.assert_awaited_once_with(force_full=True)
