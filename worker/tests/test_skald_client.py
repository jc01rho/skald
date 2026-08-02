"""Tests for Skald API client."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from skald_worker.circuit_breaker import CircuitBreaker, CircuitBreakerConfig
from skald_worker.clients.skald import (
    SkaldClient,
    SkaldClientRequestError,
    SpecReconciliationManifestRequest,
    get_skald_client,
)


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
        hash2 = client.compute_content_hash(
            content,
            title="Different title",
            metadata={"key": "value"},
            tags=["tag-a", "tag-b"],
        )

        # Same content should produce same hash regardless of title/metadata/tags
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
        mock_response.status_code = 200
        mock_response.json.return_value = sample_memo
        mock_response.raise_for_status = MagicMock()

        mock_http_client = MagicMock()
        mock_http_client.is_closed = False
        mock_http_client.request = AsyncMock(return_value=mock_response)
        mock_http_client.aclose = AsyncMock()
        client._client = mock_http_client

        result = await client.get_memo("jira:TEST-123")

        mock_http_client.request.assert_awaited_once_with(
            "GET",
            "/api/v1/memo/jira:TEST-123",
            params={"id_type": "reference_id"},
        )
        mock_response.raise_for_status.assert_called_once()
        assert result == sample_memo

    @pytest.mark.asyncio
    async def test_get_memo_not_found(self, client):
        """Test getting a non-existent memo returns None without tripping circuit breaker."""
        mock_response = MagicMock()
        mock_response.status_code = 404
        mock_response.raise_for_status = MagicMock()

        mock_http_client = MagicMock()
        mock_http_client.is_closed = False
        mock_http_client.request = AsyncMock(return_value=mock_response)
        mock_http_client.aclose = AsyncMock()
        client._client = mock_http_client

        result = await client.get_memo("nonexistent-ref")

        mock_http_client.request.assert_awaited_once_with(
            "GET",
            "/api/v1/memo/nonexistent-ref",
            params={"id_type": "reference_id"},
        )
        mock_response.raise_for_status.assert_not_called()
        assert result is None
        assert client.circuit_breaker.state.value == "closed"
        assert client.circuit_breaker.get_status()["failure_count"] == 0

    @pytest.mark.asyncio
    async def test_count_memos_with_source_filter(self, client):
        """Test counting memos with an optional source filter."""
        mock_response = MagicMock()
        mock_response.json.return_value = {"count": 42, "results": []}

        with patch.object(client, "_request_with_retry", new_callable=AsyncMock) as mock_request:
            mock_request.return_value = mock_response

            result = await client.count_memos(source="notion")

            mock_request.assert_called_once_with(
                "GET",
                "/api/v1/memo",
                params={"page": 1, "page_size": 1, "source": "notion"},
            )
            assert result == 42

    @pytest.mark.asyncio
    async def test_count_memos_without_source_filter(self, client):
        """Test counting all memos without a source filter."""
        mock_response = MagicMock()
        mock_response.json.return_value = {"count": 0, "results": []}

        with patch.object(client, "_request_with_retry", new_callable=AsyncMock) as mock_request:
            mock_request.return_value = mock_response

            result = await client.count_memos()

            mock_request.assert_called_once_with(
                "GET",
                "/api/v1/memo",
                params={"page": 1, "page_size": 1},
            )
            assert result == 0

    @pytest.mark.asyncio
    async def test_client_error_does_not_open_shared_circuit(self):
        breaker = CircuitBreaker(
            "skald-api-test",
            CircuitBreakerConfig(
                failure_threshold=1,
                exclude_exceptions=(SkaldClientRequestError,),
            ),
        )
        client = SkaldClient(
            base_url="https://api.skald.test",
            api_key="test-api-key",
            project_id="test-project-id",
            max_retries=1,
            circuit_breaker=breaker,
        )
        request = MagicMock()
        request.url = "https://api.skald.test/api/v1/spec-revisions/stage-and-publish"
        response = MagicMock()
        response.status_code = 400
        response.reason_phrase = "Bad Request"
        response.request = request
        response.text = '{"error":{"code":"RELATION_HASH_MISMATCH"}}'
        client._client = MagicMock(is_closed=False)
        client._client.request = AsyncMock(return_value=response)

        with pytest.raises(SkaldClientRequestError, match="RELATION_HASH_MISMATCH"):
            await client._request_with_retry("POST", "/api/v1/spec-revisions/stage-and-publish", json={})

        assert breaker.is_closed
        assert breaker.get_status()["failure_count"] == 0

    @pytest.mark.asyncio
    async def test_stage_and_publish_retries_transient_statuses_but_not_client_errors(self):
        breaker = CircuitBreaker(
            "stage-publish-retry-test",
            CircuitBreakerConfig(failure_threshold=5, recovery_timeout=30.0, success_threshold=2),
        )
        client = SkaldClient(
            base_url="https://api.skald.test",
            api_key="test-api-key",
            project_id="test-project-id",
            max_retries=3,
            retry_min_wait=0,
            retry_max_wait=0,
            circuit_breaker=breaker,
        )
        request = httpx.Request("POST", "https://api.skald.test/api/v1/spec-revisions/stage-and-publish")
        responses = [
            httpx.Response(503, request=request),
            httpx.Response(408, request=request),
            httpx.Response(201, request=request, json={"status": "published"}),
        ]
        client._client = MagicMock(is_closed=False)
        client._client.request = AsyncMock(side_effect=responses)

        response = await client._request_with_retry("POST", "/api/v1/spec-revisions/stage-and-publish", json={})

        assert response.status_code == 201
        assert client._client.request.await_count == 3

        client._client.request = AsyncMock(return_value=httpx.Response(422, request=request, text="invalid payload"))
        with pytest.raises(SkaldClientRequestError, match="invalid payload"):
            await client._request_with_retry("POST", "/api/v1/spec-revisions/stage-and-publish", json={})
        assert client._client.request.await_count == 1

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

                await client.upsert_memo(
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

    @pytest.mark.asyncio
    async def test_submit_spec_reconciliation_manifest_posts_typed_payload(self, client):
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "run": {"run_id": "run-1"},
            "promotion": {"state": "canary_eligible"},
            "idempotent_replay": False,
        }
        request = SpecReconciliationManifestRequest(
            run_id="run-1",
            scope_key="spms:all",
            source_system="spms",
            source_type="all",
            authoritative=True,
            complete=False,
            manifest_hash="a" * 64,
            count=3,
            errors=({"endpoint": "techs", "stage": "page", "error": "timeout"},),
            identity_drift=0,
            revision_drift=0,
            authorization_drift=0,
            relation_drift=0,
            claim_drift=0,
            memo_link_drift=0,
            started_at="2026-07-30T12:00:00+00:00",
            completed_at=None,
            lifecycle_evidence=(),
        )

        with patch.object(client, "_request_with_retry", new_callable=AsyncMock) as mock_request:
            mock_request.return_value = mock_response
            receipt = await client.submit_spec_reconciliation_manifest(request)

        mock_request.assert_awaited_once_with(
            "POST",
            "/api/v1/spec-reconciliation/manifests",
            json=request.to_payload(),
        )
        assert receipt.run_id == "run-1"
        assert receipt.promotion_state == "canary_eligible"


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
