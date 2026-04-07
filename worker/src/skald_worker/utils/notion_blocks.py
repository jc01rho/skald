"""Utilities for converting Notion block payloads into Markdown."""

from typing import Any

HEADING_PREFIXES = {
    "heading_1": "#",
    "heading_2": "##",
    "heading_3": "###",
}


def rich_text_to_plain(rich_texts: list[dict[str, Any]] | None) -> str:
    """Convert Notion rich text objects into Markdown-friendly inline text."""
    if not rich_texts:
        return ""

    rendered_parts: list[str] = []
    for rich_text in rich_texts:
        if not isinstance(rich_text, dict):
            continue

        text = _extract_rich_text_content(rich_text)
        if not text:
            continue

        annotations = rich_text.get("annotations") or {}
        rendered = text

        if annotations.get("code"):
            rendered = f"`{rendered}`"
        if annotations.get("bold"):
            rendered = f"**{rendered}**"
        if annotations.get("italic"):
            rendered = f"*{rendered}*"
        if annotations.get("strikethrough"):
            rendered = f"~~{rendered}~~"

        text_data = rich_text.get("text") or {}
        link_data = text_data.get("link") or {}
        link_url = rich_text.get("href") or link_data.get("url")
        if link_url:
            rendered = f"[{rendered}]({link_url})"

        rendered_parts.append(rendered)

    return "".join(rendered_parts)


def blocks_to_markdown(blocks: list[dict[str, Any]]) -> str:
    """Convert supported Notion blocks into Markdown without making API calls."""
    rendered_blocks = _render_blocks(blocks, indent_level=0)
    return "\n\n".join(block for block in rendered_blocks if block.strip()).strip()


def _render_blocks(blocks: list[dict[str, Any]], indent_level: int) -> list[str]:
    rendered_blocks: list[str] = []
    number_index = 0

    for block in blocks:
        block_type = block.get("type", "unknown")
        if block_type == "numbered_list_item":
            number_index += 1
        else:
            number_index = 0

        rendered = _render_block(block, indent_level=indent_level, number_index=number_index)
        if rendered.strip():
            rendered_blocks.append(rendered)

    return rendered_blocks


def _render_block(block: dict[str, Any], indent_level: int, number_index: int) -> str:
    block_type = block.get("type", "unknown")
    block_data = block.get(block_type) or {}
    indent = "    " * indent_level

    if block_type == "paragraph":
        content = _with_indent(rich_text_to_plain(block_data.get("rich_text")), indent)
    elif block_type in HEADING_PREFIXES:
        heading_text = rich_text_to_plain(block_data.get("rich_text"))
        content = _with_indent(f"{HEADING_PREFIXES[block_type]} {heading_text}".rstrip(), indent)
    elif block_type == "bulleted_list_item":
        bullet_text = rich_text_to_plain(block_data.get("rich_text"))
        content = _with_indent(f"- {bullet_text}".rstrip(), indent)
    elif block_type == "numbered_list_item":
        number_text = rich_text_to_plain(block_data.get("rich_text"))
        content = _with_indent(f"{number_index}. {number_text}".rstrip(), indent)
    elif block_type == "code":
        language = block_data.get("language", "")
        code_text = _raw_rich_text(block_data.get("rich_text"))
        content = _with_indent(f"```{language}\n{code_text}\n```".rstrip(), indent)
    elif block_type == "quote":
        quote_text = rich_text_to_plain(block_data.get("rich_text"))
        content = _with_indent(f"> {quote_text}".rstrip(), indent)
    elif block_type == "callout":
        icon = _render_callout_icon(block_data.get("icon"))
        text = rich_text_to_plain(block_data.get("rich_text"))
        content = _with_indent(f"> {icon} {text}".rstrip(), indent)
    elif block_type == "table":
        content = _render_table(block, indent_level)
    elif block_type == "divider":
        content = _with_indent("---", indent)
    elif block_type == "toggle":
        toggle_text = rich_text_to_plain(block_data.get("rich_text"))
        content = _with_indent(f"**{toggle_text}**".rstrip(), indent)
    elif block_type == "image":
        url = _extract_file_url(block_data)
        caption = rich_text_to_plain(block_data.get("caption")) or "image"
        content = _with_indent(f"![{caption}]({url})" if url else caption, indent)
    elif block_type == "bookmark":
        url = block_data.get("url", "")
        content = _with_indent(f"[{url}]({url})" if url else "", indent)
    elif block_type == "to_do":
        checked = "x" if block_data.get("checked") else " "
        todo_text = rich_text_to_plain(block_data.get("rich_text"))
        content = _with_indent(f"- [{checked}] {todo_text}".rstrip(), indent)
    elif block_type == "child_page":
        title = block_data.get("title", "Untitled")
        url = block.get("url") or _notion_page_url(block.get("id", ""))
        content = _with_indent(f"[📄 {title}]({url})" if url else f"📄 {title}", indent)
    elif block_type == "table_row":
        content = _with_indent(_render_table_row(block_data), indent)
    else:
        content = _with_indent(f"<!-- unsupported block: {block_type} -->", indent)

    children = block.get("children", [])
    if not children or block_type in {"table", "table_row", "child_page"}:
        return content

    rendered_children = _render_blocks(children, indent_level=indent_level + 1)
    if not rendered_children:
        return content

    if not content.strip():
        return "\n\n".join(rendered_children)

    children_content = "\n\n".join(rendered_children)
    return f"{content}\n\n{children_content}"


def _render_table(block: dict[str, Any], indent_level: int) -> str:
    table_data = block.get("table", {})
    rows = [child for child in block.get("children", []) if child.get("type") == "table_row"]
    if not rows:
        return _with_indent("| |\n| --- |", "    " * indent_level)

    parsed_rows = [_table_row_cells(row.get("table_row", {})) for row in rows]
    width = max(len(row) for row in parsed_rows) if parsed_rows else 1
    normalized_rows = [_normalize_row(row, width) for row in parsed_rows]

    if table_data.get("has_column_header"):
        header = normalized_rows[0]
        body = normalized_rows[1:]
    else:
        header = normalized_rows[0]
        body = normalized_rows[1:]

    lines = [
        _markdown_table_line(header),
        _markdown_table_line(["---"] * width),
    ]
    lines.extend(_markdown_table_line(row) for row in body)

    return _indent_multiline("\n".join(lines), indent_level)


def _render_table_row(block_data: dict[str, Any]) -> str:
    return _markdown_table_line(_table_row_cells(block_data))


def _table_row_cells(block_data: dict[str, Any]) -> list[str]:
    cells = block_data.get("cells", [])
    return [rich_text_to_plain(cell) for cell in cells]


def _markdown_table_line(cells: list[str]) -> str:
    escaped_cells = [cell.replace("|", "\\|") for cell in cells]
    return f"| {' | '.join(escaped_cells)} |"


def _normalize_row(row: list[str], width: int) -> list[str]:
    return row + [""] * (width - len(row))


def _extract_rich_text_content(rich_text: dict[str, Any]) -> str:
    if not isinstance(rich_text, dict):
        return ""

    plain_text = rich_text.get("plain_text")
    if plain_text is not None:
        return plain_text

    rich_text_type = rich_text.get("type")
    if rich_text_type == "text":
        return (rich_text.get("text") or {}).get("content", "")
    if rich_text_type == "equation":
        return (rich_text.get("equation") or {}).get("expression", "")

    return ""


def _raw_rich_text(rich_texts: list[dict[str, Any]] | None) -> str:
    if not rich_texts:
        return ""
    return "".join(_extract_rich_text_content(rich_text) for rich_text in rich_texts)


def _render_callout_icon(icon: dict[str, Any] | None) -> str:
    if not icon:
        return "💡"

    icon_type = icon.get("type")
    if icon_type == "emoji":
        return icon.get("emoji", "💡")

    return "💡"


def _extract_file_url(block_data: dict[str, Any]) -> str:
    file_type = block_data.get("type")
    if not file_type:
        return ""
    return block_data.get(file_type, {}).get("url", "")


def _notion_page_url(page_id: str) -> str:
    if not page_id:
        return ""
    return f"https://www.notion.so/{page_id.replace('-', '')}"


def _with_indent(text: str, indent: str) -> str:
    if not text:
        return ""
    return "\n".join(f"{indent}{line}" if line else "" for line in text.splitlines())


def _indent_multiline(text: str, indent_level: int) -> str:
    return _with_indent(text, "    " * indent_level)
