"""Technical documentation collector service for SPMS."""

from typing import Any

import httpx
import structlog
from bs4 import BeautifulSoup

from skald_worker.clients.skald import get_skald_client
from skald_worker.config import settings
from skald_worker.retry import with_retry

logger = structlog.get_logger(__name__)

INFORMATION_PRODUCT_ALIASES = {
    "엔터프라이즈": "sparrow",
    "enterprise": "sparrow",
    "sparrow enterprise": "sparrow",
    "sparrow": "sparrow",
    "sast": "sparrow-sast",
    "sparrow sast": "sparrow-sast",
    "sca": "sparrow-sca",
    "sparrow sca": "sparrow-sca",
}

# Default retry configuration
DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_MIN_WAIT = 1.0
DEFAULT_RETRY_MAX_WAIT = 30.0

# SPMS API endpoints
SPMS_ENDPOINTS = {
    "functions": "/api/functions",
    "techs": "/api/techs",
    "information": "/api/information",
    "screens": "/api/screens",
    "troubleshoots": "/api/troubleshoots",
}


def html_to_markdown(html: str) -> str:
    """Convert HTML content to markdown.

    Args:
        html: HTML content

    Returns:
        Markdown text
    """
    soup = BeautifulSoup(html, "html.parser")

    # Remove script and style elements
    for element in soup(["script", "style", "nav", "footer", "header"]):
        element.decompose()

    # Get text content
    text = soup.get_text(separator="\n", strip=True)

    # Clean up multiple newlines
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    return "\n\n".join(lines)


def normalize_search_text(*parts: str) -> str:
    return " ".join(part.strip() for part in parts if isinstance(part, str) and part.strip())


def infer_information_product_id(*parts: str) -> str:
    haystack = normalize_search_text(*parts).lower()
    for alias, product_id in sorted(INFORMATION_PRODUCT_ALIASES.items(), key=lambda item: len(item[0]), reverse=True):
        if alias in haystack:
            return product_id
    return ""


def build_information_search_aliases(title: str, category: str, description: str) -> list[str]:
    aliases = {
        title.strip(),
        normalize_search_text(title, "기능 설명"),
        normalize_search_text(title, "차이 비교"),
        normalize_search_text(title, "개요 설명 사용 방법"),
    }

    if category:
        aliases.add(normalize_search_text(category, title))
        aliases.add(normalize_search_text(category, title, "기능 설명"))

    normalized_description = normalize_search_text(description)
    if "전수분석" in normalized_description and "수시분석" in normalized_description:
        aliases.update(
            {
                "전수분석 수시분석 차이 비교",
                "전수분석 수시분석 기능 설명",
                normalize_search_text(title, "전수분석 수시분석 차이"),
            }
        )

    return sorted(alias for alias in aliases if alias)


class DocsCollector:
    """Collector service for technical documentation with retry support."""

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
        """Get or create HTTP client."""
        if self._client is None or self._client.is_closed:
            headers = {"Content-Type": "application/json"}

            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers=headers,
                timeout=httpx.Timeout(60.0, connect=10.0),
            )
        return self._client

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def _request_with_retry(
        self,
        method: str,
        url: str,
        **kwargs: Any,
    ) -> httpx.Response:
        """Execute HTTP request with retry logic.

        Args:
            method: HTTP method
            url: Request URL
            **kwargs: Additional request kwargs

        Returns:
            HTTP response
        """

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

    async def fetch_functions(
        self,
        page: int = 1,
        page_size: int = 50,
        updated_since: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch functions from SPMS."""
        params: dict[str, Any] = {
            "status": "completed",
            "page": page,
            "size": page_size,
        }
        if updated_since:
            params["updatedSince"] = updated_since

        try:
            response = await self._request_with_retry("GET", "/api/functions", params=params)
            return response.json()
        except httpx.HTTPError as e:
            logger.error("Failed to fetch functions", error=str(e))
            return []

    async def fetch_techs(
        self,
        page: int = 1,
        page_size: int = 50,
        updated_since: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch tech documents from SPMS."""
        params: dict[str, Any] = {
            "page": page,
            "size": page_size,
        }
        if updated_since:
            params["updatedSince"] = updated_since

        try:
            response = await self._request_with_retry("GET", "/api/techs", params=params)
            return response.json()
        except httpx.HTTPError as e:
            logger.error("Failed to fetch techs", error=str(e))
            return []

    async def fetch_information(
        self,
        page: int = 1,
        page_size: int = 50,
        updated_since: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch information from SPMS."""
        params: dict[str, Any] = {
            "status": "completed",
            "page": page,
            "size": page_size,
        }
        if updated_since:
            params["updatedSince"] = updated_since

        try:
            response = await self._request_with_retry("GET", "/api/information", params=params)
            return response.json()
        except httpx.HTTPError as e:
            logger.error("Failed to fetch information", error=str(e))
            return []

    async def fetch_screens(
        self,
        page: int = 1,
        page_size: int = 50,
        updated_since: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch screens from SPMS."""
        params: dict[str, Any] = {
            "product": "enterprise",
            "page": page,
            "size": page_size,
        }
        if updated_since:
            params["updatedSince"] = updated_since

        try:
            response = await self._request_with_retry("GET", "/api/screens", params=params)
            return response.json()
        except httpx.HTTPError as e:
            logger.error("Failed to fetch screens", error=str(e))
            return []

    async def fetch_troubleshoots(
        self,
        page: int = 1,
        page_size: int = 50,
        updated_since: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch troubleshoots from SPMS."""
        params: dict[str, Any] = {
            "page": page,
            "size": page_size,
        }
        if updated_since:
            params["updatedSince"] = updated_since

        try:
            response = await self._request_with_retry("GET", "/api/troubleshoots", params=params)
            return response.json()
        except httpx.HTTPError as e:
            logger.error("Failed to fetch troubleshoots", error=str(e))
            return []

    async def fetch_function_detail(self, function_id: str) -> dict[str, Any] | None:
        """Fetch function detail from SPMS using function_id (e.g., SVR-MY-RISKY-RULE-R)."""
        try:
            response = await self._request_with_retry("GET", f"/api/functions/{function_id}")
            return response.json()
        except httpx.HTTPError as e:
            logger.error("Failed to fetch function detail", function_id=function_id, error=str(e))
            return None
            return None

    async def fetch_tech_detail(self, tech_id: int) -> dict[str, Any] | None:
        """Fetch tech document detail from SPMS."""
        try:
            response = await self._request_with_retry("GET", f"/api/techs/{tech_id}")
            return response.json()
        except httpx.HTTPError as e:
            logger.error("Failed to fetch tech detail", tech_id=tech_id, error=str(e))
            return None

    async def fetch_information_detail(self, info_id: int) -> dict[str, Any] | None:
        """Fetch information detail from SPMS."""
        try:
            response = await self._request_with_retry("GET", f"/api/information/{info_id}")
            return response.json()
        except httpx.HTTPError as e:
            logger.error("Failed to fetch information detail", info_id=info_id, error=str(e))
            return None

    async def fetch_screen_detail(self, screen_id: int) -> dict[str, Any] | None:
        """Fetch screen detail from SPMS."""
        try:
            response = await self._request_with_retry("GET", f"/api/screens/{screen_id}")
            return response.json()
        except httpx.HTTPError as e:
            logger.error("Failed to fetch screen detail", screen_id=screen_id, error=str(e))
            return None

    async def fetch_troubleshoot_detail(self, troubleshoot_id: int) -> dict[str, Any] | None:
        """Fetch troubleshoot detail from SPMS."""
        try:
            response = await self._request_with_retry("GET", f"/api/troubleshoots/{troubleshoot_id}")
            return response.json()
        except httpx.HTTPError as e:
            logger.error("Failed to fetch troubleshoot detail", troubleshoot_id=troubleshoot_id, error=str(e))
            return None

    def item_to_markdown(self, item: dict[str, Any], item_type: str) -> tuple[str, str, dict[str, Any]]:
        """Convert SPMS item to markdown format for Skald memo."""

        product_id = ""

        # Extract title based on item type
        if item_type in ("function", "functions"):
            title = item.get("name", "Untitled Function")
            doc_id = f"func-{item.get('id', '')}"
            category = item.get("category", "")
            component = item.get("component", "")
            description = item.get("detail", "") or item.get("description", "")
            author = item.get("author", "")
            created = item.get("date_created", "")
            updated = item.get("date_updated", "")
            url_path = f"/enterprise/functions/{item.get('function_id', item.get('id', ''))}"
        elif item_type in ("tech", "techs"):
            title = item.get("title", "Untitled Tech Doc")
            doc_id = f"tech-{item.get('id', '')}"
            category = item.get("category", "")
            product_id = item.get("product_id", "")
            component = ""
            description = item.get("description", "")
            author = item.get("author", "")
            created = item.get("date_created", "")
            updated = item.get("date_updated", "")
            url_path = f"/enterprise/techs/{item.get('id', '')}"
        elif item_type == "information":
            title = item.get("Name", "Untitled Information")
            doc_id = f"info-{item.get('id', '')}"
            category = item.get("Type", "")
            component = ""
            description = item.get("Content", "") or item.get("description", "")
            product_id = infer_information_product_id(title, category, description)
            author = ""
            created = item.get("date_created", "")
            updated = item.get("date_updated", "")
            url_path = f"/enterprise/information/{item.get('id', '')}"
        elif item_type in ("troubleshoot", "troubleshoots"):
            title = item.get("title", "Untitled Troubleshoot")
            doc_id = f"ts-{item.get('id', '')}"
            category = item.get("category", "")
            product_id = item.get("product_id", "")
            component = item.get("component", "") or ""
            issue_sum = item.get("issue_sum", "")
            ts_solution = item.get("ts_solution", "")
            description = ""
            if issue_sum:
                description += f"## 문제 요약\n\n{issue_sum}\n\n"
            if ts_solution:
                description += f"## 해결 방법\n\n{ts_solution}"
            description = description.strip()
            author = ""
            created = item.get("date_created", "")
            updated = item.get("date_updated", "")
            url_path = f"/enterprise/troubleshoots/{item.get('id', '')}"
        else:
            title = "Untitled"
            doc_id = f"doc-{item.get('id', '')}"
            category = component = description = author = created = updated = product_id = ""
            url_path = ""

        # Build metadata
        metadata = {
            "doc_id": doc_id,
            "doc_type": item_type,
            "category": category,
            "component": component,
            "author": author,
            "created": created,
            "updated": updated,
            "source_url": f"{self.base_url}{url_path}" if url_path else "",
            "spms_id": item.get("id", ""),
            "search_text": normalize_search_text(title, category, description),
            "title_tokens": [token for token in {title.strip(), *[part for part in title.replace('/', ' ').split() if part]} if token],
        }

        if item_type in ("function", "functions"):
            metadata["api_function_id"] = item.get("function_id", item.get("id", ""))

        if item_type == "information":
            metadata["search_aliases"] = build_information_search_aliases(title, category, description)

        if item_type in ("troubleshoot", "troubleshoots", "tech", "techs", "information") and product_id:
            metadata["product_id"] = product_id

        # Build markdown content
        sections = []
        sections.append(f"# {title}\n")

        # Metadata table
        sections.append("## Document Information\n")
        sections.append("| Field | Value |")
        sections.append("|-------|-------|")
        sections.append(f"| **ID** | {doc_id} |")
        sections.append(f"| **Type** | {item_type} |")
        if category:
            sections.append(f"| **Category** | {category} |")
        if component:
            sections.append(f"| **Component** | {component} |")
        if author:
            sections.append(f"| **Author** | {author} |")
        if created:
            sections.append(f"| **Created** | {created} |")
        if updated:
            sections.append(f"| **Updated** | {updated} |")
        sections.append("")

        # Content
        if description:
            sections.append("## Content\n")
            sections.append(description)

        content = "\n".join(sections)
        return title, content, metadata

    def build_reference_id(self, item: dict[str, Any], item_type: str) -> str:
        if item_type in ("function", "functions"):
            item_identifier = item.get("function_id", item.get("id", ""))
        else:
            item_identifier = item.get("id", "")

        return f"spms:{item_type}:{item_identifier}"

    async def sync_item(self, item: dict[str, Any], item_type: str) -> dict[str, Any]:
        """Sync a single SPMS item to Skald."""
        # Fetch full content if needed
        item_id = item.get("id")
        function_id = item.get("function_id")
        if function_id and item_type in ("function", "functions") and "detail" not in item:
            full_item = await self.fetch_function_detail(function_id)
            if full_item:
                item = full_item
        elif item_id and item_type in ("tech", "techs") and "description" not in item:
            full_item = await self.fetch_tech_detail(item_id)
            if full_item:
                item = full_item
        elif item_id and item_type == "information" and "Content" not in item:
            full_item = await self.fetch_information_detail(item_id)
            if full_item:
                item = full_item
        elif item_id and item_type in ("troubleshoot", "troubleshoots") and "issue_sum" not in item:
            full_item = await self.fetch_troubleshoot_detail(item_id)
            if full_item:
                item = full_item

        title, content, metadata = self.item_to_markdown(item, item_type)
        reference_id = self.build_reference_id(item, item_type)

        skald = get_skald_client()
        return await skald.upsert_memo(
            title=title,
            content=content,
            reference_id=reference_id,
            source=item_type,  # Use specific type: functions, techs, information
            metadata=metadata,
        )

    async def sync_endpoint(
        self,
        endpoint_type: str,
        updated_since: str | None = None,
        max_items: int = 500,
    ) -> dict[str, int]:
        """Sync all items from a specific SPMS endpoint."""
        logger.info(f"Starting {endpoint_type} sync", updated_since=updated_since, max_items=max_items)

        processed = 0
        failed = 0
        skipped = 0
        page = 1
        page_size = 50

        fetch_methods = {
            "functions": self.fetch_functions,
            "techs": self.fetch_techs,
            "information": self.fetch_information,
            "screens": self.fetch_screens,
            "troubleshoots": self.fetch_troubleshoots,
        }

        fetch_method = fetch_methods.get(endpoint_type)
        if not fetch_method:
            logger.error(f"Unknown endpoint type: {endpoint_type}")
            return {"processed": 0, "failed": 0, "skipped": 0}

        while processed + failed < max_items:
            items = await fetch_method(
                page=page,
                page_size=page_size,
                updated_since=updated_since,
            )

            if not items:
                break

            for item in items:
                if processed + failed >= max_items:
                    break

                item_date_updated = item.get("date_updated", "")
                if updated_since and item_date_updated and item_date_updated < updated_since:
                    skipped += 1
                    continue

                try:
                    await self.sync_item(item, endpoint_type)
                    processed += 1
                except Exception as e:
                    logger.error(
                        f"Failed to sync {endpoint_type} item",
                        item_id=item.get("id"),
                        error=str(e),
                    )
                    failed += 1

            page += 1

        logger.info(
            f"{endpoint_type} sync completed",
            processed=processed,
            failed=failed,
            skipped=skipped,
        )

        return {
            "processed": processed,
            "failed": failed,
            "skipped": skipped,
        }

    async def sync_all(
        self,
        updated_since: str | None = None,
        max_documents: int = 5000,
    ) -> dict[str, dict[str, int]]:
        """Sync all SPMS document types to Skald."""
        logger.info("Starting SPMS docs sync", updated_since=updated_since, max_documents=max_documents)

        results = {}

        for endpoint_type in ["functions", "techs", "information", "troubleshoots"]:
            endpoint_results = await self.sync_endpoint(
                endpoint_type=endpoint_type,
                updated_since=updated_since,
                max_items=max_documents,
            )
            results[endpoint_type] = endpoint_results

        total_processed = sum(r["processed"] for r in results.values())
        total_failed = sum(r["failed"] for r in results.values())
        total_skipped = sum(r.get("skipped", 0) for r in results.values())

        logger.info(
            "SPMS docs sync completed",
            total_processed=total_processed,
            total_failed=total_failed,
            total_skipped=total_skipped,
            results=results,
        )

        return {
            "total": {
                "processed": total_processed,
                "failed": total_failed,
                "skipped": total_skipped,
            },
            "by_type": results,
        }


# Singleton instance
_docs_collector: DocsCollector | None = None


def get_docs_collector() -> DocsCollector:
    """Get or create the singleton docs collector."""
    global _docs_collector
    if _docs_collector is None:
        _docs_collector = DocsCollector()
    return _docs_collector


# Fresh rebuild 20260207081045
