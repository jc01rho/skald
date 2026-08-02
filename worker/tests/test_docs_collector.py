"""Current SPMS API behavior tests for the docs collector."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from skald_worker.collectors.docs_collector import DocsCollector, get_docs_collector, html_to_markdown


@pytest.fixture
def collector():
    return DocsCollector(base_url="https://spms.test", api_key="test-api-key")


def response(payload):
    result = MagicMock()
    result.json.return_value = payload
    return result


class TestHtmlToMarkdown:
    def test_removes_non_content_elements(self):
        result = html_to_markdown(
            "<nav>Navigation</nav><main><p>Hello <strong>world</strong></p></main>"
            "<script>alert('bad')</script><footer>Footer</footer>"
        )

        assert "Hello" in result
        assert "world" in result
        assert "Navigation" not in result
        assert "alert" not in result
        assert "Footer" not in result


class TestSpmsEndpoints:
    @pytest.mark.asyncio
    async def test_fetch_functions_uses_spms_pagination_and_update_filter(self, collector):
        payload = [{"id": 17, "function_id": "SVR-17", "Name": "Function 17"}]
        with patch.object(
            collector, "_request_with_retry", new_callable=AsyncMock, return_value=response(payload)
        ) as request:
            result = await collector.fetch_functions(
                page=3,
                page_size=25,
                updated_since="2026-08-01T00:00:00.000Z",
            )

        assert result == payload
        request.assert_awaited_once_with(
            "GET",
            "/api/functions",
            params={
                "status": "completed",
                "page": 3,
                "size": 25,
                "updatedSince": "2026-08-01T00:00:00.000Z",
            },
        )

    @pytest.mark.asyncio
    async def test_fetch_tech_page_uses_current_endpoint(self, collector):
        with patch.object(
            collector, "_request_with_retry", new_callable=AsyncMock, return_value=response([])
        ) as request:
            assert await collector.fetch_techs(page=2, page_size=10) == []

        request.assert_awaited_once_with("GET", "/api/techs", params={"page": 2, "size": 10})

    @pytest.mark.asyncio
    async def test_fetch_page_transport_failure_is_not_terminal_empty_page(self, collector):
        with (
            patch.object(
                collector,
                "_request_with_retry",
                new_callable=AsyncMock,
                side_effect=httpx.ConnectError("SPMS unavailable"),
            ),
            pytest.raises(httpx.ConnectError, match="SPMS unavailable"),
        ):
            await collector.fetch_information()

    @pytest.mark.asyncio
    async def test_fetch_function_detail_uses_function_locator(self, collector):
        payload = {"id": 17, "function_id": "SVR-17", "related_info": []}
        with patch.object(
            collector, "_request_with_retry", new_callable=AsyncMock, return_value=response(payload)
        ) as request:
            assert await collector.fetch_function_detail("SVR-17") == payload

        request.assert_awaited_once_with("GET", "/api/functions/SVR-17")

    @pytest.mark.asyncio
    async def test_fetch_detail_transport_failure_is_not_masked(self, collector):
        with (
            patch.object(
                collector,
                "_request_with_retry",
                new_callable=AsyncMock,
                side_effect=httpx.ConnectError("SPMS unavailable"),
            ),
            pytest.raises(httpx.ConnectError, match="SPMS unavailable"),
        ):
            await collector.fetch_tech_detail(17)


class TestSpmsSync:
    @pytest.mark.asyncio
    async def test_sync_item_fetches_function_detail_and_publishes_revision(self, collector):
        list_item = {"id": 17, "function_id": "SVR-17", "Name": "Function 17"}
        detail = {
            "id": 17,
            "function_id": "SVR-17",
            "name": "Function 17",
            "status": "completed",
            "date_updated": "2026-08-01T00:00:00.000Z",
            "detail": "Current detail",
            "related_info": [],
            "parent": None,
            "product": {"id": "sparrow"},
            "actions": [],
            "relatedFunctions": [],
            "relatedInformation": [],
            "project_permission": [],
            "system_permission": [],
        }
        publish_receipt = MagicMock()
        skald = AsyncMock()
        skald.stage_and_publish_spec_revision.return_value = publish_receipt

        with (
            patch.object(collector, "fetch_function_detail", new_callable=AsyncMock, return_value=detail) as fetch,
            patch("skald_worker.collectors.docs_collector.get_skald_client", return_value=skald),
            patch("skald_worker.collectors.docs_collector.settings.skald_project_id", "project-1"),
        ):
            result = await collector.sync_item(list_item, "functions")

        assert result is publish_receipt
        fetch.assert_awaited_once_with("SVR-17")
        request = skald.stage_and_publish_spec_revision.await_args.args[0]
        assert request.source["source_key"] == "spms:function:17"
        assert request.source["immutable_source_id"] == "17"
        assert request.source["code"] == "SVR-17"

    @pytest.mark.asyncio
    async def test_sync_endpoint_paginates_until_terminal_page(self, collector):
        pages = [
            [{"id": 1}, {"id": 2}],
            [{"id": 3}],
            [],
        ]
        with (
            patch.object(collector, "fetch_techs", new_callable=AsyncMock, side_effect=pages) as fetch,
            patch.object(collector, "sync_item", new_callable=AsyncMock) as sync_item,
        ):
            result = await collector.sync_endpoint("techs", max_items=10)

        assert result == {"processed": 3, "failed": 0, "skipped": 0}
        assert [call.kwargs["page"] for call in fetch.await_args_list] == [1, 2, 3]
        assert sync_item.await_count == 3

    @pytest.mark.asyncio
    async def test_sync_endpoint_counts_item_failures_and_continues(self, collector):
        with (
            patch.object(
                collector,
                "fetch_troubleshoots",
                new_callable=AsyncMock,
                side_effect=[[{"id": 1}, {"id": 2}], []],
            ),
            patch.object(
                collector,
                "sync_item",
                new_callable=AsyncMock,
                side_effect=[RuntimeError("publish failed"), MagicMock()],
            ),
        ):
            result = await collector.sync_endpoint("troubleshoots", max_items=10)

        assert result == {"processed": 1, "failed": 1, "skipped": 0}

    @pytest.mark.asyncio
    async def test_sync_endpoint_transport_exhaustion_propagates(self, collector):
        with (
            patch.object(
                collector,
                "fetch_information",
                new_callable=AsyncMock,
                side_effect=httpx.ConnectError("SPMS unavailable"),
            ),
            pytest.raises(httpx.ConnectError, match="SPMS unavailable"),
        ):
            await collector.sync_endpoint("information", max_items=10)

    @pytest.mark.asyncio
    async def test_sync_all_uses_one_global_budget_in_deterministic_order(self, collector):
        calls = []

        async def sync_endpoint(endpoint_type, updated_since=None, max_items=500):
            calls.append((endpoint_type, max_items))
            used = min(max_items, 2)
            return {"processed": used, "failed": 0, "skipped": 0}

        with patch.object(collector, "sync_endpoint", side_effect=sync_endpoint):
            result = await collector.sync_all(max_documents=3)

        assert calls == [("functions", 3), ("techs", 1)]
        assert result["total"] == {"processed": 3, "failed": 0, "skipped": 0}
        assert list(result["by_type"]) == ["functions", "techs", "information", "troubleshoots"]

    @pytest.mark.asyncio
    async def test_sync_all_failures_consume_global_budget(self, collector):
        calls = []

        async def sync_endpoint(endpoint_type, updated_since=None, max_items=500):
            calls.append((endpoint_type, max_items))
            return {"processed": 0, "failed": max_items, "skipped": 0}

        with patch.object(collector, "sync_endpoint", side_effect=sync_endpoint):
            result = await collector.sync_all(max_documents=2)

        assert calls == [("functions", 2)]
        assert result["total"] == {"processed": 0, "failed": 2, "skipped": 0}


class TestDocsCollectorSingleton:
    def test_get_docs_collector_returns_singleton(self):
        with patch("skald_worker.collectors.docs_collector.settings") as mock_settings:
            mock_settings.spms_base_url = "https://spms.test"
            import skald_worker.collectors.docs_collector as docs_module

            docs_module._docs_collector = None
            assert get_docs_collector() is get_docs_collector()
