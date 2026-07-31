"""Skald API client for interacting with Skald service."""

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any
from uuid import UUID

import httpx
import structlog

from skald_worker.circuit_breaker import (
    CircuitBreaker,
    CircuitBreakerConfig,
    get_circuit_breaker,
)
from skald_worker.config import settings
from skald_worker.retry import with_retry

logger = structlog.get_logger(__name__)

# Default retry configuration
DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_MIN_WAIT = 1.0
DEFAULT_RETRY_MAX_WAIT = 30.0


class SkaldClientRequestError(httpx.HTTPStatusError):
    """Non-retryable client error that must not mark Skald as unavailable."""



def sha256_text(value: str) -> str:
    """Return the SHA256 digest of an exact UTF-8 string."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()



def _legacy_reference_id_from_source(source: str | None, metadata: dict[str, Any] | None) -> str | None:
    if not source or not metadata:
        return None

    if source in {"function", "functions"}:
        function_id = metadata.get("api_function_id")
        if function_id:
            return f"{source}-{function_id}"
        return None

    spms_id = metadata.get("spms_id")
    if not spms_id:
        return None

    return f"{source}-{spms_id}"


def canonical_json(value: Any) -> str:
    """Serialize JSON-compatible data deterministically for hashing and transport."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonical_hash(value: Any) -> str:
    """Return the SHA256 digest of a canonical JSON value."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _raise_for_status(response: httpx.Response) -> None:
    """Raise client errors separately so they do not open the service circuit."""
    if 400 <= response.status_code < 500 and response.status_code not in {408, 429}:
        message = f"Client error '{response.status_code} {response.reason_phrase}' for url '{response.request.url}'"
        try:
            detail = response.text.strip()
        except httpx.ResponseNotRead:
            detail = ""
        if detail:
            message = f"{message}: {detail}"
        raise SkaldClientRequestError(message, request=response.request, response=response)
    response.raise_for_status()



@dataclass(frozen=True)
class SpecRevisionPublishRequest:
    project_id: str
    idempotency_key: str
    source: dict[str, Any]
    revision: dict[str, Any]
    memo: dict[str, Any]
    relations: tuple[dict[str, Any], ...]
    claims: tuple[dict[str, Any], ...]
    expected_relation_count: int
    expected_relation_hash: str
    expected_claim_count: int
    expected_claim_hash: str

    def to_payload(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SpecRevisionPublishReceipt:
    status: str
    source_id: str
    source_key: str
    revision_id: str
    memo_uuid: str
    memo_reference_id: str
    source_payload_hash: str
    relation_hash: str
    claim_hash: str
    idempotent_replay: bool


@dataclass(frozen=True)
class SpecExactRefetchCertificate:
    reference_id: str
    outcome: str
    checked_at: str
    run_id: str
    certificate_hash: str


@dataclass(frozen=True)
class SpecAbsenceProof:
    first_run_id: str
    first_observed_at: str
    second_run_id: str
    second_observed_at: str
    grace_deadline: str


@dataclass(frozen=True)
class SpecLifecycleEvidence:
    memo_reference_id: str
    observed_at: str
    absent: bool
    reason: str
    exact_refetch: SpecExactRefetchCertificate | None = None
    absence_proof: SpecAbsenceProof | None = None


@dataclass(frozen=True)
class SpecReconciliationManifestRequest:
    run_id: str
    scope_key: str
    source_system: str
    source_type: str
    authoritative: bool
    complete: bool
    manifest_hash: str
    count: int
    errors: tuple[dict[str, Any], ...]
    identity_drift: int
    revision_drift: int
    authorization_drift: int
    relation_drift: int
    claim_drift: int
    memo_link_drift: int
    started_at: str
    completed_at: str | None
    lifecycle_evidence: tuple[SpecLifecycleEvidence, ...]

    def to_payload(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SpecReconciliationManifestReceipt:
    run_id: str
    promotion_state: str
    idempotent_replay: bool

class SkaldClient:
    """HTTP client for Skald API with automatic retry and circuit breaker."""

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        project_id: str | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_min_wait: float = DEFAULT_RETRY_MIN_WAIT,
        retry_max_wait: float = DEFAULT_RETRY_MAX_WAIT,
        circuit_breaker: CircuitBreaker | None = None,
    ):
        self.base_url = (base_url or settings.skald_base_url).rstrip("/")
        self.api_key = api_key or settings.skald_api_key
        self.project_id = project_id or settings.skald_project_id
        self.max_retries = max_retries
        self.retry_min_wait = retry_min_wait
        self.retry_max_wait = retry_max_wait
        self._client: httpx.AsyncClient | None = None

        # Circuit breaker for this client
        if circuit_breaker:
            self._circuit_breaker = circuit_breaker
        else:
            self._circuit_breaker = get_circuit_breaker(
                "skald-api",
                CircuitBreakerConfig(
                    failure_threshold=settings.circuit_breaker_failure_threshold,
                    recovery_timeout=settings.circuit_breaker_recovery_timeout,
                    success_threshold=settings.circuit_breaker_success_threshold,
                    exclude_exceptions=(SkaldClientRequestError,),
                ),
            )

    @property
    def client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None or self._client.is_closed:
            headers = {
                "Content-Type": "application/json",
            }
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"

            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers=headers,
                timeout=httpx.Timeout(60.0, connect=10.0),
            )
        return self._client

    async def _request_with_retry(
        self,
        method: str,
        url: str,
        **kwargs: Any,
    ) -> httpx.Response:
        """Execute HTTP request with retry logic and circuit breaker.

        Args:
            method: HTTP method
            url: Request URL
            **kwargs: Additional request kwargs

        Returns:
            HTTP response

        Raises:
            CircuitBreakerError: If circuit is open
            httpx.HTTPError: On request failure after retries
        """
        # Check circuit breaker first
        async with self._circuit_breaker:

            async def _do_request() -> httpx.Response:
                response = await self.client.request(method, url, **kwargs)
                _raise_for_status(response)
                return response

            return await with_retry(
                _do_request,
                max_attempts=self.max_retries,
                min_wait=self.retry_min_wait,
                max_wait=self.retry_max_wait,
            )

    @property
    def circuit_breaker(self) -> CircuitBreaker:
        """Get the circuit breaker for this client."""
        return self._circuit_breaker

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    @staticmethod
    def compute_content_hash(
        content: str,
        title: str = "",
        metadata: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> str:
        """Compute SHA256 hash of content for change detection.

        Args:
            content: Main content
            title: Unused, kept for backward-compatible call signatures
            metadata: Unused, kept for backward-compatible call signatures
            tags: Unused, kept for backward-compatible call signatures

        Returns:
            Full SHA256 hex digest of content
        """
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    async def create_memo(
        self,
        title: str,
        content: str,
        reference_id: str,
        source: str = "worker",
        metadata: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        """Create a new memo in Skald.

        Args:
            title: Memo title
            content: Memo content (markdown)
            reference_id: External reference ID for deduplication
            source: Source identifier (e.g., 'jira', 'spms')
            metadata: Additional metadata
            tags: Tags for categorization and search

        Returns:
            Created memo data
        """
        payload = {
            "title": title,
            "content": content,
            "reference_id": reference_id,
            "projectId": self.project_id,
            "source": source,
            "contentHash": self.compute_content_hash(content, title, metadata, tags),
            "metadata": metadata or {},
            "tags": tags or [],
        }

        response = await self._request_with_retry("POST", "/api/v1/memo", json=payload)
        logger.info("Created memo", reference_id=reference_id, title=title)
        return response.json()

    async def update_memo(
        self,
        reference_id: str,
        title: str | None = None,
        content: str | None = None,
        metadata: dict[str, Any] | None = None,
        tags: list[str] | None = None,
        client_reference_id: str | None = None,
    ) -> dict[str, Any]:
        """Update an existing memo by reference ID.

        Args:
            reference_id: External reference ID
            title: New title (optional)
            content: New content (optional)
            metadata: Updated metadata (optional)
            tags: Updated tags (optional)

        Returns:
            Updated memo data
        """
        payload: dict[str, Any] = {}
        if title:
            payload["title"] = title
        if content:
            payload["content"] = content
            payload["contentHash"] = self.compute_content_hash(content, title or "", metadata, tags)
        if metadata:
            payload["metadata"] = metadata
        if tags is not None:
            payload["tags"] = tags
        if client_reference_id is not None:
            payload["client_reference_id"] = client_reference_id

        response = await self._request_with_retry(
            "PATCH",
            f"/api/v1/memo/{reference_id}",
            params={"id_type": "reference_id"},
            json=payload,
        )
        logger.info("Updated memo", reference_id=reference_id)
        return response.json()

    async def get_memo(self, reference_id: str) -> dict[str, Any] | None:
        """Get a memo by reference ID.

        Args:
            reference_id: External reference ID

        Returns:
            Memo data or None if not found
        """
        async with self._circuit_breaker:

            async def _do_request() -> dict[str, Any] | None:
                response = await self.client.request(
                    "GET",
                    f"/api/v1/memo/{reference_id}",
                    params={"id_type": "reference_id"},
                )
                if response.status_code == 404:
                    return None
                response.raise_for_status()
                return response.json()

            return await with_retry(
                _do_request,
                max_attempts=self.max_retries,
                min_wait=self.retry_min_wait,
                max_wait=self.retry_max_wait,
            )

    async def count_memos(self, source: str | None = None) -> int:
        """Count memos in the configured Skald project."""
        params: dict[str, Any] = {"page": 1, "page_size": 1}
        if source:
            params["source"] = source

        response = await self._request_with_retry("GET", "/api/v1/memo", params=params)
        data = response.json()
        return int(data.get("count", 0))

    async def upsert_memo(
        self,
        title: str,
        content: str,
        reference_id: str,
        source: str = "worker",
        metadata: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        """Create or update a memo based on reference ID and content hash.

        Args:
            title: Memo title
            content: Memo content
            reference_id: External reference ID
            source: Source identifier
            metadata: Additional metadata
            tags: Tags for categorization

        Returns:
            Memo data (created or updated)
        """
        lookup_reference_id = reference_id
        existing = await self.get_memo(reference_id)
        if not existing:
            legacy_reference_id = _legacy_reference_id_from_source(source, metadata)
            if legacy_reference_id and legacy_reference_id != reference_id:
                existing = await self.get_memo(legacy_reference_id)
                if existing:
                    lookup_reference_id = legacy_reference_id
        content_hash = self.compute_content_hash(content, title, metadata, tags)

        if existing:
            # Check if content has changed
            existing_hash = existing.get("contentHash", "")
            if existing_hash == content_hash:
                logger.debug("Memo unchanged, skipping update", reference_id=reference_id)
                return existing

            # Update existing memo
            return await self.update_memo(
                reference_id=lookup_reference_id,
                title=title,
                content=content,
                metadata=metadata,
                tags=tags,
                client_reference_id=reference_id,
            )

        # Create new memo
        return await self.create_memo(
            title=title,
            content=content,
            reference_id=reference_id,
            source=source,
            metadata=metadata,
            tags=tags,
        )

    async def stage_and_publish_spec_revision(
        self,
        request: SpecRevisionPublishRequest,
    ) -> SpecRevisionPublishReceipt:
        """Atomically publish a canonical spec revision and validate its receipt."""
        payload = request.to_payload()
        response = await self._request_with_retry(
            "POST",
            "/api/v1/spec-revisions/stage-and-publish",
            json=payload,
        )
        data = response.json()
        required_text = (
            "source_key",
            "memo_reference_id",
            "source_payload_hash",
            "relation_hash",
            "claim_hash",
        )
        required_ids = ("source_id", "revision_id", "memo_uuid")
        if data.get("status") != "published" or any(not isinstance(data.get(key), str) or not data[key] for key in required_text):
            raise ValueError("Invalid stage-and-publish receipt")
        try:
            for key in required_ids:
                UUID(str(data.get(key)))
        except (TypeError, ValueError) as error:
            raise ValueError("Invalid stage-and-publish receipt IDs") from error
        expected = {
            "source_key": request.source["source_key"],
            "source_payload_hash": request.revision["source_payload_hash"],
            "relation_hash": request.expected_relation_hash,
            "claim_hash": request.expected_claim_hash,
            "memo_reference_id": request.memo["client_reference_id"],
        }
        mismatches = [key for key, value in expected.items() if data.get(key) != value]
        if mismatches:
            raise ValueError(f"Stage-and-publish receipt mismatch: {', '.join(mismatches)}")
        if not isinstance(data.get("idempotent_replay"), bool):
            raise ValueError("Invalid stage-and-publish idempotency receipt")
        return SpecRevisionPublishReceipt(**{key: data[key] for key in SpecRevisionPublishReceipt.__dataclass_fields__})

    async def submit_spec_reconciliation_manifest(
        self,
        request: SpecReconciliationManifestRequest,
    ) -> SpecReconciliationManifestReceipt:
        """Submit authoritative reconciliation proof and validate the server receipt."""
        response = await self._request_with_retry(
            "POST",
            "/api/v1/spec-reconciliation/manifests",
            json=request.to_payload(),
        )
        data = response.json()
        run = data.get("run")
        promotion = data.get("promotion")
        if not isinstance(run, dict) or run.get("run_id") != request.run_id:
            raise ValueError("Invalid reconciliation manifest receipt run")
        if not isinstance(promotion, dict) or not isinstance(promotion.get("state"), str):
            raise ValueError("Invalid reconciliation manifest receipt promotion")
        if not isinstance(data.get("idempotent_replay"), bool):
            raise ValueError("Invalid reconciliation manifest idempotency receipt")
        return SpecReconciliationManifestReceipt(
            run_id=run["run_id"],
            promotion_state=promotion["state"],
            idempotent_replay=data["idempotent_replay"],
        )

    async def search(
        self,
        query: str,
        limit: int = 10,
        threshold: float = 0.7,
        filters: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Search memos using vector similarity.

        Args:
            query: Search query text
            limit: Maximum number of results
            threshold: Similarity threshold (0-1)
            filters: Optional filters to apply, e.g.:
                [{"field": "source", "operator": "eq", "value": "jira", "filter_type": "native_field"}]

        Returns:
            Search results
        """
        payload: dict[str, Any] = {
            "query": query,
            "projectId": self.project_id,
            "limit": min(limit, 50),
            "threshold": threshold,
        }

        if filters:
            payload["filters"] = filters

        response = await self._request_with_retry("POST", "/api/v1/search", json=payload)
        return response.json()

    async def chat(
        self,
        message: str,
        conversation_id: str | None = None,
        filters: list[dict[str, Any]] | None = None,
        system_prompt: str | None = None,
    ) -> dict[str, Any]:
        """Send a chat message for RAG-based response.

        Args:
            message: User message
            conversation_id: Optional conversation ID for context
            filters: Optional filters for search context
            system_prompt: Optional system prompt for chat behavior

        Returns:
            Chat response
        """
        payload: dict[str, Any] = {
            "message": message,
            "projectId": self.project_id,
        }
        if conversation_id:
            payload["conversationId"] = conversation_id
        if filters:
            payload["filters"] = filters
        if system_prompt:
            payload["systemPrompt"] = system_prompt

        response = await self._request_with_retry("POST", "/api/v1/chat", json=payload)
        return response.json()


# Singleton instance
_skald_client: SkaldClient | None = None


def get_skald_client() -> SkaldClient:
    """Get or create the singleton Skald client."""
    global _skald_client
    if _skald_client is None:
        _skald_client = SkaldClient()
    return _skald_client
