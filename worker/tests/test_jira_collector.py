"""Tests for Jira collector."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from skald_worker.collectors.jira_collector import (
    JiraCollector,
    jira_issue_to_markdown,
    get_jira_collector,
)


class TestJiraIssueToMarkdown:
    """Test Jira issue to markdown conversion."""

    def test_basic_conversion(self, sample_jira_issue):
        """Test basic issue to markdown conversion."""
        title, content, metadata, tags = jira_issue_to_markdown(sample_jira_issue)

        # Check title format (new format: "KEY summary" without brackets)
        assert title == "TEST-123 Test issue summary"

        # Check metadata (new field names)
        assert metadata["issueKey"] == "TEST-123"
        assert metadata["status"] == "Open"
        assert metadata["issueType"] == "Bug"

        # Check content structure (new format)
        assert "# TEST-123: Test issue summary" in content
        assert "**현재 상태**: Open" in content
        assert "## 문제 설명" in content
        assert "Test issue description" in content

        # Check tags
        assert "Bug" in tags
        assert "Open" in tags

    def test_conversion_with_comments(self, sample_jira_issue):
        """Test conversion includes comments."""
        # Add a comment
        comment = MagicMock()
        comment.author = MagicMock()
        comment.author.displayName = "commenter"
        comment.created = "2024-01-17T09:00:00.000+0000"
        comment.body = "This is a test comment"
        sample_jira_issue.fields.comment.comments = [comment]

        title, content, metadata, tags = jira_issue_to_markdown(sample_jira_issue)

        assert "## 논의 내용" in content
        assert "commenter" in content
        assert "This is a test comment" in content

    def test_conversion_with_custom_fields(self, sample_jira_issue):
        """Test conversion handles custom fields."""
        # Add custom field
        sample_jira_issue.fields.customfield_10001 = "재현 절차 내용"
        custom_field_dict = {"customfield_10001": "재현 절차"}

        title, content, metadata, tags = jira_issue_to_markdown(sample_jira_issue, custom_field_dict=custom_field_dict)

        assert "## 재현 절차" in content
        assert "재현 절차 내용" in content


class TestJiraCollector:
    """Test JiraCollector class."""

    @pytest.fixture
    def collector(self):
        """Create a JiraCollector for testing."""
        with patch("skald_worker.collectors.jira_collector.settings") as mock_settings:
            mock_settings.jira_server = "https://jira.test.com"
            mock_settings.jira_user = "test-user"
            mock_settings.jira_password = "test-pass"
            mock_settings.jira_jql_filter = "project = TEST"
            mock_settings.worker_concurrency = 2

            return JiraCollector(
                server="https://jira.test.com",
                user="test-user",
                password="test-pass",
                jql_filter="project = TEST",
            )

    @pytest.mark.asyncio
    async def test_fetch_issues(self, collector, sample_jira_issue):
        """Test fetching issues from Jira."""
        mock_jira = MagicMock()
        mock_jira.search_issues.return_value = [sample_jira_issue]

        with patch.object(collector, "_jira", mock_jira):
            with patch.object(collector, "_fetch_issues_sync", return_value=[sample_jira_issue]):
                issues = await collector.fetch_issues(max_results=10)

                assert len(issues) == 1
                assert issues[0].key == "TEST-123"

    @pytest.mark.asyncio
    async def test_sync_issue(self, collector, sample_jira_issue, sample_memo):
        """Test syncing a single issue to Skald."""
        mock_skald = AsyncMock()
        mock_skald.upsert_memo.return_value = sample_memo

        with patch("skald_worker.collectors.jira_collector.get_skald_client", return_value=mock_skald):
            result = await collector.sync_issue(sample_jira_issue)

            mock_skald.upsert_memo.assert_called_once()
            call_kwargs = mock_skald.upsert_memo.call_args.kwargs
            assert call_kwargs["reference_id"] == "jira:TEST-123"
            assert call_kwargs["source"] == "jira"
            assert "TEST-123" in call_kwargs["title"]
            assert "tags" in call_kwargs  # New: tags are now passed

    @pytest.mark.asyncio
    async def test_sync_all(self, collector, sample_jira_issue, sample_memo):
        """Test syncing all issues."""
        mock_skald = AsyncMock()
        mock_skald.upsert_memo.return_value = sample_memo

        with patch.object(collector, "fetch_issues", new_callable=AsyncMock) as mock_fetch:
            mock_fetch.return_value = [sample_jira_issue, sample_jira_issue]

            with patch("skald_worker.collectors.jira_collector.get_skald_client", return_value=mock_skald):
                result = await collector.sync_all(max_results=10)

                assert result["total"] == 2
                assert result["processed"] == 2
                assert result["failed"] == 0

    @pytest.mark.asyncio
    async def test_sync_all_with_failures(self, collector, sample_jira_issue):
        """Test sync all handles failures gracefully."""
        mock_skald = AsyncMock()
        mock_skald.upsert_memo.side_effect = Exception("API Error")

        with patch.object(collector, "fetch_issues", new_callable=AsyncMock) as mock_fetch:
            mock_fetch.return_value = [sample_jira_issue]

            with patch("skald_worker.collectors.jira_collector.get_skald_client", return_value=mock_skald):
                result = await collector.sync_all(max_results=10)

                assert result["total"] == 1
                assert result["processed"] == 0
                assert result["failed"] == 1

    @pytest.mark.asyncio
    async def test_find_similar_issues(self, collector, sample_jira_issue, sample_search_results):
        """Test finding similar issues."""
        mock_skald = AsyncMock()
        mock_skald.search.return_value = sample_search_results

        with patch.object(collector, "_fetch_single_issue_sync", return_value=sample_jira_issue):
            with patch("skald_worker.collectors.jira_collector.get_skald_client", return_value=mock_skald):
                result = await collector.find_similar_issues("TEST-123", limit=5)

                assert result["issue_key"] == "TEST-123"
                assert len(result["similar_issues"]) > 0


class TestJiraCollectorSingleton:
    """Test singleton behavior."""

    def test_get_jira_collector_returns_singleton(self):
        """Test that get_jira_collector returns same instance."""
        with patch("skald_worker.collectors.jira_collector.settings") as mock_settings:
            mock_settings.jira_server = "https://jira.test.com"
            mock_settings.jira_user = "test"
            mock_settings.jira_password = "test"
            mock_settings.jira_jql_filter = "project = TEST"
            mock_settings.worker_concurrency = 2

            # Reset singleton
            import skald_worker.collectors.jira_collector as jira_module

            jira_module._jira_collector = None

            collector1 = get_jira_collector()
            collector2 = get_jira_collector()

            assert collector1 is collector2
