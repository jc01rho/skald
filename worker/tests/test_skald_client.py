"""Tests for Skald API client."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import httpx

from skald_worker.clients.skald import SkaldClient, get_skald_client


class TestSkaldClient:
    """Test cases for SkaldClient."""

    @pytest.fixture
    def client(self):
        """Create a SkaldClient instance for testing."""
        with patch("skald_worker.clients.skald.settings") as mock_settings:
            mock_settings.skald_base_url = "https://api.skald.test"
            mock_settings.skald_api_key = "test-api-key"
            mock_settings.skald_project_id = "test-project-id"
            return SkaldClient(
                base_url="https://api.skald.test",
                api_key="test-api-key",
                project_id="test-project-id",
            )

    def test_compute_content_hash(self, client):
        """Test content hash computation."""
        content = "Test content for hashing"
        hash1 = client.compute_content_hash(content)
        hash2 = client.compute_content_hash(content)

        # Same content should produce same hash
        assert hash1 == hash2
        assert len(hash1) == 64  # SHA256 produces 64 hex characters

        # Different content should produce different hash
        hash3 = client.compute_content_hash("Different content")
        assert hash1 != hash3

    @pytest.mark.asyncio
    async def test_create_memo(self, client, sample_memo):
        """Test memo creation."""
        mock_response = MagicMock()
        mock_response.json.return_value = sample_memo
        mock_response.raise_for_status = MagicMock()

        with patch.object(client, "_request_with_retry", new_callable=AsyncMock) as mock_request:
            mock_request.return_value = mock_response

            result = await client.create_memo(
                title="Test Title",
                content="Test content",
                reference_id="test-ref-123",
                source="test",
                metadata={"key": "value"},
            )

            mock_request.assert_called_once()
            call_args = mock_request.call_args
            assert call_args[0][0] == "POST"
            assert call_args[0][1] == "/api/v1/memo"
            assert result == sample_memo

    @pytest.mark.asyncio
    async def test_get_memo_found(self, client, sample_memo):
        """Test getting an existing memo."""
        mock_response = MagicMock()
        mock_response.json.return_value = sample_memo

        with patch.object(client, "_request_with_retry", new_callable=AsyncMock) as mock_request:
            mock_request.return_value = mock_response

            result = await client.get_memo("jira:TEST-123")

            mock_request.assert_called_once()
            assert result == sample_memo

    @pytest.mark.asyncio
    async def test_get_memo_not_found(self, client):
        """Test getting a non-existent memo returns None."""
        mock_response = MagicMock()
        mock_response.status_code = 404

        with patch.object(client, "_request_with_retry", new_callable=AsyncMock) as mock_request:
            mock_request.side_effect = httpx.HTTPStatusError(
                message="Not Found",
                request=MagicMock(),
                response=mock_response,
            )

            result = await client.get_memo("nonexistent-ref")
            assert result is None

    @pytest.mark.asyncio
    async def test_upsert_memo_creates_new(self, client, sample_memo):
        """Test upsert creates new memo when none exists."""
        mock_response = MagicMock()
        mock_response.json.return_value = sample_memo

        with patch.object(client, "get_memo", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = None  # No existing memo

            with patch.object(client, "create_memo", new_callable=AsyncMock) as mock_create:
                mock_create.return_value = sample_memo

                result = await client.upsert_memo(
                    title="New Memo",
                    content="New content",
                    reference_id="new-ref",
                    source="test",
                )

                mock_get.assert_called_once_with("new-ref")
                mock_create.assert_called_once()
                assert result == sample_memo

    @pytest.mark.asyncio
    async def test_upsert_memo_updates_existing(self, client, sample_memo):
        """Test upsert updates memo when content changes."""
        existing_memo = {**sample_memo, "contentHash": "old-hash"}

        with patch.object(client, "get_memo", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = existing_memo

            with patch.object(client, "update_memo", new_callable=AsyncMock) as mock_update:
                updated_memo = {**sample_memo, "contentHash": "new-hash"}
                mock_update.return_value = updated_memo

                result = await client.upsert_memo(
                    title="Updated Title",
                    content="New content",  # Different content = different hash
                    reference_id="existing-ref",
                )

                mock_update.assert_called_once()

    @pytest.mark.asyncio
    async def test_upsert_memo_skips_unchanged(self, client, sample_memo):
        """Test upsert skips update when content is unchanged."""
        content = "Same content"
        content_hash = client.compute_content_hash(content)
        existing_memo = {**sample_memo, "contentHash": content_hash}

        with patch.object(client, "get_memo", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = existing_memo

            with patch.object(client, "update_memo", new_callable=AsyncMock) as mock_update:
                result = await client.upsert_memo(
                    title="Same Title",
                    content=content,
                    reference_id="existing-ref",
                )

                mock_update.assert_not_called()
                assert result == existing_memo

    @pytest.mark.asyncio
    async def test_search(self, client, sample_search_results):
        """Test vector search."""
        mock_response = MagicMock()
        mock_response.json.return_value = sample_search_results

        with patch.object(client, "_request_with_retry", new_callable=AsyncMock) as mock_request:
            mock_request.return_value = mock_response

            result = await client.search(
                query="test query",
                limit=5,
                threshold=0.8,
            )

            mock_request.assert_called_once()
            call_args = mock_request.call_args
            assert call_args[0][0] == "POST"
            assert call_args[0][1] == "/api/v1/search"
            assert result == sample_search_results

    @pytest.mark.asyncio
    async def test_chat(self, client):
        """Test chat endpoint."""
        chat_response = {
            "response": "This is the AI response",
            "sources": [{"id": "memo-1", "title": "Source 1"}],
        }
        mock_response = MagicMock()
        mock_response.json.return_value = chat_response

        with patch.object(client, "_request_with_retry", new_callable=AsyncMock) as mock_request:
            mock_request.return_value = mock_response

            result = await client.chat(
                message="What is the solution?",
                conversation_id="conv-123",
            )

            mock_request.assert_called_once()
            assert result == chat_response


class TestSkaldClientSingleton:
    """Test singleton behavior."""

    def test_get_skald_client_returns_singleton(self):
        """Test that get_skald_client returns the same instance."""
        with patch("skald_worker.clients.skald.settings") as mock_settings:
            mock_settings.skald_base_url = "https://api.skald.test"
            mock_settings.skald_api_key = "test-key"
            mock_settings.skald_project_id = "test-project"

            # Reset singleton
            import skald_worker.clients.skald as skald_module

            skald_module._skald_client = None

            client1 = get_skald_client()
            client2 = get_skald_client()

            assert client1 is client2
