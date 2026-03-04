"""Tests for authentication middleware."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from skald_worker.middleware.auth import require_api_key


@pytest.fixture
def app_with_auth():
    """Create a test app with auth middleware."""
    from fastapi import Depends

    app = FastAPI()

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/protected")
    async def protected(_api_key: str | None = Depends(require_api_key)):
        return {"message": "secret"}

    return app


class TestAPIKeyAuthentication:
    """Test API key authentication."""

    def test_health_endpoint_no_auth_required(self, app_with_auth, monkeypatch):
        """Health endpoint doesn't require authentication."""
        monkeypatch.setattr("skald_worker.config.settings.worker_api_key", "test-secret")
        client = TestClient(app_with_auth)

        response = client.get("/health")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_protected_endpoint_requires_auth(self, app_with_auth, monkeypatch):
        """Protected endpoint requires API key when configured."""
        monkeypatch.setattr("skald_worker.config.settings.worker_api_key", "test-secret")
        monkeypatch.setattr("skald_worker.middleware.auth.settings.worker_api_key", "test-secret")
        client = TestClient(app_with_auth)

        response = client.get("/protected")

        assert response.status_code == 401

    def test_protected_endpoint_accepts_valid_key(self, app_with_auth, monkeypatch):
        """Protected endpoint accepts valid API key."""
        monkeypatch.setattr("skald_worker.config.settings.worker_api_key", "test-secret")
        monkeypatch.setattr("skald_worker.middleware.auth.settings.worker_api_key", "test-secret")
        client = TestClient(app_with_auth)

        response = client.get("/protected", headers={"X-API-Key": "test-secret"})

        assert response.status_code == 200
        assert response.json()["message"] == "secret"

    def test_protected_endpoint_rejects_invalid_key(self, app_with_auth, monkeypatch):
        """Protected endpoint rejects invalid API key."""
        monkeypatch.setattr("skald_worker.config.settings.worker_api_key", "test-secret")
        monkeypatch.setattr("skald_worker.middleware.auth.settings.worker_api_key", "test-secret")
        client = TestClient(app_with_auth)

        response = client.get("/protected", headers={"X-API-Key": "wrong-key"})

        assert response.status_code == 403

    def test_no_auth_when_key_not_configured(self, app_with_auth, monkeypatch):
        """No authentication required when API key is not configured."""
        monkeypatch.setattr("skald_worker.config.settings.worker_api_key", "")
        monkeypatch.setattr("skald_worker.middleware.auth.settings.worker_api_key", "")
        client = TestClient(app_with_auth)

        response = client.get("/protected")

        assert response.status_code == 200
        assert response.json()["message"] == "secret"


class TestVerifyAPIKey:
    """Test verify_api_key function."""

    def test_verify_returns_true_for_valid_key(self, monkeypatch):
        """Returns True for valid API key."""
        from skald_worker.middleware.auth import verify_api_key

        monkeypatch.setattr("skald_worker.middleware.auth.settings.worker_api_key", "my-secret")

        assert verify_api_key("my-secret") is True

    def test_verify_returns_false_for_invalid_key(self, monkeypatch):
        """Returns False for invalid API key."""
        from skald_worker.middleware.auth import verify_api_key

        monkeypatch.setattr("skald_worker.middleware.auth.settings.worker_api_key", "my-secret")

        assert verify_api_key("wrong-key") is False

    def test_verify_returns_false_for_none(self, monkeypatch):
        """Returns False for None API key."""
        from skald_worker.middleware.auth import verify_api_key

        monkeypatch.setattr("skald_worker.middleware.auth.settings.worker_api_key", "my-secret")

        assert verify_api_key(None) is False

    def test_verify_returns_true_when_not_configured(self, monkeypatch):
        """Returns True when API key is not configured (auth disabled)."""
        from skald_worker.middleware.auth import verify_api_key

        monkeypatch.setattr("skald_worker.middleware.auth.settings.worker_api_key", "")

        assert verify_api_key(None) is True
        assert verify_api_key("any-key") is True
