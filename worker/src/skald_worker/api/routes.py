"""API routes for the worker service."""

import time

import structlog
from fastapi import APIRouter, Depends, HTTPException

from skald_worker.api.schemas import (
    ChatRequest,
    ChatResponse,
    HealthResponse,
    SearchRequest,
    SearchResponse,
    SearchResult,
    SimilarIssue,
    SimilarIssuesRequest,
    SimilarIssuesResponse,
    SyncRequest,
    SyncResponse,
)
from skald_worker.circuit_breaker import CircuitBreakerError, get_all_circuit_breakers
from skald_worker.clients.skald import get_skald_client
from skald_worker.collectors.docs_collector import get_docs_collector
from skald_worker.collectors.jira_collector import get_jira_collector
from skald_worker.config import settings
from skald_worker.errors import (
    circuit_breaker_open,
    external_service_error,
    integration_not_configured,
    internal_error,
)
from skald_worker.metrics import (
    chat_duration_seconds,
    chat_requests_total,
    circuit_breaker_rejections_total,
    search_duration_seconds,
    search_requests_total,
    similar_issues_requests_total,
    sync_items_processed_total,
    sync_job_duration_seconds,
    sync_jobs_total,
)
from skald_worker.middleware.auth import require_api_key
from skald_worker.sync_state import get_sync_state_manager

logger = structlog.get_logger(__name__)

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Health check endpoint."""
    from skald_worker import __version__
    from skald_worker.scheduler import get_scheduler_status

    # Get circuit breaker statuses
    circuit_breakers = {name: breaker.get_status() for name, breaker in get_all_circuit_breakers().items()}

    # Get sync state
    sync_state_manager = get_sync_state_manager()
    sync_status = sync_state_manager.get_status()

    return HealthResponse(
        status="healthy",
        version=__version__,
        collectors={
            "jira": settings.jira_enabled and bool(settings.jira_server),
            "docs": settings.docs_enabled and bool(settings.spms_base_url),
        },
        scheduler=get_scheduler_status(),
        circuit_breakers=circuit_breakers,
        sync_status=sync_status,
    )


@router.post("/search", response_model=SearchResponse)
async def search(
    request: SearchRequest,
    _api_key: str | None = Depends(require_api_key),
) -> SearchResponse:
    """Search for documents using RAG.

    Proxies search request to Skald API and returns results.
    """
    start_time = time.perf_counter()
    try:
        skald = get_skald_client()

        # Convert filter models to dicts for API
        filters = None
        if request.filters:
            filters = [f.model_dump() for f in request.filters]

        result = await skald.search(
            query=request.query,
            limit=request.limit,
            threshold=request.threshold,
            filters=filters,
        )

        results = []
        for item in result.get("results", []):
            results.append(
                SearchResult(
                    id=item.get("id", ""),
                    title=item.get("title", ""),
                    content=item.get("content", "")[:500],  # Truncate content
                    score=item.get("score", 0.0),
                    reference_id=item.get("referenceId"),
                    metadata=item.get("metadata", {}),
                )
            )

        search_requests_total.labels(status="success").inc()
        search_duration_seconds.observe(time.perf_counter() - start_time)

        return SearchResponse(
            query=request.query,
            results=results,
            total=len(results),
        )

    except CircuitBreakerError as e:
        search_requests_total.labels(status="circuit_open").inc()
        circuit_breaker_rejections_total.labels(name=e.name).inc()
        raise circuit_breaker_open("Skald", e.recovery_time)

    except Exception as e:
        search_requests_total.labels(status="error").inc()
        logger.error("Search failed", error=str(e))
        raise external_service_error("Skald", "Search failed", e)


@router.post("/similar-issues", response_model=SimilarIssuesResponse)
async def find_similar_issues(
    request: SimilarIssuesRequest,
    _api_key: str | None = Depends(require_api_key),
) -> SimilarIssuesResponse:
    """Find similar Jira issues.

    Fetches the specified issue from Jira, converts it to text,
    and searches for similar documents in Skald.
    """
    if not settings.jira_enabled or not settings.jira_server:
        similar_issues_requests_total.labels(status="error").inc()
        raise integration_not_configured("Jira")

    try:
        collector = get_jira_collector()
        result = await collector.find_similar_issues(
            issue_key=request.issue_key,
            limit=request.limit,
            threshold=request.threshold,
        )

        similar = []
        for item in result.get("similar_issues", []):
            similar.append(
                SimilarIssue(
                    reference_id=item.get("referenceId", ""),
                    title=item.get("title", ""),
                    score=item.get("score", 0.0),
                    metadata=item.get("metadata", {}),
                )
            )

        similar_issues_requests_total.labels(status="success").inc()

        return SimilarIssuesResponse(
            issue_key=request.issue_key,
            similar_issues=similar,
        )

    except CircuitBreakerError as e:
        similar_issues_requests_total.labels(status="circuit_open").inc()
        circuit_breaker_rejections_total.labels(name=e.name).inc()
        raise circuit_breaker_open("Skald", e.recovery_time)

    except Exception as e:
        similar_issues_requests_total.labels(status="error").inc()
        logger.error("Find similar issues failed", issue_key=request.issue_key, error=str(e))
        raise external_service_error("Search", "Find similar issues failed", e)


@router.post("/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    _api_key: str | None = Depends(require_api_key),
) -> ChatResponse:
    """Chat with RAG system.

    Proxies chat request to Skald API for RAG-based response.
    """
    start_time = time.perf_counter()
    try:
        skald = get_skald_client()

        # Convert filter models to dicts for API
        filters = None
        if request.filters:
            filters = [f.model_dump() for f in request.filters]

        result = await skald.chat(
            message=request.message,
            conversation_id=request.conversation_id,
            filters=filters,
            system_prompt=request.system_prompt,
        )

        chat_requests_total.labels(status="success").inc()
        chat_duration_seconds.observe(time.perf_counter() - start_time)

        return ChatResponse(
            message=result.get("message", ""),
            conversation_id=result.get("conversationId"),
            sources=result.get("sources", []),
        )

    except CircuitBreakerError as e:
        chat_requests_total.labels(status="circuit_open").inc()
        circuit_breaker_rejections_total.labels(name=e.name).inc()
        raise circuit_breaker_open("Skald", e.recovery_time)

    except Exception as e:
        chat_requests_total.labels(status="error").inc()
        logger.error("Chat failed", error=str(e))
        raise external_service_error("Skald", "Chat failed", e)


@router.post("/sync", response_model=SyncResponse)
async def trigger_sync(
    request: SyncRequest,
    _api_key: str | None = Depends(require_api_key),
) -> SyncResponse:
    """Manually trigger a sync operation.

    Supports syncing Jira issues or technical docs on demand.
    """
    start_time = time.perf_counter()
    sync_state_manager = get_sync_state_manager()

    try:
        if request.source == "jira":
            if not settings.jira_enabled or not settings.jira_server:
                sync_jobs_total.labels(source="jira", status="error").inc()
                raise integration_not_configured("Jira")

            sync_state_manager.record_sync_start("jira")
            collector = get_jira_collector()
            jql = request.options.get("jql", settings.jira_jql_filter)
            max_results = request.options.get("max_results", 100)

            result = await collector.sync_all(jql=jql, max_results=max_results)

            # Record metrics
            sync_jobs_total.labels(source="jira", status="success").inc()
            sync_job_duration_seconds.labels(source="jira").observe(time.perf_counter() - start_time)
            sync_items_processed_total.labels(source="jira", status="success").inc(result["processed"])
            sync_items_processed_total.labels(source="jira", status="failed").inc(result["failed"])

            # Record sync state
            sync_state_manager.record_sync_success(
                "jira",
                items_processed=result["processed"],
                items_failed=result["failed"],
                metadata={"jql": jql, "max_results": max_results},
            )

            return SyncResponse(
                source="jira",
                status="completed",
                processed=result["processed"],
                failed=result["failed"],
                message=f"Synced {result['processed']} issues",
            )

        elif request.source == "docs":
            if not settings.docs_enabled or not settings.spms_base_url:
                sync_jobs_total.labels(source="docs", status="error").inc()
                raise integration_not_configured("Docs")

            sync_state_manager.record_sync_start("docs")
            collector = get_docs_collector()
            updated_since = request.options.get("updated_since")
            max_documents = request.options.get("max_documents", 500)

            result = await collector.sync_all(
                updated_since=updated_since,
                max_documents=max_documents,
            )

            # Extract totals from nested result structure
            total_processed = result["total"]["processed"]
            total_failed = result["total"]["failed"]

            # Record metrics
            sync_jobs_total.labels(source="docs", status="success").inc()
            sync_job_duration_seconds.labels(source="docs").observe(time.perf_counter() - start_time)
            sync_items_processed_total.labels(source="docs", status="success").inc(total_processed)
            sync_items_processed_total.labels(source="docs", status="failed").inc(total_failed)

            # Record sync state
            sync_state_manager.record_sync_success(
                "docs",
                items_processed=total_processed,
                items_failed=total_failed,
                metadata={"max_documents": max_documents, "by_type": result.get("by_type", {})},
            )

            return SyncResponse(
                source="docs",
                status="completed",
                processed=total_processed,
                failed=total_failed,
                message=f"Synced {total_processed} documents",
            )

        else:
            from skald_worker.errors import bad_request

            raise bad_request(f"Unknown source: {request.source}. Valid sources: jira, docs")

    except HTTPException:
        raise

    except CircuitBreakerError as e:
        sync_jobs_total.labels(source=request.source, status="circuit_open").inc()
        sync_state_manager.record_sync_failure(request.source, f"Circuit breaker open: {e.name}")
        circuit_breaker_rejections_total.labels(name=e.name).inc()
        raise circuit_breaker_open("Skald", e.recovery_time)

    except Exception as e:
        sync_jobs_total.labels(source=request.source, status="error").inc()
        sync_state_manager.record_sync_failure(request.source, str(e))
        logger.error("Sync failed", source=request.source, error=str(e))
        raise internal_error(f"Sync failed: {e}")
