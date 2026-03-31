"""Release status collector service for SPMS."""

from datetime import datetime, timezone
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

RELEASE_PROJECTS = ["SPARROW", "SPSAST", "SPDAST"]
ROADMAP_REQUIREMENTS_QUERY = "로드맵 = 예"
NON_ROADMAP_REQUIREMENTS_QUERY = "(로드맵 = 아니요 OR 로드맵 is EMPTY)"

PRODUCT_INFO: dict[str, dict[str, Any]] = {
    "SPARROW": {
        "name": "Sparrow Enterprise",
        "product_id": "sparrow",
        "aliases": ["엔터프라이즈"],
    },
    "SPSAST": {
        "name": "Sparrow SAST",
        "product_id": "sparrow-sast",
        "aliases": ["SAST"],
    },
    "SPDAST": {
        "name": "Sparrow DAST",
        "product_id": "dast",
        "aliases": ["DAST"],
    },
}


def _format_epoch_millis(value: Any) -> str:
    if value in (None, ""):
        return ""

    try:
        timestamp = int(value) / 1000
    except (TypeError, ValueError):
        return str(value)

    return datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _extract_option_values(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []

    result: list[str] = []
    for value in values:
        if isinstance(value, dict):
            option_value = value.get("value") or value.get("name") or value.get("key")
            if option_value:
                result.append(str(option_value))
        elif value:
            result.append(str(value))
    return result


def _extract_issue_summary(issue: dict[str, Any]) -> dict[str, Any]:
    fields = issue.get("fields", {}) if isinstance(issue.get("fields"), dict) else {}
    assignee = fields.get("assignee") if isinstance(fields.get("assignee"), dict) else {}
    priority = fields.get("priority") if isinstance(fields.get("priority"), dict) else {}
    status = fields.get("status") if isinstance(fields.get("status"), dict) else {}

    return {
        "key": issue.get("key", ""),
        "summary": fields.get("summary", ""),
        "status": status.get("name", ""),
        "updated": fields.get("updated", ""),
        "created": fields.get("created", ""),
        "assignee": assignee.get("displayName", ""),
        "priority": priority.get("name", ""),
        "components": [
            component.get("name", "")
            for component in fields.get("components", [])
            if isinstance(component, dict) and component.get("name")
        ],
        "tools": _extract_option_values(fields.get("tools")),
        "sites": _extract_option_values(fields.get("sites")),
        "roadmap": _extract_option_values(fields.get("roadmap")),
    }


def _format_issue_lines(issues: list[dict[str, Any]]) -> list[str]:
    if not issues:
        return ["- 없음"]

    lines: list[str] = []
    for issue in issues:
        summary = _extract_issue_summary(issue)
        headline = f"- {summary['key']}: {summary['summary']}"
        details: list[str] = []
        if summary["status"]:
            details.append(f"상태: {summary['status']}")
        if summary["priority"]:
            details.append(f"우선순위: {summary['priority']}")
        if summary["assignee"]:
            details.append(f"담당자: {summary['assignee']}")
        if summary["components"]:
            details.append(f"구성요소: {', '.join(summary['components'])}")
        if summary["tools"]:
            details.append(f"도구: {', '.join(summary['tools'])}")
        if summary["sites"]:
            details.append(f"사이트: {', '.join(summary['sites'])}")
        if summary["roadmap"]:
            details.append(f"로드맵: {', '.join(summary['roadmap'])}")
        if summary["updated"]:
            details.append(f"업데이트: {summary['updated']}")

        if details:
            lines.append(f"{headline} ({' | '.join(details)})")
        else:
            lines.append(headline)

    return lines


def _format_release_notes_items(items: Any) -> list[str]:
    if not isinstance(items, list) or not items:
        return ["- 등록된 릴리즈 노트가 없습니다."]

    lines: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue

        category = item.get("category", "")
        headline = item.get("headline", "")
        summary = item.get("summary", "")
        link = item.get("link", "")
        product = item.get("product", "")

        parts = []
        if category:
            parts.append(f"[{category}]")
        if headline:
            parts.append(headline)
        if product:
            parts.append(f"제품: {product}")

        line = " ".join(parts).strip() or "릴리즈 노트 항목"
        if summary:
            line = f"{line} - {summary}"
        if link:
            line = f"{line} ({link})"
        lines.append(f"- {line}")

    return lines or ["- 등록된 릴리즈 노트가 없습니다."]


class ReleaseCollector:
    """Collector service for SPMS release status documents."""

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

    async def fetch_versions(self) -> list[dict[str, Any]]:
        try:
            response = await self._request_with_retry(
                "GET",
                "/api/releases/versions",
                params={"projects": ",".join(RELEASE_PROJECTS)},
            )
            return response.json()
        except httpx.HTTPError as exc:
            logger.error("Failed to fetch release versions", error=str(exc))
            return []

    async def fetch_version_detail(self, version_id: str) -> dict[str, Any] | None:
        try:
            response = await self._request_with_retry("GET", f"/api/releases/versions/{version_id}")
            return response.json()
        except httpx.HTTPError as exc:
            logger.error("Failed to fetch release detail", version_id=version_id, error=str(exc))
            return None

    async def fetch_release_notes(self, version_id: str) -> dict[str, Any] | None:
        try:
            response = await self._request_with_retry("GET", f"/api/releases/versions/{version_id}/notes")
            return response.json()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                logger.info("Release notes not found", version_id=version_id)
                return None
            logger.error("Failed to fetch release notes", version_id=version_id, error=str(exc))
            return None
        except httpx.HTTPError as exc:
            logger.error("Failed to fetch release notes", version_id=version_id, error=str(exc))
            return None

    async def fetch_version_issues(
        self,
        version_id: str,
        issue_type: str,
        query: str | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"type": issue_type}
        if query:
            params["q"] = query

        try:
            response = await self._request_with_retry(
                "GET",
                f"/api/releases/versions/{version_id}/issues",
                params=params,
            )
            return response.json()
        except httpx.HTTPError as exc:
            logger.error(
                "Failed to fetch release issues",
                version_id=version_id,
                issue_type=issue_type,
                query=query,
                error=str(exc),
            )
            return []

    def build_reference_id(self, version_id: str) -> str:
        return f"spms:release:{version_id}"

    def release_to_markdown(
        self,
        version_summary: dict[str, Any],
        detail: dict[str, Any],
        release_notes: dict[str, Any] | None,
        roadmap_issues: list[dict[str, Any]],
        requirement_issues: list[dict[str, Any]],
        incident_issues: list[dict[str, Any]],
        checker_issues: list[dict[str, Any]],
    ) -> tuple[str, str, dict[str, Any], list[str]]:
        project_key = str(detail.get("projectKey") or version_summary.get("project") or "")
        product_info = PRODUCT_INFO.get(project_key, {"name": project_key or "Unknown", "aliases": []})
        product_name = str(product_info.get("name", project_key or "Unknown"))
        product_id = str(product_info.get("product_id", ""))
        aliases = [str(alias) for alias in product_info.get("aliases", [])]
        version_id = str(detail.get("id") or version_summary.get("id") or "")
        version_name = str(detail.get("name") or version_summary.get("name") or "Unknown")
        title = f"{product_name} {version_name} 릴리즈 현황"

        metadata = {
            "doc_type": "release",
            "release_id": version_id,
            "project": project_key,
            "product": product_name,
            "product_id": product_id,
            "product_aliases": aliases,
            "version": version_name,
            "released": bool(detail.get("released", version_summary.get("released", False))),
            "archived": bool(detail.get("archived", version_summary.get("archived", False))),
            "start_date": str(detail.get("startDate", "")),
            "release_date": str(detail.get("releaseDate", version_summary.get("releaseDate", ""))),
            "user_release_date": str(detail.get("userReleaseDate", "")),
            "release_note_status": str((release_notes or {}).get("status", "")),
            "release_note_updated": str((release_notes or {}).get("date_updated", "")),
            "roadmap_issue_count": len(roadmap_issues),
            "requirement_issue_count": len(requirement_issues),
            "incident_issue_count": len(incident_issues),
            "checker_issue_count": len(checker_issues),
            "source_url": f"{self.base_url}/api/releases/versions/{quote(version_id)}",
            "release_notes_url": f"{self.base_url}/api/releases/versions/{quote(version_id)}/notes",
        }

        tags = ["release", project_key, product_name, product_id, version_name, *aliases]
        tags = [tag for tag in tags if tag]
        tags = list(dict.fromkeys(tags))

        lines = [f"# {title}", "", "## 릴리즈 정보", "", "| Field | Value |", "|-------|-------|"]
        lines.append(f"| Version ID | {version_id} |")
        lines.append(f"| Project | {project_key} |")
        lines.append(f"| Product | {product_name} |")
        if aliases:
            lines.append(f"| Aliases | {', '.join(aliases)} |")
        lines.append(f"| Version | {version_name} |")
        lines.append(f"| Start Date | {detail.get('startDate', '')} |")
        lines.append(f"| Release Date | {detail.get('releaseDate', version_summary.get('releaseDate', ''))} |")
        lines.append(f"| User Release Date | {detail.get('userReleaseDate', '')} |")
        lines.append(f"| Released | {detail.get('released', version_summary.get('released', False))} |")
        lines.append(f"| Archived | {detail.get('archived', version_summary.get('archived', False))} |")
        if detail.get("devcenterId"):
            lines.append(f"| DevCenter ID | {detail.get('devcenterId')} |")
        lines.append("")

        lines.extend([
            "## 릴리즈 노트 메타데이터",
            "",
            "| Field | Value |",
            "|-------|-------|",
            f"| Status | {(release_notes or {}).get('status', '')} |",
            f"| Updated At | {(release_notes or {}).get('date_updated', '')} |",
            f"| Released On | {(release_notes or {}).get('released_on', '')} |",
            "",
            "## 릴리즈 노트",
            "",
            *_format_release_notes_items((release_notes or {}).get("all_desc")),
            "",
            "## 로드맵 이슈",
            "",
            *_format_issue_lines(roadmap_issues),
            "",
            "## 제품 요구사항",
            "",
            *_format_issue_lines(requirement_issues),
            "",
            "## 장애",
            "",
            *_format_issue_lines(incident_issues),
            "",
            "## 체커",
            "",
            *_format_issue_lines(checker_issues),
        ])

        return title, "\n".join(lines), metadata, tags

    async def sync_release(self, version_summary: dict[str, Any]) -> dict[str, Any]:
        version_id = str(version_summary.get("id", ""))
        detail = await self.fetch_version_detail(version_id)
        if not detail:
            raise ValueError(f"Release detail missing for version {version_id}")

        release_notes = await self.fetch_release_notes(version_id)
        roadmap_issues = await self.fetch_version_issues(version_id, "제품 요구사항", ROADMAP_REQUIREMENTS_QUERY)
        requirement_issues = await self.fetch_version_issues(version_id, "제품 요구사항", NON_ROADMAP_REQUIREMENTS_QUERY)
        incident_issues = await self.fetch_version_issues(version_id, "장애")
        checker_issues = await self.fetch_version_issues(version_id, "체커")

        title, content, metadata, tags = self.release_to_markdown(
            version_summary=version_summary,
            detail=detail,
            release_notes=release_notes,
            roadmap_issues=roadmap_issues,
            requirement_issues=requirement_issues,
            incident_issues=incident_issues,
            checker_issues=checker_issues,
        )

        skald = get_skald_client()
        return await skald.upsert_memo(
            title=title,
            content=content,
            reference_id=self.build_reference_id(version_id),
            source="release",
            metadata=metadata,
            tags=tags,
        )

    async def sync_all(self, max_versions: int = 5000) -> dict[str, int]:
        logger.info("Starting release sync", max_versions=max_versions)
        versions = await self.fetch_versions()

        processed = 0
        failed = 0

        for version_summary in versions[:max_versions]:
            try:
                await self.sync_release(version_summary)
                processed += 1
            except Exception as exc:
                logger.error(
                    "Failed to sync release",
                    version_id=version_summary.get("id"),
                    error=str(exc),
                )
                failed += 1

        logger.info("Release sync completed", processed=processed, failed=failed)
        return {
            "total": min(len(versions), max_versions),
            "processed": processed,
            "failed": failed,
        }


_release_collector: ReleaseCollector | None = None


def get_release_collector() -> ReleaseCollector:
    global _release_collector
    if _release_collector is None:
        _release_collector = ReleaseCollector()
    return _release_collector
