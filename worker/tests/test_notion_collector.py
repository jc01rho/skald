"""Tests for Notion collector discovery behavior."""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from skald_worker.collectors.notion_collector import NotionCollector


class TestNotionCollector:
    """Test child page discovery for Notion collector."""

    @pytest.mark.asyncio
    async def test_discover_child_pages_includes_child_database_entries(self, monkeypatch: pytest.MonkeyPatch) -> None:
        collector = NotionCollector(
            token="test-token",
            root_page_id="root-page",
            max_depth=3,
            max_pages=10,
        )

        async def fake_fetch_all_block_children(block_id: str) -> list[dict]:
            if block_id == "root-page":
                return [
                    {
                        "id": "database-1",
                        "type": "child_database",
                        "child_database": {"title": "Knowledge Base"},
                        "has_children": False,
                    }
                ]
            if block_id == "db-page-1":
                return []
            return []

        async def fake_fetch_all_database_entries(database_id: str, max_results: int | None = None) -> list[dict]:
            assert database_id == "database-1"
            assert max_results == 10
            return [
                {
                    "id": "db-page-1",
                    "last_edited_time": "2026-04-10T00:00:00.000Z",
                    "properties": {
                        "Name": {
                            "type": "title",
                            "title": [{"plain_text": "Collected from Database"}],
                        }
                    },
                }
            ]

        monkeypatch.setattr(collector, "fetch_all_block_children", fake_fetch_all_block_children)
        monkeypatch.setattr(collector, "fetch_all_database_entries", fake_fetch_all_database_entries)

        discovered = await collector.discover_child_pages("root-page", current_depth=1)

        assert discovered == [
            {
                "id": "db-page-1",
                "title": "Collected from Database",
                "last_edited_time": "2026-04-10T00:00:00.000Z",
                "depth": 2,
                "parent_id": "root-page",
            }
        ]

    @pytest.mark.asyncio
    async def test_discover_child_pages_deduplicates_database_and_child_page_hits(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        collector = NotionCollector(
            token="test-token",
            root_page_id="root-page",
            max_depth=3,
            max_pages=10,
        )

        async def fake_fetch_all_block_children(block_id: str) -> list[dict]:
            if block_id == "root-page":
                return [
                    {
                        "id": "shared-page",
                        "type": "child_page",
                        "child_page": {"title": "Shared"},
                    },
                    {
                        "id": "database-1",
                        "type": "child_database",
                        "child_database": {"title": "Knowledge Base"},
                    },
                ]
            return []

        async def fake_fetch_page(page_id: str) -> dict:
            assert page_id == "shared-page"
            return {
                "id": "shared-page",
                "last_edited_time": "2026-04-10T00:00:00.000Z",
                "properties": {
                    "title": {
                        "type": "title",
                        "title": [{"plain_text": "Shared"}],
                    }
                },
            }

        async def fake_fetch_all_database_entries(database_id: str, max_results: int | None = None) -> list[dict]:
            assert database_id == "database-1"
            return [
                {
                    "id": "shared-page",
                    "last_edited_time": "2026-04-10T00:00:00.000Z",
                    "properties": {
                        "Name": {
                            "type": "title",
                            "title": [{"plain_text": "Shared"}],
                        }
                    },
                }
            ]

        monkeypatch.setattr(collector, "fetch_all_block_children", fake_fetch_all_block_children)
        monkeypatch.setattr(collector, "fetch_page", fake_fetch_page)
        monkeypatch.setattr(collector, "fetch_all_database_entries", fake_fetch_all_database_entries)

        discovered = await collector.discover_child_pages("root-page", current_depth=1)

        assert len(discovered) == 1
        assert discovered[0]["id"] == "shared-page"

    @pytest.mark.asyncio
    async def test_sync_page_skips_empty_markdown_content(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        collector = NotionCollector(
            token="test-token",
            root_page_id="root-page",
        )

        async def fake_fetch_page(page_id: str) -> dict:
            assert page_id == "empty-page"
            return {
                "id": page_id,
                "last_edited_time": "2026-04-10T00:00:00.000Z",
                "properties": {
                    "Name": {
                        "type": "title",
                        "title": [{"plain_text": "Empty page"}],
                    }
                },
            }

        async def fake_fetch_all_block_children(page_id: str) -> list[dict]:
            assert page_id == "empty-page"
            return []

        class UnexpectedClient:
            async def upsert_memo(self, **kwargs):  # pragma: no cover - should never run
                raise AssertionError("upsert_memo should not be called for empty pages")

        monkeypatch.setattr(collector, "fetch_page", fake_fetch_page)
        monkeypatch.setattr(collector, "fetch_all_block_children", fake_fetch_all_block_children)
        monkeypatch.setattr(
            "skald_worker.collectors.notion_collector.get_skald_client",
            lambda: UnexpectedClient(),
        )

        status, result = await collector._sync_page("empty-page")

        assert status == "skipped"
        assert result is None

    @pytest.mark.asyncio
    async def test_sync_page_skips_short_non_empty_markdown(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        collector = NotionCollector(
            token="test-token",
            root_page_id="root-page",
        )

        short_content = "짧은 메모"

        async def fake_fetch_page(page_id: str) -> dict:
            assert page_id == "short-page"
            return {
                "id": page_id,
                "last_edited_time": "2026-04-10T00:00:00.000Z",
                "properties": {
                    "Name": {
                        "type": "title",
                        "title": [{"plain_text": "Short page"}],
                    }
                },
            }

        async def fake_fetch_all_block_children(page_id: str) -> list[dict]:
            assert page_id == "short-page"
            return [{"type": "paragraph", "paragraph": {"rich_text": []}}]

        class UnexpectedClient:
            async def upsert_memo(self, **kwargs):  # pragma: no cover - should never run
                raise AssertionError("upsert_memo should not be called for short pages")

        monkeypatch.setattr(collector, "fetch_page", fake_fetch_page)
        monkeypatch.setattr(collector, "fetch_all_block_children", fake_fetch_all_block_children)
        monkeypatch.setattr(
            "skald_worker.collectors.notion_collector.blocks_to_markdown",
            lambda _blocks: short_content,
        )
        monkeypatch.setattr(
            "skald_worker.collectors.notion_collector.get_skald_client",
            lambda: UnexpectedClient(),
        )

        status, result = await collector._sync_page("short-page")

        assert status == "skipped"
        assert result is None

    @pytest.mark.asyncio
    async def test_sync_page_processes_markdown_at_300_chars(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        collector = NotionCollector(
            token="test-token",
            root_page_id="root-page",
        )

        exact_threshold_content = "가" * 300

        async def fake_fetch_page(page_id: str) -> dict:
            assert page_id == "threshold-page"
            return {
                "id": page_id,
                "last_edited_time": "2026-04-10T00:00:00.000Z",
                "properties": {
                    "Name": {
                        "type": "title",
                        "title": [{"plain_text": "Threshold page"}],
                    }
                },
            }

        async def fake_fetch_all_block_children(page_id: str) -> list[dict]:
            assert page_id == "threshold-page"
            return [{"type": "paragraph", "paragraph": {"rich_text": []}}]

        class RecordingClient:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            async def upsert_memo(self, **kwargs):
                self.calls.append(kwargs)
                return {"memo_uuid": "memo-short"}

        client = RecordingClient()

        monkeypatch.setattr(collector, "fetch_page", fake_fetch_page)
        monkeypatch.setattr(collector, "fetch_all_block_children", fake_fetch_all_block_children)
        monkeypatch.setattr(
            "skald_worker.collectors.notion_collector.blocks_to_markdown",
            lambda _blocks: exact_threshold_content,
        )
        monkeypatch.setattr(
            "skald_worker.collectors.notion_collector.get_skald_client",
            lambda: client,
        )

        status, result = await collector._sync_page("threshold-page")

        assert status == "processed"
        assert result == {"memo_uuid": "memo-short"}
        assert len(client.calls) == 1
        assert client.calls[0]["content"] == exact_threshold_content

    @pytest.mark.asyncio
    async def test_sync_all_force_full_ignores_last_sync_time(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        collector = NotionCollector(
            token="test-token",
            root_page_id="root-page",
        )

        seen_cutoff_times = []

        class SyncManager:
            def record_sync_start(self, source: str) -> None:
                assert source == "notion"

            def get_cursor(self, source: str):
                assert source == "notion"
                return None

            def get_last_sync_time(self, source: str):
                assert source == "notion"
                return "should-not-be-used"

            def record_sync_success(self, source: str, **kwargs) -> None:
                assert source == "notion"
                assert kwargs["cursor"].endswith("Z")

            def record_sync_failure(self, source: str, error: str) -> None:  # pragma: no cover
                raise AssertionError(error)

        async def fake_sync_page(page_id: str, **kwargs):
            seen_cutoff_times.append(kwargs.get("cutoff_time"))
            return "processed", {"page_id": page_id}

        monkeypatch.setattr(
            "skald_worker.collectors.notion_collector.get_sync_state_manager",
            lambda: SyncManager(),
        )
        monkeypatch.setattr(collector, "_sync_page", fake_sync_page)
        monkeypatch.setattr(collector, "discover_child_pages", AsyncMock(return_value=[]))

        result = await collector.sync_all(force_full=True)

        assert result == {"processed": 1, "failed": 0}
        assert seen_cutoff_times == [None]

    @pytest.mark.asyncio
    async def test_incremental_saved_cursor_compares_with_notion_timestamp(self, monkeypatch):
        collector = NotionCollector(token="test-token", root_page_id="root-page")
        sync_manager = MagicMock()
        sync_manager.get_cursor.return_value = "2026-08-02T01:00:00.000Z"
        monkeypatch.setattr(
            "skald_worker.collectors.notion_collector.get_sync_state_manager",
            lambda: sync_manager,
        )
        monkeypatch.setattr(collector, "_sync_page", AsyncMock(return_value=("skipped", None)))
        monkeypatch.setattr(collector, "discover_child_pages", AsyncMock(return_value=[]))

        result = await collector.sync_all()

        assert result == {"processed": 0, "failed": 0}
        cutoff = collector._sync_page.await_args.kwargs["cutoff_time"]
        assert cutoff == datetime(2026, 8, 2, 1, 0, 0)

    @pytest.mark.asyncio
    async def test_sync_all_failed_page_records_failure_without_advancing_success(self, monkeypatch):
        collector = NotionCollector(token="test-token", root_page_id="root-page")
        sync_manager = MagicMock()
        sync_manager.get_last_sync_time.return_value = None
        monkeypatch.setattr(
            "skald_worker.collectors.notion_collector.get_sync_state_manager",
            lambda: sync_manager,
        )
        monkeypatch.setattr(collector, "_sync_page", AsyncMock(return_value=("failed", None)))
        monkeypatch.setattr(collector, "discover_child_pages", AsyncMock(return_value=[]))

        result = await collector.sync_all()

        assert result == {"processed": 0, "failed": 1}
        sync_manager.record_sync_failure.assert_called_once_with(
            "notion",
            "Notion sync completed with 1 failed pages",
        )
        sync_manager.record_sync_success.assert_not_called()

    @pytest.mark.asyncio
    async def test_sync_all_discovery_failure_records_failure_and_propagates(self, monkeypatch):
        collector = NotionCollector(token="test-token", root_page_id="root-page")
        sync_manager = MagicMock()
        sync_manager.get_last_sync_time.return_value = None
        monkeypatch.setattr(
            "skald_worker.collectors.notion_collector.get_sync_state_manager",
            lambda: sync_manager,
        )
        monkeypatch.setattr(collector, "_sync_page", AsyncMock(return_value=("processed", {})))
        monkeypatch.setattr(
            collector,
            "discover_child_pages",
            AsyncMock(side_effect=RuntimeError("Notion pagination exhausted")),
        )

        with pytest.raises(RuntimeError, match="Notion pagination exhausted"):
            await collector.sync_all()

        sync_manager.record_sync_failure.assert_called_once_with("notion", "Notion pagination exhausted")
        sync_manager.record_sync_success.assert_not_called()
