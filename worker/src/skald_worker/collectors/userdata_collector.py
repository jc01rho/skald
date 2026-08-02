"""Customer userdata collector service for SPMS."""

import re
import unicodedata
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import httpx
import structlog

from skald_worker.clients.skald import get_skald_client
from skald_worker.config import settings
from skald_worker.retry import with_retry

logger = structlog.get_logger(__name__)

DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_MIN_WAIT = 1.0
DEFAULT_RETRY_MAX_WAIT = 30.0


def _normalize_text(value: Any) -> str:
    """Normalize external text while removing control and Unicode whitespace hazards."""
    normalized = unicodedata.normalize("NFKC", str(value or ""))
    return " ".join(part for part in re.split(r"[\s\x00-\x1f\x7f]+", normalized.strip()) if part)


def _userdata_identity(item: dict[str, Any]) -> tuple[str, str]:
    project_code = _normalize_text(item.get("projectCode"))
    reference = _normalize_text(item.get("reference"))
    identity = project_code or reference
    if not identity:
        raise ValueError("Userdata projectCode/reference must not be empty")
    sanitized = quote(re.sub(r"\s+", "-", identity), safe="-._~")
    return project_code or identity, sanitized


def _format_userdata_timestamp(value: Any) -> str:
    if value in (None, ""):
        return ""
    try:
        timestamp = int(value) / 1000
    except (TypeError, ValueError):
        return str(value)
    return datetime.fromtimestamp(timestamp, tz=UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


class UserdataCollector:
    """Collector service for SPMS customer userdata."""

    def __init__(
        self,
        base_url: str | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_min_wait: float = DEFAULT_RETRY_MIN_WAIT,
        retry_max_wait: float = DEFAULT_RETRY_MAX_WAIT,
    ):
        self.base_url = (base_url or settings.spms_base_url).rstrip("/")
        self.max_retries = max_retries
        self.retry_min_wait = retry_min_wait
        self.retry_max_wait = retry_max_wait
        self._client: httpx.AsyncClient | None = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers={"Content-Type": "application/json"},
                timeout=httpx.Timeout(60.0, connect=10.0),
            )
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def _request_with_retry(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        async def _do_request() -> httpx.Response:
            response = await self.client.request(method, url, **kwargs)
            response.raise_for_status()
            return response

        return await with_retry(
            _do_request,
            max_attempts=self.max_retries,
            min_wait=self.retry_min_wait,
            max_wait=self.retry_max_wait,
        )

    async def fetch_userdata(self) -> list[dict[str, Any]]:
        try:
            response = await self._request_with_retry("GET", "/api/userdata")
            return response.json()
        except httpx.HTTPError as exc:
            logger.error("Failed to fetch userdata", error=str(exc))
            raise

    def build_reference_id(self, item: dict[str, Any]) -> str:
        _, identity = _userdata_identity(item)
        return f"spms:userdata:{identity}"

    def userdata_to_markdown(self, item: dict[str, Any]) -> tuple[str, str, dict[str, Any], list[str]]:
        project_code, _ = _userdata_identity(item)
        site = _normalize_text(item.get("site"))
        product = _normalize_text(item.get("product"))
        version = _normalize_text(item.get("version"))
        title = f"{site} {project_code} 고객 사용자 데이터".strip()
        collected_at = _format_userdata_timestamp(item.get("timestamp"))

        metadata = {
            "doc_type": "userdata",
            "project_code": project_code,
            "site": site,
            "product": product,
            "version": version,
            "timestamp": item.get("timestamp"),
            "reference": _normalize_text(item.get("reference")),
            "collected_at": collected_at,
            "source_url": f"{self.base_url}/api/userdata",
        }

        tags = ["userdata", product, version, site]
        tags = [tag for tag in tags if tag]
        tags = list(dict.fromkeys(tags))
        clients = [_normalize_text(value) for value in item.get("client", [])]
        clients = [value for value in clients if value]
        languages = [_normalize_text(value) for value in item.get("language", [])]
        languages = [value for value in languages if value]
        frameworks = [_normalize_text(value) for value in item.get("framework", [])]
        frameworks = [value for value in frameworks if value]

        lines = [f"# {title}", "", "## 고객 정보", "", "| Field | Value |", "|-------|-------|"]
        lines.append(f"| Project Code | {project_code} |")
        lines.append(f"| Site | {site} |")
        lines.append(f"| Product | {product} |")
        lines.append(f"| Version | {version} |")
        lines.append(f"| Collected At | {collected_at} |")
        lines.append("")

        lines.extend(
            [
                "## 사용량 통계",
                "",
                "| Metric | Value |",
                "|--------|-------|",
                f"| Users | {item.get('users')} |",
                f"| User Groups | {item.get('userGroups')} |",
                f"| Projects | {item.get('projects')} |",
                f"| Analyses | {item.get('analyses')} |",
                f"| Issues | {item.get('issues')} |",
                "",
                "## 사용 클라이언트",
                "",
                *([f"- {value}" for value in clients] or ["- 없음"]),
                "",
                "## 사용 언어",
                "",
                *([f"- {value}" for value in languages] or ["- 없음"]),
                "",
                "## 사용 프레임워크",
                "",
                *([f"- {value}" for value in frameworks] or ["- 없음"]),
            ]
        )

        return title, "\n".join(lines), metadata, tags

    async def sync_item(self, item: dict[str, Any]) -> dict[str, Any]:
        title, content, metadata, tags = self.userdata_to_markdown(item)
        skald = get_skald_client()
        return await skald.upsert_memo(
            title=title,
            content=content,
            reference_id=self.build_reference_id(item),
            source="userdata",
            metadata=metadata,
            tags=tags,
        )

    async def sync_all(self, max_items: int = 5000) -> dict[str, int]:
        logger.info("Starting userdata sync", max_items=max_items)
        items = await self.fetch_userdata()

        processed = 0
        failed = 0

        for item in items[:max_items]:
            try:
                await self.sync_item(item)
                processed += 1
            except Exception as exc:
                logger.error(
                    "Failed to sync userdata item",
                    project_code=item.get("projectCode"),
                    error=str(exc),
                )
                failed += 1

        logger.info("Userdata sync completed", processed=processed, failed=failed)
        return {
            "total": min(len(items), max_items),
            "processed": processed,
            "failed": failed,
        }


_userdata_collector: UserdataCollector | None = None


def get_userdata_collector() -> UserdataCollector:
    global _userdata_collector
    if _userdata_collector is None:
        _userdata_collector = UserdataCollector()
    return _userdata_collector
