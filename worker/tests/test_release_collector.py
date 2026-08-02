"""Tests for release collector."""

from unittest.mock import AsyncMock, patch

import pytest

from skald_worker.collectors.release_collector import ReleaseCollector, get_release_collector


@pytest.fixture
def sample_release_summary():
    return {
        "id": "12065",
        "project": "SPARROW",
        "name": "2602.1",
        "archived": False,
        "released": True,
        "releaseDate": "2026-02-27T15:00:00.000Z",
    }


@pytest.fixture
def sample_release_detail():
    return {
        "id": "12065",
        "name": "2602.1",
        "projectKey": "SPARROW",
        "archived": False,
        "released": True,
        "startDate": "2026-02-23",
        "releaseDate": "2026-02-27",
        "userReleaseDate": "2026년 02월 27일",
        "devcenterId": 78,
    }


@pytest.fixture
def sample_release_notes():
    return {
        "status": "published",
        "date_updated": "2026-02-25T06:19:42.489Z",
        "released_on": "2026-02-27T12:00:00",
        "all_desc": [
            {
                "headline": "소스코드 분석 | 옵션 동작 변경",
                "summary": "옵션 동작이 변경되었습니다.",
                "category": "CHANGED",
                "link": "https://jira.sparrowfasoo.com/browse/SPARROW-9730",
            }
        ],
    }


@pytest.fixture
def sample_release_issue():
    return {
        "id": "58820",
        "key": "SPARROW-9622",
        "fields": {
            "summary": "AI 모델 구성요소 식별 지원",
            "created": "2026-01-11T23:53:19.000+0900",
            "updated": "2026-02-27T17:01:38.000+0900",
            "components": [{"name": "엔진"}],
            "status": {"name": "완료"},
            "priority": {"name": "보통"},
            "assignee": {"displayName": "김남진"},
            "tools": [{"value": "공통"}],
            "sites": [{"value": "클라우드"}],
            "roadmap": [{"value": "예"}],
        },
    }


class TestReleaseCollector:
    @pytest.fixture
    def collector(self):
        with patch("skald_worker.collectors.release_collector.settings") as mock_settings:
            mock_settings.spms_base_url = "https://spms.test"
            return ReleaseCollector(base_url="https://spms.test")

    def test_release_to_markdown(
        self,
        collector,
        sample_release_summary,
        sample_release_detail,
        sample_release_notes,
        sample_release_issue,
    ):
        title, content, metadata, tags = collector.release_to_markdown(
            version_summary=sample_release_summary,
            detail=sample_release_detail,
            release_notes=sample_release_notes,
            roadmap_issues=[sample_release_issue],
            requirement_issues=[sample_release_issue],
            incident_issues=[sample_release_issue],
            checker_issues=[sample_release_issue],
        )

        assert title == "Sparrow Enterprise 2602.1 릴리즈 현황"
        assert "엔터프라이즈" in content
        assert "## 릴리즈 노트" in content
        assert "## 장애" in content
        assert metadata["release_id"] == "12065"
        assert metadata["product_id"] == "sparrow"
        assert metadata["roadmap_issue_count"] == 1
        assert "release" in tags
        assert "sparrow" in tags

    @pytest.mark.asyncio
    async def test_sync_release(
        self,
        collector,
        sample_release_summary,
        sample_release_detail,
        sample_release_notes,
        sample_release_issue,
        sample_memo,
    ):
        mock_skald = AsyncMock()
        mock_skald.upsert_memo.return_value = sample_memo

        with (
            patch.object(collector, "fetch_version_detail", new=AsyncMock(return_value=sample_release_detail)),
            patch.object(collector, "fetch_release_notes", new=AsyncMock(return_value=sample_release_notes)),
            patch.object(
                collector,
                "fetch_version_issues",
                new=AsyncMock(side_effect=[[sample_release_issue]] * 4),
            ),
            patch("skald_worker.collectors.release_collector.get_skald_client", return_value=mock_skald),
        ):
            await collector.sync_release(sample_release_summary)

        call_kwargs = mock_skald.upsert_memo.call_args.kwargs
        assert call_kwargs["reference_id"] == "spms:release:12065"
        assert call_kwargs["source"] == "release"
        assert call_kwargs["metadata"]["product_id"] == "sparrow"
        assert call_kwargs["metadata"]["version"] == "2602.1"

    @pytest.mark.asyncio
    async def test_sync_all(self, collector, sample_release_summary, sample_memo):
        mock_skald = AsyncMock()
        mock_skald.upsert_memo.return_value = sample_memo

        with (
            patch.object(collector, "fetch_versions", new=AsyncMock(return_value=[sample_release_summary])),
            patch.object(collector, "sync_release", new=AsyncMock(return_value=sample_memo)),
        ):
            result = await collector.sync_all(max_versions=10)

        assert result["total"] == 1
        assert result["processed"] == 1
        assert result["failed"] == 0

    @pytest.mark.asyncio
    async def test_release_notes_http_500_is_counted(self, collector, sample_release_summary):
        import httpx

        request = httpx.Request("GET", "https://spms.test/api/releases/versions/12065/notes")
        response = httpx.Response(500, request=request)
        error = httpx.HTTPStatusError("server error", request=request, response=response)

        with (
            patch.object(collector, "fetch_versions", new=AsyncMock(return_value=[sample_release_summary])),
            patch.object(collector, "fetch_version_detail", new=AsyncMock(return_value={"id": "12065"})),
            patch.object(collector, "_request_with_retry", new=AsyncMock(side_effect=error)),
        ):
            result = await collector.sync_all(max_versions=10)

        assert result == {"total": 1, "processed": 0, "failed": 1}


class TestReleaseCollectorSingleton:
    def test_get_release_collector_returns_singleton(self):
        with patch("skald_worker.collectors.release_collector.settings") as mock_settings:
            mock_settings.spms_base_url = "https://spms.test"

            import skald_worker.collectors.release_collector as release_module

            release_module._release_collector = None
            collector1 = get_release_collector()
            collector2 = get_release_collector()

            assert collector1 is collector2
