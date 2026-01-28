"""Main FastAPI application entry point."""

import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import structlog
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from skald_worker import __version__
from skald_worker.api import router
from skald_worker.config import settings
from skald_worker.metrics import (
    http_request_duration_seconds,
    http_requests_total,
    init_metrics,
)
from skald_worker.scheduler import start_scheduler, stop_scheduler


def configure_logging() -> None:
    """Configure structured logging."""
    processors = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
    ]

    if settings.log_format == "console":
        processors.append(structlog.dev.ConsoleRenderer())
    else:
        processors.append(structlog.processors.JSONRenderer())

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, settings.log_level.upper(), logging.INFO)
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan context manager."""
    logger = structlog.get_logger(__name__)

    # Startup
    logger.info(
        "Starting Skald Worker",
        version=__version__,
        jira_enabled=settings.jira_enabled,
        docs_enabled=settings.docs_enabled,
    )

    # Initialize metrics
    init_metrics(version=__version__, environment=settings.environment)

    # Start scheduler
    start_scheduler()

    yield

    # Shutdown
    logger.info("Shutting down Skald Worker")
    stop_scheduler()


# Configure logging before creating app
configure_logging()

# Create FastAPI application
app = FastAPI(
    title="Skald Worker",
    description="Data collection worker for Skald - collects Jira issues and technical docs",
    version=__version__,
    lifespan=lifespan,
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routes
app.include_router(router)


@app.middleware("http")
async def metrics_middleware(request: Request, call_next) -> Response:
    """Middleware to track HTTP request metrics."""
    # Skip metrics endpoint to avoid self-instrumentation
    if request.url.path == "/metrics":
        return await call_next(request)

    start_time = time.perf_counter()
    response = await call_next(request)
    duration = time.perf_counter() - start_time

    # Record metrics
    endpoint = request.url.path
    method = request.method
    status_code = str(response.status_code)

    http_requests_total.labels(
        method=method,
        endpoint=endpoint,
        status_code=status_code,
    ).inc()

    http_request_duration_seconds.labels(
        method=method,
        endpoint=endpoint,
    ).observe(duration)

    return response


@app.get("/metrics", include_in_schema=False)
async def metrics() -> Response:
    """Prometheus metrics endpoint."""
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST,
    )


def main() -> None:
    """Run the application."""
    import uvicorn

    uvicorn.run(
        "skald_worker.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
