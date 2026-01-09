"""Jira issue collector service."""

import asyncio
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any

import structlog
from jira import JIRA
from jira.exceptions import JIRAError
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from skald_worker.clients.skald import get_skald_client
from skald_worker.config import settings

logger = structlog.get_logger(__name__)

# Retry configuration for Jira API calls
DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_MIN_WAIT = 1.0
DEFAULT_RETRY_MAX_WAIT = 30.0

# JIRA errors that should trigger a retry (connection issues, rate limits, server errors)
RETRYABLE_JIRA_ERRORS = (
    ConnectionError,
    TimeoutError,
    OSError,
)

# Custom field names to extract from Jira issues
CUSTOM_FIELD_NAMES = [
    "기대 결과",
    "실제 결과",
    "재현 절차",
    "결함 심각도",
    "영향",
    "원인",
    "사이트",
    "구성 요소",
    "목표",
    "배경",
    "상세",
    "설명",
    "대상 도구",
]


def _process_user_mentions(text: str, user_id_name_dict: dict[str, str]) -> str:
    """Process user mentions in text, converting [~user_id] to To. username."""
    if not text or not user_id_name_dict:
        return text

    result = text
    # Match [~user_id] pattern
    for match in re.findall(r"\[~([-_.\w]+)\]", text):
        if match in user_id_name_dict:
            result = result.replace(f"[~{match}]", f"To. {user_id_name_dict[match]}")

    # Match [user_id] pattern (without ~)
    for match in re.findall(r"\[([-_.\w]+)\]", text):
        if match in user_id_name_dict:
            result = result.replace(f"[{match}]", f"To. {user_id_name_dict[match]}")

    return result


def _extract_first_assignee(issue: Any) -> str | None:
    """Extract the first assignee from issue changelog."""
    if not hasattr(issue, "changelog") or issue.changelog is None:
        return None

    for history in issue.changelog.histories:
        for item in history.items:
            if item.field == "assignee":
                if item.fromString is not None:
                    return item.fromString
                return item.toString
    return None


def _clean_content(content: str) -> str:
    """Clean content by removing unnecessary patterns for better RAG."""
    if not content:
        return content

    result = content.replace("\r\n", "\n").replace("^", "").replace("\u00a0", " ").replace("\xa0", " ").replace("~", "")

    # Remove image patterns
    result = re.sub(r"!\w+-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}\.\w+\|width=\d+,height=\d+!", "", result)
    result = re.sub(r"!\w+-\d+\.\w+\|thumbnail!", "", result)
    result = re.sub(r"!\w+-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}\.\w+!", "", result)

    # Remove URL patterns
    result = re.sub(r"\[https?://[^\]]+\]", "", result)
    result = re.sub(r"\[링크\|https?://[^\]]+\]", "", result)

    # Remove code blocks
    result = re.sub(r"\{code:java\}.*?\{code\}", "", result, flags=re.DOTALL)

    # Remove stack traces
    result = re.sub(r"(at\s+[\w.$_/]+\(.*?\)\n)+", "", result)

    # Normalize multiple newlines
    result = re.sub(r"\n{3,}", "\n\n", result)

    return result


def jira_issue_to_markdown(
    issue: Any,
    custom_field_dict: dict[str, str] | None = None,
    user_id_name_dict: dict[str, str] | None = None,
) -> tuple[str, str, dict[str, Any], list[str]]:
    """Convert a Jira issue to markdown format for Skald memo.

    Args:
        issue: Jira issue object
        custom_field_dict: Mapping of custom field IDs to names
        user_id_name_dict: Mapping of user IDs to display names

    Returns:
        Tuple of (title, content, metadata, tags)
    """
    fields = issue.fields
    custom_field_dict = custom_field_dict or {}
    user_id_name_dict = user_id_name_dict or {}

    # Extract basic info
    assignee = fields.assignee.displayName if fields.assignee else "없음"
    reporter = fields.reporter.displayName if fields.reporter else "없음"
    status = fields.status.name if fields.status else "없음"
    issue_type = fields.issuetype.name if fields.issuetype else "없음"
    project_key = fields.project.key if fields.project else ""
    project_name = fields.project.name if fields.project else ""

    # Extract fix versions
    fix_versions = []
    if hasattr(fields, "fixVersions") and fields.fixVersions:
        fix_versions = [v.name for v in fields.fixVersions]

    # Extract first assignee from changelog
    first_assignee = _extract_first_assignee(issue)
    if first_assignee is None:
        first_assignee = assignee

    # Process comments - filter out auto-generated ones
    comments = []
    if hasattr(fields, "comment") and fields.comment and fields.comment.comments:
        for comment in fields.comment.comments:
            body = comment.body if comment.body else ""
            author = comment.author.displayName if comment.author else "Unknown"

            # Skip auto-generated comments
            if "이 댓글은 자동생성되었습니다" in body:
                continue
            if "####Teamcity Build Link" in body:
                continue
            if author == "QA ROBOT":
                continue

            # Process user mentions
            processed_body = _process_user_mentions(body, user_id_name_dict)
            comments.append(f"From. {author}: {processed_body}")

    # Extract custom fields
    custom_fields: dict[str, Any] = {}
    for attr_name in dir(fields):
        if attr_name.startswith("customfield_"):
            field_value = getattr(fields, attr_name, None)
            if field_value is None:
                continue
            field_name = custom_field_dict.get(attr_name, "")
            if field_name in CUSTOM_FIELD_NAMES:
                custom_fields[field_name] = field_value

    # Extract target tool value
    target_tool_raw = custom_fields.get("대상 도구", "없음")
    if isinstance(target_tool_raw, list) and len(target_tool_raw) > 0:
        target_tool = target_tool_raw[0].value if hasattr(target_tool_raw[0], "value") else str(target_tool_raw[0])
    elif hasattr(target_tool_raw, "value"):
        target_tool = target_tool_raw.value
    else:
        target_tool = str(target_tool_raw) if target_tool_raw else "없음"

    # Extract other custom field values as strings
    site = str(custom_fields.get("사이트", "없음"))
    component = str(custom_fields.get("구성 요소", "없음"))
    severity = str(custom_fields.get("결함 심각도", "없음"))

    # Parse dates
    created_dt = None
    updated_dt = None
    try:
        if fields.created:
            created_dt = datetime.strptime(fields.created[:19], "%Y-%m-%dT%H:%M:%S")
    except (ValueError, TypeError):
        pass
    try:
        if fields.updated:
            updated_dt = datetime.strptime(fields.updated[:19], "%Y-%m-%dT%H:%M:%S")
    except (ValueError, TypeError):
        pass

    # Build changelog text (last 10 entries)
    changelog_lines = []
    if hasattr(issue, "changelog") and issue.changelog is not None:
        for history in issue.changelog.histories:
            created_at = getattr(history, "created", "")
            author_name = ""
            if hasattr(history, "author") and history.author:
                author_name = getattr(history.author, "displayName", "")
            for item in history.items:
                field = getattr(item, "field", "")
                from_str = getattr(item, "fromString", "") or ""
                to_str = getattr(item, "toString", "") or ""
                changelog_lines.append(f"- {created_at} {author_name} {field}: '{from_str}' -> '{to_str}'")
    _changelog_text = "\n".join(changelog_lines[-10:]) if changelog_lines else ""  # noqa: F841

    # Build title
    title = f"{issue.key} {fields.summary}"

    # Build RAG-optimized markdown content
    lines = []

    # Title and status
    lines.append(f"# {issue.key}: {fields.summary}")
    lines.append("")
    lines.append(f"**현재 상태**: {status}, 담당자: {assignee}")
    lines.append("")

    # Description
    description = fields.description if hasattr(fields, "description") and fields.description else ""
    if description and description.strip():
        lines.append("## 문제 설명")
        lines.append(description.strip())
        lines.append("")

    # Reproduction steps
    repro = custom_fields.get("재현 절차", "")
    if repro and repro != "없음" and str(repro).strip():
        lines.append("## 재현 절차")
        lines.append(str(repro).strip())
        lines.append("")

    # Expected vs Actual results
    expected = custom_fields.get("기대 결과", "")
    actual = custom_fields.get("실제 결과", "")
    if (expected and expected != "없음") or (actual and actual != "없음"):
        lines.append("## 결과 비교")
        if expected and expected != "없음":
            lines.append(f"**기대 결과**: {expected}")
        if actual and actual != "없음":
            lines.append(f"**실제 결과**: {actual}")
        lines.append("")

    # Cause
    cause = custom_fields.get("원인", "")
    if cause and cause != "없음" and str(cause).strip():
        lines.append("## 원인")
        lines.append(str(cause).strip())
        lines.append("")

    # Impact
    impact = custom_fields.get("영향", "")
    if impact and impact != "없음" and str(impact).strip():
        lines.append("## 영향")
        lines.append(str(impact).strip())
        lines.append("")

    # Goal/Background/Details
    for field_name, section_name in [("목표", "목표"), ("배경", "배경"), ("상세", "상세 내용")]:
        field_value = custom_fields.get(field_name, "")
        if field_value and field_value != "없음" and str(field_value).strip():
            lines.append(f"## {section_name}")
            lines.append(str(field_value).strip())
            lines.append("")

    # Comments (last 5)
    if comments:
        lines.append("## 논의 내용")
        recent_comments = comments[-5:]
        for comment in recent_comments:
            clean_comment = comment.strip()
            if len(clean_comment) > 500:
                clean_comment = clean_comment[:500] + "..."
            lines.append(clean_comment)
            lines.append("")

    # Classification info
    classification_parts = []
    if target_tool and target_tool != "없음":
        classification_parts.append(f"도구: {target_tool}")
    if site and site != "없음":
        classification_parts.append(f"사이트: {site}")
    if component and component != "없음":
        classification_parts.append(f"구성요소: {component}")
    if severity and severity != "없음":
        classification_parts.append(f"심각도: {severity}")
    if fix_versions:
        classification_parts.append(f"수정 버전: {', '.join(fix_versions)}")

    if classification_parts:
        lines.append("## 분류")
        lines.append(", ".join(classification_parts) + ".")
        lines.append("")

    # Clean content
    markdown_content = "\n".join(lines)
    clean_content = _clean_content(markdown_content)

    # Build rich metadata
    metadata: dict[str, Any] = {
        # Basic identification
        "issueKey": issue.key,
        "documentType": "jira",
        "issueType": issue_type,
        "project": project_key,
        "projectName": project_name,
        # People
        "reporter": reporter,
        "assignee": assignee,
        "firstAssignee": first_assignee,
        # Status
        "status": status,
        # Classification
        "site": site,
        "component": component,
        "targetTool": target_tool,
        "severity": severity,
        # Dates
        "createdDate": created_dt.strftime("%Y-%m-%d") if created_dt else "",
        "updatedDate": updated_dt.strftime("%Y-%m-%d") if updated_dt else "",
        "createdYear": created_dt.year if created_dt else 0,
        "createdMonth": created_dt.month if created_dt else 0,
        "updatedYear": updated_dt.year if updated_dt else 0,
        "updatedMonth": updated_dt.month if updated_dt else 0,
        # Version info
        "fixVersions": ", ".join(fix_versions) if fix_versions else "없음",
    }

    # Build tags
    tags = [issue_type, status, project_key]
    if target_tool and target_tool != "없음":
        tags.append(target_tool)
    if site and site != "없음":
        tags.append(site)
    # Remove duplicates while preserving order
    tags = list(dict.fromkeys(tags))

    return title, clean_content, metadata, tags


class JiraCollector:
    """Collector service for Jira issues with retry support."""

    def __init__(
        self,
        server: str | None = None,
        user: str | None = None,
        password: str | None = None,
        jql_filter: str | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_min_wait: float = DEFAULT_RETRY_MIN_WAIT,
        retry_max_wait: float = DEFAULT_RETRY_MAX_WAIT,
    ):
        self.server = server or settings.jira_server
        self.user = user or settings.jira_user
        self.password = password or settings.jira_password
        self.jql_filter = jql_filter or settings.jira_jql_filter
        self.max_retries = max_retries
        self.retry_min_wait = retry_min_wait
        self.retry_max_wait = retry_max_wait
        self._jira: JIRA | None = None
        self._executor = ThreadPoolExecutor(max_workers=settings.worker_concurrency)
        # Field and user mappings for rich metadata
        self._custom_field_dict: dict[str, str] = {}
        self._user_id_name_dict: dict[str, str] = {}
        self._fields_loaded = False

    @property
    def jira(self) -> JIRA:
        """Get or create Jira client."""
        if self._jira is None:
            self._jira = JIRA(
                server=self.server,
                basic_auth=(self.user, self.password),
            )
        return self._jira

    def _load_field_mappings(self) -> None:
        """Load Jira custom field and user mappings (lazy initialization)."""
        if self._fields_loaded:
            return

        try:
            # Collect custom field info
            fields = self.jira.fields()
            for field in fields:
                if field["id"].startswith("customfield_"):
                    self._custom_field_dict[field["id"]] = field["name"]

            # Collect user info
            try:
                users = self.jira.search_users("@", maxResults=100)
                for user in users:
                    if hasattr(user, "key") and user.key:
                        self._user_id_name_dict[user.key] = user.displayName
                    if hasattr(user, "name") and user.name:
                        self._user_id_name_dict[user.name] = user.displayName
            except Exception as e:
                logger.warning("Failed to load Jira users", error=str(e))

            self._fields_loaded = True
            logger.info(
                "Loaded Jira field mappings",
                custom_fields=len(self._custom_field_dict),
                users=len(self._user_id_name_dict),
            )
        except Exception as e:
            logger.warning("Failed to load Jira field mappings", error=str(e))

    def _is_retryable_jira_error(self, exc: BaseException) -> bool:
        """Check if a JIRA error should be retried."""
        if isinstance(exc, RETRYABLE_JIRA_ERRORS):
            return True
        if isinstance(exc, JIRAError):
            # Retry on rate limits (429) and server errors (5xx)
            status_code = getattr(exc, "status_code", None)
            if status_code and (status_code == 429 or status_code >= 500):
                return True
        return False

    def _fetch_issues_sync(self, jql: str, max_results: int = 100) -> list[Any]:
        """Fetch Jira issues synchronously with retry (for thread pool)."""

        @retry(
            retry=retry_if_exception_type(RETRYABLE_JIRA_ERRORS),
            stop=stop_after_attempt(self.max_retries),
            wait=wait_exponential(
                multiplier=2.0,
                min=self.retry_min_wait,
                max=self.retry_max_wait,
            ),
            reraise=True,
        )
        def _do_search(start_at: int, batch_size: int) -> list[Any]:
            return list(
                self.jira.search_issues(
                    jql,
                    startAt=start_at,
                    maxResults=batch_size,
                    expand="changelog,comment",
                )
            )

        issues: list[Any] = []
        start_at = 0

        while True:
            batch_size = min(50, max_results - len(issues))
            try:
                batch = _do_search(start_at, batch_size)
            except Exception as e:
                logger.error(
                    "Failed to fetch Jira issues after retries",
                    jql=jql,
                    start_at=start_at,
                    error=str(e),
                )
                break

            if not batch:
                break

            issues.extend(batch)
            start_at += len(batch)

            if len(issues) >= max_results or len(batch) < 50:
                break

        return issues

    def _fetch_single_issue_sync(self, issue_key: str) -> Any:
        """Fetch a single Jira issue with retry."""

        @retry(
            retry=retry_if_exception_type(RETRYABLE_JIRA_ERRORS),
            stop=stop_after_attempt(self.max_retries),
            wait=wait_exponential(
                multiplier=2.0,
                min=self.retry_min_wait,
                max=self.retry_max_wait,
            ),
            reraise=True,
        )
        def _do_fetch() -> Any:
            return self.jira.issue(issue_key, expand="comment")

        return _do_fetch()

    async def fetch_issues(self, jql: str | None = None, max_results: int = 100) -> list[Any]:
        """Fetch Jira issues matching the JQL query.

        Args:
            jql: JQL query (defaults to configured filter)
            max_results: Maximum number of issues to fetch

        Returns:
            List of Jira issue objects
        """
        query = jql or self.jql_filter
        logger.info("Fetching Jira issues", jql=query, max_results=max_results)

        loop = asyncio.get_event_loop()
        issues = await loop.run_in_executor(
            self._executor,
            self._fetch_issues_sync,
            query,
            max_results,
        )

        logger.info("Fetched Jira issues", count=len(issues))
        return issues

    async def sync_issue(self, issue: Any) -> dict[str, Any]:
        """Sync a single Jira issue to Skald.

        Args:
            issue: Jira issue object

        Returns:
            Skald memo data
        """
        # Ensure field mappings are loaded
        self._load_field_mappings()

        title, content, metadata, tags = jira_issue_to_markdown(
            issue,
            custom_field_dict=self._custom_field_dict,
            user_id_name_dict=self._user_id_name_dict,
        )
        reference_id = f"jira:{issue.key}"

        skald = get_skald_client()
        return await skald.upsert_memo(
            title=title,
            content=content,
            reference_id=reference_id,
            source="jira",
            metadata=metadata,
            tags=tags,
        )

    async def sync_all(self, jql: str | None = None, max_results: int = 100) -> dict[str, int]:
        """Sync all matching Jira issues to Skald.

        Args:
            jql: JQL query (defaults to configured filter)
            max_results: Maximum number of issues to sync

        Returns:
            Summary with created/updated/skipped counts
        """
        issues = await self.fetch_issues(jql, max_results)

        created = 0
        updated = 0
        failed = 0

        for issue in issues:
            try:
                await self.sync_issue(issue)
                # Note: upsert_memo handles create vs update internally
                # For simplicity, we count all as processed
                created += 1
            except Exception as e:
                logger.error("Failed to sync issue", issue_key=issue.key, error=str(e))
                failed += 1

        logger.info(
            "Jira sync completed",
            total=len(issues),
            processed=created,
            failed=failed,
        )

        return {
            "total": len(issues),
            "processed": created,
            "failed": failed,
        }

    async def find_similar_issues(
        self,
        issue_key: str,
        limit: int = 5,
        threshold: float = 0.7,
    ) -> dict[str, Any]:
        """Find similar issues to a given Jira issue.

        Args:
            issue_key: Jira issue key (e.g., 'PROJ-123')
            limit: Maximum number of similar issues
            threshold: Similarity threshold

        Returns:
            Similar issues with similarity scores
        """
        # Fetch the issue with retry
        loop = asyncio.get_event_loop()
        issue = await loop.run_in_executor(
            self._executor,
            self._fetch_single_issue_sync,
            issue_key,
        )

        # Ensure field mappings are loaded
        self._load_field_mappings()

        # Convert to text for search
        title, content, _, _ = jira_issue_to_markdown(
            issue,
            custom_field_dict=self._custom_field_dict,
            user_id_name_dict=self._user_id_name_dict,
        )
        search_text = f"{title}\n\n{content}"

        # Search in Skald
        skald = get_skald_client()
        results = await skald.search(
            query=search_text,
            limit=limit + 1,  # +1 to exclude self
            threshold=threshold,
        )

        # Filter out the issue itself
        similar = []
        for result in results.get("results", []):
            ref_id = result.get("referenceId", "")
            if ref_id != f"jira:{issue_key}":
                similar.append(result)
                if len(similar) >= limit:
                    break

        return {
            "issue_key": issue_key,
            "similar_issues": similar,
        }


# Singleton instance
_jira_collector: JiraCollector | None = None


def get_jira_collector() -> JiraCollector:
    """Get or create the singleton Jira collector."""
    global _jira_collector
    if _jira_collector is None:
        _jira_collector = JiraCollector()
    return _jira_collector
