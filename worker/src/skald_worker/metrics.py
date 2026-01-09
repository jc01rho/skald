"""Prometheus metrics for observability."""

from prometheus_client import Counter, Gauge, Histogram, Info

# Application info
app_info = Info("skald_worker", "Skald Worker service information")

# HTTP request metrics
http_requests_total = Counter(
    "skald_worker_http_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status_code"],
)

http_request_duration_seconds = Histogram(
    "skald_worker_http_request_duration_seconds",
    "HTTP request duration in seconds",
    ["method", "endpoint"],
    buckets=[0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
)

# External API call metrics
external_api_calls_total = Counter(
    "skald_worker_external_api_calls_total",
    "Total external API calls",
    ["service", "endpoint", "status"],
)

external_api_duration_seconds = Histogram(
    "skald_worker_external_api_duration_seconds",
    "External API call duration in seconds",
    ["service", "endpoint"],
    buckets=[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
)

external_api_retries_total = Counter(
    "skald_worker_external_api_retries_total",
    "Total external API call retries",
    ["service", "endpoint"],
)

# Sync job metrics
sync_jobs_total = Counter(
    "skald_worker_sync_jobs_total",
    "Total sync jobs executed",
    ["source", "status"],
)

sync_job_duration_seconds = Histogram(
    "skald_worker_sync_job_duration_seconds",
    "Sync job duration in seconds",
    ["source"],
    buckets=[1.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0],
)

sync_items_processed_total = Counter(
    "skald_worker_sync_items_processed_total",
    "Total items processed during sync",
    ["source", "status"],
)

# Scheduler metrics
scheduler_jobs_running = Gauge(
    "skald_worker_scheduler_jobs_running",
    "Number of scheduler jobs currently running",
)

scheduler_next_run_seconds = Gauge(
    "skald_worker_scheduler_next_run_seconds",
    "Seconds until next scheduled job run",
    ["job_id"],
)

# Search/chat metrics
search_requests_total = Counter(
    "skald_worker_search_requests_total",
    "Total search requests",
    ["status"],
)

search_duration_seconds = Histogram(
    "skald_worker_search_duration_seconds",
    "Search request duration in seconds",
    buckets=[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
)

chat_requests_total = Counter(
    "skald_worker_chat_requests_total",
    "Total chat requests",
    ["status"],
)

chat_duration_seconds = Histogram(
    "skald_worker_chat_duration_seconds",
    "Chat request duration in seconds",
    buckets=[0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
)

similar_issues_requests_total = Counter(
    "skald_worker_similar_issues_requests_total",
    "Total similar issues requests",
    ["status"],
)

# Circuit breaker metrics
circuit_breaker_state = Gauge(
    "skald_worker_circuit_breaker_state",
    "Circuit breaker state (0=closed, 1=half_open, 2=open)",
    ["name"],
)

circuit_breaker_failures_total = Counter(
    "skald_worker_circuit_breaker_failures_total",
    "Total circuit breaker recorded failures",
    ["name"],
)

circuit_breaker_rejections_total = Counter(
    "skald_worker_circuit_breaker_rejections_total",
    "Total requests rejected by open circuit breaker",
    ["name"],
)

circuit_breaker_state_changes_total = Counter(
    "skald_worker_circuit_breaker_state_changes_total",
    "Total circuit breaker state transitions",
    ["name", "from_state", "to_state"],
)

# Auth metrics
auth_failures_total = Counter(
    "skald_worker_auth_failures_total",
    "Total authentication failures",
    ["reason"],
)


def init_metrics(version: str = "0.1.0", environment: str = "development") -> None:
    """Initialize application info metrics.

    Args:
        version: Application version
        environment: Deployment environment
    """
    app_info.info(
        {
            "version": version,
            "environment": environment,
        }
    )
