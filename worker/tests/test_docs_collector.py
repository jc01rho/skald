"""Tests for docs collector."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import httpx

from skald_worker.collectors.docs_collector import (
    DocsCollector,
    html_to_markdown,
    get_docs_collector,
)


class TestHtmlToMarkdown:
    """Test HTML to markdown conversion."""

    def test_basic_html_conversion(self):
        """Test basic HTML to text conversion."""
        html = "<p>Hello <strong>world</strong></p>"
        result = html_to_markdown(html)

        assert "Hello" in result
        assert "world" in result

    def test_removes_script_tags(self):
        """Test that script tags are removed."""
        html = "<p>Content</p><script>alert('bad')</script>"
        result = html_to_markdown(html)

        assert "Content" in result
        assert "script" not in result.lower()
        assert "alert" not in result

    def test_removes_style_tags(self):
        """Test that style tags are removed."""
        html = "<p>Content</p><style>.red { color: red; }</style>"
        result = html_to_markdown(html)

        assert "Content" in result
        assert "style" not in result.lower()
        assert "color" not in result

    def test_removes_navigation(self):
        """Test that nav/header/footer are removed."""
        html = """
        <nav>Navigation</nav>
        <header>Header</header>
        <main><p>Main content</p></main>
        <footer>Footer</footer>
        """
        result = html_to_markdown(html)

        assert "Main content" in result
        assert "Navigation" not in result
        assert "Header" not in result
        assert "Footer" not in result


class TestDocsCollector:
    """Test DocsCollector class."""

    @pytest.fixture
    def collector(self):
        """Create a DocsCollector for testing."""
        with patch("skald_worker.collectors.docs_collector.settings") as mock_settings:
            mock_settings.spms_base_url = "https://docs.test.com"
            mock_settings.spms_api_key = "test-api-key"

            return DocsCollector(
                base_url="https://docs.test.com",
                api_key="test-api-key",
            )

    def test_document_to_markdown(self, collector, sample_document):
        """Test document to markdown conversion."""
        title, content, metadata = collector.document_to_markdown(sample_document)

        # Check title
        assert title == "Test Document"

        # Check metadata
        assert metadata["doc_id"] == "doc-123"
        assert metadata["doc_type"] == "guide"
        assert metadata["category"] == "testing"
        assert "test" in metadata["tags"]

        # Check content structure
        assert "# Test Document" in content
        assert "## Document Information" in content
        assert "| **ID** | doc-123 |" in content
        assert "## Content" in content

    @pytest.mark.asyncio
    async def test_fetch_document_list(self, collector):
        """Test fetching document list."""
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "documents": [
                {"id": "doc-1", "title": "Doc 1"},
                {"id": "doc-2", "title": "Doc 2"},
            ]
        }

        with patch.object(collector, "_request_with_retry", new_callable=AsyncMock) as mock_request:
            mock_request.return_value = mock_response

            result = await collector.fetch_document_list(page=1, page_size=50)

            mock_request.assert_called_once()
            assert len(result) == 2
            assert result[0]["id"] == "doc-1"

    @pytest.mark.asyncio
    async def test_fetch_document_list_error(self, collector):
        """Test fetch document list handles errors."""
        with patch.object(collector, "_request_with_retry", new_callable=AsyncMock) as mock_request:
            mock_request.side_effect = httpx.HTTPError("Connection failed")

            result = await collector.fetch_document_list()

            assert result == []

    @pytest.mark.asyncio
    async def test_fetch_document_content(self, collector, sample_document):
        """Test fetching document content."""
        mock_response = MagicMock()
        mock_response.json.return_value = sample_document

        with patch.object(collector, "_request_with_retry", new_callable=AsyncMock) as mock_request:
            mock_request.return_value = mock_response

            result = await collector.fetch_document_content("doc-123")

            mock_request.assert_called_once()
            assert result["id"] == "doc-123"

    @pytest.mark.asyncio
    async def test_fetch_document_content_not_found(self, collector):
        """Test fetch document handles 404."""
        mock_response = MagicMock()
        mock_response.status_code = 404

        with patch.object(collector, "_request_with_retry", new_callable=AsyncMock) as mock_request:
            mock_request.side_effect = httpx.HTTPStatusError(
                message="Not Found",
                request=MagicMock(),
                response=mock_response,
            )

            result = await collector.fetch_document_content("nonexistent")

            assert result is None

    @pytest.mark.asyncio
    async def test_sync_document(self, collector, sample_document, sample_memo):
        """Test syncing a single document to Skald."""
        mock_skald = AsyncMock()
        mock_skald.upsert_memo.return_value = sample_memo

        with patch("skald_worker.collectors.docs_collector.get_skald_client", return_value=mock_skald):
            result = await collector.sync_document(sample_document)

            mock_skald.upsert_memo.assert_called_once()
            call_kwargs = mock_skald.upsert_memo.call_args.kwargs
            assert call_kwargs["reference_id"] == "doc:doc-123"
            assert call_kwargs["source"] == "spms"

    @pytest.mark.asyncio
    async def test_sync_all(self, collector, sample_document, sample_memo):
        """Test syncing all documents."""
        mock_skald = AsyncMock()
        mock_skald.upsert_memo.return_value = sample_memo

        with patch.object(collector, "fetch_document_list", new_callable=AsyncMock) as mock_list:
            # First call returns documents, second call returns empty (end of pages)
            mock_list.side_effect = [
                [sample_document, sample_document],
                [],
            ]

            with patch("skald_worker.collectors.docs_collector.get_skald_client", return_value=mock_skald):
                result = await collector.sync_all(max_documents=10)

                assert result["processed"] == 2
                assert result["failed"] == 0

    @pytest.mark.asyncio
    async def test_sync_all_with_failures(self, collector, sample_document):
        """Test sync all handles failures gracefully."""
        mock_skald = AsyncMock()
        mock_skald.upsert_memo.side_effect = Exception("API Error")

        with patch.object(collector, "fetch_document_list", new_callable=AsyncMock) as mock_list:
            mock_list.side_effect = [[sample_document], []]

            with patch("skald_worker.collectors.docs_collector.get_skald_client", return_value=mock_skald):
                result = await collector.sync_all(max_documents=10)

                assert result["processed"] == 0
                assert result["failed"] == 1


class TestDocsCollectorSingleton:
    """Test singleton behavior."""

    def test_get_docs_collector_returns_singleton(self):
        """Test that get_docs_collector returns same instance."""
        with patch("skald_worker.collectors.docs_collector.settings") as mock_settings:
            mock_settings.spms_base_url = "https://docs.test.com"
            mock_settings.spms_api_key = "test-key"

            # Reset singleton
            import skald_worker.collectors.docs_collector as docs_module

            docs_module._docs_collector = None

            collector1 = get_docs_collector()
            collector2 = get_docs_collector()

            assert collector1 is collector2
