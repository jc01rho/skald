"""API routes for the worker service."""

import time
from datetime import timedelta

import structlog
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

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
from skald_worker.collectors.notion_collector import get_notion_collector
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
from skald_worker.middleware.auth import require_api_key, require_mutation_api_key
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
            "notion": settings.notion_enabled and bool(settings.notion_token) and bool(settings.notion_root_page_id),
            "release": settings.release_enabled and bool(settings.spms_base_url),
            "userdata": settings.userdata_enabled and bool(settings.spms_base_url),
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
        raise circuit_breaker_open("Skald", e.recovery_time) from e

    except Exception as e:
        search_requests_total.labels(status="error").inc()
        logger.error("Search failed", error=str(e))
        raise external_service_error("Skald", "Search failed", e) from e


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
        raise circuit_breaker_open("Skald", e.recovery_time) from e

    except Exception as e:
        similar_issues_requests_total.labels(status="error").inc()
        logger.error("Find similar issues failed", issue_key=request.issue_key, error=str(e))
        raise external_service_error("Search", "Find similar issues failed", e) from e


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
        raise circuit_breaker_open("Skald", e.recovery_time) from e

    except Exception as e:
        chat_requests_total.labels(status="error").inc()
        logger.error("Chat failed", error=str(e))
        raise external_service_error("Skald", "Chat failed", e) from e


@router.post("/sync", response_model=SyncResponse)
async def trigger_sync(
    request: SyncRequest,
    _api_key: str = Depends(require_mutation_api_key),
) -> SyncResponse:
    """Manually trigger a sync operation.

    Supports syncing Jira issues, technical docs, or Notion pages on demand.
    """
    start_time = time.perf_counter()
    sync_state_manager = get_sync_state_manager()

    try:
        if request.source != "docs" and request.mode != "incremental":
            from skald_worker.errors import bad_request

            raise bad_request(f"Sync mode '{request.mode}' is only supported for docs")
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

            collector = get_docs_collector()

            if request.mode == "authoritative":
                sync_state_manager.record_sync_start("docs_authoritative")
                result = await collector.sync_authoritative_all(
                    minimum_interval=timedelta(seconds=settings.spec_reconciliation_interval_seconds),
                    grace_period=timedelta(seconds=settings.spec_reconciliation_grace_seconds),
                )
                total_processed = result["count"]
                total_failed = len(result.get("errors", []))
                response = SyncResponse(
                    source="docs",
                    mode="authoritative",
                    status="completed" if result["complete"] else "incomplete",
                    processed=total_processed,
                    failed=total_failed,
                    run_id=result["run_id"],
                    complete=result["complete"],
                    count=result["count"],
                    promotion_state=result["promotion_state"],
                    progress={"by_type": result.get("by_type", {}), "errors": result.get("errors", [])},
                    message=f"Authoritative reconciliation observed {result['count']} documents",
                )
                if not result["complete"]:
                    failure_message = f"Authoritative reconciliation {result['run_id']} was incomplete"
                    sync_state_manager.record_sync_failure("docs_authoritative", failure_message)
                    sync_jobs_total.labels(source="docs", status="error").inc()
                    sync_items_processed_total.labels(source="docs", status="failed").inc(total_failed)
                    raise HTTPException(status_code=502, detail=response.model_dump())
                sync_state_manager.record_sync_success(
                    "docs_authoritative",
                    items_processed=total_processed,
                    items_failed=total_failed,
                    metadata={
                        "run_id": result["run_id"],
                        "complete": result["complete"],
                        "promotion_state": result["promotion_state"],
                    },
                )
            else:
                sync_state_manager.record_sync_start("docs")
                requested_max_documents = request.options.get(
                    "max_documents",
                    settings.spec_backfill_max_documents if request.mode == "full_backfill" else 5000,
                )
                max_documents = requested_max_documents
                if (
                    not isinstance(requested_max_documents, int)
                    or isinstance(requested_max_documents, bool)
                    or requested_max_documents < 1
                ):
                    from skald_worker.errors import bad_request

                    raise bad_request("options.max_documents must be a positive integer")
                max_documents = min(requested_max_documents, settings.spec_backfill_max_documents)
                updated_since = None if request.mode == "full_backfill" else request.options.get("updated_since")
                result = await collector.sync_all(
                    updated_since=updated_since,
                    max_documents=max_documents,
                )
                total = result.get("total", result)
                total_processed = total.get("processed", 0)
                total_failed = total.get("failed", 0)
                total_skipped = total.get("skipped", 0)
                response = SyncResponse(
                    source="docs",
                    mode=request.mode,
                    status="completed" if total_failed == 0 else "failed",
                    processed=total_processed,
                    failed=total_failed,
                    skipped=total_skipped,
                    max_documents=max_documents,
                    progress={"by_type": result.get("by_type", {})},
                    message=f"Synced {total_processed} documents in {request.mode} mode",
                )
                if total_failed and request.mode == "full_backfill":
                    sync_state_manager.record_sync_failure(
                        "docs",
                        f"{request.mode} completed with {total_failed} failed documents",
                    )
                    sync_jobs_total.labels(source="docs", status="error").inc()
                    sync_items_processed_total.labels(source="docs", status="success").inc(total_processed)
                    sync_items_processed_total.labels(source="docs", status="failed").inc(total_failed)
                    return JSONResponse(status_code=502, content=response.model_dump(mode="json"))
                sync_state_manager.record_sync_success(
                    "docs",
                    items_processed=total_processed,
                    items_failed=0,
                    metadata={
                        "mode": request.mode,
                        "updated_since": updated_since,
                        "max_documents": max_documents,
                        "by_type": result.get("by_type", {}),
                    },
                )

            sync_jobs_total.labels(source="docs", status="success").inc()
            sync_job_duration_seconds.labels(source="docs").observe(time.perf_counter() - start_time)
            sync_items_processed_total.labels(source="docs", status="success").inc(total_processed)
            sync_items_processed_total.labels(source="docs", status="failed").inc(total_failed)
            return response

        elif request.source == "notion":
            if not settings.notion_enabled or not settings.notion_token or not settings.notion_root_page_id:
                sync_jobs_total.labels(source="notion", status="error").inc()
                raise integration_not_configured("Notion")

            sync_state_manager.record_sync_start("notion")
            collector = get_notion_collector()
            result = await collector.sync_all()

            sync_jobs_total.labels(source="notion", status="success").inc()
            sync_job_duration_seconds.labels(source="notion").observe(time.perf_counter() - start_time)
            sync_items_processed_total.labels(source="notion", status="success").inc(result["processed"])
            sync_items_processed_total.labels(source="notion", status="failed").inc(result["failed"])

            sync_state_manager.record_sync_success(
                "notion",
                items_processed=result["processed"],
                items_failed=result["failed"],
                metadata={"root_page_id": settings.notion_root_page_id},
            )

            return SyncResponse(
                source="notion",
                status="completed",
                processed=result["processed"],
                failed=result["failed"],
                message=f"Synced {result['processed']} Notion pages",
            )

        else:
            from skald_worker.errors import bad_request

            raise bad_request(f"Unknown source: {request.source}. Valid sources: jira, docs, notion")

    except HTTPException:
        raise

    except CircuitBreakerError as e:
        sync_jobs_total.labels(source=request.source, status="circuit_open").inc()
        sync_state_manager.record_sync_failure(request.source, f"Circuit breaker open: {e.name}")
        circuit_breaker_rejections_total.labels(name=e.name).inc()
        raise circuit_breaker_open("Skald", e.recovery_time) from e

    except Exception as e:
        sync_jobs_total.labels(source=request.source, status="error").inc()
        sync_state_manager.record_sync_failure(request.source, str(e))
        logger.error("Sync failed", source=request.source, error=str(e))
        raise internal_error(f"Sync failed: {e}") from e
