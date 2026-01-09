"""Tests for retry utilities."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import httpx
from tenacity import RetryError

from skald_worker.retry import (
    is_retryable_httpx_error,
    with_retry,
    RETRYABLE_STATUS_CODES,
)


class TestIsRetryableError:
    """Test retry predicate logic."""

    def test_connection_error_is_retryable(self):
        """Test that connection errors trigger retry."""
        exc = httpx.ConnectError("Connection refused")
        assert is_retryable_httpx_error(exc) is True

    def test_timeout_errors_are_retryable(self):
        """Test that timeout errors trigger retry."""
        assert is_retryable_httpx_error(httpx.ConnectTimeout("Timeout")) is True
        assert is_retryable_httpx_error(httpx.ReadTimeout("Timeout")) is True
        assert is_retryable_httpx_error(httpx.WriteTimeout("Timeout")) is True
        assert is_retryable_httpx_error(httpx.PoolTimeout("Timeout")) is True

    def test_network_error_is_retryable(self):
        """Test that network errors trigger retry."""
        exc = httpx.NetworkError("Network unreachable")
        assert is_retryable_httpx_error(exc) is True

    @pytest.mark.parametrize("status_code", list(RETRYABLE_STATUS_CODES))
    def test_retryable_status_codes(self, status_code):
        """Test that specific HTTP status codes trigger retry."""
        response = MagicMock()
        response.status_code = status_code
        exc = httpx.HTTPStatusError(
            message=f"HTTP {status_code}",
            request=MagicMock(),
            response=response,
        )
        assert is_retryable_httpx_error(exc) is True

    @pytest.mark.parametrize("status_code", [400, 401, 403, 404, 422])
    def test_non_retryable_status_codes(self, status_code):
        """Test that client errors do not trigger retry."""
        response = MagicMock()
        response.status_code = status_code
        exc = httpx.HTTPStatusError(
            message=f"HTTP {status_code}",
            request=MagicMock(),
            response=response,
        )
        assert is_retryable_httpx_error(exc) is False

    def test_generic_exception_not_retryable(self):
        """Test that generic exceptions do not trigger retry."""
        exc = ValueError("Some error")
        assert is_retryable_httpx_error(exc) is False


class TestWithRetry:
    """Test the with_retry helper function."""

    @pytest.mark.asyncio
    async def test_successful_call_no_retry(self):
        """Test successful call returns immediately."""
        mock_func = AsyncMock(return_value="success")

        result = await with_retry(mock_func, max_attempts=3)

        assert result == "success"
        assert mock_func.call_count == 1

    @pytest.mark.asyncio
    async def test_retry_on_transient_failure(self):
        """Test retry on transient failures."""
        mock_func = AsyncMock()
        mock_func.side_effect = [
            httpx.ConnectError("Fail 1"),
            httpx.ConnectError("Fail 2"),
            "success",
        ]

        result = await with_retry(
            mock_func,
            max_attempts=3,
            min_wait=0.01,
            max_wait=0.02,
        )

        assert result == "success"
        assert mock_func.call_count == 3

    @pytest.mark.asyncio
    async def test_exhausted_retries_raises(self):
        """Test that exhausted retries raise the original exception."""
        mock_func = AsyncMock()
        mock_func.side_effect = httpx.ConnectError("Always fails")

        with pytest.raises(httpx.ConnectError):
            await with_retry(
                mock_func,
                max_attempts=2,
                min_wait=0.01,
                max_wait=0.02,
            )

        assert mock_func.call_count == 2

    @pytest.mark.asyncio
    async def test_non_retryable_error_raises_immediately(self):
        """Test that non-retryable errors are raised immediately."""
        mock_func = AsyncMock()
        mock_func.side_effect = ValueError("Not retryable")

        with pytest.raises(ValueError):
            await with_retry(mock_func, max_attempts=3)

        assert mock_func.call_count == 1

    @pytest.mark.asyncio
    async def test_retry_on_429_rate_limit(self):
        """Test retry on 429 rate limit response."""
        response = MagicMock()
        response.status_code = 429

        mock_func = AsyncMock()
        mock_func.side_effect = [
            httpx.HTTPStatusError("Rate limited", request=MagicMock(), response=response),
            "success",
        ]

        result = await with_retry(
            mock_func,
            max_attempts=3,
            min_wait=0.01,
            max_wait=0.02,
        )

        assert result == "success"
        assert mock_func.call_count == 2

    @pytest.mark.asyncio
    async def test_retry_on_503_service_unavailable(self):
        """Test retry on 503 service unavailable."""
        response = MagicMock()
        response.status_code = 503

        mock_func = AsyncMock()
        mock_func.side_effect = [
            httpx.HTTPStatusError("Service unavailable", request=MagicMock(), response=response),
            "success",
        ]

        result = await with_retry(
            mock_func,
            max_attempts=3,
            min_wait=0.01,
            max_wait=0.02,
        )

        assert result == "success"
