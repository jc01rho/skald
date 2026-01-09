"""Collectors package."""

from skald_worker.collectors.docs_collector import DocsCollector, get_docs_collector
from skald_worker.collectors.jira_collector import JiraCollector, get_jira_collector

__all__ = [
    "JiraCollector",
    "get_jira_collector",
    "DocsCollector",
    "get_docs_collector",
]
