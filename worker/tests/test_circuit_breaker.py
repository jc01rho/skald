"""Tests for circuit breaker functionality."""

import asyncio

import pytest

from skald_worker.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitBreakerError,
    CircuitState,
    get_circuit_breaker,
    reset_all_circuit_breakers,
)


@pytest.fixture(autouse=True)
def reset_breakers():
    """Reset all circuit breakers before each test."""
    reset_all_circuit_breakers()
    yield
    reset_all_circuit_breakers()


class TestCircuitBreakerStates:
    """Test circuit breaker state transitions."""

    def test_initial_state_is_closed(self):
        """Circuit breaker starts in CLOSED state."""
        breaker = CircuitBreaker("test")
        assert breaker.state == CircuitState.CLOSED
        assert breaker.is_closed
        assert not breaker.is_open

    def test_opens_after_failure_threshold(self):
        """Circuit opens after reaching failure threshold."""
        config = CircuitBreakerConfig(failure_threshold=3)
        breaker = CircuitBreaker("test", config)

        for _ in range(3):
            breaker.record_failure(Exception("test error"))

        assert breaker.state == CircuitState.OPEN
        assert breaker.is_open

    def test_remains_closed_below_threshold(self):
        """Circuit stays closed below failure threshold."""
        config = CircuitBreakerConfig(failure_threshold=5)
        breaker = CircuitBreaker("test", config)

        for _ in range(4):
            breaker.record_failure(Exception("test error"))

        assert breaker.state == CircuitState.CLOSED
        assert breaker.is_closed

    def test_success_resets_failure_count(self):
        """Successful call resets failure count."""
        config = CircuitBreakerConfig(failure_threshold=5)
        breaker = CircuitBreaker("test", config)

        for _ in range(4):
            breaker.record_failure(Exception("test error"))

        breaker.record_success()

        # Should be able to fail 4 more times without opening
        for _ in range(4):
            breaker.record_failure(Exception("test error"))

        assert breaker.state == CircuitState.CLOSED


class TestCircuitBreakerRecovery:
    """Test circuit breaker recovery behavior."""

    @pytest.mark.asyncio
    async def test_transitions_to_half_open_after_timeout(self):
        """Circuit transitions to HALF_OPEN after recovery timeout."""
        config = CircuitBreakerConfig(failure_threshold=1, recovery_timeout=0.1)
        breaker = CircuitBreaker("test", config)

        breaker.record_failure(Exception("test error"))
        assert breaker.state == CircuitState.OPEN

        await asyncio.sleep(0.15)
        assert breaker.state == CircuitState.HALF_OPEN

    def test_success_in_half_open_closes_circuit(self):
        """Successful calls in HALF_OPEN close the circuit."""
        config = CircuitBreakerConfig(
            failure_threshold=1,
            recovery_timeout=0.0,
            success_threshold=2,
        )
        breaker = CircuitBreaker("test", config)

        breaker.record_failure(Exception("test error"))
        assert breaker.state == CircuitState.HALF_OPEN

        breaker.record_success()
        assert breaker.state == CircuitState.HALF_OPEN

        breaker.record_success()
        assert breaker.state == CircuitState.CLOSED

    def test_failure_in_half_open_reopens_circuit(self):
        """Failure in HALF_OPEN reopens the circuit."""
        config = CircuitBreakerConfig(failure_threshold=1, recovery_timeout=0.0)
        breaker = CircuitBreaker("test", config)

        breaker.record_failure(Exception("test error"))
        assert breaker.state == CircuitState.HALF_OPEN

        breaker.record_failure(Exception("another error"))
        assert breaker.state == CircuitState.OPEN


class TestCircuitBreakerContextManager:
    """Test circuit breaker async context manager."""

    @pytest.mark.asyncio
    async def test_context_manager_records_success(self):
        """Context manager records success on clean exit."""
        breaker = CircuitBreaker("test")

        async with breaker:
            pass

        # After success, failure count should be 0
        assert breaker._state.failure_count == 0

    @pytest.mark.asyncio
    async def test_context_manager_records_failure(self):
        """Context manager records failure on exception."""
        breaker = CircuitBreaker("test")

        with pytest.raises(ValueError):
            async with breaker:
                raise ValueError("test error")

        assert breaker._state.failure_count == 1

    @pytest.mark.asyncio
    async def test_context_manager_rejects_when_open(self):
        """Context manager raises error when circuit is open."""
        config = CircuitBreakerConfig(failure_threshold=1, recovery_timeout=60.0)
        breaker = CircuitBreaker("test", config)

        breaker.record_failure(Exception("test error"))

        with pytest.raises(CircuitBreakerError) as exc_info:
            async with breaker:
                pass

        assert exc_info.value.name == "test"
        assert exc_info.value.recovery_time > 0


class TestCircuitBreakerDecorator:
    """Test circuit breaker as decorator."""

    @pytest.mark.asyncio
    async def test_decorator_wraps_function(self):
        """Decorator wraps async function with circuit breaker."""
        breaker = CircuitBreaker("test")

        @breaker
        async def my_function():
            return "success"

        result = await my_function()
        assert result == "success"

    @pytest.mark.asyncio
    async def test_decorator_records_failure(self):
        """Decorator records failures from wrapped function."""
        config = CircuitBreakerConfig(failure_threshold=2)
        breaker = CircuitBreaker("test", config)

        @breaker
        async def failing_function():
            raise RuntimeError("test error")

        with pytest.raises(RuntimeError):
            await failing_function()

        assert breaker._state.failure_count == 1


class TestCircuitBreakerRegistry:
    """Test circuit breaker registry functions."""

    def test_get_circuit_breaker_creates_new(self):
        """get_circuit_breaker creates new breaker if not exists."""
        breaker = get_circuit_breaker("new-test-breaker")
        assert breaker.name == "new-test-breaker"

    def test_get_circuit_breaker_returns_existing(self):
        """get_circuit_breaker returns existing breaker."""
        breaker1 = get_circuit_breaker("existing-test")
        breaker2 = get_circuit_breaker("existing-test")
        assert breaker1 is breaker2

    def test_get_status_returns_dict(self):
        """get_status returns circuit breaker status dict."""
        config = CircuitBreakerConfig(failure_threshold=5)
        breaker = CircuitBreaker("status-test", config)

        status = breaker.get_status()

        assert status["name"] == "status-test"
        assert status["state"] == "closed"
        assert status["failure_count"] == 0
        assert status["config"]["failure_threshold"] == 5


class TestCircuitBreakerExclusions:
    """Test exception exclusion from circuit breaker."""

    def test_excluded_exceptions_not_counted(self):
        """Excluded exceptions don't count toward failure threshold."""

        class ExcludedError(Exception):
            pass

        config = CircuitBreakerConfig(
            failure_threshold=2,
            exclude_exceptions=(ExcludedError,),
        )
        breaker = CircuitBreaker("test", config)

        breaker.record_failure(ExcludedError("excluded"))
        breaker.record_failure(ExcludedError("excluded"))
        breaker.record_failure(ExcludedError("excluded"))

        assert breaker.state == CircuitState.CLOSED
        assert breaker._state.failure_count == 0

    def test_non_excluded_exceptions_counted(self):
        """Non-excluded exceptions count toward failure threshold."""

        class ExcludedError(Exception):
            pass

        config = CircuitBreakerConfig(
            failure_threshold=2,
            exclude_exceptions=(ExcludedError,),
        )
        breaker = CircuitBreaker("test", config)

        breaker.record_failure(ValueError("not excluded"))
        breaker.record_failure(ValueError("not excluded"))

        assert breaker.state == CircuitState.OPEN
