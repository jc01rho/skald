"""Configuration settings for Skald Worker."""

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Skald API Configuration
    skald_base_url: str = Field(
        default="http://localhost:3000",
        description="Base URL for Skald API",
    )
    skald_api_key: str = Field(
        default="",
        description="API key for Skald authentication",
    )
    skald_project_id: str = Field(
        default="",
        description="Project ID for Skald memos",
    )

    # Jira Configuration
    jira_server: str = Field(
        default="",
        description="Jira server URL",
    )
    jira_url: str = Field(
        default="",
        description="Jira browser URL for issue links (e.g., https://jira.example.com)",
    )
    jira_user: str = Field(
        default="",
        description="Jira username for authentication",
    )
    jira_password: str = Field(
        default="",
        description="Jira password/token for authentication",
    )
    jira_jql_filter: str = Field(
        default="TYPE IN (인시던트, 장애) AND updated >= -1d ORDER BY updated DESC",
        description="JQL query to filter Jira issues",
    )
    jira_poll_interval_minutes: int = Field(
        default=10,
        description="Polling interval for Jira issues in minutes",
    )
    jira_enabled: bool = Field(
        default=True,
        description="Enable Jira issue collection",
    )

    # Technical Docs Configuration
    spms_base_url: str = Field(
        default="",
        description="Base URL for SPMS/tech docs API",
    )
    spms_api_key: str = Field(
        default="",
        description="API key for SPMS authentication",
    )
    spms_auth_required: bool = Field(
        default=True,
        description="Require SPMS bearer authentication when docs collection is enabled in production",
    )
    docs_poll_interval_minutes: int = Field(
        default=30,
        description="Polling interval for technical docs in minutes (ignored if docs_sync_cron is set)",
    )
    docs_sync_cron_hour: int = Field(
        default=3,
        description="Hour to run daily docs sync (0-23, default 3 AM)",
    )
    docs_sync_cron_minute: int = Field(
        default=0,
        description="Minute to run daily docs sync (0-59, default 0)",
    )
    docs_sync_days: int = Field(
        default=7,
        description="Number of days to look back for updated documents",
    )
    docs_enabled: bool = Field(
        default=True,
        description="Enable technical docs collection",
    )
    docs_reconciliation_interval_hours: int = Field(
        default=24,
        gt=0,
        description="Relative cadence in hours for scheduled authoritative reconciliation",
    )
    docs_reconciliation_grace_hours: int = Field(
        default=48,
        ge=0,
        description="Compatibility setting retained for existing deployments",
    )
    spec_reconciliation_interval_seconds: int = Field(
        default=86400,
        gt=0,
        description="Minimum seconds separating explicit authoritative clean observations",
    )
    spec_reconciliation_grace_seconds: int = Field(
        default=172800,
        ge=0,
        description="Minimum absence grace seconds for explicit authoritative operations",
    )
    spec_startup_backfill_enabled: bool = Field(
        default=False,
        description="Run the bounded SPMS backfill once at worker startup",
    )
    spec_startup_authoritative_enabled: bool = Field(
        default=False,
        description="Run authoritative reconciliation after an enabled startup backfill",
    )
    spec_backfill_max_documents: int = Field(
        default=5000,
        gt=0,
        description="Maximum documents processed by a startup SPMS backfill",
    )
    release_enabled: bool = Field(
        default=True,
        description="Enable release status collection",
    )
    userdata_enabled: bool = Field(
        default=True,
        description="Enable customer userdata collection",
    )

    # Worker Configuration
    worker_concurrency: int = Field(
        default=4,
        description="Number of concurrent workers for processing",
    )
    log_level: str = Field(
        default="INFO",
        description="Logging level",
    )
    log_format: str = Field(
        default="json",
        description="Logging format (json or console)",
    )

    # Server Configuration
    host: str = Field(
        default="0.0.0.0",
        description="Host to bind the server",
    )
    port: int = Field(
        default=8080,
        description="Port to bind the server",
    )
    environment: str = Field(
        default="development",
        description="Deployment environment (development, staging, production)",
    )

    # Security Configuration
    worker_api_key: str = Field(
        default="",
        description="API key for authenticating worker API requests; required in production",
    )

    @model_validator(mode="after")
    def require_production_api_keys(self) -> "Settings":
        """Fail closed when production APIs have no required shared secret."""
        if self.environment.strip().lower() != "production":
            return self
        if not self.worker_api_key.strip():
            raise ValueError("WORKER_API_KEY is required when ENVIRONMENT=production")
        if (
            self.docs_enabled
            and self.spms_base_url.strip()
            and self.spms_auth_required
            and not self.spms_api_key.strip()
        ):
            raise ValueError(
                "SPMS_API_KEY is required when production docs collection is enabled; "
                "set SPMS_AUTH_REQUIRED=false only for an internal unauthenticated SPMS"
            )
        return self

    # Circuit Breaker Configuration
    circuit_breaker_failure_threshold: int = Field(
        default=5,
        description="Number of consecutive failures before opening circuit",
    )
    circuit_breaker_recovery_timeout: float = Field(
        default=30.0,
        description="Seconds to wait before attempting recovery",
    )
    circuit_breaker_success_threshold: int = Field(
        default=2,
        description="Number of successful calls to close circuit from half-open",
    )

    # Notion Configuration
    notion_enabled: bool = Field(
        default=False,
        description="Enable Notion wiki collection",
    )
    notion_token: str = Field(
        default="",
        description="Notion integration token (Internal Integration Secret)",
    )
    notion_root_page_id: str = Field(
        default="",
        description="Root Notion page ID to crawl (and all children)",
    )
    notion_sync_cron_hour: int = Field(
        default=1,
        description="Hour to run daily Notion sync (0-23, default 1 AM)",
    )
    notion_sync_cron_minute: int = Field(
        default=0,
        description="Minute to run daily Notion sync (0-59, default 0)",
    )
    notion_max_depth: int = Field(
        default=5,
        description="Maximum depth for recursive child page traversal",
    )
    notion_max_pages: int = Field(
        default=500,
        description="Maximum pages to process per sync (safety valve)",
    )
    notion_rate_limit_rps: float = Field(
        default=2.5,
        description="Notion API requests per second limit (official: 3, safe: 2.5)",
    )

    # Sync State Persistence
    sync_state_file: str = Field(
        default="/var/lib/skald-worker/sync-state.json",
        description="Path to durable file for persisting sync state",
    )


settings = Settings()
