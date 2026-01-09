"""Sync state persistence for tracking last sync times.

Persists sync state to a JSON file to avoid re-processing
already synced items after worker restarts.
"""

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import structlog

from skald_worker.config import settings

logger = structlog.get_logger(__name__)


@dataclass
class SourceSyncState:
    """Sync state for a single source."""

    last_sync_time: str | None = None
    last_successful_sync: str | None = None
    items_processed: int = 0
    items_failed: int = 0
    last_error: str | None = None
    cursor: str | None = None  # For pagination-based sync
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SyncState:
    """Overall sync state containing all sources."""

    version: str = "1.0"
    sources: dict[str, SourceSyncState] = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
    updated_at: str = field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")

    def get_source(self, source_name: str) -> SourceSyncState:
        """Get or create sync state for a source."""
        if source_name not in self.sources:
            self.sources[source_name] = SourceSyncState()
        return self.sources[source_name]

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "version": self.version,
            "sources": {name: asdict(state) for name, state in self.sources.items()},
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SyncState":
        """Create from dictionary."""
        sources = {}
        for name, state_data in data.get("sources", {}).items():
            sources[name] = SourceSyncState(**state_data)

        return cls(
            version=data.get("version", "1.0"),
            sources=sources,
            created_at=data.get("created_at", datetime.utcnow().isoformat() + "Z"),
            updated_at=data.get("updated_at", datetime.utcnow().isoformat() + "Z"),
        )


class SyncStateManager:
    """Manages persistence of sync state to disk."""

    def __init__(self, state_file: str | None = None):
        self.state_file = Path(state_file or settings.sync_state_file)
        self._state: SyncState | None = None
        self._dirty = False

    @property
    def state(self) -> SyncState:
        """Get current sync state, loading from file if needed."""
        if self._state is None:
            self._state = self._load()
        return self._state

    def _load(self) -> SyncState:
        """Load sync state from file."""
        if not self.state_file.exists():
            logger.info("No sync state file found, starting fresh", path=str(self.state_file))
            return SyncState()

        try:
            with open(self.state_file) as f:
                data = json.load(f)
            state = SyncState.from_dict(data)
            logger.info(
                "Loaded sync state",
                path=str(self.state_file),
                sources=list(state.sources.keys()),
            )
            return state
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(
                "Failed to load sync state, starting fresh",
                path=str(self.state_file),
                error=str(e),
            )
            return SyncState()

    def save(self) -> None:
        """Save sync state to file."""
        if self._state is None:
            return

        self._state.updated_at = datetime.utcnow().isoformat() + "Z"

        try:
            # Ensure directory exists
            self.state_file.parent.mkdir(parents=True, exist_ok=True)

            # Write atomically via temp file
            temp_file = self.state_file.with_suffix(".tmp")
            with open(temp_file, "w") as f:
                json.dump(self._state.to_dict(), f, indent=2)

            # Atomic rename
            temp_file.replace(self.state_file)

            self._dirty = False
            logger.debug("Saved sync state", path=str(self.state_file))

        except OSError as e:
            logger.error("Failed to save sync state", path=str(self.state_file), error=str(e))
            raise

    def get_last_sync_time(self, source: str) -> datetime | None:
        """Get the last sync time for a source.

        Args:
            source: Source name (e.g., 'jira', 'docs')

        Returns:
            Last sync datetime or None if never synced
        """
        source_state = self.state.get_source(source)
        if source_state.last_successful_sync:
            try:
                return datetime.fromisoformat(source_state.last_successful_sync.rstrip("Z"))
            except ValueError:
                return None
        return None

    def get_cursor(self, source: str) -> str | None:
        """Get pagination cursor for a source."""
        return self.state.get_source(source).cursor

    def record_sync_start(self, source: str) -> None:
        """Record that a sync has started.

        Args:
            source: Source name
        """
        source_state = self.state.get_source(source)
        source_state.last_sync_time = datetime.utcnow().isoformat() + "Z"
        self._dirty = True

    def record_sync_success(
        self,
        source: str,
        items_processed: int,
        items_failed: int = 0,
        cursor: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Record a successful sync.

        Args:
            source: Source name
            items_processed: Number of items processed
            items_failed: Number of items that failed
            cursor: Optional pagination cursor for next sync
            metadata: Optional additional metadata
        """
        source_state = self.state.get_source(source)
        now = datetime.utcnow().isoformat() + "Z"

        source_state.last_successful_sync = now
        source_state.items_processed = items_processed
        source_state.items_failed = items_failed
        source_state.last_error = None
        source_state.cursor = cursor

        if metadata:
            source_state.metadata.update(metadata)

        self._dirty = True
        self.save()

        logger.info(
            "Recorded sync success",
            source=source,
            items_processed=items_processed,
            items_failed=items_failed,
        )

    def record_sync_failure(self, source: str, error: str) -> None:
        """Record a failed sync.

        Args:
            source: Source name
            error: Error message
        """
        source_state = self.state.get_source(source)
        source_state.last_error = error
        source_state.last_sync_time = datetime.utcnow().isoformat() + "Z"

        self._dirty = True
        self.save()

        logger.warning("Recorded sync failure", source=source, error=error)

    def clear_cursor(self, source: str) -> None:
        """Clear pagination cursor for a source (for full resync)."""
        source_state = self.state.get_source(source)
        source_state.cursor = None
        self._dirty = True
        self.save()

    def get_status(self) -> dict[str, Any]:
        """Get current sync status for all sources."""
        return {
            "sources": {
                name: {
                    "last_successful_sync": state.last_successful_sync,
                    "items_processed": state.items_processed,
                    "items_failed": state.items_failed,
                    "last_error": state.last_error,
                    "has_cursor": state.cursor is not None,
                }
                for name, state in self.state.sources.items()
            },
            "updated_at": self.state.updated_at,
        }


# Singleton instance
_sync_state_manager: SyncStateManager | None = None


def get_sync_state_manager() -> SyncStateManager:
    """Get or create the singleton sync state manager."""
    global _sync_state_manager
    if _sync_state_manager is None:
        _sync_state_manager = SyncStateManager()
    return _sync_state_manager
