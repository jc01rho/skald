"""Background scheduler for periodic data collection."""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from skald_worker.collectors.docs_collector import get_docs_collector
from skald_worker.collectors.jira_collector import get_jira_collector
from skald_worker.config import settings

logger = structlog.get_logger(__name__)

# Global scheduler instance
_scheduler: AsyncIOScheduler | None = None
_last_runs: dict[str, datetime] = {}


async def jira_sync_job() -> None:
    """Scheduled job to sync Jira issues."""
    logger.info("Starting scheduled Jira sync")
    try:
        collector = get_jira_collector()
        result = await collector.sync_all()
        _last_runs["jira"] = datetime.now()
        logger.info(
            "Scheduled Jira sync completed",
            processed=result["processed"],
            failed=result["failed"],
        )
    except Exception as e:
        logger.error("Scheduled Jira sync failed", error=str(e))


async def docs_sync_job() -> None:
    """Scheduled job to sync technical docs (incremental, last N days)."""
    logger.info("Starting scheduled docs sync")
    try:
        collector = get_docs_collector()
        
        # Calculate updated_since based on configured days
        updated_since = (
            datetime.now(timezone.utc) - timedelta(days=settings.docs_sync_days)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        
        logger.info(
            "Syncing docs updated since",
            updated_since=updated_since,
            days=settings.docs_sync_days,
        )
        
        result = await collector.sync_all(updated_since=updated_since)
        _last_runs["docs"] = datetime.now()
        
        # Handle nested result structure
        total = result.get("total", result)
        logger.info(
            "Scheduled docs sync completed",
            processed=total.get("processed", 0),
            failed=total.get("failed", 0),
        )
    except Exception as e:
        logger.error("Scheduled docs sync failed", error=str(e))


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
