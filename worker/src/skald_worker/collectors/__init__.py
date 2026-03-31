"""Collectors package."""

from skald_worker.collectors.docs_collector import DocsCollector, get_docs_collector
from skald_worker.collectors.jira_collector import JiraCollector, get_jira_collector
from skald_worker.collectors.release_collector import ReleaseCollector, get_release_collector
from skald_worker.collectors.userdata_collector import UserdataCollector, get_userdata_collector

__all__ = [
    "JiraCollector",
    "get_jira_collector",
    "DocsCollector",
    "get_docs_collector",
    "ReleaseCollector",
    "get_release_collector",
    "UserdataCollector",
    "get_userdata_collector",
]
