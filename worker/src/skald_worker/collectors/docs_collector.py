"""Technical documentation collector service for SPMS."""

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
import structlog
from bs4 import BeautifulSoup

from skald_worker.clients.skald import (
    SpecAbsenceProof,
    SpecExactRefetchCertificate,
    SpecLifecycleEvidence,
    SpecReconciliationManifestRequest,
    SpecRevisionPublishRequest,
    canonical_hash,
    get_skald_client,
    sha256_text,
)
from skald_worker.config import settings
from skald_worker.retry import with_retry
from skald_worker.sync_state import SyncStateManager, get_sync_state_manager

logger = structlog.get_logger(__name__)

def _rfc3339_millis(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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

FUNCTION_DETAIL_REQUIRED_FIELDS = frozenset(
    {
        "id",
        "function_id",
        "name",
        "status",
        "date_updated",
        "detail",
        "related_info",
        "parent",
        "product",
        "actions",
        "relatedFunctions",
        "relatedInformation",
        "project_permission",
        "system_permission",
    }
)
PARSER_VERSION = "spms-canonical-v1"
EXTRACTOR_VERSION = "spms-claims-v1"
DISPLAY_LABEL_PATTERN = re.compile(r"화면에 표시될 때 레이블은\s*(.+?)(?:(?:으로|로)\s+표시됩니다)[.]?")


class IncompleteSpmsDetailError(ValueError):
    """Raised when an SPMS response cannot authoritatively replace a revision."""


@dataclass(frozen=True)
class RelatedInformation:
    relation_id: str
    function_spms_id: str
    information_spms_id: str
    title: str
    properties: tuple[str, ...]
    target_reference_id: str
    source_url: str

    def read_model(self) -> dict[str, Any]:
        return {
            "relation_id": self.relation_id,
            "information_id": self.information_spms_id,
            "title": self.title,
            "properties": list(self.properties),
            "reference_id": self.target_reference_id,
            "source_url": self.source_url,
        }

    def canonical_relation(self) -> dict[str, Any]:
        return {
            "relation_type": "USES_INFORMATION",
            "target": {
                "source_system": "spms",
                "source_type": "information",
                "immutable_source_id": self.information_spms_id,
                "source_key": self.target_reference_id,
                "title": self.title,
                "code": None,
                "source_url": self.source_url,
            },
            "source_relation_id": self.relation_id,
            "provenance": "spms.related_info",
            "evidence": {
                "path": f"related_info[{self.relation_id}]",
                "label": self.title,
            },
            "properties": list(self.properties),
        }


def is_complete_function_detail(item: dict[str, Any]) -> bool:
    return FUNCTION_DETAIL_REQUIRED_FIELDS.issubset(item)


def normalize_related_information(item: dict[str, Any], base_url: str) -> tuple[RelatedInformation, ...]:
    if "related_info" not in item:
        raise IncompleteSpmsDetailError("SPMS function detail is missing related_info")
    raw_relations = item["related_info"]
    if not isinstance(raw_relations, list):
        raise IncompleteSpmsDetailError("SPMS related_info must be an array")

    normalized: dict[str, RelatedInformation] = {}
    for raw in raw_relations:
        if not isinstance(raw, dict):
            raise IncompleteSpmsDetailError("SPMS related_info entry must be an object")
        function_ref = raw.get("functional_specification_id")
        information_ref = raw.get("Information_Definition_id")
        relation_id = raw.get("id")
        if not isinstance(function_ref, dict) or not isinstance(information_ref, dict):
            raise IncompleteSpmsDetailError("SPMS related_info entry has invalid references")
        function_id = function_ref.get("id")
        information_id = information_ref.get("id")
        if relation_id in (None, "") or function_id in (None, "") or information_id in (None, ""):
            raise IncompleteSpmsDetailError("SPMS related_info entry is missing an immutable ID")
        if str(function_id) != str(item.get("id")):
            raise IncompleteSpmsDetailError("SPMS related_info source ID does not match function detail")
        properties = information_ref.get("properties", [])
        if properties is None:
            properties = []
        if not isinstance(properties, list):
            raise IncompleteSpmsDetailError("SPMS related_info properties must be an array")
        immutable_id = str(information_id)
        relation = RelatedInformation(
            relation_id=str(relation_id),
            function_spms_id=str(function_id),
            information_spms_id=immutable_id,
            title=str(information_ref.get("Name") or "").strip(),
            properties=tuple(sorted({str(value).strip() for value in properties if str(value).strip()})),
            target_reference_id=f"spms:information:{immutable_id}",
            source_url=f"{base_url}/enterprise/information/{immutable_id}",
        )
        if not relation.title:
            raise IncompleteSpmsDetailError("SPMS related_info target is missing a title")
        previous = normalized.get(immutable_id)
        if previous and previous != relation:
            raise IncompleteSpmsDetailError(f"Conflicting duplicate related_info target: {immutable_id}")
        normalized[immutable_id] = relation
    return tuple(sorted(normalized.values(), key=lambda relation: (int(relation.information_spms_id) if relation.information_spms_id.isdigit() else 2**63, relation.information_spms_id)))


def extract_display_label(item: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    ui_name = item.get("UI_name")
    if isinstance(ui_name, str) and ui_name.strip():
        return ui_name.strip(), "UI_name", ui_name.strip()
    alias = item.get("alias")
    if isinstance(alias, str) and alias.strip() and "\n" not in alias:
        return alias.strip(), "alias", alias.strip()
    description = item.get("description")
    if isinstance(description, str):
        match = DISPLAY_LABEL_PATTERN.search(description)
        if match:
            return match.group(1).strip(), "description_section", match.group(0)
    return None, None, None


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
        api_key: str | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_min_wait: float = DEFAULT_RETRY_MIN_WAIT,
        retry_max_wait: float = DEFAULT_RETRY_MAX_WAIT,
    ):
        self.base_url = (base_url or settings.spms_base_url).rstrip("/")
        self.api_key = api_key
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
            "title_tokens": sorted({title.strip(), *[part for part in title.replace('/', ' ').split() if part]} - {""}),
        }

        if item_type in ("function", "functions"):
            metadata["api_function_id"] = item.get("function_id", item.get("id", ""))
            relations = normalize_related_information(item, self.base_url)
            metadata.update(
                {
                    "spms_immutable_id": str(item.get("id", "")),
                    "source_updated_at": item.get("date_updated") or None,
                    "source_status": item.get("status") or None,
                    "source_version": item.get("version") or None,
                    "parent_function": item.get("parent"),
                    "product": item.get("product"),
                    "related_information": [relation.read_model() for relation in relations],
                    "relation_schema_version": 1,
                }
            )

        if item_type == "information":
            metadata["search_aliases"] = build_information_search_aliases(title, category, description)
            display_label, display_label_source, display_label_evidence = extract_display_label(item)
            metadata.update(
                {
                    "canonical_name": title,
                    "display_label": display_label,
                    "display_label_source": display_label_source,
                    "display_label_evidence": display_label_evidence,
                }
            )

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

        if item_type in ("function", "functions"):
            relations = normalize_related_information(item, self.base_url)
            sections.append("\n## 관련 정보 정의\n")
            for relation in relations:
                sections.append(f"- [{relation.title}](/information/{relation.information_spms_id})")
                if relation.properties:
                    sections.append(f"  - 속성: {', '.join(relation.properties)}")

        content = "\n".join(sections)
        return title, content, metadata

    def build_reference_id(self, item: dict[str, Any], item_type: str) -> str:
        if item_type in ("function", "functions"):
            item_identifier = item.get("function_id", item.get("id", ""))
        else:
            item_identifier = item.get("id", "")

        return f"spms:{item_type}:{item_identifier}"

    def build_spec_revision_request(
        self,
        item: dict[str, Any],
        item_type: str,
        title: str,
        content: str,
        metadata: dict[str, Any],
    ) -> SpecRevisionPublishRequest:
        source_type = item_type[:-1] if item_type in {"functions", "techs", "troubleshoots"} else item_type
        immutable_source_id = str(item.get("id", ""))
        if not immutable_source_id:
            raise IncompleteSpmsDetailError("SPMS item is missing immutable ID")
        source_key = f"spms:{source_type}:{immutable_source_id}"
        code = str(item.get("function_id") or "") or None
        relations: tuple[dict[str, Any], ...] = ()
        if source_type == "function":
            canonical_relations = []
            for index, relation in enumerate(normalize_related_information(item, self.base_url)):
                canonical_relation = relation.canonical_relation()
                canonical_relation["evidence"]["path"] = f"related_info[{index}]"
                canonical_relations.append(canonical_relation)
            relations = tuple(canonical_relations)
        claims: tuple[dict[str, Any], ...] = ()
        if source_type == "information":
            label, label_source, evidence_excerpt = extract_display_label(item)
            if label:
                evidence = {
                    "path": label_source,
                    "excerpt": evidence_excerpt or label,
                    "hash": sha256_text(evidence_excerpt or label),
                }
                claims = (
                    {
                        "subject": source_key,
                        "predicate": "DISPLAY_LABEL",
                        "value": label,
                        "unit": None,
                        "condition": None,
                        "object": None,
                        "evidence": evidence,
                        "rule_version": EXTRACTOR_VERSION,
                    },
                )
        canonical_payload = dict(item)
        if source_type == "function":
            canonical_payload["related_info"] = [
                {
                    "id": relation.relation_id,
                    "functional_specification_id": {"id": relation.function_spms_id},
                    "Information_Definition_id": {
                        "id": relation.information_spms_id,
                        "Name": relation.title,
                        "properties": list(relation.properties),
                    },
                }
                for relation in normalize_related_information(item, self.base_url)
            ]
        source_payload_hash = canonical_hash(canonical_payload)
        relation_hash = canonical_hash(relations)
        claim_hash = canonical_hash(claims)
        source = {
            "source_key": source_key,
            "source_system": "spms",
            "source_type": source_type,
            "immutable_source_id": immutable_source_id,
            "title": title,
            "code": code,
            "source_url": metadata.get("source_url") or None,
            "status": item.get("status") or None,
            "aliases": [code] if code else [],
        }
        memo = {
            "memo_uuid": None,
            "client_reference_id": code or self.build_reference_id(item, item_type),
            "title": title,
            "content": content,
            "metadata": metadata,
            "source": "spms",
        }
        content_hash = sha256_text(content)
        metadata_hash = canonical_hash(memo["metadata"])
        relation_input_hash = canonical_hash(
            {
                "source": source,
                "memo_title": memo["title"],
                "memo_metadata": memo["metadata"],
                "relations": relations,
            }
        )
        revision = {
            "source_revision": f"{item.get('version') or item.get('date_updated') or 'unversioned'}:{source_payload_hash}",
            "source_updated_at": item.get("date_updated") or None,
            "parser_version": PARSER_VERSION,
            "extractor_version": EXTRACTOR_VERSION,
            "schema_version": "1",
            "canonical_payload": canonical_payload,
            "source_payload_hash": source_payload_hash,
            "content_hash": content_hash,
            "metadata_hash": metadata_hash,
            "relation_hash": relation_hash,
            "claim_hash": claim_hash,
            "relation_input_hash": relation_input_hash,
        }
        idempotency_key = canonical_hash(
            {
                "project_id": settings.skald_project_id,
                "source_key": source_key,
                "revision": revision,
                "relations": relations,
                "claims": claims,
            }
        )
        return SpecRevisionPublishRequest(
            project_id=settings.skald_project_id,
            idempotency_key=idempotency_key,
            source=source,
            revision=revision,
            memo=memo,
            relations=relations,
            claims=claims,
            expected_relation_count=len(relations),
            expected_relation_hash=relation_hash,
            expected_claim_count=len(claims),
            expected_claim_hash=claim_hash,
        )

    async def sync_item(self, item: dict[str, Any], item_type: str) -> Any:
        """Sync a single SPMS item to Skald."""
        item_id = item.get("id")
        function_id = item.get("function_id")
        if function_id and item_type in ("function", "functions"):
            list_item_id = item_id
            if not is_complete_function_detail(item):
                full_item = await self.fetch_function_detail(function_id)
                if not full_item:
                    raise IncompleteSpmsDetailError("Unable to fetch complete SPMS function detail")
                if str(full_item.get("id")) != str(list_item_id) or str(full_item.get("function_id")) != str(function_id):
                    raise IncompleteSpmsDetailError("SPMS function detail identity mismatch")
                item = full_item
            if not is_complete_function_detail(item):
                raise IncompleteSpmsDetailError("SPMS function detail is incomplete")
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
        skald = get_skald_client()
        if item_type in ("function", "functions", "information"):
            request = self.build_spec_revision_request(item, item_type, title, content, metadata)
            return await skald.stage_and_publish_spec_revision(request)
        return await skald.upsert_memo(
            title=title,
            content=content,
            reference_id=self.build_reference_id(item, item_type),
            source=item_type,
            metadata=metadata,
        )

    async def _exact_refetch_status(
        self,
        endpoint_type: str,
        source_key: str,
        locator: str | None,
    ) -> str:
        """Return present/absent/error from an exact SPMS detail request."""
        immutable_id = source_key.rsplit(":", 1)[-1]
        if endpoint_type == "functions" and not locator:
            return "error"
        detail_paths = {
            "functions": f"/api/functions/{locator}",
            "techs": f"/api/techs/{immutable_id}",
            "information": f"/api/information/{immutable_id}",
            "troubleshoots": f"/api/troubleshoots/{immutable_id}",
        }
        path = detail_paths[endpoint_type]
        try:
            response = await self.client.request("GET", path)
            if response.status_code == 404:
                return "absent"
            response.raise_for_status()
            payload = response.json()
            return "present" if str(payload.get("id")) == immutable_id else "error"
        except (httpx.HTTPError, ValueError, TypeError):
            return "error"

    async def _fetch_authoritative_page(
        self,
        endpoint_type: str,
        page: int,
        page_size: int,
    ) -> list[dict[str, Any]]:
        """Fetch a page without converting transport failures into terminal empty pages."""
        params: dict[str, Any] = {"page": page, "size": page_size}
        if endpoint_type in {"functions", "information"}:
            params["status"] = "completed"
        response = await self._request_with_retry("GET", f"/api/{endpoint_type}", params=params)
        payload = response.json()
        if not isinstance(payload, list):
            raise ValueError("SPMS authoritative page is not a list")
        return payload

    async def _fetch_authoritative_detail(
        self,
        endpoint_type: str,
        item: dict[str, Any],
    ) -> dict[str, Any]:
        """Fetch and identity-check the exact detail used for authoritative publication."""
        immutable_id = str(item.get("id", ""))
        locator = str(item.get("function_id") or immutable_id)
        response = await self._request_with_retry("GET", f"/api/{endpoint_type}/{locator}")
        detail = response.json()
        if not isinstance(detail, dict) or str(detail.get("id", "")) != immutable_id:
            raise IncompleteSpmsDetailError("SPMS authoritative detail identity mismatch")
        if endpoint_type == "functions" and str(detail.get("function_id", "")) != locator:
            raise IncompleteSpmsDetailError("SPMS authoritative function locator mismatch")
        return detail

    async def sync_authoritative_endpoint(
        self,
        endpoint_type: str,
        *,
        state_manager: SyncStateManager | None = None,
        minimum_interval: timedelta = timedelta(0),
        grace_period: timedelta = timedelta(0),
        page_size: int = 50,
    ) -> dict[str, Any]:
        """Enumerate an endpoint to its terminal page and reconcile only complete runs."""
        manager = state_manager or get_sync_state_manager()
        source = f"spms-{endpoint_type}"
        existing_state = manager.state.get_source(source)
        if existing_state.reconciliation_run_id:
            run_id = existing_state.reconciliation_run_id
            manifest: dict[str, Any] = dict(existing_state.reconciliation_manifest)
        else:
            run_id = str(uuid4())
            manager.begin_authoritative_reconciliation(source, run_id)
            manifest = {
                "run_id": run_id,
                "endpoint": endpoint_type,
                "started_at": datetime.now(UTC).isoformat(),
                "pages": [],
                "ids": [],
                "count": 0,
                "errors": [],
                "terminal_page": None,
                "complete": False,
            }
            manager.update_reconciliation_manifest(source, manifest)
        if endpoint_type not in {"functions", "techs", "information", "troubleshoots"}:
            raise ValueError(f"Unknown authoritative endpoint type: {endpoint_type}")

        seen: set[str] = set(manager.state.get_source(source).pending_snapshot)
        completed_ids = set(manifest["ids"])
        page = len(manifest["pages"]) + 1
        while True:
            try:
                items = await self._fetch_authoritative_page(endpoint_type, page, page_size)
            except Exception as exc:
                manifest["errors"].append({"page": page, "stage": "page", "error": str(exc)})
                break
            if not isinstance(items, list):
                manifest["errors"].append({"page": page, "stage": "page", "error": "non-list response"})
                break
            page_ids = [str(item.get("id", "")) for item in items]
            manifest["pages"].append({"page": page, "count": len(items), "ids": page_ids})
            if not items:
                manifest["terminal_page"] = page
                break
            if any(not item_id for item_id in page_ids):
                manifest["errors"].append({"page": page, "stage": "identity", "error": "missing immutable ID"})
            duplicates = sorted(item_id for item_id in page_ids if item_id in completed_ids)
            if duplicates:
                manifest["errors"].append({"page": page, "stage": "drift", "duplicate_ids": duplicates})
            for item, item_id in zip(items, page_ids, strict=True):
                if item_id:
                    source_type = endpoint_type[:-1] if endpoint_type in {"functions", "techs", "troubleshoots"} else endpoint_type
                    source_key = f"spms:{source_type}:{item_id}"
                    manager.record_authoritative_presence(
                        source,
                        source_key,
                        locator=str(item.get("function_id") or item_id),
                    )
                    seen.add(item_id)
                try:
                    detail = await self._fetch_authoritative_detail(endpoint_type, item)
                    await self.sync_item(detail, endpoint_type)
                except Exception as exc:
                    manifest["errors"].append(
                        {"page": page, "stage": "detail_or_publish", "id": item_id, "error": str(exc)}
                    )
            manifest["ids"] = sorted(seen)
            completed_ids.update(page_ids)
            manifest["count"] = len(seen)
            manager.update_reconciliation_manifest(source, manifest)
            page += 1

        complete = manifest["terminal_page"] is not None and not manifest["errors"]
        manifest["complete"] = complete
        manifest["completed_at"] = datetime.now(UTC).isoformat()
        manager.update_reconciliation_manifest(source, manifest)
        prior_absence_keys = set(manager.state.get_source(source).absence_evidence)
        candidates = manager.finish_authoritative_reconciliation(
            source,
            run_id,
            complete=complete,
            completed_at=datetime.now(UTC),
            minimum_interval=minimum_interval,
            grace_period=grace_period,
        )
        lifecycle_evidence: list[SpecLifecycleEvidence] = []
        candidate_keys = set(candidates)
        source_state = manager.state.get_source(source)
        for source_key in sorted(prior_absence_keys - set(source_state.absence_evidence)):
            lifecycle_evidence.append(
                SpecLifecycleEvidence(
                    memo_reference_id=source_key,
                    observed_at=manifest["completed_at"],
                    absent=False,
                    reason="Present in complete authoritative SPMS snapshot",
                )
            )
        for source_key, evidence in sorted(source_state.absence_evidence.items()):
            checked_at = datetime.now(UTC).isoformat()
            exact_refetch = None
            absence_proof = None
            if source_key in candidate_keys:
                status = await self._exact_refetch_status(endpoint_type, source_key, evidence.get("locator"))
                if status == "absent":
                    certificate = {
                        "reference_id": source_key,
                        "outcome": "absent",
                        "checked_at": checked_at,
                        "run_id": run_id,
                    }
                    exact_refetch = SpecExactRefetchCertificate(
                        reference_id=source_key,
                        outcome="absent",
                        checked_at=checked_at,
                        run_id=run_id,
                        certificate_hash=canonical_hash(certificate),
                    )
                    first_observed_at = str(evidence["first_absent_at"])
                    absence_proof = SpecAbsenceProof(
                        first_run_id=str(evidence["first_absent_run_id"]),
                        first_observed_at=first_observed_at,
                        second_run_id=str(evidence["last_absent_run_id"]),
                        second_observed_at=str(evidence["last_absent_at"]),
                        grace_deadline=(
                            datetime.fromisoformat(first_observed_at.replace("Z", "+00:00")) + grace_period
                        ).isoformat(),
                    )
            lifecycle_evidence.append(
                SpecLifecycleEvidence(
                    memo_reference_id=source_key,
                    observed_at=str(evidence["last_absent_at"]),
                    absent=True,
                    reason="Absent from complete authoritative SPMS snapshot",
                    exact_refetch=exact_refetch,
                    absence_proof=absence_proof,
                )
            )
        manifest["lifecycle_evidence"] = lifecycle_evidence
        manager.state.get_source(source).reconciliation_manifest = manifest
        manager.save()
        return manifest

    async def sync_authoritative_all(
        self,
        *,
        state_manager: SyncStateManager | None = None,
        minimum_interval: timedelta = timedelta(0),
        grace_period: timedelta = timedelta(0),
    ) -> dict[str, Any]:
        """Run terminal authoritative enumeration and submit its proof to Skald."""
        manager = state_manager or get_sync_state_manager()
        by_type = {}
        for endpoint_type in ("functions", "techs", "information", "troubleshoots"):
            by_type[endpoint_type] = await self.sync_authoritative_endpoint(
                endpoint_type,
                state_manager=state_manager,
                minimum_interval=minimum_interval,
                grace_period=grace_period,
            )

        complete = all(manifest["complete"] for manifest in by_type.values())
        errors = tuple(
            {"endpoint": endpoint_type, **error}
            for endpoint_type, manifest in by_type.items()
            for error in manifest["errors"]
        )
        completed_at = datetime.now(UTC).isoformat()
        hash_input = {
            "endpoints": {
                endpoint_type: {
                    "ids": manifest["ids"],
                    "count": manifest["count"],
                    "complete": manifest["complete"],
                    "errors": manifest["errors"],
                }
                for endpoint_type, manifest in sorted(by_type.items())
            }
        }
        run_id = canonical_hash(
            {endpoint_type: manifest["run_id"] for endpoint_type, manifest in sorted(by_type.items())}
        )
        lifecycle_evidence: list[SpecLifecycleEvidence] = []
        for manifest in by_type.values():
            for evidence in manifest["lifecycle_evidence"]:
                exact_refetch = evidence.exact_refetch
                if exact_refetch is not None:
                    checked_at = _rfc3339_millis(datetime.fromisoformat(exact_refetch.checked_at.replace("Z", "+00:00")))
                    certificate_hash = canonical_hash(
                        {
                            "checked_at": checked_at,
                            "outcome": "absent",
                            "reference_id": exact_refetch.reference_id,
                            "run_id": run_id,
                        }
                    )
                    exact_refetch = SpecExactRefetchCertificate(
                        reference_id=exact_refetch.reference_id,
                        outcome="absent",
                        checked_at=checked_at,
                        run_id=run_id,
                        certificate_hash=certificate_hash,
                    )
                lifecycle_evidence.append(
                    SpecLifecycleEvidence(
                        memo_reference_id=evidence.memo_reference_id,
                        observed_at=evidence.observed_at,
                        absent=evidence.absent,
                        reason=evidence.reason,
                        exact_refetch=exact_refetch,
                        absence_proof=evidence.absence_proof,
                    )
                )
        request = SpecReconciliationManifestRequest(
            run_id=run_id,
            scope_key="spms:all",
            source_system="spms",
            source_type="all",
            authoritative=True,
            complete=complete,
            manifest_hash=canonical_hash(hash_input),
            count=sum(manifest["count"] for manifest in by_type.values()),
            errors=errors,
            identity_drift=sum(1 for error in errors if error.get("stage") == "identity"),
            revision_drift=sum(1 for error in errors if error.get("stage") == "detail_or_publish"),
            authorization_drift=0,
            relation_drift=0,
            claim_drift=0,
            memo_link_drift=sum(1 for error in errors if error.get("stage") == "drift"),
            started_at=min(str(manifest["started_at"]) for manifest in by_type.values()),
            completed_at=completed_at if complete else None,
            lifecycle_evidence=tuple(lifecycle_evidence) if complete else (),
        )
        try:
            receipt = await get_skald_client().submit_spec_reconciliation_manifest(request)
        except Exception as exc:
            manager.record_sync_failure("spms-reconciliation", f"Manifest submission failed: {exc}")
            raise
        if complete:
            manager.record_sync_success(
                "spms-reconciliation",
                items_processed=request.count,
                items_failed=len(request.errors),
                metadata={"run_id": run_id, "manifest_hash": request.manifest_hash},
            )
        else:
            manager.record_sync_failure(
                "spms-reconciliation",
                f"Authoritative reconciliation {run_id} was incomplete with {len(request.errors)} errors",
            )
        return {
            "run_id": run_id,
            "complete": complete,
            "count": request.count,
            "errors": list(errors),
            "manifest_hash": request.manifest_hash,
            "by_type": by_type,
            "promotion_state": receipt.promotion_state,
        }

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
        """Sync SPMS document types in stable order under one shared global budget."""
        logger.info("Starting SPMS docs sync", updated_since=updated_since, max_documents=max_documents)

        results: dict[str, dict[str, int]] = {}
        remaining = max_documents

        for endpoint_type in ["functions", "techs", "information", "troubleshoots"]:
            if remaining == 0:
                results[endpoint_type] = {"processed": 0, "failed": 0, "skipped": 0}
                continue
            endpoint_results = await self.sync_endpoint(
                endpoint_type=endpoint_type,
                updated_since=updated_since,
                max_items=remaining,
            )
            results[endpoint_type] = endpoint_results
            remaining -= endpoint_results["processed"] + endpoint_results["failed"]

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
        _docs_collector = DocsCollector(api_key=settings.spms_api_key)
    return _docs_collector


# Fresh rebuild 20260207081045
