"""API schemas for request/response models."""

from typing import Any

from pydantic import BaseModel, Field


# Search schemas
class SearchFilter(BaseModel):
    """Search filter model."""

    field: str = Field(..., description="Field name to filter on")
    operator: str = Field(default="eq", description="Filter operator: eq, ne, contains, etc.")
    value: str = Field(..., description="Filter value")
    filter_type: str = Field(default="native_field", description="Filter type: native_field or custom_metadata")


class SearchRequest(BaseModel):
    """Search request model."""

    query: str = Field(..., description="Search query text")
    limit: int = Field(default=10, ge=1, le=100, description="Maximum number of results")
    threshold: float = Field(default=0.7, ge=0.0, le=1.0, description="Similarity threshold")
    filters: list[SearchFilter] | None = Field(default=None, description="Optional search filters")


class SearchResult(BaseModel):
    """Individual search result."""

    id: str
    title: str
    content: str
    score: float
    reference_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SearchResponse(BaseModel):
    """Search response model."""

    query: str
    results: list[SearchResult]
    total: int


# Similar issues schemas
class SimilarIssuesRequest(BaseModel):
    """Similar issues request model."""

    issue_key: str = Field(..., description="Jira issue key (e.g., 'PROJ-123')")
    limit: int = Field(default=5, ge=1, le=20, description="Maximum number of similar issues")
    threshold: float = Field(default=0.7, ge=0.0, le=1.0, description="Similarity threshold")


class SimilarIssue(BaseModel):
    """Similar issue result."""

    reference_id: str
    title: str
    score: float
    metadata: dict[str, Any] = Field(default_factory=dict)


class SimilarIssuesResponse(BaseModel):
    """Similar issues response model."""

    issue_key: str
    similar_issues: list[SimilarIssue]


# Chat schemas
class ChatRequest(BaseModel):
    """Chat request model."""

    message: str = Field(..., description="User message")
    conversation_id: str | None = Field(default=None, description="Optional conversation ID")
    filters: list[SearchFilter] | None = Field(default=None, description="Optional search filters")
    system_prompt: str | None = Field(default=None, description="Optional system prompt")


class ChatResponse(BaseModel):
    """Chat response model."""

    message: str
    conversation_id: str | None = None
    sources: list[dict[str, Any]] = Field(default_factory=list)


# Sync schemas
class SyncRequest(BaseModel):
    """Manual sync trigger request."""

    source: str = Field(..., description="Source to sync: 'jira' or 'docs'")
    options: dict[str, Any] = Field(default_factory=dict, description="Source-specific options")


class SyncResponse(BaseModel):
    """Sync response model."""

    source: str
    status: str
    processed: int
    failed: int
    message: str | None = None


# Health schemas
class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    version: str
    collectors: dict[str, bool]
    scheduler: dict[str, Any]
    circuit_breakers: dict[str, Any] = Field(default_factory=dict)
    sync_status: dict[str, Any] = Field(default_factory=dict)
