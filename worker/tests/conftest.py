"""Test configuration and fixtures."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx


@pytest.fixture
def mock_httpx_client():
    """Create a mock httpx AsyncClient."""
    client = AsyncMock(spec=httpx.AsyncClient)
    client.is_closed = False
    return client


@pytest.fixture
def mock_httpx_response():
    """Factory for creating mock HTTP responses."""

    def _create_response(
        status_code: int = 200,
        json_data: dict | list | None = None,
    ) -> MagicMock:
        response = MagicMock(spec=httpx.Response)
        response.status_code = status_code
        response.json.return_value = json_data or {}
        response.raise_for_status = MagicMock()
        if status_code >= 400:
            response.raise_for_status.side_effect = httpx.HTTPStatusError(
                message=f"HTTP {status_code}",
                request=MagicMock(),
                response=response,
            )
        return response

    return _create_response


@pytest.fixture
def sample_jira_issue():
    """Create a sample Jira issue object."""
    issue = MagicMock()
    issue.key = "TEST-123"
    issue.id = "12345"

    fields = MagicMock()
    fields.summary = "Test issue summary"
    fields.description = "Test issue description"

    # Issue type with name attribute
    fields.issuetype = MagicMock()
    fields.issuetype.name = "Bug"

    # Status with name attribute
    fields.status = MagicMock()
    fields.status.name = "Open"

    # Priority
    fields.priority = MagicMock()
    fields.priority.name = "High"

    # Assignee with displayName
    fields.assignee = MagicMock()
    fields.assignee.displayName = "john.doe"

    # Reporter with displayName
    fields.reporter = MagicMock()
    fields.reporter.displayName = "jane.doe"

    # Project
    fields.project = MagicMock()
    fields.project.key = "TEST"
    fields.project.name = "Test Project"

    fields.created = "2024-01-15T10:00:00.000+0000"
    fields.updated = "2024-01-16T15:30:00.000+0000"
    fields.resolutiondate = None
    fields.labels = ["bug", "critical"]
    fields.components = []
    fields.fixVersions = []
    fields.comment = MagicMock()
    fields.comment.comments = []
    fields.resolution = None

    issue.fields = fields
    issue.changelog = None  # No changelog by default
    return issue


@pytest.fixture
def sample_document():
    """Create a sample document from SPMS."""
    return {
        "id": "doc-123",
        "title": "Test Document",
        "content": "<p>This is test content.</p>",
        "format": "html",
        "type": "guide",
        "category": "testing",
        "tags": ["test", "documentation"],
        "author": "Test Author",
        "createdAt": "2024-01-10T09:00:00Z",
        "updatedAt": "2024-01-11T14:00:00Z",
        "url": "https://docs.example.com/test-doc",
    }


@pytest.fixture
def sample_memo():
    """Create a sample Skald memo response."""
    return {
        "id": "memo-uuid-123",
        "title": "[TEST-123] Test issue summary",
        "content": "# Test content",
        "referenceId": "jira:TEST-123",
        "projectId": "project-123",
        "source": "jira",
        "contentHash": "abc123hash",
        "metadata": {
            "jira_key": "TEST-123",
            "status": "Open",
        },
        "createdAt": "2024-01-15T10:00:00Z",
        "updatedAt": "2024-01-15T10:00:00Z",
    }


@pytest.fixture
def sample_search_results():
    """Create sample search results."""
    return {
        "results": [
            {
                "id": "memo-1",
                "title": "Related Issue 1",
                "referenceId": "jira:TEST-100",
                "score": 0.95,
            },
            {
                "id": "memo-2",
                "title": "Related Issue 2",
                "referenceId": "jira:TEST-101",
                "score": 0.88,
            },
        ],
        "total": 2,
    }
