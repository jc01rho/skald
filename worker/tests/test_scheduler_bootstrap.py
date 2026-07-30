"""Tests for deployment-start bootstrap sync scheduling."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from skald_worker.scheduler import bootstrap_initial_full_sync


def configure_startup(monkeypatch, scheduler, *, backfill: bool, authoritative: bool) -> None:
    monkeypatch.setattr(scheduler.settings, "docs_enabled", True)
    monkeypatch.setattr(scheduler.settings, "spms_base_url", "https://spms.test")
    monkeypatch.setattr(scheduler.settings, "spec_startup_backfill_enabled", backfill)
    monkeypatch.setattr(scheduler.settings, "spec_startup_authoritative_enabled", authoritative)
    monkeypatch.setattr(scheduler.settings, "spec_backfill_max_documents", 250)
    monkeypatch.setattr(scheduler.settings, "spec_reconciliation_interval_seconds", 86400)
    monkeypatch.setattr(scheduler.settings, "spec_reconciliation_grace_seconds", 172800)
    monkeypatch.setattr(scheduler.settings, "notion_enabled", False)
    monkeypatch.setattr(scheduler.settings, "notion_token", "")
    monkeypatch.setattr(scheduler.settings, "notion_root_page_id", "")


@pytest.mark.asyncio
async def test_bootstrap_is_non_mutating_when_startup_triggers_disabled(monkeypatch):
    """Safe defaults do not inspect or mutate production data."""
    import skald_worker.scheduler as scheduler

    configure_startup(monkeypatch, scheduler, backfill=False, authoritative=False)
    skald = AsyncMock()
    docs_collector = MagicMock()
    monkeypatch.setattr(scheduler, "get_skald_client", lambda: skald)
    monkeypatch.setattr(scheduler, "get_docs_collector", lambda: docs_collector)

    await bootstrap_initial_full_sync()

    skald.count_memos.assert_not_called()
    docs_collector.sync_all.assert_not_called()
    docs_collector.sync_authoritative_all.assert_not_called()


@pytest.mark.asyncio
async def test_bootstrap_backfills_empty_projection_then_reconciles(monkeypatch):
    """Explicit startup trigger performs a bounded backfill before reconciliation."""
    import skald_worker.scheduler as scheduler

    configure_startup(monkeypatch, scheduler, backfill=True, authoritative=True)
    skald = AsyncMock()
    skald.count_memos.return_value = 0
    docs_collector = AsyncMock()
    docs_collector.sync_all.return_value = {"total": {"processed": 4, "failed": 0, "skipped": 0}}
    docs_collector.sync_authoritative_all.return_value = {
        "run_id": "run-1",
        "complete": True,
        "count": 4,
        "promotion_state": "promoted",
    }
    monkeypatch.setattr(scheduler, "get_skald_client", lambda: skald)
    monkeypatch.setattr(scheduler, "get_docs_collector", lambda: docs_collector)

    await bootstrap_initial_full_sync()

    assert skald.count_memos.await_count == 5
    docs_collector.sync_all.assert_awaited_once_with(updated_since=None, max_documents=250)
    docs_collector.sync_authoritative_all.assert_awaited_once()


@pytest.mark.asyncio
async def test_bootstrap_detects_legacy_memos_missing_canonical_projection(monkeypatch):
    """Legacy function/information memos trigger projection backfill despite nonzero totals."""
    import skald_worker.scheduler as scheduler

    configure_startup(monkeypatch, scheduler, backfill=True, authoritative=False)
    counts = {"functions": 7, "techs": 0, "information": 2, "troubleshoots": 0, "spms": 1}
    skald = AsyncMock()
    skald.count_memos.side_effect = lambda source=None: counts[source]
    docs_collector = AsyncMock()
    docs_collector.sync_all.return_value = {"total": {"processed": 9, "failed": 0, "skipped": 0}}
    monkeypatch.setattr(scheduler, "get_skald_client", lambda: skald)
    monkeypatch.setattr(scheduler, "get_docs_collector", lambda: docs_collector)

    await bootstrap_initial_full_sync()

    docs_collector.sync_all.assert_awaited_once_with(updated_since=None, max_documents=250)
    docs_collector.sync_authoritative_all.assert_not_called()


@pytest.mark.asyncio
async def test_bootstrap_skips_idempotently_when_canonical_projection_exists(monkeypatch):
    """Canonical SPMS projection without legacy canonical sources does not rerun backfill."""
    import skald_worker.scheduler as scheduler

    configure_startup(monkeypatch, scheduler, backfill=True, authoritative=False)
    counts = {"functions": 0, "techs": 3, "information": 0, "troubleshoots": 2, "spms": 5}
    skald = AsyncMock()
    skald.count_memos.side_effect = lambda source=None: counts[source]
    docs_collector = MagicMock()
    monkeypatch.setattr(scheduler, "get_skald_client", lambda: skald)
    monkeypatch.setattr(scheduler, "get_docs_collector", lambda: docs_collector)

    await bootstrap_initial_full_sync()

    docs_collector.sync_all.assert_not_called()
    docs_collector.sync_authoritative_all.assert_not_called()
