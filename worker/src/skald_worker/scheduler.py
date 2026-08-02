"""Background scheduler for periodic data collection."""

from datetime import UTC, datetime, timedelta
from typing import Any

import structlog
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from skald_worker.clients.skald import get_skald_client
from skald_worker.collectors.docs_collector import get_docs_collector
from skald_worker.collectors.jira_collector import get_jira_collector
from skald_worker.collectors.notion_collector import get_notion_collector
from skald_worker.collectors.release_collector import get_release_collector
from skald_worker.collectors.userdata_collector import get_userdata_collector
from skald_worker.config import settings
from skald_worker.metrics import sync_items_processed_total, sync_job_duration_seconds, sync_jobs_total
from skald_worker.sync_state import SyncStateCorruptionError, get_sync_state_manager

logger = structlog.get_logger(__name__)

# Global scheduler instance
_scheduler: AsyncIOScheduler | None = None
_last_runs: dict[str, datetime] = {}
SPMS_BOOTSTRAP_SOURCES = ("functions", "techs", "information", "troubleshoots")
SPMS_CANONICAL_LEGACY_SOURCES = ("functions", "information")


def _result_counts(result: dict[str, Any]) -> tuple[int, int]:
    total = result.get("total", result)
    return int(total.get("processed", 0)), int(total.get("failed", 0))


def _require_clean_result(source: str, result: dict[str, Any]) -> tuple[int, int]:
    processed, failed = _result_counts(result)
    sync_items_processed_total.labels(source=source, status="success").inc(processed)
    sync_items_processed_total.labels(source=source, status="failed").inc(failed)
    if failed > 0:
        raise RuntimeError(f"{source} sync completed with {failed} failed items")
    return processed, failed


def _record_scheduled_failure(source: str) -> None:
    sync_jobs_total.labels(source=source, status="error").inc()


def _record_durable_failure(source: str, error: Exception) -> None:
    try:
        get_sync_state_manager().record_sync_failure(source, str(error))
    except SyncStateCorruptionError:
        logger.error("Cannot record sync failure because durable state is corrupt", source=source)
    except Exception as state_error:
        logger.error("Failed to persist sync failure", source=source, error=str(state_error))


async def jira_sync_job() -> None:
    """Scheduled job to sync Jira issues."""
    logger.info("Starting scheduled Jira sync")
    started_at = datetime.now(UTC)
    try:
        collector = get_jira_collector()
        result = await collector.sync_all()
        processed, failed = _require_clean_result("jira", result)
        _last_runs["jira"] = datetime.now(UTC)
        sync_jobs_total.labels(source="jira", status="success").inc()
        sync_job_duration_seconds.labels(source="jira").observe((datetime.now(UTC) - started_at).total_seconds())
        logger.info("Scheduled Jira sync completed", processed=processed, failed=failed)
    except Exception as e:
        _record_scheduled_failure("jira")
        _record_durable_failure("jira", e)
        logger.error("Scheduled Jira sync failed", error=str(e))
        raise


async def docs_sync_job() -> None:
    """Scheduled job to sync technical docs (incremental, last N days)."""
    logger.info("Starting scheduled docs sync")
    started_at = datetime.now(UTC)
    try:
        collector = get_docs_collector()
        updated_since = (datetime.now(UTC) - timedelta(days=settings.docs_sync_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        logger.info("Syncing docs updated since", updated_since=updated_since, days=settings.docs_sync_days)
        result = await collector.sync_all(updated_since=updated_since)
        processed, failed = _require_clean_result("docs", result)
        _last_runs["docs"] = datetime.now(UTC)
        sync_jobs_total.labels(source="docs", status="success").inc()
        sync_job_duration_seconds.labels(source="docs").observe((datetime.now(UTC) - started_at).total_seconds())
        logger.info("Scheduled docs sync completed", processed=processed, failed=failed)
    except Exception as e:
        _record_scheduled_failure("docs")
        _record_durable_failure("docs", e)
        logger.error("Scheduled docs sync failed", error=str(e))
        raise


async def docs_authoritative_reconciliation_job() -> None:
    """Scheduled terminal SPMS enumeration for safe absence reconciliation."""
    logger.info("Starting authoritative docs reconciliation")
    started_at = datetime.now(UTC)
    try:
        collector = get_docs_collector()
        result = await collector.sync_authoritative_all(
            minimum_interval=timedelta(seconds=settings.spec_reconciliation_interval_seconds),
            grace_period=timedelta(seconds=settings.spec_reconciliation_grace_seconds),
        )
        if not result.get("complete", False) or result.get("errors"):
            raise RuntimeError(f"Authoritative docs reconciliation {result.get('run_id')} was incomplete")
        _last_runs["docs_reconciliation"] = datetime.now(UTC)
        sync_jobs_total.labels(source="docs", status="success").inc()
        sync_job_duration_seconds.labels(source="docs").observe((datetime.now(UTC) - started_at).total_seconds())
        logger.info("Authoritative docs reconciliation completed", complete=True, count=result["count"])
    except Exception as e:
        _record_scheduled_failure("docs")
        _record_durable_failure("docs_authoritative", e)
        logger.error("Authoritative docs reconciliation failed", error=str(e))
        raise


async def release_sync_job() -> None:
    """Scheduled job to sync release status documents."""
    logger.info("Starting scheduled release sync")
    started_at = datetime.now(UTC)
    try:
        result = await get_release_collector().sync_all()
        processed, failed = _require_clean_result("release", result)
        _last_runs["release"] = datetime.now(UTC)
        sync_jobs_total.labels(source="release", status="success").inc()
        sync_job_duration_seconds.labels(source="release").observe((datetime.now(UTC) - started_at).total_seconds())
        logger.info("Scheduled release sync completed", processed=processed, failed=failed)
    except Exception as e:
        _record_scheduled_failure("release")
        _record_durable_failure("release", e)
        logger.error("Scheduled release sync failed", error=str(e))
        raise


async def userdata_sync_job() -> None:
    """Scheduled job to sync customer userdata documents."""
    logger.info("Starting scheduled userdata sync")
    started_at = datetime.now(UTC)
    try:
        result = await get_userdata_collector().sync_all()
        processed, failed = _require_clean_result("userdata", result)
        _last_runs["userdata"] = datetime.now(UTC)
        sync_jobs_total.labels(source="userdata", status="success").inc()
        sync_job_duration_seconds.labels(source="userdata").observe((datetime.now(UTC) - started_at).total_seconds())
        logger.info("Scheduled userdata sync completed", processed=processed, failed=failed)
    except Exception as e:
        _record_scheduled_failure("userdata")
        _record_durable_failure("userdata", e)
        logger.error("Scheduled userdata sync failed", error=str(e))
        raise


async def notion_sync_job() -> None:
    """Scheduled job to sync Notion wiki pages."""
    logger.info("Starting scheduled Notion sync")
    started_at = datetime.now(UTC)
    try:
        result = await get_notion_collector().sync_all()
        processed, failed = _require_clean_result("notion", result)
        _last_runs["notion"] = datetime.now(UTC)
        sync_jobs_total.labels(source="notion", status="success").inc()
        sync_job_duration_seconds.labels(source="notion").observe((datetime.now(UTC) - started_at).total_seconds())
        logger.info("Scheduled Notion sync completed", processed=processed, failed=failed)
    except Exception as e:
        _record_scheduled_failure("notion")
        logger.error("Scheduled Notion sync failed", error=str(e))
        raise


async def bootstrap_initial_full_sync() -> None:
    """Run enabled startup backfills and expose any mutation failures to startup."""
    failures: list[Exception] = []
    _ = get_sync_state_manager().state

    if settings.docs_enabled and settings.spms_base_url:
        try:
            await _bootstrap_initial_spms_sync(get_skald_client())
        except Exception as exc:
            _record_durable_failure("docs_bootstrap", exc)
            logger.error("Initial full SPMS sync failed", error=str(exc))
            failures.append(exc)

    if settings.notion_enabled and settings.notion_token and settings.notion_root_page_id:
        try:
            await _bootstrap_initial_notion_sync(get_skald_client())
        except Exception as exc:
            _record_durable_failure("notion_bootstrap", exc)
            logger.error("Initial full Notion sync failed", error=str(exc))
            failures.append(exc)

    if len(failures) == 1:
        raise failures[0]
    if failures:
        raise ExceptionGroup("Startup sync mutations failed", failures)


async def _bootstrap_initial_spms_sync(skald) -> None:
    """Backfill legacy/empty SPMS projections and then reconcile when enabled."""
    if not settings.spec_startup_backfill_enabled and not settings.spec_startup_authoritative_enabled:
        logger.info("Skipping startup SPMS mutation; startup triggers are disabled")
        return

    legacy_counts = {source: await skald.count_memos(source=source) for source in SPMS_BOOTSTRAP_SOURCES}
    canonical_count = await skald.count_memos(source="spms")
    needs_backfill = (all(count == 0 for count in legacy_counts.values()) and canonical_count == 0) or any(
        legacy_counts[source] > 0 for source in SPMS_CANONICAL_LEGACY_SOURCES
    )
    collector = get_docs_collector()

    if settings.spec_startup_backfill_enabled and needs_backfill:
        logger.info(
            "Starting startup SPMS full backfill",
            legacy_source_counts=legacy_counts,
            canonical_count=canonical_count,
            max_documents=settings.spec_backfill_max_documents,
        )
        result = await collector.sync_all(
            updated_since=None,
            max_documents=settings.spec_backfill_max_documents,
        )
        processed, failed = _require_clean_result("docs", result)
        _last_runs["docs_bootstrap"] = datetime.now(UTC)
        logger.info(
            "Startup SPMS full backfill completed",
            processed=processed,
            failed=failed,
            skipped=result.get("total", result).get("skipped", 0),
        )
    elif settings.spec_startup_backfill_enabled:
        logger.info(
            "Skipping startup SPMS full backfill; canonical projection exists",
            legacy_source_counts=legacy_counts,
            canonical_count=canonical_count,
        )

    if settings.spec_startup_authoritative_enabled:
        result = await collector.sync_authoritative_all(
            minimum_interval=timedelta(seconds=settings.spec_reconciliation_interval_seconds),
            grace_period=timedelta(seconds=settings.spec_reconciliation_grace_seconds),
        )
        if not result.get("complete", False) or result.get("errors"):
            raise RuntimeError(f"Startup authoritative SPMS reconciliation {result.get('run_id')} was incomplete")
        _last_runs["docs_reconciliation_bootstrap"] = datetime.now(UTC)
        logger.info(
            "Startup authoritative SPMS reconciliation completed",
            run_id=result["run_id"],
            complete=True,
            count=result["count"],
            promotion_state=result["promotion_state"],
        )


async def _bootstrap_initial_notion_sync(skald) -> None:
    """Run full Notion sync when no Notion source data exists."""
    notion_count = await skald.count_memos(source="notion")
    if notion_count == 0:
        logger.info("Starting initial full Notion sync", source_count=notion_count)
        collector = get_notion_collector()
        result = await collector.sync_all(force_full=True)
        processed, failed = _require_clean_result("notion", result)
        _last_runs["notion_bootstrap"] = datetime.now(UTC)
        logger.info("Initial full Notion sync completed", processed=processed, failed=failed)
    else:
        logger.info("Skipping initial full Notion sync; source data exists", source_count=notion_count)


def start_scheduler() -> AsyncIOScheduler:
    """Start the background scheduler with configured jobs."""
    global _scheduler

    if _scheduler is not None:
        return _scheduler

    _scheduler = AsyncIOScheduler()

    # Add Jira sync job if enabled
    if settings.jira_enabled and settings.jira_server:
        _scheduler.add_job(
            jira_sync_job,
            trigger=IntervalTrigger(minutes=settings.jira_poll_interval_minutes),
            id="jira_sync",
            name="Jira Issue Sync",
            replace_existing=True,
        )
        logger.info(
            "Scheduled Jira sync job",
            interval_minutes=settings.jira_poll_interval_minutes,
        )

    # Add docs sync job if enabled (daily at configured hour)
    if settings.docs_enabled and settings.spms_base_url:
        _scheduler.add_job(
            docs_sync_job,
            trigger=CronTrigger(
                hour=settings.docs_sync_cron_hour,
                minute=settings.docs_sync_cron_minute,
            ),
            id="docs_sync",
            name="Docs Sync",
            replace_existing=True,
        )
        logger.info(
            "Scheduled docs sync job",
            cron_hour=settings.docs_sync_cron_hour,
            cron_minute=settings.docs_sync_cron_minute,
            sync_days=settings.docs_sync_days,
        )
        _scheduler.add_job(
            docs_authoritative_reconciliation_job,
            trigger=IntervalTrigger(hours=settings.docs_reconciliation_interval_hours),
            id="docs_reconciliation",
            name="Docs Authoritative Reconciliation",
            replace_existing=True,
        )

    if settings.release_enabled and settings.spms_base_url:
        _scheduler.add_job(
            release_sync_job,
            trigger=CronTrigger(
                hour=settings.docs_sync_cron_hour,
                minute=settings.docs_sync_cron_minute,
            ),
            id="release_sync",
            name="Release Sync",
            replace_existing=True,
        )
        logger.info(
            "Scheduled release sync job",
            cron_hour=settings.docs_sync_cron_hour,
            cron_minute=settings.docs_sync_cron_minute,
        )

    if settings.userdata_enabled and settings.spms_base_url:
        _scheduler.add_job(
            userdata_sync_job,
            trigger=CronTrigger(
                hour=settings.docs_sync_cron_hour,
                minute=settings.docs_sync_cron_minute,
            ),
            id="userdata_sync",
            name="Userdata Sync",
            replace_existing=True,
        )
        logger.info(
            "Scheduled userdata sync job",
            cron_hour=settings.docs_sync_cron_hour,
            cron_minute=settings.docs_sync_cron_minute,
        )

    if settings.notion_enabled and settings.notion_token and settings.notion_root_page_id:
        _scheduler.add_job(
            notion_sync_job,
            trigger=CronTrigger(
                hour=settings.notion_sync_cron_hour,
                minute=settings.notion_sync_cron_minute,
            ),
            id="notion_sync",
            name="Notion Sync",
            replace_existing=True,
        )
        logger.info(
            "Scheduled notion sync job",
            cron_hour=settings.notion_sync_cron_hour,
            cron_minute=settings.notion_sync_cron_minute,
        )

    _scheduler.start()
    logger.info("Scheduler started")

    return _scheduler


def stop_scheduler() -> None:
    """Stop the background scheduler."""
    global _scheduler

    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Scheduler stopped")


def get_scheduler_status() -> dict[str, Any]:
    """Get current scheduler status."""
    if _scheduler is None:
        return {
            "running": False,
            "jobs": [],
        }

    jobs = []
    for job in _scheduler.get_jobs():
        jobs.append(
            {
                "id": job.id,
                "name": job.name,
                "next_run": str(job.next_run_time) if job.next_run_time else None,
                "last_run": str(_last_runs.get(job.id.replace("_sync", "")))
                if job.id.replace("_sync", "") in _last_runs
                else None,
            }
        )

    return {
        "running": _scheduler.running,
        "jobs": jobs,
    }
