"""Tests for Notion collector discovery behavior."""

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
