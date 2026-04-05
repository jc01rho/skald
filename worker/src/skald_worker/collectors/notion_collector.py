"""Notion wiki page collector service."""

import asyncio
import inspect
import time
from datetime import UTC, datetime
from typing import Any, Literal

import structlog
from notion_client import AsyncClient
from notion_client.errors import APIResponseError, HTTPResponseError
from tenacity import (
    AsyncRetrying,
    before_sleep_log,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

from skald_worker.clients.skald import get_skald_client
from skald_worker.config import settings
from skald_worker.sync_state import get_sync_state_manager
from skald_worker.utils.notion_blocks import blocks_to_markdown

logger = structlog.get_logger(__name__)

DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_MIN_WAIT = 1.0
DEFAULT_RETRY_MAX_WAIT = 30.0

SyncStatus = Literal["processed", "skipped", "failed"]


def _is_retryable_notion_error(exc: BaseException) -> bool:
    """Check if a Notion API error should be retried."""
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        return True

    if isinstance(exc, (APIResponseError, HTTPResponseError)):
        status = getattr(exc, "status", None)
        if isinstance(status, int) and (status == 429 or status >= 500):
            return True

        code = getattr(exc, "code", None)
        if code in {
            "rate_limited",
            "internal_server_error",
            "service_unavailable",
            "bad_gateway",
            "gateway_timeout",
        }:
            return True

    return False


def _parse_timestamp(value: str | None) -> datetime | None:
    """Parse Notion/sync-state timestamps into naive UTC datetimes."""
    if not value:
        return None

    try:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(UTC).replace(tzinfo=None)
        return parsed
    except ValueError:
        return None


def _retry_after_delay_seconds(exc: BaseException) -> float | None:
    """Extract Retry-After delay from a Notion error response when available."""
    if not isinstance(exc, (APIResponseError, HTTPResponseError)):
        return None

    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return None

    raw_value = headers.get("Retry-After") or headers.get("retry-after")
    if not raw_value:
        return None

    try:
        return max(float(raw_value), 0.0)
    except (TypeError, ValueError):
        return None


class NotionCollector:
    """Collector service for page-based Notion wiki content."""

    def __init__(
        self,
        token: str | None = None,
        root_page_id: str | None = None,
        max_depth: int | None = None,
        max_pages: int | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_min_wait: float = DEFAULT_RETRY_MIN_WAIT,
        retry_max_wait: float = DEFAULT_RETRY_MAX_WAIT,
        rate_limit_rps: float | None = None,
    ):
        self.token = token or settings.notion_token
        self.root_page_id = root_page_id or settings.notion_root_page_id
        self.max_depth = max_depth if max_depth is not None else settings.notion_max_depth
        self.max_pages = max_pages if max_pages is not None else settings.notion_max_pages
        self.max_retries = max_retries
        self.retry_min_wait = retry_min_wait
        self.retry_max_wait = retry_max_wait
        self.rate_limit_rps = (
            rate_limit_rps if rate_limit_rps is not None else settings.notion_rate_limit_rps
        )

        self._client: AsyncClient | None = None
        self._last_request_time = 0.0
        self._request_semaphore = asyncio.Semaphore(1)

    @property
    def client(self) -> AsyncClient:
        """Get or create Notion async client."""
        if self._client is None:
            self._client = AsyncClient(auth=self.token)
        return self._client

    async def close(self) -> None:
        """Close the Notion client if the SDK exposes a close hook."""
        if self._client is None:
            return

        close_method = getattr(self._client, "aclose", None) or getattr(self._client, "close", None)
        if close_method is not None:
            result = close_method()
            if inspect.isawaitable(result):
                await result

        self._client = None

    async def _enforce_rate_limit(self) -> None:
        """Serialize Notion API request starts to the configured RPS ceiling."""
        if self.rate_limit_rps <= 0:
            return

        min_interval = 1.0 / self.rate_limit_rps
        async with self._request_semaphore:
            now = time.monotonic()
            elapsed = now - self._last_request_time
            if self._last_request_time and elapsed < min_interval:
                await asyncio.sleep(min_interval - elapsed)
            self._last_request_time = time.monotonic()

    async def _request_with_retry(self, func: Any, *args: Any, **kwargs: Any) -> Any:
        """Execute a Notion SDK request with local retry handling."""
        retrying = AsyncRetrying(
            retry=retry_if_exception(_is_retryable_notion_error),
            stop=stop_after_attempt(self.max_retries),
            wait=wait_exponential(multiplier=2.0, min=self.retry_min_wait, max=self.retry_max_wait),
            before_sleep=before_sleep_log(logger, log_level=20),
            reraise=True,
        )

        async for attempt in retrying:
            with attempt:
                try:
                    await self._enforce_rate_limit()
                    return await func(*args, **kwargs)
                except (APIResponseError, HTTPResponseError) as exc:
                    retry_after = _retry_after_delay_seconds(exc)
                    if retry_after is not None:
                        logger.warning(
                            "Respecting Notion Retry-After header",
                            retry_after=retry_after,
                        )
                        await asyncio.sleep(retry_after)
                    raise

        raise RuntimeError("Notion request retry loop ended unexpectedly")

    async def fetch_page(self, page_id: str) -> dict[str, Any]:
        """Fetch a single Notion page metadata object."""
        return await self._request_with_retry(self.client.pages.retrieve, page_id)

    async def fetch_block_children(
        self,
        block_id: str,
        start_cursor: str | None = None,
    ) -> dict[str, Any]:
        """Fetch one page of block children."""
        params: dict[str, Any] = {}
        if start_cursor:
            params["start_cursor"] = start_cursor

        return await self._request_with_retry(
            self.client.blocks.children.list,
            block_id,
            **params,
        )

    async def fetch_all_block_children(self, block_id: str) -> list[dict[str, Any]]:
        """Fetch all block children for a page/block, following pagination."""
        all_blocks: list[dict[str, Any]] = []
        start_cursor: str | None = None

        while True:
            response = await self.fetch_block_children(block_id, start_cursor)
            all_blocks.extend(response.get("results", []))

            if not response.get("has_more", False):
                break

            start_cursor = response.get("next_cursor")
            if not start_cursor:
                break

        for block in all_blocks:
            if block.get("has_children") and block.get("type") != "child_page":
                child_block_id = block.get("id")
                if child_block_id:
                    block["children"] = await self.fetch_all_block_children(child_block_id)

        return all_blocks

    async def discover_child_pages(
        self,
        page_id: str,
        current_depth: int = 0,
    ) -> list[dict[str, Any]]:
        """Discover child pages recursively from a root wiki page."""
        if current_depth > self.max_depth:
            logger.debug(
                "Max depth reached, stopping child page discovery",
                page_id=page_id,
                current_depth=current_depth,
                max_depth=self.max_depth,
            )
            return []

        discovered_pages: list[dict[str, Any]] = []

        try:
            blocks = await self.fetch_all_block_children(page_id)
            for block in blocks:
                if block.get("type") != "child_page":
                    continue

                child_page_id = block.get("id")
                if not child_page_id:
                    continue

                page_metadata = await self.fetch_page(child_page_id)
                child_title = self._extract_page_title(page_metadata)
                discovered_pages.append(
                    {
                        "id": child_page_id,
                        "title": child_title,
                        "last_edited_time": page_metadata.get("last_edited_time"),
                        "depth": current_depth + 1,
                        "parent_id": page_id,
                    }
                )

                if len(discovered_pages) >= self.max_pages:
                    logger.warning(
                        "Max pages limit reached during child page discovery",
                        max_pages=self.max_pages,
                    )
                    break

                nested_pages = await self.discover_child_pages(
                    child_page_id,
                    current_depth=current_depth + 1,
                )
                discovered_pages.extend(nested_pages)

                if len(discovered_pages) >= self.max_pages:
                    logger.warning(
                        "Max pages limit reached after recursive discovery",
                        max_pages=self.max_pages,
                    )
                    break
        except Exception as exc:
            logger.error(
                "Failed to discover child pages",
                page_id=page_id,
                error=str(exc),
            )

        return discovered_pages[: self.max_pages]

    def _build_reference_id(self, page_id: str) -> str:
        """Build the Skald reference_id for a Notion page."""
        return f"notion:page:{page_id}"

    @staticmethod
    def _extract_page_title(page_data: dict[str, Any]) -> str:
        """Extract a page title without assuming a fixed property key name."""
        properties = page_data.get("properties", {})
        for property_value in properties.values():
            if not isinstance(property_value, dict):
                continue
            if property_value.get("type") != "title":
                continue

            title_segments = property_value.get("title", [])
            text = "".join(segment.get("plain_text", "") for segment in title_segments)
            if text.strip():
                return text.strip()

        return "Untitled"

    @staticmethod
    def _is_stale_page(last_edited_time: str | None, cutoff_time: datetime | None) -> bool:
        """Return True when a page does not need re-sync for incremental runs."""
        if cutoff_time is None:
            return False

        parsed_last_edited = _parse_timestamp(last_edited_time)
        if parsed_last_edited is None:
            return False

        return parsed_last_edited <= cutoff_time

    async def _sync_page(
        self,
        page_id: str,
        title: str | None = None,
        last_edited_time: str | None = None,
        cutoff_time: datetime | None = None,
    ) -> tuple[SyncStatus, dict[str, Any] | None]:
        """Sync one page to Skald and distinguish skipped pages from failures."""
        try:
            page_data: dict[str, Any] | None = None

            if title is None or last_edited_time is None or cutoff_time is not None:
                page_data = await self.fetch_page(page_id)
                title = title or self._extract_page_title(page_data)
                last_edited_time = last_edited_time or page_data.get("last_edited_time")

            if self._is_stale_page(last_edited_time, cutoff_time):
                logger.debug(
                    "Skipping unchanged Notion page",
                    page_id=page_id,
                    last_edited_time=last_edited_time,
                )
                return "skipped", None

            blocks = await self.fetch_all_block_children(page_id)
            markdown_content = blocks_to_markdown(blocks)
            reference_id = self._build_reference_id(page_id)

            result = await get_skald_client().upsert_memo(
                title=title or "Untitled",
                content=markdown_content,
                reference_id=reference_id,
                source="notion",
                metadata={
                    "notion_page_id": page_id,
                    "source": "notion",
                    "document_type": "wiki_page",
                    "last_edited_time": last_edited_time,
                    "notion_url": f"https://www.notion.so/{page_id.replace('-', '')}",
                },
            )

            logger.info(
                "Synced Notion page to Skald",
                page_id=page_id,
                title=title,
            )
            return "processed", result
        except Exception as exc:
            logger.error(
                "Failed to sync Notion page",
                page_id=page_id,
                error=str(exc),
            )
            return "failed", None

    async def sync_all(self) -> dict[str, int]:
        """Sync a root wiki page and its child pages to Skald."""
        if not self.token:
            logger.warning("No notion_token configured, skipping Notion sync")
            return {"processed": 0, "failed": 0}

        if not self.root_page_id:
            logger.warning("No notion_root_page_id configured, skipping Notion sync")
            return {"processed": 0, "failed": 0}

        sync_manager = get_sync_state_manager()
        sync_manager.record_sync_start("notion")

        last_sync_time = sync_manager.get_last_sync_time("notion")
        processed = 0
        failed = 0
        skipped = 0

        logger.info(
            "Starting Notion sync",
            root_page_id=self.root_page_id,
            max_depth=self.max_depth,
            max_pages=self.max_pages,
            incremental=last_sync_time is not None,
        )

        try:
            root_status, _ = await self._sync_page(
                self.root_page_id,
                cutoff_time=last_sync_time,
            )
            if root_status == "processed":
                processed += 1
            elif root_status == "failed":
                failed += 1
            else:
                skipped += 1

            child_pages = await self.discover_child_pages(self.root_page_id, current_depth=1)
            for page_info in child_pages:
                if processed + failed + skipped >= self.max_pages:
                    logger.info(
                        "Max pages limit reached during Notion sync",
                        processed=processed,
                        failed=failed,
                        skipped=skipped,
                        max_pages=self.max_pages,
                    )
                    break

                page_id = page_info.get("id")
                if not page_id:
                    continue

                status, _ = await self._sync_page(
                    page_id,
                    title=page_info.get("title"),
                    last_edited_time=page_info.get("last_edited_time"),
                    cutoff_time=last_sync_time,
                )
                if status == "processed":
                    processed += 1
                elif status == "failed":
                    failed += 1
                else:
                    skipped += 1

            sync_manager.record_sync_success(
                "notion",
                items_processed=processed,
                items_failed=failed,
                metadata={
                    "skipped": skipped,
                    "root_page_id": self.root_page_id,
                },
            )

            logger.info(
                "Notion sync completed",
                processed=processed,
                failed=failed,
                skipped=skipped,
            )
            return {"processed": processed, "failed": failed}
        except Exception as exc:
            error_message = str(exc)
            sync_manager.record_sync_failure("notion", error_message)
            logger.error("Notion sync failed", error=error_message)
            return {"processed": processed, "failed": failed + 1}


_notion_collector: NotionCollector | None = None


def get_notion_collector() -> NotionCollector:
    """Get or create the singleton Notion collector."""
    global _notion_collector
    if _notion_collector is None:
        _notion_collector = NotionCollector()
    return _notion_collector
