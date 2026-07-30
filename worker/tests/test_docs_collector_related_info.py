from unittest.mock import AsyncMock, patch

import pytest

from skald_worker.collectors.docs_collector import (
    DocsCollector,
    IncompleteSpmsDetailError,
    is_complete_function_detail,
    normalize_related_information,
)


def function_detail(related_info=None):
    item = {
        "id": 574,
        "function_id": "SVR-MY-REQUEST-LIST-R",
        "name": "처리한 결재 목록 조회",
        "status": "completed",
        "date_updated": "2026-06-30T07:28:36.847Z",
        "detail": "원문 상세",
        "parent": {"function_id": "SVR-MY-R", "title": "마이페이지 조회"},
        "product": {"id": 1, "name": "Sparrow"},
        "actions": [],
        "relatedFunctions": [],
        "relatedInformation": [],
        "project_permission": [],
        "system_permission": [],
    }
    if related_info is not None:
        item["related_info"] = related_info
    return item


def relation(relation_id, information_id, title, properties):
    return {
        "id": relation_id,
        "functional_specification_id": {"id": 574},
        "Information_Definition_id": {
            "id": information_id,
            "Name": title,
            "properties": properties,
        },
    }


def test_missing_and_empty_related_info_are_distinct():
    missing = function_detail()
    assert not is_complete_function_detail(missing)
    with pytest.raises(IncompleteSpmsDetailError):
        normalize_related_information(missing, "https://spms.example.com")

    empty = function_detail([])
    assert is_complete_function_detail(empty)
    assert normalize_related_information(empty, "https://spms.example.com") == ()


def test_related_information_is_lossless_deduplicated_and_deterministic():
    item = function_detail(
        [
            relation(1788, 1244, "결재 요청 상태", ["필터 가능", "고유값"]),
            relation(1787, 1243, "결재 대상 항목 이름", ["고유값", "간단 검색", "고유값"]),
        ]
    )
    normalized = normalize_related_information(item, "https://spms.example.com")

    assert [value.information_spms_id for value in normalized] == ["1243", "1244"]
    assert normalized[0].relation_id == "1787"
    assert normalized[0].function_spms_id == "574"
    assert normalized[0].properties == ("간단 검색", "고유값")
    assert normalized[0].target_reference_id == "spms:information:1243"

    collector = DocsCollector(base_url="https://spms.example.com")
    _, content, metadata = collector.item_to_markdown(item, "functions")
    assert "원문 상세" in content
    assert "## 관련 정보 정의" in content
    assert "[결재 대상 항목 이름](/information/1243)" in content
    assert metadata["spms_immutable_id"] == "574"
    assert metadata["related_information"][0]["relation_id"] == "1787"


@pytest.mark.asyncio
async def test_list_item_with_detail_but_without_related_info_fetches_detail():
    collector = DocsCollector(base_url="https://spms.example.com")
    list_item = function_detail()
    full_item = function_detail([])
    collector.fetch_function_detail = AsyncMock(return_value=full_item)
    skald = AsyncMock()
    skald.stage_and_publish_spec_revision.return_value = {"status": "published"}

    with patch("skald_worker.collectors.docs_collector.get_skald_client", return_value=skald), patch(
        "skald_worker.collectors.docs_collector.settings.skald_project_id", "project-id"
    ):
        await collector.sync_item(list_item, "functions")

    collector.fetch_function_detail.assert_awaited_once_with("SVR-MY-REQUEST-LIST-R")
    request = skald.stage_and_publish_spec_revision.await_args.args[0]
    assert request.source["source_key"] == "spms:function:574"
    assert request.expected_relation_count == 0


@pytest.mark.asyncio
async def test_detail_fetch_failure_does_not_publish_incomplete_revision():
    collector = DocsCollector(base_url="https://spms.example.com")
    collector.fetch_function_detail = AsyncMock(return_value=None)
    skald = AsyncMock()

    with (
        patch("skald_worker.collectors.docs_collector.get_skald_client", return_value=skald),
        pytest.raises(IncompleteSpmsDetailError),
    ):
        await collector.sync_item(function_detail(), "functions")

    skald.stage_and_publish_spec_revision.assert_not_awaited()
