"""Tests for Notion block markdown rendering helpers."""

from skald_worker.utils.notion_blocks import blocks_to_markdown, rich_text_to_plain


def test_rich_text_to_plain_ignores_none_entries() -> None:
    result = rich_text_to_plain([None, {"type": "text", "plain_text": "hello", "text": None}])

    assert result == "hello"


def test_rich_text_to_plain_handles_null_link_object() -> None:
    result = rich_text_to_plain(
        [
            {
                "type": "text",
                "plain_text": "hello",
                "text": {"content": "hello", "link": None},
                "href": None,
                "annotations": None,
            }
        ]
    )

    assert result == "hello"


def test_blocks_to_markdown_handles_null_block_payload() -> None:
    result = blocks_to_markdown(
        [
            {"type": "paragraph", "paragraph": None},
            {"type": "paragraph", "paragraph": {"rich_text": [None]}},
        ]
    )

    assert result == ""


def test_rich_text_to_plain_handles_null_equation_payload() -> None:
    result = rich_text_to_plain(
        [
            {
                "type": "equation",
                "plain_text": "E=mc^2",
                "equation": None,
                "href": None,
            }
        ]
    )

    assert result == "E=mc^2"


def test_blocks_to_markdown_renders_child_database() -> None:
    result = blocks_to_markdown(
        [
            {
                "type": "child_database",
                "id": "13412909-57b2-8093-8763-c016ec8b88be",
                "child_database": {"title": "Engineering Docs"},
                "url": "https://www.notion.so/engineering-docs",
            }
        ]
    )

    assert "🗃️ Engineering Docs" in result
    assert "https://www.notion.so/engineering-docs" in result
