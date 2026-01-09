"""Technical documentation collector service."""

from typing import Any

import httpx
import structlog
from bs4 import BeautifulSoup

from skald_worker.clients.skald import get_skald_client
from skald_worker.config import settings
from skald_worker.retry import with_retry

logger = structlog.get_logger(__name__)

# Default retry configuration
DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_MIN_WAIT = 1.0
DEFAULT_RETRY_MAX_WAIT = 30.0


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


class DocsCollector:
    """Collector service for technical documentation with retry support."""

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_min_wait: float = DEFAULT_RETRY_MIN_WAIT,
        retry_max_wait: float = DEFAULT_RETRY_MAX_WAIT,
    ):
        self.base_url = (base_url or settings.spms_base_url).rstrip("/")
        self.api_key = api_key or settings.spms_api_key
        self.max_retries = max_retries
        self.retry_min_wait = retry_min_wait
        self.retry_max_wait = retry_max_wait
        self._client: httpx.AsyncClient | None = None

    @property
    def client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None or self._client.is_closed:
            headers = {"Content-Type": "application/json"}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"

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

    async def fetch_document_list(
        self,
        page: int = 1,
        page_size: int = 50,
        updated_since: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch list of documents from SPMS.

        Args:
            page: Page number (1-indexed)
            page_size: Number of documents per page
            updated_since: ISO date string to filter by update date

        Returns:
            List of document metadata
        """
        params: dict[str, Any] = {
            "page": page,
            "pageSize": page_size,
        }
        if updated_since:
            params["updatedSince"] = updated_since

        try:
            response = await self._request_with_retry("GET", "/api/documents", params=params)
            data = response.json()
            return data.get("documents", [])
        except httpx.HTTPError as e:
            logger.error("Failed to fetch document list", error=str(e))
            return []

    async def fetch_document_content(self, doc_id: str) -> dict[str, Any] | None:
        """Fetch full document content.

        Args:
            doc_id: Document ID

        Returns:
            Document data with content
        """
        try:
            response = await self._request_with_retry("GET", f"/api/documents/{doc_id}")
            return response.json()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                logger.warning("Document not found", doc_id=doc_id)
                return None
            raise
        except httpx.HTTPError as e:
            logger.error("Failed to fetch document", doc_id=doc_id, error=str(e))
            return None

    def document_to_markdown(self, doc: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
        """Convert a document to markdown format for Skald memo.

        Args:
            doc: Document data

        Returns:
            Tuple of (title, content, metadata)
        """
        title = doc.get("title", "Untitled Document")
        doc_id = doc.get("id", "")
        doc_type = doc.get("type", "document")
        category = doc.get("category", "")
        tags = doc.get("tags", [])
        author = doc.get("author", "")
        created = doc.get("createdAt", "")
        updated = doc.get("updatedAt", "")

        # Build metadata
        metadata = {
            "doc_id": doc_id,
            "doc_type": doc_type,
            "category": category,
            "tags": tags,
            "author": author,
            "created": created,
            "updated": updated,
            "source_url": doc.get("url", ""),
        }

        # Build markdown content
        sections = []

        # Header
        sections.append(f"# {title}\n")

        # Metadata table
        sections.append("## Document Information\n")
        sections.append("| Field | Value |")
        sections.append("|-------|-------|")
        sections.append(f"| **ID** | {doc_id} |")
        sections.append(f"| **Type** | {doc_type} |")
        if category:
            sections.append(f"| **Category** | {category} |")
        if author:
            sections.append(f"| **Author** | {author} |")
        if created:
            sections.append(f"| **Created** | {created} |")
        if updated:
            sections.append(f"| **Updated** | {updated} |")
        if tags:
            sections.append(f"| **Tags** | {', '.join(tags)} |")

        sections.append("")

        # Content
        raw_content = doc.get("content", "")
        content_format = doc.get("format", "text")

        if content_format == "html":
            content_text = html_to_markdown(raw_content)
        else:
            content_text = raw_content

        sections.append("## Content\n")
        sections.append(content_text)

        content = "\n".join(sections)
        return title, content, metadata

    async def sync_document(self, doc: dict[str, Any]) -> dict[str, Any]:
        """Sync a single document to Skald.

        Args:
            doc: Document data

        Returns:
            Skald memo data
        """
        # Fetch full content if not present
        if "content" not in doc:
            doc_id = doc.get("id")
            if doc_id:
                full_doc = await self.fetch_document_content(doc_id)
                if full_doc:
                    doc = full_doc

        title, content, metadata = self.document_to_markdown(doc)
        reference_id = f"doc:{doc.get('id', '')}"

        skald = get_skald_client()
        return await skald.upsert_memo(
            title=title,
            content=content,
            reference_id=reference_id,
            source="spms",
            metadata=metadata,
        )

    async def sync_all(
        self,
        updated_since: str | None = None,
        max_documents: int = 500,
    ) -> dict[str, int]:
        """Sync all documents to Skald.

        Args:
            updated_since: ISO date string to filter by update date
            max_documents: Maximum number of documents to sync

        Returns:
            Summary with processed/failed counts
        """
        logger.info("Starting docs sync", updated_since=updated_since, max_documents=max_documents)

        processed = 0
        failed = 0
        page = 1
        page_size = 50

        while processed + failed < max_documents:
            docs = await self.fetch_document_list(
                page=page,
                page_size=page_size,
                updated_since=updated_since,
            )

            if not docs:
                break

            for doc in docs:
                if processed + failed >= max_documents:
                    break

                try:
                    await self.sync_document(doc)
                    processed += 1
                except Exception as e:
                    logger.error(
                        "Failed to sync document",
                        doc_id=doc.get("id"),
                        error=str(e),
                    )
                    failed += 1

            page += 1

        logger.info(
            "Docs sync completed",
            processed=processed,
            failed=failed,
        )

        return {
            "processed": processed,
            "failed": failed,
        }


# Singleton instance
_docs_collector: DocsCollector | None = None


def get_docs_collector() -> DocsCollector:
    """Get or create the singleton docs collector."""
    global _docs_collector
    if _docs_collector is None:
        _docs_collector = DocsCollector()
    return _docs_collector
