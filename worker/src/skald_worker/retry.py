"""Retry utilities with exponential backoff for external API calls."""

from collections.abc import Callable
from typing import Any, TypeVar

import httpx
import structlog
from tenacity import (
    AsyncRetrying,
    RetryError,
    before_sleep_log,
    retry,
    retry_any,
    retry_if_exception,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

logger = structlog.get_logger(__name__)

# Type variable for generic return types
T = TypeVar("T")

# Exceptions that should trigger a retry
RETRYABLE_EXCEPTIONS = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.WriteTimeout,
    httpx.PoolTimeout,
    httpx.NetworkError,
)

# HTTP status codes that should trigger a retry
RETRYABLE_STATUS_CODES = {408, 429}


def is_retryable_httpx_error(exc: BaseException) -> bool:
    """Check if an httpx exception should be retried.

    Args:
        exc: Exception to check

    Returns:
        True if the exception should trigger a retry
    """
    if isinstance(exc, RETRYABLE_EXCEPTIONS):
        return True

    if isinstance(exc, httpx.HTTPStatusError):
        status_code = exc.response.status_code
        return status_code in RETRYABLE_STATUS_CODES or 500 <= status_code < 600

    return False


retry_if_retryable_httpx_error = retry_if_exception(is_retryable_httpx_error)


# Default retry configuration for async HTTP calls
def async_http_retry(
    max_attempts: int = 3,
    min_wait: float = 1.0,
    max_wait: float = 30.0,
    multiplier: float = 2.0,
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """Decorator for async HTTP calls with exponential backoff.

    Args:
        max_attempts: Maximum number of retry attempts
        min_wait: Minimum wait time between retries (seconds)
        max_wait: Maximum wait time between retries (seconds)
        multiplier: Exponential backoff multiplier

    Returns:
        Decorated function with retry logic
    """
    return retry(
        retry=retry_any(
            retry_if_exception_type(RETRYABLE_EXCEPTIONS),
            retry_if_retryable_httpx_error,
        ),
        stop=stop_after_attempt(max_attempts),
        wait=wait_exponential(multiplier=multiplier, min=min_wait, max=max_wait),
        before_sleep=before_sleep_log(logger, log_level=20),  # 20 = INFO
        reraise=True,
    )


async def with_retry(
    func: Callable[..., T],
    *args: Any,
    max_attempts: int = 3,
    min_wait: float = 1.0,
    max_wait: float = 30.0,
    multiplier: float = 2.0,
    **kwargs: Any,
) -> T:
    """Execute an async function with retry logic.

    Args:
        func: Async function to execute
        *args: Positional arguments for the function
        max_attempts: Maximum retry attempts
        min_wait: Minimum wait between retries (seconds)
        max_wait: Maximum wait between retries (seconds)
        multiplier: Exponential backoff multiplier
        **kwargs: Keyword arguments for the function

    Returns:
        Function result

    Raises:
        RetryError: If all retries are exhausted
        Exception: The original exception if non-retryable
    """
    retrying = AsyncRetrying(
        retry=retry_any(
            retry_if_exception_type(RETRYABLE_EXCEPTIONS),
            retry_if_retryable_httpx_error,
        ),
        stop=stop_after_attempt(max_attempts),
        wait=wait_exponential(multiplier=multiplier, min=min_wait, max=max_wait),
        before_sleep=before_sleep_log(logger, log_level=20),
        reraise=True,
    )

    async for attempt in retrying:
        with attempt:
            return await func(*args, **kwargs)

    # This should never be reached due to reraise=True
    raise RetryError(None)


class RetryableHTTPClient:
    """Mixin providing retry-enabled HTTP methods for httpx.AsyncClient."""

    client: httpx.AsyncClient
    max_retries: int = 3
    retry_min_wait: float = 1.0
    retry_max_wait: float = 30.0
    retry_multiplier: float = 2.0

    async def _request_with_retry(
        self,
        method: str,
        url: str,
        **kwargs: Any,
    ) -> httpx.Response:
        """Execute HTTP request with retry logic.

        Args:
            method: HTTP method (GET, POST, etc.)
            url: Request URL
            **kwargs: Additional request arguments

        Returns:
            HTTP response
        """

        async def _do_request() -> httpx.Response:
            response = await self.client.request(method, url, **kwargs)
            response.raise_for_status()
            return response

        return await with_retry(
            _do_request,
            max_attempts=self.max_retries,
            min_wait=self.retry_min_wait,
            max_wait=self.retry_max_wait,
            multiplier=self.retry_multiplier,
        )

    async def get_with_retry(self, url: str, **kwargs: Any) -> httpx.Response:
        """GET request with retry."""
        return await self._request_with_retry("GET", url, **kwargs)

    async def post_with_retry(self, url: str, **kwargs: Any) -> httpx.Response:
        """POST request with retry."""
        return await self._request_with_retry("POST", url, **kwargs)

    async def patch_with_retry(self, url: str, **kwargs: Any) -> httpx.Response:
        """PATCH request with retry."""
        return await self._request_with_retry("PATCH", url, **kwargs)

    async def put_with_retry(self, url: str, **kwargs: Any) -> httpx.Response:
        """PUT request with retry."""
        return await self._request_with_retry("PUT", url, **kwargs)

    async def delete_with_retry(self, url: str, **kwargs: Any) -> httpx.Response:
        """DELETE request with retry."""
        return await self._request_with_retry("DELETE", url, **kwargs)
