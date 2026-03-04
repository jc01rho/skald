"""Structured error responses for consistent API error handling.

Provides a unified error response format across all worker endpoints.
"""

from datetime import datetime
from enum import Enum
from typing import Any

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field


class ErrorCode(str, Enum):
    """Standardized error codes for the worker API."""

    # Client errors (4xx)
    BAD_REQUEST = "BAD_REQUEST"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    NOT_FOUND = "NOT_FOUND"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    RATE_LIMITED = "RATE_LIMITED"
    INTEGRATION_NOT_CONFIGURED = "INTEGRATION_NOT_CONFIGURED"

    # Server errors (5xx)
    INTERNAL_ERROR = "INTERNAL_ERROR"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"
    EXTERNAL_SERVICE_ERROR = "EXTERNAL_SERVICE_ERROR"
    CIRCUIT_BREAKER_OPEN = "CIRCUIT_BREAKER_OPEN"
    TIMEOUT = "TIMEOUT"


class ErrorDetail(BaseModel):
    """Detailed information about an error."""

    field: str | None = Field(None, description="Field name if validation error")
    message: str = Field(..., description="Human-readable error message")
    code: str | None = Field(None, description="Machine-readable error code")


class ErrorResponse(BaseModel):
    """Standardized error response format."""

    error: str = Field(..., description="Error code")
    message: str = Field(..., description="Human-readable error message")
    details: list[ErrorDetail] | None = Field(None, description="Additional error details")
    request_id: str | None = Field(None, description="Request ID for tracing")
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
    path: str | None = Field(None, description="Request path")

    class Config:
        json_schema_extra = {
            "example": {
                "error": "VALIDATION_ERROR",
                "message": "Request validation failed",
                "details": [{"field": "query", "message": "Field is required", "code": "required"}],
                "request_id": "req_abc123",
                "timestamp": "2024-01-10T12:00:00Z",
                "path": "/search",
            }
        }


class WorkerHTTPException(HTTPException):
    """Extended HTTPException with structured error support."""

    def __init__(
        self,
        status_code: int,
        error_code: ErrorCode,
        message: str,
        details: list[ErrorDetail] | None = None,
        headers: dict[str, str] | None = None,
    ):
        self.error_code = error_code
        self.error_message = message
        self.error_details = details
        super().__init__(status_code=status_code, detail=message, headers=headers)


def create_error_response(
    status_code: int,
    error_code: ErrorCode,
    message: str,
    details: list[ErrorDetail] | None = None,
    request: Request | None = None,
    request_id: str | None = None,
) -> JSONResponse:
    """Create a structured error response.

    Args:
        status_code: HTTP status code
        error_code: Standardized error code
        message: Human-readable error message
        details: Optional additional error details
        request: Optional request object for path extraction
        request_id: Optional request ID for tracing

    Returns:
        JSONResponse with structured error body
    """
    body = ErrorResponse(
        error=error_code.value,
        message=message,
        details=details,
        request_id=request_id,
        path=str(request.url.path) if request else None,
    )

    return JSONResponse(
        status_code=status_code,
        content=body.model_dump(exclude_none=True),
    )


# Common error factories


def bad_request(message: str, details: list[ErrorDetail] | None = None) -> WorkerHTTPException:
    """Create a 400 Bad Request error."""
    return WorkerHTTPException(
        status_code=400,
        error_code=ErrorCode.BAD_REQUEST,
        message=message,
        details=details,
    )


def unauthorized(message: str = "Authentication required") -> WorkerHTTPException:
    """Create a 401 Unauthorized error."""
    return WorkerHTTPException(
        status_code=401,
        error_code=ErrorCode.UNAUTHORIZED,
        message=message,
    )


def forbidden(message: str = "Access denied") -> WorkerHTTPException:
    """Create a 403 Forbidden error."""
    return WorkerHTTPException(
        status_code=403,
        error_code=ErrorCode.FORBIDDEN,
        message=message,
    )


def not_found(resource: str, identifier: str | None = None) -> WorkerHTTPException:
    """Create a 404 Not Found error."""
    if identifier:
        message = f"{resource} '{identifier}' not found"
    else:
        message = f"{resource} not found"
    return WorkerHTTPException(
        status_code=404,
        error_code=ErrorCode.NOT_FOUND,
        message=message,
    )


def integration_not_configured(integration: str) -> WorkerHTTPException:
    """Create an error for unconfigured integrations (Jira, docs, etc.)."""
    return WorkerHTTPException(
        status_code=400,
        error_code=ErrorCode.INTEGRATION_NOT_CONFIGURED,
        message=f"{integration} integration is not configured",
        details=[
            ErrorDetail(
                message=f"Please configure {integration} settings in environment variables",
                code="missing_config",
            )
        ],
    )


def external_service_error(
    service: str,
    message: str,
    original_error: Exception | None = None,
) -> WorkerHTTPException:
    """Create an error for external service failures."""
    details = None
    if original_error:
        details = [
            ErrorDetail(
                message=str(original_error),
                code="external_error",
            )
        ]
    return WorkerHTTPException(
        status_code=502,
        error_code=ErrorCode.EXTERNAL_SERVICE_ERROR,
        message=f"{service} service error: {message}",
        details=details,
    )


def circuit_breaker_open(service: str, recovery_time: float) -> WorkerHTTPException:
    """Create an error when circuit breaker is open."""
    return WorkerHTTPException(
        status_code=503,
        error_code=ErrorCode.CIRCUIT_BREAKER_OPEN,
        message=f"{service} service is temporarily unavailable",
        details=[
            ErrorDetail(
                message=f"Service health check in progress. Retry after {recovery_time:.0f} seconds.",
                code="circuit_open",
            )
        ],
        headers={"Retry-After": str(int(recovery_time))},
    )


def service_unavailable(message: str = "Service temporarily unavailable") -> WorkerHTTPException:
    """Create a 503 Service Unavailable error."""
    return WorkerHTTPException(
        status_code=503,
        error_code=ErrorCode.SERVICE_UNAVAILABLE,
        message=message,
    )


def internal_error(message: str = "An unexpected error occurred") -> WorkerHTTPException:
    """Create a 500 Internal Server Error."""
    return WorkerHTTPException(
        status_code=500,
        error_code=ErrorCode.INTERNAL_ERROR,
        message=message,
    )


def rate_limited(retry_after: int = 60) -> WorkerHTTPException:
    """Create a 429 Too Many Requests error."""
    return WorkerHTTPException(
        status_code=429,
        error_code=ErrorCode.RATE_LIMITED,
        message="Rate limit exceeded",
        details=[
            ErrorDetail(
                message=f"Please retry after {retry_after} seconds",
                code="rate_limit",
            )
        ],
        headers={"Retry-After": str(retry_after)},
    )
