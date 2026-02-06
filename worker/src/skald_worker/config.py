"""Configuration settings for Skald Worker."""

from pydantic import Field
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
        default="updated >= -1d ORDER BY updated DESC",
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
        description="API key for authenticating worker API requests. If empty, authentication is disabled.",
    )

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

    # Sync State Persistence
    sync_state_file: str = Field(
        default="/tmp/skald-worker-sync-state.json",
        description="Path to file for persisting sync state",
    )


settings = Settings()
