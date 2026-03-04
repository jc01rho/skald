"""Tests for structured error responses."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from skald_worker.errors import (
    ErrorCode,
    ErrorDetail,
    ErrorResponse,
    WorkerHTTPException,
    bad_request,
    circuit_breaker_open,
    external_service_error,
    forbidden,
    integration_not_configured,
    internal_error,
    not_found,
    rate_limited,
    unauthorized,
)


class TestErrorResponse:
    """Test ErrorResponse model."""

    def test_error_response_structure(self):
        """ErrorResponse has correct structure."""
        response = ErrorResponse(
            error="TEST_ERROR",
            message="Test error message",
            path="/test",
        )

        assert response.error == "TEST_ERROR"
        assert response.message == "Test error message"
        assert response.path == "/test"
        assert response.timestamp is not None

    def test_error_response_with_details(self):
        """ErrorResponse includes error details."""
        details = [
            ErrorDetail(field="name", message="Name is required", code="required"),
            ErrorDetail(field="email", message="Invalid email format", code="format"),
        ]

        response = ErrorResponse(
            error="VALIDATION_ERROR",
            message="Validation failed",
            details=details,
        )

        assert len(response.details) == 2
        assert response.details[0].field == "name"
        assert response.details[1].code == "format"


class TestErrorFactories:
    """Test error factory functions."""

    def test_bad_request(self):
        """bad_request creates 400 error."""
        error = bad_request("Invalid input")

        assert error.status_code == 400
        assert error.error_code == ErrorCode.BAD_REQUEST
        assert error.error_message == "Invalid input"

    def test_unauthorized(self):
        """unauthorized creates 401 error."""
        error = unauthorized()

        assert error.status_code == 401
        assert error.error_code == ErrorCode.UNAUTHORIZED

    def test_forbidden(self):
        """forbidden creates 403 error."""
        error = forbidden("Access denied")

        assert error.status_code == 403
        assert error.error_code == ErrorCode.FORBIDDEN

    def test_not_found(self):
        """not_found creates 404 error with resource name."""
        error = not_found("Issue", "PROJ-123")

        assert error.status_code == 404
        assert error.error_code == ErrorCode.NOT_FOUND
        assert "PROJ-123" in error.error_message

    def test_integration_not_configured(self):
        """integration_not_configured creates 400 error."""
        error = integration_not_configured("Jira")

        assert error.status_code == 400
        assert error.error_code == ErrorCode.INTEGRATION_NOT_CONFIGURED
        assert "Jira" in error.error_message
        assert error.error_details is not None

    def test_external_service_error(self):
        """external_service_error creates 502 error."""
        original = ValueError("Connection failed")
        error = external_service_error("Skald", "API call failed", original)

        assert error.status_code == 502
        assert error.error_code == ErrorCode.EXTERNAL_SERVICE_ERROR
        assert "Skald" in error.error_message
        assert error.error_details[0].message == "Connection failed"

    def test_circuit_breaker_open(self):
        """circuit_breaker_open creates 503 error with Retry-After."""
        error = circuit_breaker_open("Skald", 30.0)

        assert error.status_code == 503
        assert error.error_code == ErrorCode.CIRCUIT_BREAKER_OPEN
        assert error.headers["Retry-After"] == "30"

    def test_rate_limited(self):
        """rate_limited creates 429 error with Retry-After."""
        error = rate_limited(60)

        assert error.status_code == 429
        assert error.error_code == ErrorCode.RATE_LIMITED
        assert error.headers["Retry-After"] == "60"

    def test_internal_error(self):
        """internal_error creates 500 error."""
        error = internal_error("Something went wrong")

        assert error.status_code == 500
        assert error.error_code == ErrorCode.INTERNAL_ERROR


class TestWorkerHTTPException:
    """Test WorkerHTTPException usage in FastAPI."""

    def test_exception_in_route(self):
        """WorkerHTTPException works correctly in routes."""
        app = FastAPI()

        @app.get("/test")
        async def test_route():
            raise bad_request("Test error", [ErrorDetail(field="test", message="Test message")])

        client = TestClient(app)
        response = client.get("/test")

        assert response.status_code == 400
        # FastAPI converts detail to string by default
        assert "Test error" in response.text
