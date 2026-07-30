from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from skald_worker.clients.skald import SpecExactRefetchCertificate, SpecLifecycleEvidence, canonical_hash
from skald_worker.collectors.docs_collector import DocsCollector
from skald_worker.sync_state import SyncStateManager


def item(item_id: int) -> dict:
    return {"id": item_id, "title": f"Tech {item_id}", "description": "detail"}


@pytest.mark.asyncio
async def test_authoritative_enumeration_reaches_terminal_page_beyond_500(tmp_path):
    collector = DocsCollector(base_url="https://spms.example.com")
    manager = SyncStateManager(str(tmp_path / "state.json"))
    corpus = [item(index) for index in range(1, 502)]

    async def fetch_page(endpoint_type, page, page_size):
        start = (page - 1) * page_size
        return corpus[start : start + page_size]

    collector._fetch_authoritative_page = AsyncMock(side_effect=fetch_page)
    collector._fetch_authoritative_detail = AsyncMock(side_effect=lambda endpoint_type, value: value)
    collector.sync_item = AsyncMock()

    manifest = await collector.sync_authoritative_endpoint("techs", state_manager=manager)

    assert manifest["complete"] is True
    assert manifest["count"] == 501
    assert manifest["terminal_page"] == 12
    assert len(manifest["pages"]) == 12
    assert len(manager.state.get_source("spms-techs").authoritative_snapshot) == 501


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_stage", ["page", "detail"])
async def test_incomplete_run_publishes_observed_updates_but_cannot_advance_absence(tmp_path, failure_stage):
    manager = SyncStateManager(str(tmp_path / "state.json"))
    state = manager.state.get_source("spms-techs")
    state.authoritative_snapshot = ("spms:tech:1", "spms:tech:2")
    manager.save()
    collector = DocsCollector(base_url="https://spms.example.com")

    async def fetch_page(endpoint_type, page, page_size):
        if failure_stage == "page" and page == 2:
            raise RuntimeError("page failed")
        return [item(1)] if page == 1 else []

    async def fetch_detail(endpoint_type, value):
        if failure_stage == "detail":
            raise RuntimeError("detail failed")
        return value

    collector._fetch_authoritative_page = AsyncMock(side_effect=fetch_page)
    collector._fetch_authoritative_detail = AsyncMock(side_effect=fetch_detail)
    collector.sync_item = AsyncMock()

    manifest = await collector.sync_authoritative_endpoint("techs", state_manager=manager)

    assert manifest["complete"] is False
    assert manifest["errors"]
    assert state.authoritative_snapshot == ("spms:tech:1", "spms:tech:2")
    assert state.absence_evidence == {}
    assert state.tombstone_ready == {}


@pytest.mark.asyncio
async def test_duplicate_page_id_records_count_drift_and_blocks_promotion(tmp_path):
    collector = DocsCollector(base_url="https://spms.example.com")
    manager = SyncStateManager(str(tmp_path / "state.json"))
    pages = {1: [item(1), item(2)], 2: [item(2), item(3)], 3: []}
    collector._fetch_authoritative_page = AsyncMock(side_effect=lambda endpoint_type, page, page_size: pages[page])
    collector._fetch_authoritative_detail = AsyncMock(side_effect=lambda endpoint_type, value: value)
    collector.sync_item = AsyncMock()

    manifest = await collector.sync_authoritative_endpoint("techs", state_manager=manager)

    assert manifest["count"] == 3
    assert manifest["complete"] is False
    assert any(error["stage"] == "drift" for error in manifest["errors"])
    assert manager.state.get_source("spms-techs").authoritative_snapshot == ()


@pytest.mark.asyncio
async def test_active_manifest_resumes_after_manager_restart(tmp_path):
    state_file = tmp_path / "state.json"
    first = SyncStateManager(str(state_file))
    first.begin_authoritative_reconciliation("spms-techs", "stable-run")
    first.record_authoritative_presence("spms-techs", "spms:tech:1", locator="1")
    first.update_reconciliation_manifest(
        "spms-techs",
        {
            "run_id": "stable-run",
            "endpoint": "techs",
            "started_at": datetime.now(UTC).isoformat(),
            "pages": [{"page": 1, "count": 1, "ids": ["1"]}],
            "ids": ["1"],
            "count": 1,
            "errors": [],
            "terminal_page": None,
            "complete": False,
        },
    )

    restarted = SyncStateManager(str(state_file))
    collector = DocsCollector(base_url="https://spms.example.com")
    collector._fetch_authoritative_page = AsyncMock(return_value=[])
    collector._fetch_authoritative_detail = AsyncMock()
    collector.sync_item = AsyncMock()

    manifest = await collector.sync_authoritative_endpoint("techs", state_manager=restarted)

    collector._fetch_authoritative_page.assert_awaited_once_with("techs", 2, 50)
    assert manifest["run_id"] == "stable-run"
    assert manifest["complete"] is True
    assert restarted.state.get_source("spms-techs").authoritative_snapshot == ("spms:tech:1",)


def test_two_separated_complete_absence_runs_require_grace_and_survive_restart(tmp_path):
    state_file = tmp_path / "state.json"
    manager = SyncStateManager(str(state_file))
    base = datetime(2026, 1, 1, tzinfo=UTC)
    manager.begin_authoritative_reconciliation("spms-techs", "baseline")
    manager.record_authoritative_presence("spms-techs", "spms:tech:1", locator="1")
    assert manager.finish_authoritative_reconciliation("spms-techs", "baseline", complete=True, completed_at=base) == ()

    manager.begin_authoritative_reconciliation("spms-techs", "absence-1")
    assert manager.finish_authoritative_reconciliation(
        "spms-techs", "absence-1", complete=True, completed_at=base + timedelta(hours=1)
    ) == ()

    restarted = SyncStateManager(str(state_file))
    restarted.begin_authoritative_reconciliation("spms-techs", "absence-too-soon")
    assert restarted.finish_authoritative_reconciliation(
        "spms-techs",
        "absence-too-soon",
        complete=True,
        completed_at=base + timedelta(hours=2),
        minimum_interval=timedelta(hours=24),
        grace_period=timedelta(hours=48),
    ) == ()

    restarted.begin_authoritative_reconciliation("spms-techs", "absence-2")
    assert restarted.finish_authoritative_reconciliation(
        "spms-techs",
        "absence-2",
        complete=True,
        completed_at=base + timedelta(hours=50),
        minimum_interval=timedelta(hours=24),
        grace_period=timedelta(hours=48),
    ) == ("spms:tech:1",)


@pytest.mark.asyncio
async def test_tombstone_observation_carries_two_runs_grace_and_exact_refetch_certificate(tmp_path):
    manager = SyncStateManager(str(tmp_path / "state.json"))
    base = datetime(2026, 1, 1, tzinfo=UTC)
    manager.begin_authoritative_reconciliation("spms-techs", "baseline")
    manager.record_authoritative_presence("spms-techs", "spms:tech:1", locator="1")
    manager.finish_authoritative_reconciliation("spms-techs", "baseline", complete=True, completed_at=base)
    manager.begin_authoritative_reconciliation("spms-techs", "absence-1")
    manager.finish_authoritative_reconciliation("spms-techs", "absence-1", complete=True, completed_at=base)

    collector = DocsCollector(base_url="https://spms.example.com")
    collector._fetch_authoritative_page = AsyncMock(return_value=[])
    collector._exact_refetch_status = AsyncMock(return_value="absent")
    manifest = await collector.sync_authoritative_endpoint(
        "techs",
        state_manager=manager,
        minimum_interval=timedelta(0),
        grace_period=timedelta(0),
    )

    evidence = manifest["lifecycle_evidence"][0]
    assert evidence.absent is True
    assert evidence.absence_proof.first_run_id == "absence-1"
    assert evidence.absence_proof.second_run_id == manifest["run_id"]
    assert evidence.absence_proof.first_observed_at
    assert evidence.absence_proof.second_observed_at
    assert evidence.absence_proof.grace_deadline
    assert evidence.exact_refetch.reference_id == "spms:tech:1"
    assert evidence.exact_refetch.outcome == "absent"
    assert len(evidence.exact_refetch.certificate_hash) == 64


@pytest.mark.asyncio
async def test_authoritative_all_submits_repeatable_manifest_and_server_owned_lifecycle(tmp_path):
    manager = SyncStateManager(str(tmp_path / "state.json"))
    collector = DocsCollector(base_url="https://spms.example.com")
    started = "2026-07-30T12:00:00+00:00"
    completed = "2026-07-30T13:00:00+00:00"
    manifests = {
        endpoint: {
            "run_id": f"run-{endpoint}",
            "endpoint": endpoint,
            "started_at": started,
            "completed_at": completed,
            "ids": ["1"],
            "count": 1,
            "errors": [],
            "complete": True,
            "lifecycle_evidence": [
                SpecLifecycleEvidence(
                    memo_reference_id="spms:tech:1",
                    observed_at=completed,
                    absent=True,
                    reason="absent",
                    exact_refetch=SpecExactRefetchCertificate(
                        reference_id="spms:tech:1",
                        outcome="absent",
                        checked_at="2026-07-30T12:59:59.123456+00:00",
                        run_id=f"run-{endpoint}",
                        certificate_hash="0" * 64,
                    ),
                )
            ] if endpoint == "techs" else [],
        }
        for endpoint in ("functions", "techs", "information", "troubleshoots")
    }
    collector.sync_authoritative_endpoint = AsyncMock(
        side_effect=lambda endpoint, **kwargs: manifests[endpoint]
    )
    skald = MagicMock()
    skald.submit_spec_reconciliation_manifest = AsyncMock(
        return_value=MagicMock(promotion_state="promoted")
    )

    with patch("skald_worker.collectors.docs_collector.get_skald_client", return_value=skald):
        first = await collector.sync_authoritative_all(state_manager=manager)
        second = await collector.sync_authoritative_all(state_manager=manager)

    first_request = skald.submit_spec_reconciliation_manifest.await_args_list[0].args[0]
    second_request = skald.submit_spec_reconciliation_manifest.await_args_list[1].args[0]
    assert first_request.manifest_hash == second_request.manifest_hash
    assert first_request.run_id == second_request.run_id
    assert first_request.count == 4
    certificate = first_request.lifecycle_evidence[0].exact_refetch
    assert certificate is not None
    assert certificate.run_id == first_request.run_id
    assert certificate.checked_at == "2026-07-30T12:59:59.123Z"
    assert certificate.certificate_hash == canonical_hash(
        {
            "checked_at": certificate.checked_at,
            "outcome": "absent",
            "reference_id": "spms:tech:1",
            "run_id": first_request.run_id,
        }
    )
    assert first["promotion_state"] == "promoted"
    assert second["promotion_state"] == "promoted"
    assert manager.state.get_source("spms-reconciliation").last_error is None


@pytest.mark.asyncio
async def test_manifest_submission_failure_marks_operational_run_failed_without_promotion(tmp_path):
    manager = SyncStateManager(str(tmp_path / "state.json"))
    collector = DocsCollector(base_url="https://spms.example.com")
    collector.sync_authoritative_endpoint = AsyncMock(
        return_value={
            "run_id": "run-1",
            "started_at": "2026-07-30T12:00:00+00:00",
            "completed_at": "2026-07-30T13:00:00+00:00",
            "ids": [],
            "count": 0,
            "errors": [],
            "complete": True,
            "lifecycle_evidence": [],
        }
    )
    skald = MagicMock()
    skald.submit_spec_reconciliation_manifest = AsyncMock(side_effect=RuntimeError("backend unavailable"))

    with (
        patch("skald_worker.collectors.docs_collector.get_skald_client", return_value=skald),
        pytest.raises(RuntimeError, match="backend unavailable"),
    ):
        await collector.sync_authoritative_all(state_manager=manager)

    state = manager.state.get_source("spms-reconciliation")
    assert state.last_error == "Manifest submission failed: backend unavailable"
    assert "promotion_state" not in state.metadata
