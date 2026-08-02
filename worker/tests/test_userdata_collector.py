"""Tests for userdata collector."""

from unittest.mock import AsyncMock, patch

import pytest

from skald_worker.collectors.userdata_collector import UserdataCollector, get_userdata_collector


@pytest.fixture
def sample_userdata_item():
    return {
        "version": "2025.4",
        "timestamp": 1764297364000,
        "projectCode": "F0146M25013",
        "site": "농협중앙회",
        "product": "Sparrow SAST/SAQT",
        "users": 4726,
        "userGroups": 3801,
        "projects": 3763,
        "analyses": 114337,
        "issues": 2280811,
        "client": ["클라이언트 CLI", "WEB"],
        "language": ["Java", "Python"],
        "framework": ["Spring Framework"],
    }


class TestUserdataCollector:
    @pytest.fixture
    def collector(self):
        with patch("skald_worker.collectors.userdata_collector.settings") as mock_settings:
            mock_settings.spms_base_url = "https://spms.test"
            return UserdataCollector(base_url="https://spms.test")

    def test_userdata_to_markdown(self, collector, sample_userdata_item):
        title, content, metadata, tags = collector.userdata_to_markdown(sample_userdata_item)

        assert "고객 사용자 데이터" in title
        assert "## 사용량 통계" in content
        assert "농협중앙회" in content
        assert metadata["project_code"] == "F0146M25013"
        assert "userdata" in tags

    def test_tabbed_identity_is_normalized_and_empty_identity_rejected(self, collector, sample_userdata_item):
        tabbed = {
            **sample_userdata_item,
            "projectCode": "\t F0146M25013\u2003QA \n",
            "reference": "\tlegacy\t",
        }

        _, content, metadata, _ = collector.userdata_to_markdown(tabbed)

        assert collector.build_reference_id(tabbed) == "spms:userdata:F0146M25013-QA"
        assert metadata["project_code"] == "F0146M25013 QA"
        assert metadata["reference"] == "legacy"
        assert "F0146M25013 QA" in content
        with pytest.raises(ValueError, match="must not be empty"):
            collector.build_reference_id({"projectCode": "\t\u2003", "reference": "\x00\n"})

    def test_usage_lists_strip_control_whitespace(self, collector, sample_userdata_item):
        dirty = {
            **sample_userdata_item,
            "client": [" Web\tClient ", "\x00", "Desktop\r\nApp"],
            "language": [" Python\u2028", "\n"],
            "framework": [" Spring\x00Boot ", "\t"],
        }

        _, content, _, _ = collector.userdata_to_markdown(dirty)

        assert "- Web Client" in content
        assert "- Desktop App" in content
        assert "- Python" in content
        assert "- Spring Boot" in content
        assert "\x00" not in content

    @pytest.mark.asyncio
    async def test_sync_item(self, collector, sample_userdata_item, sample_memo):
        mock_skald = AsyncMock()
        mock_skald.upsert_memo.return_value = sample_memo

        with patch("skald_worker.collectors.userdata_collector.get_skald_client", return_value=mock_skald):
            await collector.sync_item(sample_userdata_item)

        call_kwargs = mock_skald.upsert_memo.call_args.kwargs
        assert call_kwargs["reference_id"] == "spms:userdata:F0146M25013"
        assert call_kwargs["source"] == "userdata"
        assert call_kwargs["metadata"]["product"] == "Sparrow SAST/SAQT"

    @pytest.mark.asyncio
    async def test_sync_all(self, collector, sample_userdata_item):
        with (
            patch.object(collector, "fetch_userdata", new=AsyncMock(return_value=[sample_userdata_item])),
            patch.object(collector, "sync_item", new=AsyncMock(return_value={"ok": True})),
        ):
            result = await collector.sync_all(max_items=10)

        assert result["total"] == 1
        assert result["processed"] == 1
        assert result["failed"] == 0


class TestUserdataCollectorSingleton:
    def test_get_userdata_collector_returns_singleton(self):
        with patch("skald_worker.collectors.userdata_collector.settings") as mock_settings:
            mock_settings.spms_base_url = "https://spms.test"

            import skald_worker.collectors.userdata_collector as userdata_module

            userdata_module._userdata_collector = None
            collector1 = get_userdata_collector()
            collector2 = get_userdata_collector()

            assert collector1 is collector2
