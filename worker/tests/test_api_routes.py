"""Tests for API routes."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# We'll test the routes module in isolation


class TestAPIRoutes:
    """Test FastAPI routes."""

    @pytest.fixture
    def app(self):
        """Create test FastAPI app."""
        with patch("skald_worker.config.settings") as mock_settings:
            mock_settings.skald_base_url = "https://api.skald.test"
            mock_settings.skald_api_key = "test-key"
            mock_settings.skald_project_id = "test-project"
            mock_settings.worker_api_key = "test-worker-key"
            mock_settings.jira_server = "https://jira.test"
            mock_settings.jira_user = "test"
            mock_settings.jira_password = "test"
            mock_settings.jira_jql_filter = "project = TEST"
            mock_settings.jira_poll_interval_minutes = 60
            mock_settings.jira_enabled = True
            mock_settings.spms_base_url = "https://docs.test"
            mock_settings.docs_poll_interval_minutes = 120
            mock_settings.docs_enabled = True
            mock_settings.spec_backfill_max_documents = 5000
            mock_settings.spec_reconciliation_interval_seconds = 86400
            mock_settings.spec_reconciliation_grace_seconds = 172800
            mock_settings.release_enabled = True
            mock_settings.userdata_enabled = True
            mock_settings.worker_concurrency = 2
            mock_settings.host = "0.0.0.0"
            mock_settings.port = 8080
            mock_settings.environment = "test"
            mock_settings.log_level = "INFO"

            from fastapi import FastAPI

            from skald_worker.api.routes import router

            with (
                patch("skald_worker.api.routes.settings", mock_settings),
                patch("skald_worker.middleware.auth.settings", mock_settings),
            ):
                app = FastAPI()
                app.include_router(router)
                yield app

    @pytest.fixture
    def client(self, app):
        """Create test client."""
        return TestClient(app, headers={"X-API-Key": "test-worker-key"})

    def test_search_endpoint(self, client):
        """Test search endpoint."""
        mock_search_result = {
            "results": [
                {"id": "1", "title": "Result 1", "score": 0.9},
            ],
            "total": 1,
        }

        with patch("skald_worker.api.routes.get_skald_client") as mock_get_client:
            mock_client = AsyncMock()
            mock_client.search.return_value = mock_search_result
            mock_get_client.return_value = mock_client

            response = client.post(
                "/search",
                json={"query": "test query", "limit": 5},
            )

            assert response.status_code == 200
            data = response.json()
            assert "results" in data

    def test_search_endpoint_validation(self, client):
        """Test search endpoint validates input."""
        response = client.post("/search", json={})

        assert response.status_code == 422  # Validation error

    def test_chat_endpoint(self, client):
        """Test chat endpoint."""
        mock_chat_result = {
            "message": "This is the AI response",
            "sources": [],
        }

        with patch("skald_worker.api.routes.get_skald_client") as mock_get_client:
            mock_client = AsyncMock()
            mock_client.chat.return_value = mock_chat_result
            mock_get_client.return_value = mock_client

            response = client.post(
                "/chat",
                json={"message": "What is the solution?"},
            )

            assert response.status_code == 200
            data = response.json()
            assert data["message"] == "This is the AI response"

    def test_similar_issues_endpoint(self, client):
        """Test similar issues endpoint."""
        mock_result = {
            "issue_key": "TEST-123",
            "similar_issues": [
                {"id": "1", "title": "Similar 1", "score": 0.9},
            ],
        }

        with patch("skald_worker.api.routes.get_jira_collector") as mock_get_collector:
            mock_collector = AsyncMock()
            mock_collector.find_similar_issues.return_value = mock_result
            mock_get_collector.return_value = mock_collector

            response = client.post(
                "/similar-issues",
                json={"issue_key": "TEST-123", "limit": 5},
            )

            assert response.status_code == 200
            data = response.json()
            assert data["issue_key"] == "TEST-123"

    def test_sync_jira_endpoint(self, client):
        """Test sync endpoint for Jira."""
        mock_result = {
            "total": 10,
            "processed": 9,
            "failed": 1,
        }

        with patch("skald_worker.api.routes.get_jira_collector") as mock_get_collector:
            mock_collector = AsyncMock()
            mock_collector.sync_all.return_value = mock_result
            mock_get_collector.return_value = mock_collector

            response = client.post(
                "/sync",
                json={"source": "jira", "options": {"max_results": 100}},
            )

            assert response.status_code == 200
            data = response.json()
            assert data["source"] == "jira"
            assert data["processed"] == 9

    def test_sync_docs_incremental_endpoint(self, client):
        """Incremental docs sync preserves updated_since and reports its mode."""
        mock_result = {
            "total": {"processed": 50, "failed": 2, "skipped": 3},
            "by_type": {"functions": {"processed": 50, "failed": 2, "skipped": 3}},
        }

        with patch("skald_worker.api.routes.get_docs_collector") as mock_get_collector:
            mock_collector = AsyncMock()
            mock_collector.sync_all.return_value = mock_result
            mock_get_collector.return_value = mock_collector

            response = client.post(
                "/sync",
                json={
                    "source": "docs",
                    "mode": "incremental",
                    "options": {"updated_since": "2026-07-01T00:00:00Z", "max_documents": 100},
                },
            )

            assert response.status_code == 200
            data = response.json()
            assert data["mode"] == "incremental"
            assert data["processed"] == 50
            assert data["skipped"] == 3
            mock_collector.sync_all.assert_awaited_once_with(
                updated_since="2026-07-01T00:00:00Z",
                max_documents=100,
            )

    def test_sync_docs_full_backfill_is_explicit_and_bounded(self, client):
        """Full backfill ignores incremental cursors and returns progress."""
        mock_result = {
            "total": {"processed": 12, "failed": 0, "skipped": 0},
            "by_type": {"functions": {"processed": 12, "failed": 0, "skipped": 0}},
        }
        with patch("skald_worker.api.routes.get_docs_collector") as mock_get_collector:
            mock_collector = AsyncMock()
            mock_collector.sync_all.return_value = mock_result
            mock_get_collector.return_value = mock_collector

            response = client.post(
                "/sync",
                json={
                    "source": "docs",
                    "mode": "full_backfill",
                    "options": {"updated_since": "ignored", "max_documents": 250},
                },
            )

            assert response.status_code == 200
            data = response.json()
            assert data["mode"] == "full_backfill"
            assert data["max_documents"] == 250
            assert data["progress"]["by_type"] == mock_result["by_type"]
            mock_collector.sync_all.assert_awaited_once_with(updated_since=None, max_documents=250)

    def test_sync_docs_partial_backfill_is_non_success_and_not_persisted(self, client):
        state_manager = MagicMock()
        mock_result = {
            "total": {"processed": 12, "failed": 1, "skipped": 0},
            "by_type": {"functions": {"processed": 12, "failed": 1, "skipped": 0}},
        }
        with (
            patch("skald_worker.api.routes.get_docs_collector") as mock_get_collector,
            patch("skald_worker.api.routes.get_sync_state_manager", return_value=state_manager),
        ):
            mock_collector = AsyncMock()
            mock_collector.sync_all.return_value = mock_result
            mock_get_collector.return_value = mock_collector
            response = client.post(
                "/sync",
                json={"source": "docs", "mode": "full_backfill", "options": {"max_documents": 250}},
            )
        assert response.status_code == 502
        assert response.json()["status"] == "failed"
        state_manager.record_sync_failure.assert_called_once()
        state_manager.record_sync_success.assert_not_called()

    def test_sync_docs_caller_cannot_raise_server_backfill_ceiling(self, client):
        """A caller-supplied cap is clamped to the configured server ceiling."""
        mock_result = {"total": {"processed": 10, "failed": 0, "skipped": 0}, "by_type": {}}
        with patch("skald_worker.api.routes.get_docs_collector") as mock_get_collector:
            mock_collector = AsyncMock()
            mock_collector.sync_all.return_value = mock_result
            mock_get_collector.return_value = mock_collector

            response = client.post(
                "/sync",
                json={"source": "docs", "mode": "full_backfill", "options": {"max_documents": 5001}},
            )

        assert response.status_code == 200
        assert response.json()["max_documents"] == 5000
        mock_collector.sync_all.assert_awaited_once_with(updated_since=None, max_documents=5000)

    def test_sync_docs_authoritative_returns_reconciliation_receipt(self, client):
        """Authoritative mode calls only authoritative enumeration and exposes its receipt."""
        result = {
            "run_id": "run-1",
            "complete": True,
            "count": 42,
            "errors": [],
            "by_type": {},
            "promotion_state": "promoted",
        }
        with patch("skald_worker.api.routes.get_docs_collector") as mock_get_collector:
            mock_collector = AsyncMock()
            mock_collector.sync_authoritative_all.return_value = result
            mock_get_collector.return_value = mock_collector

            response = client.post("/sync", json={"source": "docs", "mode": "authoritative"})

            assert response.status_code == 200
            data = response.json()
            assert data["mode"] == "authoritative"
            assert data["run_id"] == "run-1"
            assert data["complete"] is True
            assert data["count"] == 42
            assert data["promotion_state"] == "promoted"
            mock_collector.sync_all.assert_not_called()
            mock_collector.sync_authoritative_all.assert_awaited_once()

    def test_sync_docs_incomplete_authoritative_run_is_non_success(self, client):
        """Incomplete authoritative evidence is recorded and returned as an explicit failure receipt."""
        result = {
            "run_id": "run-incomplete",
            "complete": False,
            "count": 7,
            "errors": [{"endpoint": "techs", "stage": "page", "error": "timeout"}],
            "by_type": {"techs": {"complete": False}},
            "promotion_state": "rejected",
        }
        state_manager = MagicMock()
        with (
            patch("skald_worker.api.routes.get_docs_collector") as mock_get_collector,
            patch("skald_worker.api.routes.get_sync_state_manager", return_value=state_manager),
            patch("skald_worker.api.routes.sync_jobs_total") as jobs_metric,
        ):
            mock_collector = AsyncMock()
            mock_collector.sync_authoritative_all.return_value = result
            mock_get_collector.return_value = mock_collector

            response = client.post("/sync", json={"source": "docs", "mode": "authoritative"})

        assert response.status_code == 502
        receipt = response.json()["detail"]
        assert receipt["status"] == "incomplete"
        assert receipt["complete"] is False
        assert receipt["run_id"] == "run-incomplete"
        state_manager.record_sync_failure.assert_called_once()
        state_manager.record_sync_success.assert_not_called()
        jobs_metric.labels.assert_any_call(source="docs", status="error")

    def test_sync_docs_failure_is_reported(self, client):
        """Collector failures do not return a misleading completed response."""
        with patch("skald_worker.api.routes.get_docs_collector") as mock_get_collector:
            mock_collector = AsyncMock()
            mock_collector.sync_all.side_effect = RuntimeError("SPMS unavailable")
            mock_get_collector.return_value = mock_collector

            response = client.post(
                "/sync",
                json={"source": "docs", "mode": "full_backfill", "options": {"max_documents": 100}},
            )

            assert response.status_code == 500

    def test_sync_rejects_docs_mode_for_other_sources(self, client):
        """Authoritative mode cannot be confused with an ordinary source sync."""
        response = client.post("/sync", json={"source": "jira", "mode": "authoritative"})

        assert response.status_code == 400

    def test_sync_requires_configured_api_key(self, app, monkeypatch):
        """Every manual sync mode remains protected by worker API authentication."""
        monkeypatch.setattr("skald_worker.middleware.auth.settings.worker_api_key", "sync-secret")
        client = TestClient(app)

        missing = client.post("/sync", json={"source": "docs", "mode": "full_backfill"})
        invalid = client.post(
            "/sync",
            headers={"X-API-Key": "wrong"},
            json={"source": "docs", "mode": "authoritative"},
        )

        assert missing.status_code == 401
        assert invalid.status_code == 403

    def test_sync_fails_closed_when_api_key_is_unset(self, app, monkeypatch):
        """Manual mutation is unavailable when no worker credential is configured."""
        monkeypatch.setattr("skald_worker.middleware.auth.settings.worker_api_key", "")
        response = TestClient(app).post(
            "/sync",
            headers={"X-API-Key": "attacker-supplied"},
            json={"source": "docs", "mode": "full_backfill"},
        )

        assert response.status_code == 401

    def test_sync_accepts_configured_bearer_and_rejects_missing_bearer(self, app, monkeypatch):
        """Configured bearer credentials work; absent or incorrect bearer credentials do not."""
        monkeypatch.setattr("skald_worker.middleware.auth.settings.worker_api_key", "sync-secret")
        with patch("skald_worker.api.routes.get_docs_collector") as mock_get_collector:
            mock_collector = AsyncMock()
            mock_collector.sync_all.return_value = {
                "total": {"processed": 0, "failed": 0, "skipped": 0},
                "by_type": {},
            }
            mock_get_collector.return_value = mock_collector
            client = TestClient(app)

            accepted = client.post(
                "/sync",
                headers={"Authorization": "Bearer sync-secret"},
                json={"source": "docs", "mode": "incremental"},
            )
            missing = client.post("/sync", json={"source": "docs", "mode": "incremental"})
            wrong = client.post(
                "/sync",
                headers={"Authorization": "Bearer wrong"},
                json={"source": "docs", "mode": "incremental"},
            )

        assert accepted.status_code == 200
        assert missing.status_code == 401
        assert wrong.status_code == 403

    def test_sync_invalid_source(self, client):
        """Test sync endpoint with invalid source."""
        response = client.post(
            "/sync",
            json={"source": "invalid"},
        )

        assert response.status_code == 400
