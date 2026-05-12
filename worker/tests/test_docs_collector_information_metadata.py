from skald_worker.collectors.docs_collector import (
    DocsCollector,
    build_information_search_aliases,
    infer_information_product_id,
)


def test_infer_information_product_id_detects_enterprise_aliases():
    assert infer_information_product_id('Sparrow Enterprise 전수분석', '가이드', '수시분석과 차이 설명') == 'sparrow'


def test_build_information_search_aliases_adds_comparison_variants():
    aliases = build_information_search_aliases(
        '전수분석',
        '기능 안내',
        '전수분석과 수시분석의 차이를 설명하는 문서',
    )

    assert '전수분석 수시분석 차이 비교' in aliases
    assert '전수분석 수시분석 기능 설명' in aliases


def test_item_to_markdown_enriches_information_metadata():
    collector = DocsCollector(base_url='https://spms.example.com')
    item = {
        'id': 321,
        'Name': 'Sparrow Enterprise 전수분석',
        'Type': '기능 안내',
        'Content': '전수분석과 수시분석의 차이를 설명하는 문서입니다.',
        'date_updated': '2026-05-13T10:00:00Z',
    }

    title, content, metadata = collector.item_to_markdown(item, 'information')

    assert title == 'Sparrow Enterprise 전수분석'
    assert '# Sparrow Enterprise 전수분석' in content
    assert metadata['doc_id'] == 'info-321'
    assert metadata['doc_type'] == 'information'
    assert metadata['product_id'] == 'sparrow'
    assert metadata['source_url'] == 'https://spms.example.com/enterprise/information/321'
    assert '전수분석 수시분석 차이 비교' in metadata['search_aliases']
    assert 'Sparrow Enterprise 전수분석' in metadata['title_tokens']
    assert '기능 안내' in metadata['search_text']
