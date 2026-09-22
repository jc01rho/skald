"""Regression coverage for release sync throttling and circuit-breaker backoff.

Both behaviors exist to stop one backend 429 from cascading into dozens of
permanently skipped versions, as observed in production on 2026-09-22
(processed=97, failed=45, of which 44 were CircuitBreakerError).
"""

from unittest.mock import AsyncMock, patch

import pytest

from skald_worker.circuit_breaker import CircuitBreakerError
from skald_worker.collectors.release_collector import ReleaseCollector


@pytest.fixture
def collector():
    return ReleaseCollector(base_url="https://spms.test")


def _versions(count):
    return [{"id": str(10000 + i), "name": f"v{i}"} for i in range(count)]


class TestReleaseSyncThrottle:
    @pytest.mark.asyncio
    async def test_sync_all_paces_requests_between_versions(self, collector):
        """Each version sync waits the configured delay so the backend rate limit is never tripped."""
        sleeps = []

        async def fake_sleep(seconds):
            sleeps.append(seconds)

        with (
            patch.object(collector, "fetch_versions", new=AsyncMock(return_value=_versions(3))),
            patch.object(collector, "sync_release", new=AsyncMock(return_value={"id": "memo"})),
            patch("skald_worker.collectors.release_collector.asyncio.sleep", new=fake_sleep),
            patch("skald_worker.collectors.release_collector.settings") as mock_settings,
        ):
            mock_settings.release_sync_delay_seconds = 0.25
            mock_settings.release_sync_circuit_max_waits = 5
            result = await collector.sync_all()

        assert result == {"total": 3, "processed": 3, "failed": 0}
        # Delay applies between versions, not before the first one.
        assert sleeps == [0.25, 0.25]

    @pytest.mark.asyncio
    async def test_zero_delay_skips_sleeping(self, collector):
        """A zero delay disables pacing entirely so existing deployments can opt out."""
        sleeps = []

        async def fake_sleep(seconds):
            sleeps.append(seconds)

        with (
            patch.object(collector, "fetch_versions", new=AsyncMock(return_value=_versions(3))),
            patch.object(collector, "sync_release", new=AsyncMock(return_value={"id": "memo"})),
            patch("skald_worker.collectors.release_collector.asyncio.sleep", new=fake_sleep),
            patch("skald_worker.collectors.release_collector.settings") as mock_settings,
        ):
            mock_settings.release_sync_delay_seconds = 0
            mock_settings.release_sync_circuit_max_waits = 5
            await collector.sync_all()

        assert sleeps == []


class TestCircuitBreakerBackoff:
    @pytest.mark.asyncio
    async def test_open_circuit_waits_and_retries_same_version(self, collector):
        """An open circuit must park the loop and retry the version, not burn it as failed."""
        sleeps = []

        async def fake_sleep(seconds):
            sleeps.append(seconds)

        attempts = []

        async def sync_release(summary):
            attempts.append(summary["id"])
            if len(attempts) == 1:
                raise CircuitBreakerError("skald-api", 12.5)
            return {"id": "memo"}

        with (
            patch.object(collector, "fetch_versions", new=AsyncMock(return_value=_versions(1))),
            patch.object(collector, "sync_release", new=sync_release),
            patch.object(collector, "_sync_previously_linked_jira", new=AsyncMock()) as linked,
            patch("skald_worker.collectors.release_collector.asyncio.sleep", new=fake_sleep),
            patch("skald_worker.collectors.release_collector.settings") as mock_settings,
        ):
            mock_settings.release_sync_delay_seconds = 0
            mock_settings.release_sync_circuit_max_waits = 5
            result = await collector.sync_all()

        # The version is retried after waiting out the breaker, and counted as processed.
        assert attempts == ["10000", "10000"]
        assert result == {"total": 1, "processed": 1, "failed": 0}
        assert sleeps == [12.5]
        linked.assert_not_called()

    @pytest.mark.asyncio
    async def test_circuit_wait_is_bounded_and_then_counted_as_failure(self, collector):
        """A breaker that never recovers must still terminate the run instead of looping forever."""
        sleeps = []

        async def fake_sleep(seconds):
            sleeps.append(seconds)

        with (
            patch.object(collector, "fetch_versions", new=AsyncMock(return_value=_versions(1))),
            patch.object(
                collector,
                "sync_release",
                new=AsyncMock(side_effect=CircuitBreakerError("skald-api", 3.0)),
            ),
            patch.object(collector, "_sync_previously_linked_jira", new=AsyncMock()) as linked,
            patch("skald_worker.collectors.release_collector.asyncio.sleep", new=fake_sleep),
            patch("skald_worker.collectors.release_collector.settings") as mock_settings,
        ):
            mock_settings.release_sync_delay_seconds = 0
            mock_settings.release_sync_circuit_max_waits = 2
            result = await collector.sync_all()

        assert result == {"total": 1, "processed": 0, "failed": 1}
        assert sleeps == [3.0, 3.0]
        linked.assert_called_once_with("10000")

    @pytest.mark.asyncio
    async def test_non_circuit_errors_still_fail_immediately(self, collector):
        """Ordinary errors keep the existing fail-fast accounting and linked-Jira refresh."""
        sleeps = []

        async def fake_sleep(seconds):
            sleeps.append(seconds)

        with (
            patch.object(collector, "fetch_versions", new=AsyncMock(return_value=_versions(1))),
            patch.object(collector, "sync_release", new=AsyncMock(side_effect=ValueError("boom"))),
            patch.object(collector, "_sync_previously_linked_jira", new=AsyncMock()) as linked,
            patch("skald_worker.collectors.release_collector.asyncio.sleep", new=fake_sleep),
            patch("skald_worker.collectors.release_collector.settings") as mock_settings,
        ):
            mock_settings.release_sync_delay_seconds = 0
            mock_settings.release_sync_circuit_max_waits = 5
            result = await collector.sync_all()

        assert result == {"total": 1, "processed": 0, "failed": 1}
        assert sleeps == []
        linked.assert_called_once_with("10000")
