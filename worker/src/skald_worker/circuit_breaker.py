"""Circuit breaker pattern for external API calls.

Prevents cascading failures by failing fast when an external service is unhealthy.
After a configurable number of failures, the circuit opens and requests fail immediately
without making actual calls. After a cooldown period, the circuit enters half-open state
and allows a test request through.

States:
- CLOSED: Normal operation, requests go through
- OPEN: Service unhealthy, requests fail immediately
- HALF_OPEN: Testing if service recovered, one request allowed
"""

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, TypeVar

import structlog

logger = structlog.get_logger(__name__)

T = TypeVar("T")


class CircuitState(Enum):
    """Circuit breaker states."""

    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass
class CircuitBreakerConfig:
    """Configuration for circuit breaker."""

    # Number of consecutive failures before opening the circuit
    failure_threshold: int = 5

    # Seconds to wait before transitioning from OPEN to HALF_OPEN
    recovery_timeout: float = 30.0

    # Number of successful calls needed to close circuit from HALF_OPEN
    success_threshold: int = 2

    # Optional: Exceptions that should be counted as failures
    # If None, all exceptions count as failures
    failure_exceptions: tuple[type[Exception], ...] | None = None

    # Optional: Exceptions that should NOT open the circuit (e.g., 4xx errors)
    exclude_exceptions: tuple[type[Exception], ...] | None = None


@dataclass
class CircuitBreakerState:
    """Mutable state for circuit breaker."""

    state: CircuitState = CircuitState.CLOSED
    failure_count: int = 0
    success_count: int = 0
    last_failure_time: float = 0.0
    last_state_change: float = field(default_factory=time.time)
    recovery_pending: bool = False

    # For half-open state: only allow one request through at a time
    half_open_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class CircuitBreakerError(Exception):
    """Raised when circuit is open and call is rejected."""

    def __init__(self, name: str, recovery_time: float):
        self.name = name
        self.recovery_time = recovery_time
        super().__init__(
            f"Circuit breaker '{name}' is OPEN. Service appears unhealthy. Retry after {recovery_time:.1f}s."
        )


class CircuitBreaker:
    """Circuit breaker for protecting external service calls.

    Usage:
        breaker = CircuitBreaker("skald-api")

        async with breaker:
            response = await client.request(...)

        # Or with decorator
        @breaker
        async def call_external_service():
            ...
    """

    def __init__(self, name: str, config: CircuitBreakerConfig | None = None):
        self.name = name
        self.config = config or CircuitBreakerConfig()
        self._state = CircuitBreakerState()

    @property
    def state(self) -> CircuitState:
        """Get current circuit state, potentially transitioning from OPEN to HALF_OPEN."""
        if self._state.state == CircuitState.OPEN:
            if self._state.recovery_pending:
                self._state.recovery_pending = False
                return CircuitState.OPEN
            if self._should_attempt_recovery():
                self._transition_to(CircuitState.HALF_OPEN)
        return self._state.state

    @property
    def is_closed(self) -> bool:
        """Check if circuit is closed (normal operation)."""
        return self.state == CircuitState.CLOSED

    @property
    def is_open(self) -> bool:
        """Check if circuit is open (failing fast)."""
        return self.state == CircuitState.OPEN

    @property
    def time_until_recovery(self) -> float:
        """Seconds until circuit might transition to HALF_OPEN."""
        if self._state.state != CircuitState.OPEN:
            return 0.0
        elapsed = time.time() - self._state.last_failure_time
        remaining = self.config.recovery_timeout - elapsed
        return max(0.0, remaining)

    def _should_attempt_recovery(self) -> bool:
        """Check if enough time has passed to try recovery."""
        elapsed = time.time() - self._state.last_failure_time
        return elapsed >= self.config.recovery_timeout

    def _transition_to(self, new_state: CircuitState) -> None:
        """Transition to a new state."""
        old_state = self._state.state
        self._state.state = new_state
        self._state.last_state_change = time.time()

        if new_state == CircuitState.CLOSED:
            self._state.failure_count = 0
            self._state.success_count = 0
            self._state.recovery_pending = False
        elif new_state == CircuitState.OPEN:
            self._state.recovery_pending = old_state == CircuitState.HALF_OPEN
        elif new_state == CircuitState.HALF_OPEN:
            self._state.success_count = 0
            self._state.recovery_pending = False

        logger.info(
            "Circuit breaker state change",
            name=self.name,
            old_state=old_state.value,
            new_state=new_state.value,
        )

    def _is_failure_exception(self, exc: Exception) -> bool:
        """Check if exception should count as a failure."""
        # Check exclusions first
        if self.config.exclude_exceptions and isinstance(exc, self.config.exclude_exceptions):
            return False

        # If specific failure exceptions defined, check against them
        if self.config.failure_exceptions:
            return isinstance(exc, self.config.failure_exceptions)

        # Default: all exceptions are failures
        return True

    def record_success(self) -> None:
        """Record a successful call."""
        if self._state.state == CircuitState.HALF_OPEN:
            self._state.success_count += 1
            if self._state.success_count >= self.config.success_threshold:
                self._transition_to(CircuitState.CLOSED)
        elif self._state.state == CircuitState.CLOSED:
            # Reset failure count on success
            self._state.failure_count = 0

    def record_failure(self, exc: Exception) -> None:
        """Record a failed call."""
        if not self._is_failure_exception(exc):
            logger.debug(
                "Exception excluded from circuit breaker",
                name=self.name,
                exception=str(exc),
            )
            return

        self._state.failure_count += 1
        self._state.last_failure_time = time.time()

        if self._state.state == CircuitState.HALF_OPEN:
            # Any failure in half-open state reopens the circuit
            self._transition_to(CircuitState.OPEN)
        elif self._state.state == CircuitState.CLOSED and self._state.failure_count >= self.config.failure_threshold:
            self._transition_to(CircuitState.OPEN)

        logger.warning(
            "Circuit breaker recorded failure",
            name=self.name,
            failure_count=self._state.failure_count,
            state=self._state.state.value,
            exception=str(exc),
        )

    async def __aenter__(self) -> "CircuitBreaker":
        """Context manager entry."""
        current_state = self.state  # This may trigger OPEN -> HALF_OPEN transition

        if current_state == CircuitState.OPEN:
            raise CircuitBreakerError(self.name, self.time_until_recovery)

        if current_state == CircuitState.HALF_OPEN:
            # Only allow one request through at a time in half-open state
            acquired = self._state.half_open_lock.locked()
            if acquired:
                raise CircuitBreakerError(self.name, self.time_until_recovery)
            await self._state.half_open_lock.acquire()

        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> bool:
        """Context manager exit."""
        # Release half-open lock if held
        if self._state.half_open_lock.locked():
            self._state.half_open_lock.release()

        if exc_val is None:
            self.record_success()
        elif isinstance(exc_val, Exception):
            self.record_failure(exc_val)

        # Don't suppress exceptions
        return False

    def __call__(self, func: Callable[..., T]) -> Callable[..., T]:
        """Decorator for async functions."""

        async def wrapper(*args: Any, **kwargs: Any) -> T:
            async with self:
                return await func(*args, **kwargs)

        return wrapper

    def get_status(self) -> dict[str, Any]:
        """Get current circuit breaker status for health checks."""
        return {
            "name": self.name,
            "state": self.state.value,
            "failure_count": self._state.failure_count,
            "success_count": self._state.success_count,
            "time_until_recovery": self.time_until_recovery,
            "config": {
                "failure_threshold": self.config.failure_threshold,
                "recovery_timeout": self.config.recovery_timeout,
                "success_threshold": self.config.success_threshold,
            },
        }


# Registry of circuit breakers for global access
_circuit_breakers: dict[str, CircuitBreaker] = {}


def get_circuit_breaker(
    name: str,
    config: CircuitBreakerConfig | None = None,
) -> CircuitBreaker:
    """Get or create a circuit breaker by name.

    Args:
        name: Unique name for the circuit breaker
        config: Optional configuration (only used when creating new)

    Returns:
        CircuitBreaker instance
    """
    if name not in _circuit_breakers:
        _circuit_breakers[name] = CircuitBreaker(name, config)
    return _circuit_breakers[name]


def get_all_circuit_breakers() -> dict[str, CircuitBreaker]:
    """Get all registered circuit breakers."""
    return _circuit_breakers.copy()


def reset_circuit_breaker(name: str) -> None:
    """Reset a circuit breaker to closed state (for testing/recovery)."""
    if name in _circuit_breakers:
        breaker = _circuit_breakers[name]
        breaker._transition_to(CircuitState.CLOSED)


def reset_all_circuit_breakers() -> None:
    """Reset all circuit breakers to closed state."""
    for breaker in _circuit_breakers.values():
        breaker._transition_to(CircuitState.CLOSED)
