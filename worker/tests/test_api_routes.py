"""Tests for API routes."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
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
            mock_settings.jira_server = "https://jira.test"
            mock_settings.jira_user = "test"
            mock_settings.jira_password = "test"
            mock_settings.jira_jql_filter = "project = TEST"
            mock_settings.jira_poll_interval_minutes = 60
            mock_settings.spms_base_url = "https://docs.test"
            mock_settings.spms_api_key = "test"
            mock_settings.docs_poll_interval_minutes = 120
            mock_settings.worker_concurrency = 2
            mock_settings.host = "0.0.0.0"
            mock_settings.port = 8080
            mock_settings.environment = "test"
            mock_settings.log_level = "INFO"

            from fastapi import FastAPI
            from skald_worker.api.routes import router

            app = FastAPI()
            app.include_router(router)
            return app

    @pytest.fixture
    def client(self, app):
        """Create test client."""
        return TestClient(app)

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
            "response": "This is the AI response",
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
            assert "response" in data

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
            assert data["result"]["processed"] == 9

    def test_sync_docs_endpoint(self, client):
        """Test sync endpoint for docs."""
        mock_result = {
            "processed": 50,
            "failed": 2,
        }

        with patch("skald_worker.api.routes.get_docs_collector") as mock_get_collector:
            mock_collector = AsyncMock()
            mock_collector.sync_all.return_value = mock_result
            mock_get_collector.return_value = mock_collector

            response = client.post(
                "/sync",
                json={"source": "docs", "options": {"max_documents": 100}},
            )

            assert response.status_code == 200
            data = response.json()
            assert data["source"] == "docs"
            assert data["result"]["processed"] == 50

    def test_sync_invalid_source(self, client):
        """Test sync endpoint with invalid source."""
        response = client.post(
            "/sync",
            json={"source": "invalid"},
        )

        assert response.status_code == 422  # Validation error
