"""Authentication middleware for worker API endpoints.

Provides API key validation for securing worker endpoints.
"""

import secrets
from typing import Annotated

import structlog
from fastapi import Depends, Header, Request
from fastapi.security import APIKeyHeader

from skald_worker.config import settings
from skald_worker.errors import forbidden, unauthorized

logger = structlog.get_logger(__name__)

# API key header scheme
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def verify_api_key(api_key: str | None) -> bool:
    """Verify the provided API key.

    Uses constant-time comparison to prevent timing attacks.

    Args:
        api_key: API key to verify

    Returns:
        True if valid, False otherwise
    """
    if not settings.worker_api_key:
        # No API key configured, allow all requests
        return True

    if not api_key:
        return False

    # Constant-time comparison
    return secrets.compare_digest(api_key, settings.worker_api_key)


async def require_api_key(
    request: Request,
    api_key: Annotated[str | None, Depends(api_key_header)] = None,
) -> str | None:
    """Dependency that requires a valid API key.

    Args:
        request: FastAPI request object
        api_key: API key from header

    Returns:
        The validated API key

    Raises:
        HTTPException: If API key is missing or invalid
    """
    # Skip auth for health and metrics endpoints
    if request.url.path in ["/health", "/metrics"]:
        return None

    # If no API key configured, allow all requests
    if not settings.worker_api_key:
        return None

    if not api_key:
        logger.warning(
            "Missing API key",
            path=request.url.path,
            client_ip=request.client.host if request.client else "unknown",
        )
        raise unauthorized("API key required")

    if not verify_api_key(api_key):
        logger.warning(
            "Invalid API key",
            path=request.url.path,
            client_ip=request.client.host if request.client else "unknown",
        )
        raise forbidden("Invalid API key")

    return api_key


async def optional_api_key(
    api_key: Annotated[str | None, Depends(api_key_header)] = None,
) -> str | None:
    """Dependency that optionally validates an API key.

    Unlike require_api_key, this does not raise an exception if no key is provided.
    Useful for endpoints that support both authenticated and public access.

    Args:
        api_key: API key from header

    Returns:
        The API key if valid, None otherwise
    """
    if api_key and verify_api_key(api_key):
        return api_key
    return None


class APIKeyMiddleware:
    """Middleware for API key validation.

    Can be used as an alternative to the dependency injection approach
    when you want to protect all routes by default.
    """

    # Paths that don't require authentication
    PUBLIC_PATHS = {"/health", "/metrics", "/docs", "/openapi.json", "/redoc"}

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope["path"]

        # Skip auth for public paths
        if path in self.PUBLIC_PATHS:
            await self.app(scope, receive, send)
            return

        # If no API key configured, allow all requests
        if not settings.worker_api_key:
            await self.app(scope, receive, send)
            return

        # Check for API key in headers
        headers = dict(scope.get("headers", []))
        api_key = headers.get(b"x-api-key", b"").decode("utf-8")

        if not verify_api_key(api_key):
            # Send 401 response
            from fastapi.responses import JSONResponse

            from skald_worker.errors import ErrorCode, ErrorResponse

            response = JSONResponse(
                status_code=401,
                content=ErrorResponse(
                    error=ErrorCode.UNAUTHORIZED.value,
                    message="API key required" if not api_key else "Invalid API key",
                    path=path,
                ).model_dump(exclude_none=True),
            )
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)
