"""Tests for release-linked Jira collection and Jira comment fidelity."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from skald_worker.collectors.jira_collector import jira_issue_to_markdown
from skald_worker.collectors.release_collector import (
    ReleaseCollector,
    _extract_linked_jira_issues,
)


def _comment(cid, author, body, created="2026-03-16T09:35:44.000+0000", updated=None):
    c = MagicMock()
    c.id = cid
    c.body = body
    c.author = MagicMock()
    c.author.displayName = author
    c.created = created
    c.updated = updated or created
    return c


def _issue_with_comments(comments, **field_overrides):
    issue = MagicMock()
    issue.key = "SPARROW-9990"
    fields = MagicMock()
    fields.summary = "루프백 허용"
    fields.description = "설명 본문"
    fields.issuetype.name = "제품 요구사항"
    fields.status.name = "완료"
    fields.priority.name = "보통"
    fields.assignee.displayName = "담당"
    fields.reporter.displayName = "보고"
    fields.project.key = "SPARROW"
    fields.project.name = "Sparrow"
    fields.created = "2026-02-26T21:05:10.000+0000"
    fields.updated = "2026-06-26T17:31:48.000+0000"
    fields.components = []
    fields.fixVersions = []
    fields.resolution = None
    fields.comment = MagicMock()
    fields.comment.comments = comments
    issue.fields = fields
    issue.changelog = None
    return issue


LONG_BODY = (
    "원인 설명입니다. " * 20
    + "해결 방법: setCheckerInfo((prev) => ({ ...prev, ...info }))로 함수형 업데이트로 변경하고 "
    + "mergeLocalizedIds(prev, info)로 language별 localized.id를 복원했습니다. "
    + "영향도: SAST/DAST/SCA 모두 적용되며 일반 사용자 화면 ModifyCustomCheckerSlideOut.js는 영향이 없습니다. "
    + "2609.1 브랜치 커밋 200414164."
)


class TestJiraCommentFidelity:
    def test_long_comment_solution_survives(self):
        issue = _issue_with_comments([_comment("112306", "이재훈", LONG_BODY)])
        title, content, metadata, tags = jira_issue_to_markdown(issue)
        assert "mergeLocalizedIds" in content
        assert "setCheckerInfo((prev) => ({ ...prev, ...info }))" in content
        assert "200414164" in content

    def test_all_comments_kept_beyond_five(self):
        comments = [_comment(str(i), f"사용자{i}", f"댓글 {i} 내용입니다.") for i in range(1, 9)]
        issue = _issue_with_comments(comments)
        title, content, metadata, tags = jira_issue_to_markdown(issue)
        for i in range(1, 9):
            assert f"댓글 {i} 내용입니다." in content

    def test_comment_provenance_ids_and_dates(self):
        issue = _issue_with_comments([_comment("104522", "이재훈", "allow.loopback=true 추가", updated="2026-03-17T01:00:00.000+0000")])
        _, content, _, _ = jira_issue_to_markdown(issue)
        assert "2026-03-16" in content
        assert "2026-03-17" in content

    def test_caret_ranges_and_links_preserved(self):
        issue = _issue_with_comments([_comment("1", "김다인", "* react: ^18.2.0 -> ^19.2.4 [TeamCity|https://teamcity.sparrow.local/build/1]")])
        _, content, _, _ = jira_issue_to_markdown(issue)
        assert "^18.2.0" in content and "^19.2.4" in content
        assert "https://teamcity.sparrow.local/build/1" in content

    def test_standard_components_fallback(self):
        issue = _issue_with_comments([])
        comp = MagicMock()
        comp.name = "서버 매니저"
        issue.fields.components = [comp]
        _, _, metadata, _ = jira_issue_to_markdown(issue)
        assert metadata["component"] == "서버 매니저"

    def test_design_detail_section_rendered(self):
        issue = _issue_with_comments([])
        issue.fields.customfield_11119 = "기존 엔진 호환성을 유지하며 경로 전달을 수정합니다."
        _, content, metadata, _ = jira_issue_to_markdown(issue, custom_field_dict={"customfield_11119": "설계 상세"})
        assert "## 설계 상세" in content
        assert "기존 엔진 호환성" in content


class TestReleaseLinkExtraction:
    def test_extracts_explicit_link_keys_only(self):
        notes = {
            "all_desc": [
                {"category": "CHANGED", "headline": "오프라인 지원", "link": "https://jira.sparrowfasoo.com/browse/SPARROW-9990"},
                {"category": "FIXED", "headline": "SPARROW-1000 언급만 있는 항목", "link": ""},
            ]
        }
        linked = _extract_linked_jira_issues(notes)
        assert [e["issue_key"] for e in linked] == ["SPARROW-9990"]
        assert linked[0]["headline"] == "오프라인 지원"

    def test_dedup_and_none(self):
        notes = {
            "all_desc": [
                {"link": "https://jira.sparrowfasoo.com/browse/SPSAST-123"},
                {"link": "https://jira.sparrowfasoo.com/browse/SPSAST-123"},
            ]
        }
        assert len(_extract_linked_jira_issues(notes)) == 1
        assert _extract_linked_jira_issues(None) == []

    def test_release_markdown_contains_linked_section_and_metadata(self):
        collector = ReleaseCollector(base_url="https://spms.test")
        linked = [{"issue_key": "SPARROW-9990", "reference_id": "SPARROW-9990", "url": "https://jira.sparrowfasoo.com/browse/SPARROW-9990", "category": "CHANGED", "headline": "오프라인 지원"}]
        title, content, metadata, tags = collector.release_to_markdown(
            version_summary={"id": "12072", "project": "SPARROW", "name": "2606.1", "releaseDate": "2026-06-26"},
            detail={"id": "12072", "name": "2606.1", "projectKey": "SPARROW", "releaseDate": "2026-06-26"},
            release_notes={"all_desc": []},
            roadmap_issues=[],
            requirement_issues=[],
            incident_issues=[],
            checker_issues=[],
            linked_jira_issues=linked,
        )
        assert "## 연결된 Jira 이슈" in content
        assert "SPARROW-9990" in content
        assert metadata["release_linked_jira_keys"] == ["SPARROW-9990"]

    @pytest.mark.asyncio
    async def test_sync_release_collects_linked_jira(self, sample_memo):
        collector = ReleaseCollector(base_url="https://spms.test")
        mock_skald = AsyncMock()
        mock_skald.upsert_memo.return_value = sample_memo
        mock_jira = AsyncMock()
        notes = {"all_desc": [{"category": "CHANGED", "headline": "h", "link": "https://jira.sparrowfasoo.com/browse/SPARROW-9990"}]}

        with (
            patch.object(collector, "fetch_version_detail", new=AsyncMock(return_value={"id": "12072", "name": "2606.1", "projectKey": "SPARROW"})),
            patch.object(collector, "fetch_release_notes", new=AsyncMock(return_value=notes)),
            patch.object(collector, "fetch_version_issues", new=AsyncMock(side_effect=[[], [], [], []])),
            patch("skald_worker.collectors.release_collector.get_skald_client", return_value=mock_skald),
            patch("skald_worker.collectors.release_collector.get_jira_collector", return_value=mock_jira),
            patch("skald_worker.collectors.release_collector.settings") as mock_settings,
        ):
            mock_settings.release_linked_jira_enabled = True
            mock_settings.release_linked_jira_max_keys = 50
            mock_settings.jira_server = "https://jira"
            mock_settings.jira_user = "u"
            mock_settings.jira_password = "p"
            await collector.sync_release({"id": "12072", "project": "SPARROW", "name": "2606.1"})

        mock_jira.sync_issue_by_key.assert_awaited_once_with("SPARROW-9990")
        keys = mock_skald.upsert_memo.call_args.kwargs["metadata"]["release_linked_jira_keys"]
        assert keys == ["SPARROW-9990"]

    @pytest.mark.asyncio
    async def test_sync_all_refreshes_previous_links_on_note_failure(self, sample_memo):
        collector = ReleaseCollector(base_url="https://spms.test")
        mock_skald = AsyncMock()
        mock_skald.get_memo.return_value = {"metadata": {"release_linked_jira_keys": ["SPARROW-9990"]}}
        mock_jira = AsyncMock()
        import httpx
        req = httpx.Request("GET", "https://spms.test/api/releases/versions/12072")
        err = httpx.HTTPStatusError("500", request=req, response=httpx.Response(500, request=req))

        with (
            patch.object(collector, "fetch_versions", new=AsyncMock(return_value=[{"id": "12072", "project": "SPARROW", "name": "2606.1"}])),
            patch.object(collector, "fetch_version_detail", new=AsyncMock(return_value={"id": "12072"})),
            patch.object(collector, "fetch_release_notes", new=AsyncMock(side_effect=err)),
            patch("skald_worker.collectors.release_collector.get_skald_client", return_value=mock_skald),
            patch("skald_worker.collectors.release_collector.get_jira_collector", return_value=mock_jira),
            patch("skald_worker.collectors.release_collector.settings") as mock_settings,
        ):
            mock_settings.release_linked_jira_enabled = True
            mock_settings.release_linked_jira_max_keys = 50
            mock_settings.jira_server = "https://jira"
            mock_settings.jira_user = "u"
            mock_settings.jira_password = "p"
            result = await collector.sync_all(max_versions=10)

        assert result == {"total": 1, "processed": 0, "failed": 1}
        mock_jira.sync_issue_by_key.assert_awaited_once_with("SPARROW-9990")

    @pytest.mark.asyncio
    async def test_missing_jira_credentials_fail_visibly(self, sample_memo):
        collector = ReleaseCollector(base_url="https://spms.test")
        mock_skald = AsyncMock()
        mock_skald.upsert_memo.return_value = sample_memo
        notes = {"all_desc": [{"link": "https://jira.sparrowfasoo.com/browse/SPARROW-9990"}]}

        with (
            patch.object(collector, "fetch_versions", new=AsyncMock(return_value=[{"id": "12072", "project": "SPARROW", "name": "2606.1"}])),
            patch.object(collector, "fetch_version_detail", new=AsyncMock(return_value={"id": "12072", "projectKey": "SPARROW", "name": "2606.1"})),
            patch.object(collector, "fetch_release_notes", new=AsyncMock(return_value=notes)),
            patch.object(collector, "fetch_version_issues", new=AsyncMock(side_effect=[[], [], [], []])),
            patch("skald_worker.collectors.release_collector.get_skald_client", return_value=mock_skald),
            patch("skald_worker.collectors.release_collector.settings") as mock_settings,
        ):
            mock_settings.release_linked_jira_enabled = True
            mock_settings.release_linked_jira_max_keys = 50
            mock_settings.jira_server = ""
            mock_settings.jira_user = ""
            mock_settings.jira_password = ""
            mock_settings.jira_comment_page_size = 100
            mock_settings.jira_comment_max_count = 500
            result = await collector.sync_all(max_versions=10)

        assert result["failed"] == 1
        # Release memo itself was still upserted before the linked-Jira gate failed.
        assert mock_skald.upsert_memo.await_count == 1
