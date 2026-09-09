"""Regression coverage for flat release counts at the scheduler boundary."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from skald_worker import scheduler


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        ({"total": 143, "processed": 113, "failed": 30}, (113, 30)),
        ({"total": 0, "processed": 0, "failed": 0}, (0, 0)),
        ({"total": {"processed": 4, "failed": 1, "skipped": 2}}, (4, 1)),
        ({"processed": 5, "failed": 2}, (5, 2)),
    ],
)
def test_result_counts_preserves_collector_counts(result, expected):
    assert scheduler._result_counts(result) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("failed", [0, 30])
async def test_release_job_accounts_for_flat_results_without_masking_failures(monkeypatch, failed):
    # Given a release result with a numeric total and isolated scheduler state.
    collector = AsyncMock()
    collector.sync_all.return_value = {"total": 143, "processed": 143 - failed, "failed": failed}
    monkeypatch.setattr(scheduler, "get_release_collector", lambda: collector)
    monkeypatch.setattr(scheduler, "_last_runs", {})
    items = MagicMock()
    jobs = MagicMock()
    durable_failure = MagicMock()
    monkeypatch.setattr(scheduler, "sync_items_processed_total", items)
    monkeypatch.setattr(scheduler, "sync_jobs_total", jobs)
    monkeypatch.setattr(scheduler, "sync_job_duration_seconds", MagicMock())
    monkeypatch.setattr(scheduler, "_record_durable_failure", durable_failure)

    # When the actual scheduled entry point consumes that result.
    if failed:
        with pytest.raises(RuntimeError) as exc_info:
            await scheduler.release_sync_job()
    else:
        await scheduler.release_sync_job()

    # Then counts survive and a partial result never advances the success marker.
    items.labels.assert_any_call(source="release", status="success")
    items.labels.assert_any_call(source="release", status="failed")
    assert [call.args[0] for call in items.labels.return_value.inc.call_args_list] == [143 - failed, failed]
    assert ("release" in scheduler._last_runs) is (failed == 0)
    jobs.labels.assert_called_once_with(source="release", status="error" if failed else "success")
    if failed:
        durable_failure.assert_called_once_with("release", exc_info.value)
    else:
        durable_failure.assert_not_called()
