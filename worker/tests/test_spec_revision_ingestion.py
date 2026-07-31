from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from skald_worker.clients.skald import SkaldClient, canonical_hash, sha256_text
from skald_worker.collectors.docs_collector import DocsCollector
from skald_worker.sync_state import SyncStateManager


def function_item(title="처리한 결재 목록 조회", properties=None):
    return {
        "id": 574,
        "function_id": "SVR-MY-REQUEST-LIST-R",
        "name": title,
        "status": "completed",
        "date_updated": "2026-06-30T07:28:36.847Z",
        "detail": "상세 원문",
        "parent": None,
        "product": {"id": 1, "name": "Sparrow"},
        "actions": [],
        "relatedFunctions": [],
        "relatedInformation": [],
        "project_permission": [],
        "system_permission": [],
        "related_info": [
            {
                "id": 1787,
                "functional_specification_id": {"id": 574},
                "Information_Definition_id": {
                    "id": 1243,
                    "Name": "결재 대상 항목 이름",
                    "properties": properties or ["고유값", "필터 가능"],
                },
            },
            {
                "id": 1788,
                "functional_specification_id": {"id": 574},
                "Information_Definition_id": {
                    "id": 27,
                    "Name": "프로젝트 이름",
                    "properties": ["필터 가능", "간단 검색"],
                },
            },
        ],
    }


def build_request(item):
    collector = DocsCollector(base_url="https://spms.example.com")
    title, content, metadata = collector.item_to_markdown(item, "functions")
    with patch("skald_worker.collectors.docs_collector.settings.skald_project_id", "project-id"):
        return collector.build_spec_revision_request(item, "functions", title, content, metadata)


def test_canonical_hashes_are_order_independent_and_relation_input_tracks_title_source_metadata():
    first = function_item(properties=["필터 가능", "고유값"])
    second = function_item(properties=["고유값", "필터 가능"])
    request_a = build_request(first)
    request_b = build_request(second)

    assert request_a.revision["relation_hash"] == request_b.revision["relation_hash"]
    assert request_a.idempotency_key == request_b.idempotency_key

    renamed = build_request(function_item(title="이름 변경"))
    assert renamed.revision["relation_hash"] == request_a.revision["relation_hash"]
    assert renamed.revision["metadata_hash"] != request_a.revision["metadata_hash"]
    assert renamed.revision["relation_input_hash"] != request_a.revision["relation_input_hash"]

    changed_source = function_item()
    changed_source["function_id"] = "SVR-MY-REQUEST-LIST-V2-R"
    changed = build_request(changed_source)
    assert changed.revision["relation_input_hash"] != request_a.revision["relation_input_hash"]
    assert [relation["target"]["source_key"] for relation in request_a.relations] == [
        "spms:information:1243",
        "spms:information:27",
    ]

    assert request_a.revision["content_hash"] == sha256_text(request_a.memo["content"])
    assert request_a.revision["metadata_hash"] == canonical_hash(request_a.memo["metadata"])
    assert request_a.revision["relation_hash"] == canonical_hash(request_a.relations)
    assert request_a.revision["claim_hash"] == canonical_hash(request_a.claims)
    assert request_a.revision["relation_input_hash"] == canonical_hash(
        {
            "source": request_a.source,
            "memo_title": request_a.memo["title"],
            "memo_metadata": request_a.memo["metadata"],
            "relations": request_a.relations,
        }
    )


@pytest.mark.asyncio
async def test_stage_and_publish_validates_receipt_hashes():
    client = SkaldClient(base_url="https://api.example.com", api_key="key", project_id="project-id")
    request = build_request(function_item())
    receipt = {
        "status": "published",
        "source_id": str(uuid4()),
        "source_key": request.source["source_key"],
        "revision_id": str(uuid4()),
        "memo_uuid": str(uuid4()),
        "memo_reference_id": request.memo["client_reference_id"],
        "source_payload_hash": request.revision["source_payload_hash"],
        "relation_hash": request.expected_relation_hash,
        "claim_hash": request.expected_claim_hash,
        "idempotent_replay": False,
    }
    response = MagicMock()
    response.json.return_value = receipt
    client._request_with_retry = AsyncMock(return_value=response)

    result = await client.stage_and_publish_spec_revision(request)
    assert result.source_key == request.source["source_key"]
    client._request_with_retry.assert_awaited_once_with(
        "POST", "/api/v1/spec-revisions/stage-and-publish", json=request.to_payload()
    )

    response.json.return_value = {**receipt, "relation_hash": "wrong"}
    with pytest.raises(ValueError, match="relation_hash"):
        await client.stage_and_publish_spec_revision(request)


def test_incomplete_reconciliation_cannot_advance_absence(tmp_path):
    manager = SyncStateManager(str(tmp_path / "state.json"))
    manager.begin_authoritative_reconciliation("spms-functions", "run-1")
    manager.record_authoritative_presence("spms-functions", "spms:function:1")
    assert manager.finish_authoritative_reconciliation("spms-functions", "run-1", complete=True) == ()

    manager.begin_authoritative_reconciliation("spms-functions", "run-2")
    assert manager.finish_authoritative_reconciliation("spms-functions", "run-2", complete=False) == ()
    state = manager.state.get_source("spms-functions")
    assert state.authoritative_snapshot == ("spms:function:1",)
    assert state.absence_generation == 1
    assert state.reconciliation_complete is False

    manager.begin_authoritative_reconciliation("spms-functions", "run-3")
    assert manager.finish_authoritative_reconciliation("spms-functions", "run-3", complete=True) == ()
    assert state.absence_generation == 2

    manager.begin_authoritative_reconciliation("spms-functions", "run-4")
    assert manager.finish_authoritative_reconciliation("spms-functions", "run-4", complete=True) == (
        "spms:function:1",
    )
